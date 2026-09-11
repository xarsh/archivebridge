/**
 * Resolving one reference found in archived markup to one part of the
 * archive being viewed — and nothing else. No network, ever: a reference
 * this module cannot satisfy from the archive comes back as `unresolved`,
 * which the renderer turns into an inert URL and a warning (see
 * docs/architecture.md, "Security constraints the viewer must satisfy":
 * "No external network fallback").
 *
 * Identity is **the archive's own recorded URLs**. Canonical MHTML gives
 * every part either a `Content-Location` (an absolute URL for an ordinary
 * resource) or a `Content-ID` reachable as a `cid:` URI, and those are the
 * only two things a reference can name. There is deliberately no
 * filename/basename/suffix matching fallback: a reference that resolves to
 * a URL the archive does not contain is a missing resource, and guessing
 * which part the author "meant" would make the viewer's resource graph
 * depend on heuristics rather than on what was captured.
 */

import { decodeCidUri } from '../mhtml/frames.ts'
import type { Diagnostic } from '../model/archive.ts'
import type { MhtmlDocument } from '../model/mhtml.ts'

/** URL schemes whose bytes are carried inline in the reference itself. Whether keeping one verbatim is safe depends on the consuming context — see the `self-contained` case of {@link ResolvedReference} — not on the scheme alone. */
const SELF_CONTAINED_SCHEMES = new Set(['data:'])

/**
 * An index of an `MhtmlDocument` for reference lookup: part index by
 * absolute `Content-Location`, and part index by `Content-ID`.
 *
 * Ambiguity is *excluded* rather than resolved. A URL or Content-ID
 * claimed by more than one part cannot be resolved to "the" part without
 * picking arbitrarily, so both are dropped from the index and reported
 * (`duplicate-content-location`/`duplicate-content-id`) — the same stance
 * `mhtml/frames.ts` takes for `cid:` frame links, for the same reason.
 */
export interface ArchiveResourceIndex {
	readonly document: MhtmlDocument
	readonly partIndexByUrl: ReadonlyMap<string, number>
	readonly partIndexByContentId: ReadonlyMap<string, number>
}

/** Normalizes a URL for identity comparison: parsed and re-serialized, with the fragment dropped (a fragment identifies a place *within* a resource, never a different resource). Returns undefined for a string that is not a URL at all. */
function normalizeUrl(value: string, base?: string): string | undefined {
	let url: URL
	try {
		url = base === undefined ? new URL(value) : new URL(value, base)
	} catch {
		return undefined
	}
	url.hash = ''
	return url.href
}

/** Builds the lookup index for `document`, reporting ambiguous identities as diagnostics. */
export function indexArchiveResources(document: MhtmlDocument, diagnostics: Diagnostic[]): ArchiveResourceIndex {
	const partIndexByUrl = new Map<string, number>()
	const ambiguousUrls = new Set<string>()
	const partIndexByContentId = new Map<string, number>()
	const ambiguousContentIds = new Set<string>()

	document.parts.forEach((part, index) => {
		if (part.location !== undefined) {
			const cid = decodeCidUri(part.location)
			// A synthetic `cid:` Content-Location (a real producer convention for
			// inline content with no natural URL — see model/mhtml.ts) is an alias
			// for this part's own identity, not a URL; it is reachable through the
			// Content-ID index instead.
			const key = cid === undefined ? normalizeUrl(part.location) : undefined
			if (key !== undefined) {
				if (partIndexByUrl.has(key)) {
					ambiguousUrls.add(key)
				} else {
					partIndexByUrl.set(key, index)
				}
			}
			if (cid !== undefined && !partIndexByContentId.has(cid)) {
				partIndexByContentId.set(cid, index)
			}
		}
		if (part.contentId !== undefined) {
			if (partIndexByContentId.has(part.contentId) && partIndexByContentId.get(part.contentId) !== index) {
				ambiguousContentIds.add(part.contentId)
			} else {
				partIndexByContentId.set(part.contentId, index)
			}
		}
	})

	for (const url of ambiguousUrls) {
		partIndexByUrl.delete(url)
		diagnostics.push({ type: 'duplicate-content-location', url })
	}
	for (const contentId of ambiguousContentIds) {
		partIndexByContentId.delete(contentId)
		diagnostics.push({ type: 'duplicate-content-id', contentId })
	}

	return { document, partIndexByUrl, partIndexByContentId }
}

