/**
 * MHTML-native frame relationships: "is this part a frame root" is a
 * relationship derived on demand from `cid:` references in `text/html`
 * part bodies, never a structural property stored on `MhtmlDocument`/
 * `MhtmlPart` — see docs/architecture.md, "Frame representation: flat
 * parts + cid: linkage". Reused by `inspect` (CLI) and by the
 * MHTML->WebArchive converter.
 */

import { MAX_FRAME_DEPTH } from '../limits.ts'
import type { Diagnostic } from '../model/archive.ts'
import type { MhtmlDocument, MhtmlPart } from '../model/mhtml.ts'
import { findFrameSrcLocations } from './html-rewrite.ts'
import { textCodecFor } from './text-codec.ts'

const CID_SCHEME = 'cid:'

/** Media type comparison is case-insensitive per MIME's own rule (RFC 2045 §5.1) — a hand-constructed `MhtmlDocument` (not necessarily produced by `mhtml/parse.ts`, which already lowercases) may carry `Content-Type`s in any case. */
function isHtmlMimeType(mimeType: string): boolean {
	return mimeType.toLowerCase() === 'text/html'
}

/**
 * Decodes a part's body as text using its declared `textEncoding`. Delegates
 * to {@link textCodecFor} — the same charset-resolution/canonicalization
 * (WHATWG Encoding Standard semantics, e.g. `iso-8859-1` -> `windows-1252`)
 * used by `convert/to-mhtml.ts`/`convert/to-web-archive.ts` when they decode a
 * part to rewrite its frame `src` attributes. Frame-reference detection and
 * HTML rewriting must agree on one decoding of the same bytes; two
 * independent charset-resolution implementations could disagree on a
 * legacy encoding and silently miss (or misdetect) a frame reference.
 */
export function decodePartText(part: MhtmlPart): string {
	return textCodecFor(part.textEncoding).decode(part.data)
}

export interface ContentIdIndex {
	/** Part index by Content-ID, for every Content-ID claimed by exactly one part. */
	readonly indexByContentId: ReadonlyMap<string, number>
	/** Content-IDs claimed by more than one part — ambiguous input; see docs/architecture.md, "Content-ID: preservation, generation, and identity". */
	readonly ambiguousContentIds: ReadonlySet<string>
}

/**
 * Every Content-ID one part claims. A part's identity can be written two
 * ways, and real producers use both: the `Content-ID` header, and a
 * synthetic `cid:` *Content-Location* for inline content with no natural
 * URL (see `model/mhtml.ts` — Blink writes exactly that for the stylesheet
 * it inlines, with no `Content-ID` header at all). A `cid:` reference names
 * either one, so both have to be in the index or a real, extremely common
 * capture shape resolves to nothing.
 */
function contentIdsOf(part: MhtmlPart): readonly string[] {
	const contentIds: string[] = []
	if (part.contentId !== undefined) {
		contentIds.push(part.contentId)
	}
	const locationContentId = part.location === undefined ? undefined : decodeCidUri(part.location)
	if (locationContentId !== undefined && locationContentId !== part.contentId) {
		contentIds.push(locationContentId)
	}
	return contentIds
}

/**
 * Indexes every Content-ID every part claims, tracking which ones are
 * claimed by more than one part. Shared by {@link findFrameRootReferences},
 * `convert/cid-references.ts`'s `cid:` -> URL rewrite and
 * `view/resources.ts`'s reference resolution, so all three agree on one
 * ambiguity analysis rather than each independently re-deriving it (and, in
 * the converter's case, redundantly re-reporting the same
 * `duplicate-content-id` this function's caller may have already reported).
 *
 * An ambiguous Content-ID keeps whichever part claimed it first in
 * `indexByContentId`, but every caller is expected to check
 * `ambiguousContentIds` first and refuse to resolve rather than silently
 * pick that part (docs/architecture.md, "Content-ID: preservation,
 * generation, and identity").
 */
