/**
 * The `cid:` half of MHTML -> WebArchive conversion: what URL a part gets
 * in the converted archive, and how every `cid:` reference in the archived
 * HTML and CSS is rewritten to point at it.
 *
 * **The problem this module exists to solve.** MHTML links a part by
 * `Content-ID` and names it with a `cid:` URI (RFC 2392). WebArchive has no
 * such concept: WebKit substitutes a resource by matching a *load* against
 * the resource's `WebResourceURL`, and `cid:` is not a scheme WebKit's
 * resource loader will attempt for an `<img src>`, a `<link href>` or a
 * CSS `url()` in the first place. So a `cid:` reference carried across
 * verbatim produces a structurally faithful `.webarchive` in which the
 * reference simply never loads — measured in real Safari, and not only for
 * exotic input: Blink writes every inlined `<style>` element as a separate
 * part with `Content-Location: cid:css-<uuid>@mhtml.blink` and links it
 * with `<link rel="stylesheet" href="cid:css-…">`, so *every* Chrome
 * capture with an inline stylesheet lost that stylesheet on conversion.
 *
 * **The rule, in one sentence.** Every part gets an absolute, loadable
 * `WebResourceURL` — its `Content-Location` when it has a real one, and
 * otherwise a deterministic synthetic URL derived from its `Content-ID` —
 * and every `cid:` reference in every `text/html` and `text/css` part is
 * rewritten to the URL of the part it names.
 *
 * ## The synthetic namespace
 *
 * {@link contentIdUrl} maps a Content-ID to
 * `https://content-id.archivebridge.invalid/<percent-encoded-id>`. The
 * shape is chosen for five properties, all of which are required:
 *
 * - **Absolute**, so it is independent of whatever base URL the converted
 *   document ends up with.
 * - **Deterministic and stable within one conversion**: the same
 *   Content-ID always produces the same URL, so the reference written into
 *   the HTML and the `WebResourceURL` written into the plist are the same
 *   string by construction rather than by two agreeing computations.
 * - **Collision-safe**, and by {@link assignWebArchiveUrls}'s check rather
 *   than by the encoding. Percent-encoding makes distinct Content-IDs
 *   distinct *strings*, but that is not quite the same as distinct *URLs*:
 *   `encodeURIComponent` leaves `.` unescaped, so the Content-IDs `.` and
 *   `..` mint two different strings that are both dot segments and both
 *   canonicalize to the namespace root. (Measured over every Content-ID of
 *   one code point up to U+02FF and the obvious multi-character dot and
 *   percent shapes, those two are the only inputs whose minted URL is not
 *   already canonical, and percent-escaping the dot does not help them —
 *   the URL Standard counts `%2e` as a dot segment too.) So the guarantee
 *   that no two parts are handed *the same URL* is the one
 *   {@link assignWebArchiveUrls} enforces, comparing {@link collisionKey}s
 *   rather than strings — which it must do regardless, for the ambiguous
 *   input and the hostile `Content-Location` planted inside this namespace.
 * - **A scheme WebKit's resource loader attempts**, which is the entire
 *   point: `https:` gives the archive's own resource table the chance to
 *   satisfy the load, and `cid:`, `about:` and `data:` do not.
 *
 *   What that buys has been measured rather than assumed, in a `WKWebView`
 *   loading a converted archive: an `<img src>`, a `<link rel=stylesheet>`,
 *   a CSS `url()` and a frame `src` in this namespace all resolve, and so
 *   does an `@font-face` `src` — the interesting one, because a webfont is
 *   CORS-restricted and this namespace is a *different origin* from the
 *   archived page. It was probed in the shape conversion actually produces,
 *   a synthetic-namespace stylesheet loading a synthetic-namespace font from
 *   a page on its own real origin, and the `FontFace` reached status
 *   `loaded` (against `error`, and fallback metrics, when the same archive
 *   omits the font resource). So substitution happens ahead of the origin
 *   checks a network fetch would face.
 *
 *   Two things are deliberately *not* claimed. Nothing here was measured
 *   for script-initiated loads (`fetch`, `XMLHttpRequest`) — no archive
 *   viewer runs archived script, so there was nothing to measure — or for
 *   media byte-range requests.
 * - **Never reachable on the network.** `.invalid` is reserved by RFC 2606
 *   precisely so it can never be delegated, so a reference this module
 *   mints can only ever be satisfied from inside the archive. A viewer that
 *   somehow failed to substitute it fails the load locally instead of
 *   asking a real server for it — the same guarantee
 *   docs/architecture.md#security-assumptions makes for everything else.
 *
 * ## Which reference sites are covered
 *
 * Every site `view/html-sites.ts` classifies as holding a reference, and
 * only those. Both the walk and the classification are the viewer's
 * (`classifyHtmlSite`), which is the point: a second answer to "is this a
 * reference?" is exactly how the converter and the viewer would end up
 * disagreeing about what an archive contains, and a missing entry in a list
 * only this module kept would be invisible — it would look exactly like a
 * resource the archive never had, which is how the defect above survived to
 * begin with.
 *
 * What the classification says, and what this module does with it:
 *
 * - a **`url`** site — `img src`, `iframe`/`frame` `src`, `link href`,
 *   `object data`, `embed src`, `video poster`, `script src`, SVG
 *   `href`/`xlink:href`, the obsolete `background` attribute, `a href`,
 *   `form action` — is replaced when its whole value is a `cid:` URI. The
 *   one exception is `<base href>`, which is the *input* to reference
 *   resolution rather than a reference;
 * - a **`srcset`** site has each candidate URL replaced;
 * - a **`css`** site — `style=`, SVG's `fill`/`stroke`/`filter`/`mask`/
 *   `clip-path`/`marker-*` presentation attributes, and the text of every
 *   `<style>` element — goes through `view/css-rewrite.ts`, which finds
 *   `url()` and `@import` targets. Every `text/css` *part* is rewritten the
 *   same way;
 * - an **`html`** site (`iframe srcdoc`) is a nested document and is walked
 *   recursively;
 * - a **`none`** site is left strictly alone.
 *
 * **That last line is a correctness rule, not an optimization.** `id`,
 * `class`, `data-*`, an `<input value>`, `title`, `alt`, `aria-label` and
 * the rest are the archived page's *content*. A converter that rewrote
 * `id="cid:x"` to a URL because the archive happens to contain a part named
 * `x` would not be translating a format — it would be editing the page,
 * breaking every CSS selector and fragment reference that named that id, and
 * changing text a reader sees. Matching on the shape of a *value* cannot
 * tell those apart from a reference; only knowing the site can.
 *
 * ## What is deliberately *not* done
 *
 * - **No viewer policy.** Conversion is a format translation, not a
 *   sanitizer: `<script src="cid:…">` is rewritten like any other
 *   reference, exactly as a `<script src="https://…">` already crosses
 *   untouched today. Refusing to render archived script is the *viewer's*
 *   job and `view/render.ts` does it for both formats (docs/architecture.md,
 *   "The security contract, as rules").
 * - **No invented URL for a reference that does not resolve.** A `cid:`
 *   naming no part, or naming an ambiguous Content-ID, is left exactly as
 *   written plus an `unresolved-resource` diagnostic — the same rule the
 *   frame rewrite has always used. A leftover `cid:` is inert in every
 *   consumer, so tolerating it costs fidelity and nothing else.
 */