/** What a reference in archived markup turned out to be. */
export type ResolvedReference =
	| {
			/** The reference names a part of this archive. */
			readonly kind: 'part'
			readonly partIndex: number
			/** The absolute URL the reference resolved to, for use as a nested stylesheet's own base URL and for warnings. Undefined for a `cid:` reference, which names a part without naming a URL. */
			readonly url: string | undefined
	  }
	| {
			/** A `data:` URL and the like: it carries its bytes inline. Whether it is safe to preserve depends on the consuming context — an opaque resource such as an image, font or media reference keeps it; the renderer refuses a `data:` URL parsed as a nested document or stylesheet instead of resolving it here. */
			readonly kind: 'self-contained'
			readonly url: string
	  }
	| {
			/** A same-document reference (`#section`, `url(#gradient)`): it names a place inside the document being rendered, so it must be left exactly as written. */
			readonly kind: 'same-document'
			readonly url: string
	  }
	| {
			/** A syntactically resolvable URL that this archive has no part for. */
			readonly kind: 'unresolved'
			readonly url: string
	  }
	| {
			/** A scheme that can execute or reach outside the archive (`javascript:`, `file:`, `ws:`, an unknown scheme), or a value that is not a URL at all. */
			readonly kind: 'rejected'
			readonly url: string
	  }

/**
 * Resolves one reference value against `baseUrl` (the effective base URL
 * of the document or stylesheet the reference was found in).
 *
 * The order of cases is the contract:
 *
 * 1. An empty or whitespace-only value references the document itself in
 *    HTML's URL rules — treated as same-document, never as "resolve the
 *    base URL", so an `<img src="">` cannot become a second load of the
 *    reconstructed document.
 * 2. A pure fragment stays as written.
 * 3. `cid:` resolves through the Content-ID index. This is how canonical
 *    MHTML links a frame to its document and how Chromium-produced MHTML
 *    names inline content, so it is checked before any URL parsing.
 * 4. `data:` and friends resolve to `self-contained` here; whether the
 *    caller keeps the bytes verbatim depends on what is consuming the
 *    reference (see the `self-contained` case of {@link ResolvedReference}).
 * 5. Anything else is resolved against `baseUrl` and looked up by URL;
 *    a scheme that is not `http(s)` or another archivable web scheme is
 *    rejected outright rather than looked up, because an archive must
 *    never be able to name a `file:`, `javascript:` or `chrome-extension:`
 *    URL and have the viewer hand it to the browser.
 */
export function resolveReference(index: ArchiveResourceIndex, value: string, baseUrl: string | undefined): ResolvedReference {
	const trimmed = value.trim()
	if (trimmed.length === 0) {
		return { kind: 'same-document', url: trimmed }
	}
	if (trimmed.startsWith('#')) {
		return { kind: 'same-document', url: trimmed }
	}

	const cid = decodeCidUri(trimmed)
	if (cid !== undefined) {
		const partIndex = index.partIndexByContentId.get(cid)
		return partIndex === undefined ? { kind: 'unresolved', url: trimmed } : { kind: 'part', partIndex, url: undefined }
	}

	const lower = trimmed.toLowerCase()
	for (const scheme of SELF_CONTAINED_SCHEMES) {
		if (lower.startsWith(scheme)) {
			return { kind: 'self-contained', url: trimmed }
		}
	}

	const resolved = normalizeUrl(trimmed, baseUrl)
	if (resolved === undefined) {
		return { kind: 'rejected', url: trimmed }
	}
	if (!isArchivableWebUrl(resolved)) {
		return { kind: 'rejected', url: resolved }
	}
	const partIndex = index.partIndexByUrl.get(resolved)
	return partIndex === undefined ? { kind: 'unresolved', url: resolved } : { kind: 'part', partIndex, url: resolved }
}

/**
 * Schemes a captured page's resource may legitimately have had. Anything
 * else — `javascript:`, `file:`, `ws:`/`wss:`, `chrome-extension:`, a
 * private app scheme — is rejected before lookup: it either executes, or
 * reads the local machine, or names something the viewer's own origin
 * controls, none of which an archive gets to ask for. `blob:` is on the
 * list because Blink captures `blob:` resources by URL
 * (docs/architecture.md, "Format vs. capture semantics") and the captured
 * bytes are then in the archive like any other part; a `blob:` reference
 * with no matching part resolves to `unresolved`, not to a live blob.
 */
function isArchivableWebUrl(url: string): boolean {
	const scheme = url.slice(0, url.indexOf(':') + 1).toLowerCase()
	return scheme === 'http:' || scheme === 'https:' || scheme === 'blob:' || scheme === 'about:'
}