export function indexContentIds(document: MhtmlDocument): ContentIdIndex {
	const indexByContentId = new Map<string, number>()
	const ambiguousContentIds = new Set<string>()
	document.parts.forEach((part, index) => {
		for (const contentId of contentIdsOf(part)) {
			const claimed = indexByContentId.get(contentId)
			if (claimed !== undefined && claimed !== index) {
				ambiguousContentIds.add(contentId)
				continue
			}
			indexByContentId.set(contentId, index)
		}
	})
	return { indexByContentId, ambiguousContentIds }
}

/** Extracts the identifier from a `cid:` URI (RFC 2392), undoing the percent-encoding a Content-ID may need to be a valid URI. Returns undefined for a value that isn't a `cid:` URI at all. */
export function decodeCidUri(value: string): string | undefined {
	const trimmed = value.trim()
	if (!trimmed.toLowerCase().startsWith(CID_SCHEME)) {
		return undefined
	}
	const raw = trimmed.slice(CID_SCHEME.length)
	try {
		return decodeURIComponent(raw)
	} catch {
		return raw
	}
}

/** Encodes a Content-ID into `cid:` URI form (RFC 2392), the inverse of {@link decodeCidUri}. */
export function encodeCidUri(contentId: string): string {
	return `${CID_SCHEME}${encodeURIComponent(contentId)}`
}

/**
 * For each `text/html` part, finds every `<iframe>`/`<frame>` `src="cid:..."`
 * reference that matches another part's Content-ID, in document order.
 * Returns a parent-part-index -> child-part-indices adjacency map; a part
 * with no frame children is simply absent as a key. Self-references (a
 * part whose HTML references its own Content-ID) are ignored rather than
 * treated as a frame relationship.
 *
 * A Content-ID claimed by more than one part is ambiguous input (see
 * `model/archive.ts`'s `duplicate-content-id`, and
 * `mhtml/parse.ts`'s `checkDuplicateIdentities`, which already reports it
 * for a freshly-parsed document) — this function does not assume that
 * check already ran (an `MhtmlDocument` can also be hand-constructed for
 * conversion), so it re-derives ambiguity itself (via {@link indexContentIds})
 * and never silently resolves a `cid:` reference to either same-ID part: a
 * `cid:` pointing at an ambiguous Content-ID is treated the same as one
 * with no match at all, plus a `duplicate-content-id` diagnostic, rather
 * than picking whichever part happened to be indexed last.
 *
 * A part whose HTML references its own Content-ID (`A -> A`) is a direct
 * self-cycle: it is reported as `cyclic-frame-reference` (the same
 * diagnostic a longer `cid:` chain that loops back on itself gets from
 * {@link buildFrameTree}) and the edge is not added to the returned
 * adjacency map — a part is never its own frame child.
 */
export function findFrameRootReferences(document: MhtmlDocument, diagnostics: Diagnostic[]): ReadonlyMap<number, readonly number[]> {
	const { indexByContentId, ambiguousContentIds } = indexContentIds(document)

	const reportedAmbiguous = new Set<string>()
	const adjacency = new Map<number, number[]>()
	document.parts.forEach((part, index) => {
		if (!isHtmlMimeType(part.mimeType)) {
			return
		}
		const html = decodePartText(part)
		const children: number[] = []
		for (const location of findFrameSrcLocations(html)) {
			const cid = decodeCidUri(location.value)
			if (cid === undefined) {
				continue
			}
			if (ambiguousContentIds.has(cid)) {
				if (!reportedAmbiguous.has(cid)) {
					reportedAmbiguous.add(cid)
					diagnostics.push({ type: 'duplicate-content-id', contentId: cid })
				}
				continue
			}
			const childIndex = indexByContentId.get(cid)
			if (childIndex === undefined) {
				continue
			}
			if (childIndex === index) {
				diagnostics.push({ type: 'cyclic-frame-reference', partIndex: childIndex })
				continue
			}
			children.push(childIndex)
		}
		if (children.length > 0) {
			adjacency.set(index, children)
		}
	})

	return adjacency
}

