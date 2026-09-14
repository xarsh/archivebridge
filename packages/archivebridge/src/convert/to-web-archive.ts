/**
 * MHTML -> WebArchive: the inverse of `to-mhtml.ts`. Finds `cid:`-referenced
 * `text/html` parts via `mhtml/frames.ts`, recursively rebuilds
 * `WebSubframeArchives`, rewrites every `cid:` reference in the emitted HTML
 * and CSS to the URL the part it names receives in the converted archive
 * (`convert/cid-references.ts` — WebArchive has no Content-ID concept and
 * WebKit's loader never attempts a `cid:` URL, so a reference carried over
 * verbatim would simply never load), and reads the metadata sidecar (if
 * present) to repopulate `WebResourceResponse`/`WebResourceFrameName`/
 * `extra`. See docs/architecture.md, "Frame representation",
 * "`cid:` references across conversion" and "Direct WebArchive <-> MHTML
 * conversion".
 *
 * **Subresource ownership is not a structural property of flat MHTML** —
 * unlike WebArchive, where every document level has its own explicit
 * `WebSubresources` array, MHTML has no field recording "this part belongs
 * to that frame" (docs/architecture.md, "Frame representation"). This
 * converter recovers it with a heuristic: each non-frame-root part is
 * assigned to the nearest preceding frame-root part in document order.
 * This exactly reconstructs the tree `to-mhtml.ts` produces (which
 * deliberately emits each frame's own parts contiguously, right after that
 * frame's main part, for this reason) and is a reasonable best-effort
 * grouping for other real MHTML too, but it is not a lossless inverse for
 * arbitrary foreign MHTML that interleaves resources across frames in a
 * different order — nothing is dropped in that case, a part just ends up
 * grouped under a different frame than a byte-identical origin capture
 * might have used.
 */

import { assignWebArchiveUrls, type CidReferenceResolver, isRewritableTextPart, rewriteCidReferencesInCss, rewriteCidReferencesInHtml } from '../convert/cid-references.ts'
import { buildFrameTree, findFrameRootReferences, groupPartsByFrame, indexContentIds, type MhtmlFrameNode } from '../mhtml/frames.ts'
import { findSidecarPart, findSidecarPartIndices, parseSidecarPart, type SidecarData } from '../mhtml/sidecar.ts'
import { isSafelyReencodable, textCodecFor } from '../mhtml/text-codec.ts'
import type { Diagnostic } from '../model/archive.ts'
import type { MhtmlDocument, MhtmlPart } from '../model/mhtml.ts'
import type { WebArchiveDocument, WebArchiveResource } from '../model/webarchive.ts'

function partToWebArchiveResource(part: MhtmlPart, url: string, data: Uint8Array, sidecarData: SidecarData | undefined): WebArchiveResource {
	const entry = part.contentId !== undefined ? sidecarData?.get(part.contentId) : undefined
	return {
		url,
		mimeType: part.mimeType,
		data,
		textEncoding: part.textEncoding,
		// Preserved whenever the sidecar explicitly carries it, regardless of whether this
		// part is currently resolved as a frame root: WebResourceFrameName has only ever been
		// observed on frame-root resources in real WebKit output, but ArchiveBridge's own
		// tolerant-preservation stance (docs/architecture.md, "Semantic losslessness") means a
		// value that was genuinely written to the sidecar for this Content-ID must round-trip
		// back out, not be discarded on the assumption that it "shouldn't" be there.
		frameName: entry?.webResourceFrameName,
		response: entry?.webResourceResponse,
		extra: entry?.resourceExtra ?? new Map(),
	}
}

/**
 * Converts a {@link MhtmlDocument} into a {@link WebArchiveDocument}. Always
 * succeeds with a document; diagnostics report degraded behavior (an
 * unresolved `cid:` reference, a truncated recursion, a malformed or
 * ambiguous sidecar) without failing the conversion — a foreign MHTML with
 * no sidecar at all is the common case and degrades to simply having no
 * residual `WebResourceResponse`/`WebResourceFrameName`/`extra` anywhere,
 * not an error (docs/architecture.md, "Metadata sidecar").
 */