import { MAX_FRAME_DEPTH } from '../limits.ts'
import { decodeCidUri } from '../mhtml/frames.ts'
import type { Diagnostic } from '../model/archive.ts'
import type { MhtmlDocument, MhtmlPart } from '../model/mhtml.ts'
import { rewriteCssReferences } from '../view/css-rewrite.ts'
import { classifyHtmlSite, type HtmlEdit, type HtmlSite, htmlAttributeMarkup, parseSrcset, rewriteHtmlSites } from '../view/html-sites.ts'

/**
 * Origin of the synthetic namespace for parts identified only by a
 * Content-ID. See this module's header for why each part of the shape is
 * what it is; `.invalid` in particular is RFC 2606-reserved and can never
 * resolve.
 */
export const CONTENT_ID_URL_ORIGIN = 'https://content-id.archivebridge.invalid'

/**
 * The absolute URL a part identified only by `contentId` receives in a
 * converted WebArchive. `encodeURIComponent` is what makes an arbitrary
 * Content-ID — which MHTML only checks for header *representability*, not
 * for URL syntax — a single valid path segment, and makes distinct IDs
 * distinct URLs.
 */
export function contentIdUrl(contentId: string): string {
	return `${CONTENT_ID_URL_ORIGIN}/${encodeURIComponent(contentId)}`
}