export interface MhtmlFrameNode {
	readonly partIndex: number
	readonly children: readonly MhtmlFrameNode[]
}

/**
 * Builds the frame tree rooted at `rootPartIndex` from an adjacency map
 * (see {@link findFrameRootReferences}), bounded by `MAX_FRAME_DEPTH` and
 * cycle-safe: a `cid:` edge that points back at one of its own ancestors
 * (e.g. A -> B -> A) is dropped entirely — reported as
 * `cyclic-frame-reference` — rather than re-expanded forever or kept as a
 * truncated duplicate node (which would otherwise make the same part
 * appear twice in the reconstructed tree: once as the real frame, once as
 * a hollow copy where the cycle was cut). A legitimate diamond (two
 * different parts both referencing the same third part, neither of which
 * is an ancestor of the other) is not a cycle and is expanded normally at
 * each occurrence. Exceeding `MAX_FRAME_DEPTH` on an otherwise non-cyclic
 * chain is a separate, still-bounded case reported as
 * `frame-depth-exceeded`.
 */
export function buildFrameTree(rootPartIndex: number, adjacency: ReadonlyMap<number, readonly number[]>, diagnostics: Diagnostic[]): MhtmlFrameNode {
	function build(partIndex: number, depth: number, ancestors: ReadonlySet<number>): MhtmlFrameNode {
		if (depth > MAX_FRAME_DEPTH) {
			diagnostics.push({ type: 'frame-depth-exceeded', depth })
			return { partIndex, children: [] }
		}
		const nextAncestors = new Set(ancestors)
		nextAncestors.add(partIndex)
		const childIndices = adjacency.get(partIndex) ?? []
		const children: MhtmlFrameNode[] = []
		for (const childIndex of childIndices) {
			if (nextAncestors.has(childIndex)) {
				diagnostics.push({ type: 'cyclic-frame-reference', partIndex: childIndex })
				continue
			}
			children.push(build(childIndex, depth + 1, nextAncestors))
		}
		return { partIndex, children }
	}
	return build(rootPartIndex, 0, new Set())
}

/** Every part index appearing anywhere in a frame tree (the root and all descendants). */
function collectFrameTreePartIndices(node: MhtmlFrameNode): ReadonlySet<number> {
	const indices = new Set<number>()
	function walk(current: MhtmlFrameNode): void {
		indices.add(current.partIndex)
		for (const child of current.children) {
			walk(child)
		}
	}
	walk(node)
	return indices
}

/**
 * Groups every part index NOT in the frame tree (and not in
 * `excludePartIndices`, used to keep every metadata-sidecar-shaped part out
 * of this grouping entirely — see docs/architecture.md, "The sidecar is
 * auxiliary archive metadata, not a saved-page resource") under whichever
 * frame-tree part index most recently preceded it in document order. MHTML
 * has no structural field recording which part "belongs" to which frame
 * (see the module doc comment above), so this is a best-effort heuristic,
 * not a guarantee — see `convert/to-web-archive.ts`'s module doc comment for
 * the reasoning and its known limitation on foreign, non-ArchiveBridge-
 * authored MHTML.
 */
export function groupPartsByFrame(document: MhtmlDocument, frameTree: MhtmlFrameNode, excludePartIndices: ReadonlySet<number>): ReadonlyMap<number, readonly number[]> {
	const frameRootIndices = collectFrameTreePartIndices(frameTree)
	const grouped = new Map<number, number[]>()
	let currentOwner = frameTree.partIndex
	document.parts.forEach((_part, index) => {
		if (excludePartIndices.has(index)) {
			return
		}
		if (frameRootIndices.has(index)) {
			currentOwner = index
			return
		}
		const owned = grouped.get(currentOwner)
		if (owned === undefined) {
			grouped.set(currentOwner, [index])
		} else {
			owned.push(index)
		}
	})
	return grouped
}