export function convertMhtmlToWebArchive(document: MhtmlDocument): { readonly document: WebArchiveDocument; readonly diagnostics: readonly Diagnostic[] } {
	const diagnostics: Diagnostic[] = []

	const sidecarResult = findSidecarPart(document, diagnostics)
	const sidecarData = sidecarResult !== undefined ? parseSidecarPart(sidecarResult.part, diagnostics) : undefined

	const adjacency = findFrameRootReferences(document, diagnostics)
	const frameTree = buildFrameTree(document.rootPartIndex, adjacency, diagnostics)
	// Every part matching the sidecar media type is excluded here — not just the single part
	// `findSidecarPart` resolved — so a duplicate or malformed sidecar part never falls through
	// to being grouped as an ordinary page resource (docs/architecture.md, "The sidecar is
	// auxiliary archive metadata, not a saved-page resource").
	const sidecarPartIndices = new Set(findSidecarPartIndices(document))
	const resourceIndicesByOwner = groupPartsByFrame(document, frameTree, sidecarPartIndices)

	// Shares `findFrameRootReferences`'s own ambiguity analysis (mhtml/frames.ts) rather than
	// re-deriving it independently: a Content-ID claimed by more than one part must never resolve
	// a `cid:` reference to whichever part happened to be indexed last.
	const { indexByContentId, ambiguousContentIds } = indexContentIds(document)
	const urlByPartIndex = assignWebArchiveUrls(document, sidecarPartIndices, diagnostics)

	// `findFrameRootReferences` above already scanned every `text/html` part in the whole document
	// (not just ones reachable from the root) and reported `duplicate-content-id` for every
	// ambiguous Content-ID a frame `src` actually referenced — so the rewrite below must not
	// re-report the same ambiguous Content-ID a second time. Seeding from the diagnostics it
	// produced keeps the two passes in agreement without either having to know the other's rules.
	const reportedAmbiguousContentIds = new Set(diagnostics.filter((entry) => entry.type === 'duplicate-content-id').map((entry) => entry.contentId))

	const resolveCidReference: CidReferenceResolver = (contentId, reference) => {
		if (ambiguousContentIds.has(contentId)) {
			if (!reportedAmbiguousContentIds.has(contentId)) {
				reportedAmbiguousContentIds.add(contentId)
				diagnostics.push({ type: 'duplicate-content-id', contentId })
			}
			diagnostics.push({ type: 'unresolved-resource', url: reference })
			return undefined
		}
		const targetIndex = indexByContentId.get(contentId)
		const url = targetIndex === undefined ? undefined : urlByPartIndex[targetIndex]
		if (url === undefined) {
			diagnostics.push({ type: 'unresolved-resource', url: reference })
			return undefined
		}
		return url
	}

	/**
	 * One part's bytes with every `cid:` reference inside it rewritten.
	 *
	 * The rewrite is attempted first and the re-encodability check only
	 * applies when it actually changed something: a part whose original bytes
	 * cannot be safely round-tripped through its own declared encoding (a
	 * stripped BOM, a malformed byte sequence tolerantly decoded to U+FFFD)
	 * would have to be re-encoded *whole* to apply even a one-attribute edit,
	 * silently normalizing bytes the edit never touched. So the edit is
	 * refused entirely rather than partially applied, and the `cid:`
	 * references are left exactly as they were.
	 */
	function rewrittenDataFor(part: MhtmlPart): Uint8Array {
		const kind = isRewritableTextPart(part)
		if (kind === undefined) {
			return part.data
		}
		const codec = textCodecFor(part.textEncoding)
		const originalText = codec.decode(part.data)
		let rewrittenText: string
		if (kind === 'css') {
			rewrittenText = rewriteCidReferencesInCss(originalText, resolveCidReference)
		} else {
			const result = rewriteCidReferencesInHtml(originalText, resolveCidReference)
			rewrittenText = result.html
			for (const reference of result.unrewritable) {
				diagnostics.push({
					type: 'malformed-resource',
					url: reference,
					message: 'a cid: reference could not be rewritten because the markup gives its attribute no source location of its own; it is left as written and will not resolve',
				})
			}
		}
		if (rewrittenText === originalText) {
			return part.data
		}
		if (!isSafelyReencodable(codec, part.data)) {
			diagnostics.push({ type: 'unsupported-encoding', encoding: part.textEncoding ?? 'utf-8' })
			return part.data
		}
		const encoded = codec.encode(rewrittenText)
		if (encoded === undefined) {
			diagnostics.push({ type: 'unsupported-encoding', encoding: part.textEncoding ?? 'utf-8' })
			return part.data
		}
		return encoded
	}

	const dataByPartIndex = document.parts.map(rewrittenDataFor)

	function resourceFor(partIndex: number): WebArchiveResource | undefined {
		const part = document.parts[partIndex]
		const url = urlByPartIndex[partIndex]
		const data = dataByPartIndex[partIndex]
		if (part === undefined || url === undefined || data === undefined) {
			return undefined
		}
		return partToWebArchiveResource(part, url, data, sidecarData)
	}

	function buildDocument(node: MhtmlFrameNode): WebArchiveDocument {
		const mainPart = document.parts[node.partIndex]
		const mainResource = resourceFor(node.partIndex)
		if (mainPart === undefined || mainResource === undefined) {
			throw new Error('convertMhtmlToWebArchive: frame tree referenced a part index outside document.parts')
		}

		const subresources = (resourceIndicesByOwner.get(node.partIndex) ?? []).map(resourceFor).filter((resource): resource is WebArchiveResource => resource !== undefined)
		const subframeArchives = node.children.map(buildDocument)
		const entry = mainPart.contentId !== undefined ? sidecarData?.get(mainPart.contentId) : undefined

		return { mainResource, subresources, subframeArchives, extra: entry?.documentExtra ?? new Map() }
	}

	return { document: buildDocument(frameTree), diagnostics }
}