/**
 * The form two `WebResourceURL`s have to differ in to be *different
 * resources*, which is not the same thing as differing as strings.
 *
 * A WebArchive consumer substitutes a resource by matching a load's URL
 * against `WebResourceURL`, and both sides of that match go through URL
 * parsing first — so `https://content-id.archivebridge.invalid/x` and
 * `https://CONTENT-ID.ARCHIVEBRIDGE.INVALID:443/x` are one resource, not
 * two. All four normalizations that close that gap are the WHATWG URL
 * parser's own and are exercised by this module's tests: lowercased host,
 * dropped default port, resolved dot segments, and (through `href`) the
 * canonical serialization of everything else.
 *
 * Two deliberate choices:
 *
 * - **This is a comparison key, never an output.** A real
 *   `Content-Location` is still written to the archive exactly as the
 *   source spelled it ({@link assignWebArchiveUrls} case 1); normalizing
 *   what a part claims its URL *was* would rewrite archive semantics to
 *   settle a question only this comparison asks.
 * - **The key is deliberately coarser than WHATWG equality** in one place:
 *   percent-escapes are compared case-insensitively, which the URL parser
 *   does not do. {@link contentIdUrl} only ever emits upper-case escapes,
 *   so this can never merge two synthetic URLs; all it can do is catch a
 *   hostile `Content-Location` that spells one of them in lower case, in
 *   case a consumer's URL handling normalizes hex case where the WHATWG
 *   parser does not. Being too eager here costs a suffix on one resource;
 *   being too lax costs a shadowed resource.
 */
function collisionKey(url: string): string {
	let canonical: string
	try {
		canonical = new URL(url).href
	} catch {
		// Not an absolute URL at all (a relative `Content-Location`, which MHTML
		// permits). There is nothing to canonicalize, and the raw string is
		// still a sound — merely narrower — key.
		canonical = url
	}
	return canonical.replace(/%[0-9a-fA-F]{2}/g, (percentEscape) => percentEscape.toUpperCase())
}

/** Placeholder identity for a part with neither a Content-Location nor a Content-ID. See {@link assignWebArchiveUrls}. */
function unidentifiedPartUrl(partIndex: number): string {
	return `about:archivebridge-unidentified-part-${partIndex}`
}

/**
 * Decides one `WebResourceURL` per MHTML part, in part order.
 *
 * The order of cases is the contract:
 *
 * 1. A real `Content-Location` is used as written. It is the URL the
 *    resource actually had, and two parts legitimately sharing one (two
 *    frames that each fetched the same stylesheet — real, measured WebKit
 *    behaviour) is not an error and is not disambiguated here.
 * 2. A part whose only identity is a `Content-ID` — whether written as the
 *    `Content-ID` header or as a synthetic `cid:` `Content-Location` —
 *    gets {@link contentIdUrl}.
 * 3. A part with no identity at all gets an `about:` placeholder and a
 *    diagnostic. It stays deliberately unloadable, unlike case 2: nothing
 *    can reference a part that has no identity, so there is no load to
 *    satisfy and inventing a loadable URL for it would only create a
 *    reference surface the archive never had.
 *
 * Synthetic URLs (case 2 and 3) are checked against every URL already
 * assigned, and against every real `Content-Location` in the document, so
 * a hostile archive cannot make a crafted `Content-Location` shadow
 * another part's resource — nor can two parts claiming one ambiguous
 * Content-ID collapse onto one entry. A collision is disambiguated
 * deterministically and reported.
 *
 * That check compares {@link collisionKey}s rather than raw strings,
 * because two `WebResourceURL`s that differ as strings can still be one
 * URL to the consumer doing the substitution — which is exactly the
 * spelling a hostile archive would choose.
 *
 * `excludedPartIndices` names the parts that never become WebArchive
 * resources at all — the metadata sidecar, which legitimately carries no
 * identity of either kind (docs/architecture.md, "The sidecar is auxiliary
 * archive metadata, not a saved-page resource"). They still get an entry so
 * the result stays index-aligned with `document.parts`, but no diagnostic
 * and no claim on the URL namespace.
 */
export function assignWebArchiveUrls(document: MhtmlDocument, excludedPartIndices: ReadonlySet<number>, diagnostics: Diagnostic[]): readonly string[] {
	const realLocations = new Set<string>()
	document.parts.forEach((part, partIndex) => {
		if (!excludedPartIndices.has(partIndex) && part.location !== undefined && decodeCidUri(part.location) === undefined) {
			realLocations.add(collisionKey(part.location))
		}
	})

	const assigned = new Set<string>()
	return document.parts.map((part, partIndex) => {
		if (excludedPartIndices.has(partIndex)) {
			return unidentifiedPartUrl(partIndex)
		}
		if (part.location !== undefined && decodeCidUri(part.location) === undefined) {
			assigned.add(collisionKey(part.location))
			// Written exactly as the archive spelled it: this is the URL the
			// resource actually had, and only the *key* above is normalized.
			return part.location
		}

		const contentId = part.contentId ?? (part.location === undefined ? undefined : decodeCidUri(part.location))
		let url: string
		if (contentId !== undefined) {
			url = contentIdUrl(contentId)
		} else {
			url = unidentifiedPartUrl(partIndex)
			diagnostics.push({
				type: 'malformed-resource',
				url,
				message: 'MHTML part has neither a Content-Location nor a Content-ID; assigned a synthetic placeholder identity',
			})
		}

		const taken = (candidate: string) => realLocations.has(collisionKey(candidate)) || assigned.has(collisionKey(candidate))
		if (taken(url)) {
			diagnostics.push({ type: 'duplicate-content-location', url })
			// Part indices are unique, so one suffix is normally enough; the loop
			// covers the remaining case where a crafted Content-Location already
			// occupies the suffixed form too.
			let disambiguated = `${url}-${partIndex}`
			let attempt = 2
			while (taken(disambiguated)) {
				disambiguated = `${url}-${partIndex}-${attempt}`
				attempt += 1
			}
			url = disambiguated
		}
		assigned.add(collisionKey(url))
		return url
	})
}

/**
 * Resolves one `cid:` reference. Returns the URL to write in its place, or
 * `undefined` to leave the reference exactly as written (no match, or an
 * ambiguous Content-ID).
 */
export type CidReferenceResolver = (contentId: string, reference: string) => string | undefined

function rewriteCidInCss(css: string, resolve: CidReferenceResolver): string {
	return rewriteCssReferences(css, (value) => {
		const contentId = decodeCidUri(value)
		return contentId === undefined ? undefined : resolve(contentId, value.trim())
	})
}

/**
 * Rewrites every `cid:` reference in one stylesheet. Returns the input
 * unchanged when it contains none.
 */
export function rewriteCidReferencesInCss(css: string, resolve: CidReferenceResolver): string {
	return rewriteCidInCss(css, resolve)
}

/** The outcome of rewriting one HTML part. */
export interface HtmlCidRewriteResult {
	readonly html: string
	/**
	 * `cid:` references this module resolved but could not splice, because
	 * `parse5` recorded no source location for the site — the
	 * attribute-merging case `view/render.ts`'s `rewriteDocument` documents
	 * (a second `<body>` start tag donates its attributes to the first
	 * element, with no span of its own). Unlike the viewer, this is not
	 * fail-closed: what stays behind is an inert `cid:` reference, not a
	 * live external URL, so the document is still converted and the caller
	 * reports the gap.
	 */
	readonly unrewritable: readonly string[]
}

/**
 * Rewrites every `cid:` reference in one HTML document — attributes,
 * `srcset` candidates, `style=` and other CSS-valued attributes, and
 * `<style>` element bodies — leaving every other byte untouched.
 */
export function rewriteCidReferencesInHtml(html: string, resolve: CidReferenceResolver, depth = 0): HtmlCidRewriteResult {
	const unrewritable: string[] = []

	/** One `cid:` URI's replacement, or undefined when the value is not one or does not resolve. */
	function resolveValue(value: string): string | undefined {
		const contentId = decodeCidUri(value)
		return contentId === undefined ? undefined : resolve(contentId, value.trim())
	}

	function visit(site: HtmlSite): HtmlEdit | undefined {
		if (site.kind === 'style-text') {
			const rewritten = rewriteCidInCss(site.text, resolve)
			return rewritten === site.text ? undefined : { markup: rewritten }
		}

		const { name, value } = site.attribute

		// Which sites hold a reference is `view/html-sites.ts`'s answer, not this
		// module's — the same answer the viewer acts on. What to *do* with each
		// kind is the format translation below.
		const classification = classifyHtmlSite(site)
		switch (classification.kind) {
			case 'none':
				// Page data — `id`, `class`, `data-*`, `value`, `title`,
				// `aria-label` — which means nothing to a resource loader in either
				// format. See this module's header: a value that merely *spells* a
				// `cid:` URI is not a reference, and rewriting it would edit the
				// archived page's content rather than translate its format.
				return undefined

			case 'css': {
				const rewritten = rewriteCidInCss(value, resolve)
				return rewritten === value ? undefined : { markup: htmlAttributeMarkup(name, rewritten) }
			}

			case 'srcset': {
				const candidates = parseSrcset(value)
				let changed = false
				const rewritten = candidates.map((candidate) => {
					const url = resolveValue(candidate.url)
					if (url === undefined) {
						return candidate
					}
					changed = true
					return { url, descriptor: candidate.descriptor }
				})
				if (!changed) {
					return undefined
				}
				// Candidates are written back as-is, without the viewer's
				// deduplication: that is a rendering workaround, and dropping a
				// candidate here would change what the archive says the page offered.
				const markup = rewritten.map((candidate) => (candidate.descriptor.length === 0 ? candidate.url : `${candidate.url} ${candidate.descriptor}`)).join(', ')
				return { markup: htmlAttributeMarkup(name, markup) }
			}

			case 'html': {
				// `<iframe srcdoc>` is a nested document, so its reference sites are
				// found by this same walk rather than by pattern-matching the markup
				// as a string. The depth bound is the viewer's
				// ({@link MAX_FRAME_DEPTH}), for the same reason: each level is a
				// document parsed out of the level above it, so a hostile archive
				// could otherwise make one attribute cost quadratic work.
				if (depth >= MAX_FRAME_DEPTH) {
					return undefined
				}
				const inner = rewriteCidReferencesInHtml(value, resolve, depth + 1)
				unrewritable.push(...inner.unrewritable)
				return inner.html === value ? undefined : { markup: htmlAttributeMarkup(name, inner.html) }
			}

			case 'url': {
				// A `<base href>` is the *input* to reference resolution, not a
				// reference: it names no part, and rewriting it would change how
				// every unrewritten reference in the document resolves. Every other
				// role names something an archive can hold — including the ones a
				// viewer refuses to load, because refusing is the viewer's job and
				// translating is this module's.
				if (classification.role === 'base') {
					return undefined
				}
				const url = resolveValue(value)
				return url === undefined ? undefined : { markup: htmlAttributeMarkup(name, url) }
			}
		}
	}

	const rewrittenHtml = rewriteHtmlSites(html, visit, (site) => {
		unrewritable.push(site.kind === 'attribute' ? site.attribute.value : site.element.tagName)
	})
	return { html: rewrittenHtml, unrewritable }
}

/** True for a part this module rewrites references inside. */
export function isRewritableTextPart(part: MhtmlPart): 'html' | 'css' | undefined {
	const mimeType = part.mimeType.trim().toLowerCase()
	if (mimeType === 'text/html') {
		return 'html'
	}
	if (mimeType === 'text/css') {
		return 'css'
	}
	return undefined
}
