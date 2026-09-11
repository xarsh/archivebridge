/**
 * Reconstructs a canonical `MhtmlDocument` into HTML a browser can lay out
 * from archive-internal resources alone — the browser-neutral half of the
 * archive viewer.
 *
 * ```text
 * canonical MhtmlDocument
 *   -> index parts by Content-Location / Content-ID   view/resources.ts
 *   -> rewrite every reference in every live document view/html-sites.ts
 *      and stylesheet to a viewer-owned resource URL  view/css-rewrite.ts
 *   -> mint those URLs through the caller's factory   (the only platform seam)
 *   -> hand back the root document's URL
 * ```
 *
 * **This is not a rendering engine.** Layout, CSS and text are the
 * browser's own job; the output of this module is HTML and bytes, never
 * pixels (docs/architecture.md, "The viewer must reconstruct, not
 * delegate"). Nor is it a second archive model: it consumes canonical
 * MHTML, the same shape `inspect` consumes, and derives frame
 * relationships from the same `cid:` -> `Content-ID` linkage, with the same
 * `MAX_FRAME_DEPTH` bound and the same cycle rule the rest of the project
 * uses.
 *
 * **Why this lives in the library and not in the extension.** It has no
 * DOM, no `chrome.*` and no `navigator`: the one platform-dependent
 * operation — turning bytes into a URL the reconstructed document may load
 * — is injected as {@link RenderMhtmlOptions.createResourceUrl}. That keeps
 * CONTRIBUTING.md's boundary rules intact in both directions: the library
 * gains no browser dependency, and the extension does not reimplement (or
 * take a `parse5` dependency for) archive parsing and reference
 * resolution. It is also what makes the expensive half of the viewer
 * reusable by the eventual Firefox and Safari viewers, whose only
 * difference is where the archive bytes come from and how a resource URL
 * is minted.
 *
 * **The security posture is the whole point, so it is stated as rules:**
 *
 * 1. Every reference a browser would load **and that is statically
 *    identifiable** is rewritten. Nothing archived keeps such a URL — not
 *    because a CSP will catch it, but because the reference is gone. The
 *    qualifier is load-bearing and is stated here rather than buried: a
 *    URL that exists only *after* CSS custom-property substitution
 *    (`:root{--x:"https://…"}` plus `image-set(var(--x) 1x)`, measured to
 *    load in Chromium 153) has no statically identifiable form — its
 *    literal text is a plain custom-property string, not a reference,
 *    until the cascade substitutes it — and reconstructing it would mean
 *    evaluating the cascade. For that one class the viewer's `img-src` CSP
 *    is a *mandatory* backstop rather than a redundancy — see
 *    `view/css-rewrite.ts` and docs/architecture.md, "The security
 *    contract, as rules".
 * 2. A reference that cannot be satisfied from inside the archive becomes
 *    {@link NEUTRALIZED_URL} and a warning. There is no fallback that
 *    fetches.
 * 3. Script references are never resolved, even though the archive may
 *    contain the bytes. `<script src>` and SVG `<script href>` are
 *    neutralized, so no script is even *loaded*, let alone run.
 * 4. Plugin content (`<object data>`, `<embed src>`) and pure network
 *    hints (`preload`, `prefetch`, `preconnect`, `dns-prefetch`,
 *    `modulepreload`, `manifest`) are neutralized. `preconnect` and
 *    `dns-prefetch` matter more than they look: they open connections that
 *    no CSP fetch directive governs, so *only* rewriting stops them.
 * 5. Inline event-handler attributes are renamed out of the handler
 *    namespace, and `javascript:`-style schemes are rejected by
 *    `view/resources.ts` before lookup — so archived script cannot run
 *    even in a context where scripting was somehow enabled.
 * 6. Hyperlinks are made non-navigable (the original target is preserved
 *    in a `data-` attribute), because navigating one would leak that the
 *    archive was opened. `<base href>`, `<meta http-equiv=refresh>` and an
 *    archived `Content-Security-Policy` meta are neutralized: the first
 *    would redirect relative resolution off the archive, the second is a
 *    navigation, and the third can only *break* the viewer's own resource
 *    URLs, since the viewer's policy is already stricter.
 * 7. Nothing can put a reference *back* after the rewrite. SVG's
 *    declarative animation elements run with no scripting at all and can
 *    assign to a URL-bearing attribute, so their operative attributes are
 *    renamed away ({@link SVG_ANIMATION_TAGS}) rather than trusted to the
 *    sandbox, which does not stop them (measured).
 * 8. A rewrite that cannot be applied fails the document closed. If a site
 *    this module decided to change has no source location to splice — a
 *    real case for hostile markup, see `rewriteDocument` — the document is
 *    refused rather than shipped with the original reference still live.
 * 9. A reference whose target the browser would parse as *more content*
 *    this module never saw is refused, not resolved: an SVG `<use>` naming
 *    another document ({@link SVG_USE_TAG}), a `data:` stylesheet, a
 *    `data:` frame. Each was measured to load its own references — the
 *    `<use>` case from inside the viewer — so "it carries its own bytes"
 *    is true of a `data:` image and false of a `data:` document.
 * 10. CSS values in attribute form are rewritten too, not just `style=`:
 *    SVG's `fill`, `stroke`, `filter`, `mask`, `clip-path` and `marker-*`
 *    presentation attributes fetch a `url()` with no script, stylesheet or
 *    `style=` anywhere (measured — see
 *    {@link SVG_URL_PRESENTATION_ATTRIBUTES}).
 *
 * The caller still owns isolation — a sandboxed frame and a restrictive
 * CSP (see `apps/extension/src/core/viewer-policy.ts`). These rules are
 * the layer that does not depend on it.
 */

import { MAX_FRAME_DEPTH, MAX_STYLESHEET_IMPORT_DEPTH } from '../limits.ts'
import { decodePartText } from '../mhtml/frames.ts'
import { resolveDocumentBaseUrl } from '../mhtml/html-rewrite.ts'
import type { Diagnostic } from '../model/archive.ts'
import type { MhtmlDocument, MhtmlPart } from '../model/mhtml.ts'
import { rewriteCssReferences } from './css-rewrite.ts'
import { type HtmlEdit, type HtmlSite, htmlAttributeMarkup, rewriteHtmlSites } from './html-sites.ts'
import { type ArchiveResourceIndex, indexArchiveResources, resolveReference } from './resources.ts'

/**
 * What every reference the viewer refuses to load is rewritten to.
 * `about:invalid` is defined (by CSS Values 3, and used the same way by
 * HTML consumers) as a URL that is guaranteed never to resolve to
 * anything, which is exactly the property wanted: the browser fails it
 * locally without issuing a request of any kind.
 */
export const NEUTRALIZED_URL = 'about:invalid'

/** Prefix for attributes this module renames rather than deletes, so nothing is silently lost from a reconstructed document and a reader can still see what was there. */
const PRESERVED_ATTRIBUTE_PREFIX = 'data-archivebridge-'

/** Upper bound on reported warnings. A single hostile or badly broken archive can contain tens of thousands of unresolvable references; the viewer needs enough of them to be diagnosable, not all of them. */
const MAX_WARNINGS = 200

/** Why a reference was refused rather than resolved. */
export type BlockedReferenceReason =
	| 'script'
	| 'plugin'
	/** `preload`/`prefetch`/`preconnect`/`dns-prefetch`/`modulepreload`/`manifest`: a request for a resource that no longer exists, and (for the connection hints) one no CSP directive would stop. */
	| 'network-hint'
	/** A scheme an archive may not name: `javascript:`, `file:`, `ws:`, an extension origin, or a value that is not a URL. */
	| 'unsafe-scheme'
	/** A hyperlink or form target: reachable only by navigating away from the archive. */
	| 'navigation'
	/** An SVG declarative-animation attribute, which could assign a live URL to an attribute the rewrite already neutralized — without any script (see {@link SVG_ANIMATION_TAGS}). */
	| 'animation'
	/**
	 * A reference whose target the browser would parse as *more content* —
	 * markup or CSS — that this module cannot reach and therefore cannot
	 * rewrite: an SVG `<use>` naming another document, a `data:` stylesheet,
	 * a `data:` frame. See {@link SVG_USE_TAG} and
	 * {@link resolveAttribute}'s `selfContained` parameter.
	 */
	| 'nested-content'

/** A viewer-policy event worth showing a human. Distinct from {@link Diagnostic}, which describes a defect in the *archive*: most of these describe a deliberate decision by the viewer. */
export type RenderWarning =
	| {
			/** The archive contains no part for a reference its markup makes. */
			readonly type: 'unresolved-reference'
			readonly url: string
			readonly element: string
			readonly attribute: string
	  }
	| {
			readonly type: 'blocked-reference'
			readonly url: string
			readonly element: string
			readonly attribute: string
			readonly reason: BlockedReferenceReason
	  }
	| {
			/** A frame chain longer than `MAX_FRAME_DEPTH`; the frame is left unloadable. */
			readonly type: 'frame-depth-exceeded'
			readonly depth: number
	  }
	| {
			/** An `@import` chain longer than `MAX_STYLESHEET_IMPORT_DEPTH`; that one import is left unloadable and everything above it is still reconstructed. */
			readonly type: 'stylesheet-import-depth-exceeded'
			readonly depth: number
	  }
	| {
			/** A frame that is already being reconstructed higher up its own chain. */
			readonly type: 'cyclic-frame-reference'
			readonly partIndex: number
	  }
	| {
			/** A site `parse5` recorded no source location for, so it could not be spliced. Reported rather than ignored, because the original reference is still in the document. */
			readonly type: 'unrewritable-reference'
			readonly element: string
			readonly attribute: string
	  }
	| {
			readonly type: 'warnings-truncated'
			readonly omitted: number
	  }

/** Counts describing what the reconstruction did, for a viewer's status line and for tests that need a semantic assertion rather than a screenshot. */
export interface RenderStats {
	/** Reconstructed HTML documents, including the root. */
	readonly documents: number
	/** Archive parts minted as resource URLs (each part at most once). */
	readonly resources: number
	/** Archived stylesheets rewritten and minted. */
	readonly stylesheets: number
	/** Hyperlinks made non-navigable. */
	readonly neutralizedLinks: number
	/** Legacy Blink `shadowmode` templates turned into declarative shadow roots. */
	readonly normalizedShadowRoots: number
	/** References with no matching part in the archive. */
	readonly unresolvedReferences: number
	/** References the viewer refused to load by policy. */
	readonly blockedReferences: number
}

export interface RenderMhtmlOptions {
	/**
	 * Turns archive bytes into a URL the reconstructed document may load,
	 * and the only platform-dependent thing this module does. In a browser
	 * this is `URL.createObjectURL(new Blob([bytes], { type: mimeType }))`
	 * wrapped in whatever owns the URL's lifetime; in a test it can be any
	 * deterministic function, which is what makes the whole rewrite path
	 * assertable without a browser.
	 *
	 * Every URL this returns belongs to one archive load, and the caller is
	 * responsible for releasing all of them together — see
	 * docs/architecture.md, "Viewer resource lifetime".
	 */
	readonly createResourceUrl: (bytes: Uint8Array, mimeType: string) => string
}

export interface MhtmlRenderResult {
	/**
	 * URL of the reconstructed root document, to be loaded in an isolated
	 * frame. Undefined when the archive has no viewable root document at all
	 * (its main resource is not HTML), in which case `diagnostics` says so
	 * and the caller shows its own failure UI rather than a document.
	 */
	readonly rootUrl: string | undefined
	/** The archive's own main-resource URL, for display. */
	readonly rootLocation: string | undefined
	readonly warnings: readonly RenderWarning[]
	readonly diagnostics: readonly Diagnostic[]
	readonly stats: RenderStats
}

const HTML_MIME_TYPES = new Set(['text/html', 'application/xhtml+xml', 'application/xml+xhtml'])

/** `rel` values whose `href` is a real resource the reconstructed document should still load. Everything else a `<link>` can say is neutralized as a network-hint/metadata-shaped reference — see {@link visitLink}. */
const FETCHED_LINK_RELS = new Set(['stylesheet', 'icon', 'shortcut icon', 'apple-touch-icon', 'apple-touch-icon-precomposed', 'mask-icon'])

/**
 * Attributes that name a resource to load, per element. Frame and
 * stylesheet sites are handled separately, since they produce documents and
 * rewritten CSS rather than opaque bytes.
 *
 * The `background` entries are the presentational attribute HTML has
 * declared obsolete and every engine still implements. Chromium loads it on
 * exactly `body`, `table`, `thead`, `tbody`, `tfoot`, `tr`, `td` and `th`
 * and ignores it everywhere else (measured, Chromium 153) — so it is a
 * genuine external image reference, reachable with no script and no CSS,
 * and the list is the measured one rather than a guess.
 */
const RESOURCE_ATTRIBUTES: ReadonlyMap<string, ReadonlySet<string>> = new Map([
	['img', new Set(['src'])],
	['source', new Set(['src'])],
	['video', new Set(['src', 'poster'])],
	['audio', new Set(['src'])],
	['track', new Set(['src'])],
	['input', new Set(['src'])],
	['body', new Set(['background'])],
	['table', new Set(['background'])],
	['thead', new Set(['background'])],
	['tbody', new Set(['background'])],
	['tfoot', new Set(['background'])],
	['tr', new Set(['background'])],
	['td', new Set(['background'])],
	['th', new Set(['background'])],
])

const SRCSET_ATTRIBUTES: ReadonlyMap<string, ReadonlySet<string>> = new Map([
	['img', new Set(['srcset'])],
	['source', new Set(['srcset'])],
])

/**
 * SVG's declarative animation elements, whose operative attributes are
 * neutralized by {@link neutralizeSvgAnimation}.
 *
 * **Why they are made inert rather than animated.** SMIL is *declarative*:
 * it runs with no scripting at all, and a sandbox without `allow-scripts`
 * does not stop it (measured, Chromium 153). It can also assign to a
 * URL-bearing attribute, which means it can put back a URL this module
 * already rewrote away — the one thing the rewrite exists to prevent. All
 * of these were measured to fetch an external URL from inside
 * `sandbox="allow-same-origin"`:
 *
 * ```svg
 * <image href="about:invalid"><set    attributeName="href" to="https://…"/></image>
 * <image href="about:invalid"><animate attributeName="href" values="https://…" fill="freeze"/></image>
 * <feImage href="about:invalid"><set  attributeName="href" to="https://…"/></feImage>
 * <set href="#target" attributeName="href" to="https://…"/>          <!-- targeting another element -->
 * <set attributeName="href" to="https://…" begin="target.click;0s"/> <!-- event-timed -->
 * ```
 *
 * Animation fidelity is worth much less to an archive reader than the
 * guarantee that a rendered archive cannot acquire a live reference after
 * the fact, so the whole mechanism is switched off rather than filtered.
 * That is also why this is a short list of attributes rather than an SVG
 * sanitizer: without `attributeName` there is no attribute to animate, and
 * without the value attributes there is nothing to animate it to.
 */
const SVG_ANIMATION_TAGS = new Set(['animate', 'animatecolor', 'animatemotion', 'animatetransform', 'set', 'discard'])

/** The attributes that make an SVG animation element do something: what it targets, and what it would assign. Renamed rather than deleted, like inline event handlers, so the reconstructed document still shows what was captured. */
const SVG_ANIMATION_ATTRIBUTES = new Set(['attributename', 'attributetype', 'to', 'from', 'by', 'values'])

/** SVG elements whose `href`/`xlink:href` names a resource. `<use>` is deliberately absent — see {@link SVG_USE_TAG}. */
const SVG_RESOURCE_TAGS = new Set(['image', 'feimage', 'filter', 'pattern', 'lineargradient', 'radialgradient', 'textpath', 'mpath', 'tref', 'animate', 'set'])

/**
 * `<use>`, which is the one SVG reference that **instantiates another
 * document's content** rather than reading bytes or an attribute from it —
 * and is therefore refused whenever it does not name a fragment of the
 * document being rendered.
 *
 * **Why it is special, measured rather than assumed.** An external `<use>`
 * target is parsed as an SVG document and the referenced subtree is cloned
 * into the *host* document, where its own references load like any other:
 * Chromium 153 fetched an `<image href="https://…">` inside the referenced
 * `<symbol>`, a `fill="url(https://…)"` inside it, and a further
 * `<use href="https://…">` nested one level deeper. Inside the viewer the
 * same construct reached the network from the archived SVG's bytes (only the
 * CSP stopped it), because those bytes are minted as an opaque resource —
 * this module rewrites the *documents* it reconstructs and the stylesheets
 * they link, not the insides of an image part.
 *
 * Every other external SVG reference was measured *not* to do this:
 * `<image>`, a CSS `background-image`, `fill`/`stroke` naming a
 * `<pattern>`/gradient, `filter`, `mask`, `clip-path`, `marker-*`,
 * `<feImage>`, `<textPath>`, `<mpath>`, `<tref>`, and `<pattern
 * href>`/`<linearGradient href>`/`<filter href>` template inheritance all
 * fetched the SVG and loaded **nothing** from inside it. So the exposure is
 * `<use>` alone, and refusing it is a one-element policy rather than an SVG
 * sanitizer.
 *
 * **What refusing costs.** An archived sprite sheet's icons disappear (with
 * a warning) instead of rendering. That is a small loss made smaller by an
 * existing limitation: a reference minted for an archive part keeps no
 * fragment, so `<use href="sprite.svg#icon">` already rendered the whole
 * sheet rather than the icon. Recursively rewriting SVG parts would be the
 * higher-fidelity answer, and it is not the change to make in the name of
 * security: it means parsing XML with an HTML parser, where a hostile
 * `<b>` forces foreign-content breakout and can hide an attribute from the
 * rewrite, while Chromium's XML parser still loads it.
 */
const SVG_USE_TAG = 'use'

/**
 * SVG presentation attributes whose value is a CSS value that may contain
 * `url()`, and which therefore go through the same CSS rewrite as a
 * `style=` attribute.
 *
 * The list is measured, not derived: in Chromium 153 exactly `fill`,
 * `stroke`, `filter`, `mask`, `clip-path`, `marker-start`, `marker-mid` and
 * `marker-end`, written as attributes, fetched an external URL named in a
 * `url()` — with no script, no stylesheet and no `style=` attribute
 * involved. `mask-image`, `cursor`, `color`, `stop-color`,
 * `background-image` and the `marker` shorthand did not fetch anything in
 * that position and are left out, the same way {@link RESOURCE_ATTRIBUTES}'
 * `background` list is the measured one.
 */
const SVG_URL_PRESENTATION_ATTRIBUTES = new Set(['fill', 'stroke', 'filter', 'mask', 'clip-path', 'marker-start', 'marker-mid', 'marker-end'])

const FRAME_TAGS = new Set(['iframe', 'frame'])

/**
 * Elements whose `href` is a hyperlink the reader can click. These keep
 * their link affordance and lose their destination
 * ({@link neutralizeHyperlink}); every other navigation-shaped attribute in
 * {@link NAVIGATION_ATTRIBUTES} is invisible to the reader and is simply
 * neutralized.
 */
const HYPERLINK_TAGS = new Set(['a', 'area'])

/**
 * Attributes that name somewhere to navigate or submit to, rather than a
 * resource to render. All are neutralized: reaching any of them means
 * leaving the archive, which would tell a server the archive was opened
 * (docs/architecture.md, "Security constraints the viewer must satisfy":
 * links stay non-navigable).
 */
const NAVIGATION_ATTRIBUTES: ReadonlyMap<string, ReadonlySet<string>> = new Map([
	['a', new Set(['ping'])],
	['area', new Set(['ping'])],
	['form', new Set(['action'])],
	['button', new Set(['formaction'])],
	['input', new Set(['formaction'])],
	['img', new Set(['longdesc'])],
	['blockquote', new Set(['cite'])],
	['q', new Set(['cite'])],
	['del', new Set(['cite'])],
	['ins', new Set(['cite'])],
	['html', new Set(['manifest'])],
])

/** A MIME type safe to hand to a `Blob`: one `type/subtype` token pair with optional parameters, and nothing that could carry a newline or a quote out of untrusted archive data. */
function sanitizeMimeType(mimeType: string): string {
	const trimmed = mimeType.trim()
	return /^[A-Za-z0-9!#$%&'*+.^_`|~-]+\/[A-Za-z0-9!#$%&'*+.^_`|~-]+([ \t]*;[ \t]*[A-Za-z0-9!#$%&'*+.^_`|~-]+=[A-Za-z0-9!#$%&'*+.^_`|~-]+)*$/.test(trimmed)
		? trimmed
		: 'application/octet-stream'
}

function isHtmlPart(part: MhtmlPart): boolean {
	return HTML_MIME_TYPES.has(part.mimeType.trim().toLowerCase())
}

function isCssPart(part: MhtmlPart): boolean {
	return part.mimeType.trim().toLowerCase() === 'text/css'
}

/**
 * Splits an `srcset` attribute into its candidates, per the HTML
 * Standard's "parse a srcset attribute" algorithm, reduced to what a
 * rewrite needs: each candidate's URL and the descriptor text that follows
 * it. A URL in `srcset` cannot contain whitespace, and a leading/trailing
 * comma belongs to the list rather than to the URL — the two rules a naive
 * `split(',')` gets wrong.
 */
function parseSrcset(value: string): readonly { readonly url: string; readonly descriptor: string }[] {
	const candidates: { url: string; descriptor: string }[] = []
	let index = 0
	const isSpace = (character: string | undefined) => character !== undefined && /[\t\n\f\r ]/.test(character)
	while (index < value.length) {
		while (isSpace(value[index]) || value[index] === ',') {
			index += 1
		}
		if (index >= value.length) {
			break
		}
		const urlStart = index
		while (index < value.length && !isSpace(value[index])) {
			index += 1
		}
		let url = value.slice(urlStart, index)
		let trailingCommas = 0
		while (url.endsWith(',')) {
			url = url.slice(0, -1)
			trailingCommas += 1
		}
		const descriptorStart = index
		if (trailingCommas === 0) {
			// Descriptors run to the next comma that is not inside parentheses; no
			// real descriptor uses parentheses, so the next comma ends the candidate.
			while (index < value.length && value[index] !== ',') {
				index += 1
			}
		}
		candidates.push({ url, descriptor: value.slice(descriptorStart, index).trim() })
	}
	return candidates
}

/**
 * Serializes srcset candidates back into an attribute value, keeping only
 * the first candidate for any given URL.
 *
 * The deduplication is a workaround for a measured Chromium behavior, and
 * it exists because rewriting *creates* the situation that triggers it:
 * two candidates that named different URLs before can name the same
 * viewer-owned URL afterwards — either because both resolved to one
 * archived part, or (far more often) because both were missing and became
 * {@link NEUTRALIZED_URL}. Chromium loads `srcset="U 1x"` and
 * `srcset="U 1x, V 2x"` but loads *nothing at all* for
 * `srcset="U 1x, U 2x"` (measured, Chromium 153), so a rewrite that left
 * the duplicate in would turn a perfectly good archived image into a blank
 * one. Keeping the first candidate keeps the density the page listed first,
 * which is the `1x` entry in every real `srcset`.
 */
function formatSrcset(candidates: readonly { readonly url: string; readonly descriptor: string }[]): string {
	const seen = new Set<string>()
	const unique = candidates.filter((candidate) => {
		if (seen.has(candidate.url)) {
			return false
		}
		seen.add(candidate.url)
		return true
	})
	return unique.map((candidate) => (candidate.descriptor.length === 0 ? candidate.url : `${candidate.url} ${candidate.descriptor}`)).join(', ')
}

/**
 * Reconstructs `document` for viewing, minting every resource URL through
 * `options.createResourceUrl`.
 *
 * Never throws for archive content: a part that cannot be read degrades to
 * an unresolvable reference and a warning, in keeping with
 * docs/architecture.md, "Diagnostics and partial failure".
 */
export function renderMhtml(document: MhtmlDocument, options: RenderMhtmlOptions): MhtmlRenderResult {
	const diagnostics: Diagnostic[] = []
	const warnings: RenderWarning[] = []
	let omittedWarnings = 0
	const index: ArchiveResourceIndex = indexArchiveResources(document, diagnostics)

	const stats = {
		documents: 0,
		resources: 0,
		stylesheets: 0,
		neutralizedLinks: 0,
		normalizedShadowRoots: 0,
		unresolvedReferences: 0,
		blockedReferences: 0,
	}

	function warn(warning: RenderWarning): void {
		if (warnings.length >= MAX_WARNINGS) {
			omittedWarnings += 1
			return
		}
		warnings.push(warning)
	}

	const resourceUrlByPart = new Map<number, string>()
	const stylesheetUrlByPart = new Map<number, string>()
	const documentUrlByPart = new Map<number, string>()
	/** Parts whose reconstruction is in progress, so a frame chain that comes back to one can be cut. */
	const inProgressParts = new Set<number>()

	function resourceUrl(partIndex: number): string {
		const cached = resourceUrlByPart.get(partIndex)
		if (cached !== undefined) {
			return cached
		}
		const part = document.parts[partIndex]
		if (part === undefined) {
			return NEUTRALIZED_URL
		}
		const url = options.createResourceUrl(part.data, sanitizeMimeType(part.mimeType))
		resourceUrlByPart.set(partIndex, url)
		stats.resources += 1
		return url
	}

	function stylesheetUrl(partIndex: number, importDepth: number): string {
		const cached = stylesheetUrlByPart.get(partIndex)
		if (cached !== undefined) {
			return cached
		}
		// Memoization alone cuts a *cycle* (the slot below is claimed before
		// recursing) and makes a diamond graph linear, but it does nothing for
		// an acyclic chain through thousands of distinct parts, which recurses
		// once per link and overflows the stack at roughly 2000 (measured).
		// That is cheap to put in a hostile archive, so the depth is bounded
		// too — see MAX_STYLESHEET_IMPORT_DEPTH for why it is its own limit.
		if (importDepth > MAX_STYLESHEET_IMPORT_DEPTH) {
			warn({ type: 'stylesheet-import-depth-exceeded', depth: importDepth })
			return NEUTRALIZED_URL
		}
		const part = document.parts[partIndex]
		if (part === undefined) {
			return NEUTRALIZED_URL
		}
		if (!isCssPart(part)) {
			// A `rel=stylesheet` pointing at something that is not CSS: serve the
			// bytes as they are and let the browser refuse them, rather than
			// running a CSS rewrite over, say, an image.
			return resourceUrl(partIndex)
		}
		// Claim the cache slot with NEUTRALIZED_URL before recursing, so a
		// stylesheet that `@import`s itself, directly or indirectly, resolves to
		// the preclaimed inert entry instead of recursing forever.
		stylesheetUrlByPart.set(partIndex, NEUTRALIZED_URL)
		const rewritten = rewriteCss(decodePartText(part), part.location, importDepth)
		const url = options.createResourceUrl(new TextEncoder().encode(rewritten), 'text/css;charset=utf-8')
		stylesheetUrlByPart.set(partIndex, url)
		stats.stylesheets += 1
		return url
	}

	/** Rewrites one stylesheet's references. `baseUrl` is the stylesheet's own URL — CSS URLs resolve against the sheet, not against the document that linked it. */
	function rewriteCss(css: string, baseUrl: string | undefined, importDepth: number): string {
		return rewriteCssReferences(css, (value, kind) => {
			const resolved = resolveReference(index, value, baseUrl)
			switch (resolved.kind) {
				case 'same-document':
					return undefined
				case 'self-contained':
					if (kind !== 'import') {
						// A `data:` image, font or media file: self-contained bytes that
						// reach no network (measured — a `data:image/svg+xml` cannot load
						// an external reference of its own).
						return undefined
					}
					// A `data:text/css` stylesheet is not self-contained at all: its
					// own `@import` and `url()` targets load, to any origin, and
					// nesting a further `data:text/css` inside it works too (measured,
					// Chromium 153). That is CSS this scanner never saw, so the import
					// is refused rather than decoded — see `BlockedReferenceReason`'s
					// `nested-content`.
					stats.blockedReferences += 1
					warn({ type: 'blocked-reference', url: resolved.url, element: 'style', attribute: '@import', reason: 'nested-content' })
					return NEUTRALIZED_URL
				case 'part':
					return kind === 'import' ? stylesheetUrl(resolved.partIndex, importDepth + 1) : resourceUrl(resolved.partIndex)
				case 'unresolved':
					stats.unresolvedReferences += 1
					warn({ type: 'unresolved-reference', url: resolved.url, element: 'style', attribute: kind === 'import' ? '@import' : 'url()' })
					return NEUTRALIZED_URL
				case 'rejected':
					stats.blockedReferences += 1
					warn({ type: 'blocked-reference', url: resolved.url, element: 'style', attribute: kind === 'import' ? '@import' : 'url()', reason: 'unsafe-scheme' })
					return NEUTRALIZED_URL
			}
		})
	}

	function documentUrl(partIndex: number, depth: number): string {
		const cached = documentUrlByPart.get(partIndex)
		if (cached !== undefined) {
			return cached
		}
		if (inProgressParts.has(partIndex)) {
			warn({ type: 'cyclic-frame-reference', partIndex })
			diagnostics.push({ type: 'cyclic-frame-reference', partIndex })
			return NEUTRALIZED_URL
		}
		if (depth > MAX_FRAME_DEPTH) {
			warn({ type: 'frame-depth-exceeded', depth })
			diagnostics.push({ type: 'frame-depth-exceeded', depth })
			return NEUTRALIZED_URL
		}
		const part = document.parts[partIndex]
		if (part === undefined || !isHtmlPart(part)) {
			return NEUTRALIZED_URL
		}
		inProgressParts.add(partIndex)
		try {
			const html = decodePartText(part)
			const documentLocation = part.location ?? 'about:blank'
			const baseUrl = resolveDocumentBaseUrl(html, documentLocation)
			const rewritten = rewriteDocument(html, baseUrl, depth)
			if (rewritten.unrewritable) {
				// A reference this module meant to rewrite is still live in the
				// markup and cannot be spliced out, so the document is not shown at
				// all — see `rewriteDocument`. `onUnlocatable` has already warned.
				return NEUTRALIZED_URL
			}
			// Always UTF-8: the reconstruction is a new document rather than a
			// round trip of the archive's bytes, and a `Blob` type's charset is a
			// *certain* encoding to the HTML parser, which outranks any
			// `<meta charset>` the archive declared (that meta is normalized to
			// `utf-8` as well, so the two can never disagree).
			const url = options.createResourceUrl(new TextEncoder().encode(rewritten.html), 'text/html;charset=utf-8')
			documentUrlByPart.set(partIndex, url)
			stats.documents += 1
			return url
		} finally {
			inProgressParts.delete(partIndex)
		}
	}

	/**
	 * One rewritten HTML document, and whether every rewrite it wanted
	 * actually landed.
	 */
	interface RewrittenDocument {
		readonly html: string
		/**
		 * True when at least one site this module decided to rewrite had no
		 * `parse5` source location and so could not be spliced — meaning the
		 * original, unrewritten markup is still in `html`.
		 */
		readonly unrewritable: boolean
	}

	/**
	 * Rewrites every reference in one HTML document.
	 *
	 * **An unsplicable site fails the whole document closed.** This is not a
	 * theoretical case: HTML's tree construction merges the attributes of a
	 * *second* `<html>` or `<body>` start tag onto the element the first one
	 * created, and `parse5` records no source location for the attributes it
	 * merges. So `…<body><p>x</p><body background="https://…">` puts a live
	 * external image reference on the rendered `<body>` — measured, both that
	 * `parse5` reports it unlocatable and that Chromium 153 loads it — and
	 * there is no span to overwrite. The same shape reaches `onload` and
	 * `<html manifest>`.
	 *
	 * Warning and shipping the document anyway would leave exactly the live
	 * external URL the rewrite exists to remove, so the document is refused
	 * instead: the caller turns it into {@link NEUTRALIZED_URL} and a note.
	 * The trigger is narrow by construction — it fires only when this module
	 * *wanted* to change a site, which no browser-written capture provokes,
	 * rather than on malformed markup in general.
	 */
	function rewriteDocument(html: string, baseUrl: string, depth: number): RewrittenDocument {
		let unrewritable = false
		const onUnlocatable = (site: HtmlSite): void => {
			unrewritable = true
			warn({ type: 'unrewritable-reference', element: site.element.tagName, attribute: site.kind === 'attribute' ? site.attribute.name : '#text' })
		}
		return { html: rewriteHtmlSites(html, (site) => visitSite(site, baseUrl, depth), onUnlocatable), unrewritable }
	}

	/**
	 * Replaces one reference-bearing attribute's value with
	 * {@link NEUTRALIZED_URL}, keeping the attribute's name. `label` names the
	 * site in the warning when the attribute name alone would not identify it
	 * (a `<link href>` means something different for each `rel`).
	 */
	function neutralize(element: string, attribute: string, url: string, reason: BlockedReferenceReason, label = attribute): HtmlEdit | undefined {
		stats.blockedReferences += 1
		warn({ type: 'blocked-reference', url, element, attribute: label, reason })
		return { markup: htmlAttributeMarkup(attribute, NEUTRALIZED_URL) }
	}

	/**
	 * Resolves one reference-bearing attribute to a viewer-owned URL, or to
	 * {@link NEUTRALIZED_URL} plus a warning.
	 *
	 * `selfContained` says what a `data:` URL means at this site. For bytes
	 * the browser decodes and displays — an image, a font, a media file — it
	 * is `keep`: the URL carries its own content, reaches no network, and
	 * dropping it would lose part of the archive for nothing. For a site whose
	 * target the browser *parses* — a stylesheet, a frame document — it is
	 * `refuse`, because the references inside that content are then live and
	 * this module never saw them. Both halves are measured (Chromium 153): a
	 * `data:image/svg+xml` image cannot load an external reference of its own,
	 * while `@import "data:text/css,…"` loads a nested `@import` and `url()`
	 * to any origin, and a `data:text/html` frame runs as a document.
	 */
	function resolveAttribute(
		element: string,
		attribute: string,
		value: string,
		baseUrl: string,
		kindOf: (partIndex: number) => string,
		selfContained: 'keep' | 'refuse' = 'keep',
	): HtmlEdit | undefined {
		const resolved = resolveReference(index, value, baseUrl)
		switch (resolved.kind) {
			case 'same-document':
				return undefined
			case 'self-contained':
				return selfContained === 'keep' ? undefined : neutralize(element, attribute, resolved.url, 'nested-content')
			case 'part':
				return { markup: htmlAttributeMarkup(attribute, kindOf(resolved.partIndex)) }
			case 'unresolved':
				stats.unresolvedReferences += 1
				warn({ type: 'unresolved-reference', url: resolved.url, element, attribute })
				return { markup: htmlAttributeMarkup(attribute, NEUTRALIZED_URL) }
			case 'rejected':
				return neutralize(element, attribute, resolved.url, 'unsafe-scheme')
		}
	}

	function visitSite(site: HtmlSite, baseUrl: string, depth: number): HtmlEdit | undefined {
		if (site.kind === 'style-text') {
			const rewritten = rewriteCss(site.text, baseUrl, 0)
			return rewritten === site.text ? undefined : { markup: rewritten }
		}

		const tag = site.element.tagName
		const name = site.attribute.name
		const value = site.attribute.value
		const html = site.element.namespace === 'html'
		const svg = site.element.namespace === 'svg'

		// Inline event handlers, on any element in any namespace. Renamed rather
		// than resolved: nothing in an archive gets to be executable markup, in
		// any context, regardless of what the isolation layer allows.
		if (/^on[a-z]/.test(name)) {
			stats.blockedReferences += 1
			warn({ type: 'blocked-reference', url: '', element: tag, attribute: name, reason: 'script' })
			return { markup: htmlAttributeMarkup(`${PRESERVED_ATTRIBUTE_PREFIX}${name}`, value) }
		}

		// Declarative animation, which needs no scripting to assign a fresh URL
		// to an attribute this module already neutralized. See
		// SVG_ANIMATION_TAGS for the measured cases.
		if (svg && SVG_ANIMATION_TAGS.has(tag) && SVG_ANIMATION_ATTRIBUTES.has(name)) {
			stats.blockedReferences += 1
			warn({ type: 'blocked-reference', url: value, element: tag, attribute: name, reason: 'animation' })
			return { markup: htmlAttributeMarkup(`${PRESERVED_ATTRIBUTE_PREFIX}${name}`, value) }
		}

		if (name === 'style') {
			const rewritten = rewriteCss(value, baseUrl, 0)
			return rewritten === value ? undefined : { markup: htmlAttributeMarkup('style', rewritten) }
		}

		if (html && tag === 'template' && (name === 'shadowmode' || name === 'shadowdelegatesfocus')) {
			return normalizeLegacyShadowAttribute(site, name, value)
		}

		if (html && tag === 'base' && name === 'href') {
			// The archive's base URL is an *input* to resolution (already applied
			// to every reference in this document); leaving it in the output would
			// point unrewritten and same-document references off the archive.
			return { markup: htmlAttributeMarkup(`${PRESERVED_ATTRIBUTE_PREFIX}base-href`, value) }
		}

		if (html && tag === 'meta') {
			return normalizeMeta(site, name, value)
		}

		if ((html && tag === 'script' && (name === 'src' || name === 'href')) || (svg && tag === 'script' && (name === 'href' || name === 'xlink:href'))) {
			return neutralize(tag, name, value, 'script')
		}

		if (html && ((tag === 'object' && name === 'data') || (tag === 'embed' && name === 'src') || (tag === 'applet' && (name === 'code' || name === 'archive')))) {
			return neutralize(tag, name, value, 'plugin')
		}

		if (html && tag === 'link') {
			return visitLink(site, name, value, baseUrl)
		}

		if (html && FRAME_TAGS.has(tag)) {
			if (name === 'src') {
				// `refuse`: a `data:text/html` frame is a document whose own markup
				// this module never rewrote. Measured in Chromium 153 outside the
				// viewer: such a frame loads its images, runs its script and nests a
				// further `data:` frame. Inside the viewer only `frame-src blob:`
				// stopped it, which is a backstop doing a rewrite's job.
				return resolveAttribute(tag, name, value, baseUrl, (partIndex) => documentUrl(partIndex, depth + 1), 'refuse')
			}
			if (name === 'srcdoc') {
				// An inline frame document: its references resolve against this
				// document's base URL (HTML's rule for `about:srcdoc`), and the same
				// depth bound as a `src` frame covers the recursion — evaluated
				// against the child's depth, not the parent's, so the two agree on
				// exactly how deep is too deep.
				const childDepth = depth + 1
				if (childDepth > MAX_FRAME_DEPTH) {
					warn({ type: 'frame-depth-exceeded', depth: childDepth })
					return { markup: htmlAttributeMarkup('srcdoc', '') }
				}
				const inline = rewriteDocument(value, baseUrl, childDepth)
				// Same rule as a frame document: markup that could not be fully
				// rewritten is emptied rather than shipped with a live reference.
				return { markup: htmlAttributeMarkup('srcdoc', inline.unrewritable ? '' : inline.html) }
			}
			return undefined
		}

		if (HYPERLINK_TAGS.has(tag) && (name === 'href' || (svg && name === 'xlink:href'))) {
			return neutralizeHyperlink(name, value, baseUrl)
		}
		if (html && NAVIGATION_ATTRIBUTES.get(tag)?.has(name) === true) {
			return neutralize(tag, name, value, 'navigation')
		}

		if (html && SRCSET_ATTRIBUTES.get(tag)?.has(name) === true) {
			return rewriteSrcset(tag, name, value, baseUrl)
		}

		if (html && RESOURCE_ATTRIBUTES.get(tag)?.has(name) === true) {
			return resolveAttribute(tag, name, value, baseUrl, resourceUrl)
		}
		if (svg && tag === SVG_USE_TAG && (name === 'href' || name === 'xlink:href')) {
			// A fragment of the document being rendered is left exactly alone; it
			// clones markup this module already rewrote. Anything else names
			// another document, whose contents would be instantiated live.
			const resolved = resolveReference(index, value, baseUrl)
			// A `cid:` reference names a part without naming a URL, so the value as
			// written is the only thing there is to report.
			return resolved.kind === 'same-document' ? undefined : neutralize(tag, name, resolved.url ?? value, 'nested-content')
		}
		if (svg && SVG_RESOURCE_TAGS.has(tag) && (name === 'href' || name === 'xlink:href')) {
			return resolveAttribute(tag, name, value, baseUrl, resourceUrl)
		}
		if (svg && SVG_URL_PRESENTATION_ATTRIBUTES.has(name)) {
			// A presentation attribute is a CSS declaration value, so it goes
			// through the CSS rewrite rather than through reference resolution:
			// `fill="url(x.png) red"` has a URL *and* a fallback paint, and
			// `fill="url(#gradient)"` names this document and must not change.
			const rewritten = rewriteCss(value, baseUrl, 0)
			return rewritten === value ? undefined : { markup: htmlAttributeMarkup(name, rewritten) }
		}

		return undefined
	}

	function normalizeLegacyShadowAttribute(site: HtmlSite, name: string, value: string): HtmlEdit | undefined {
		if (site.kind !== 'attribute') {
			return undefined
		}
		// An element that already declares the standard attribute is left alone:
		// the standard one is what the browser hydrates, and adding a second
		// source of truth could only disagree with it.
		if (site.element.attribute('shadowrootmode') !== undefined) {
			return undefined
		}
		if (name === 'shadowdelegatesfocus') {
			return site.element.attribute('shadowmode') === undefined ? undefined : { markup: htmlAttributeMarkup('shadowrootdelegatesfocus', value) }
		}
		const mode = value.toLowerCase()
		// `open` and `closed` are the only modes there are; anything else is not
		// a shadow root Blink wrote, and a mode is never invented — a captured
		// closed root stays closed.
		if (mode !== 'open' && mode !== 'closed') {
			return undefined
		}
		stats.normalizedShadowRoots += 1
		return { markup: htmlAttributeMarkup('shadowrootmode', mode) }
	}

	function normalizeMeta(site: HtmlSite, name: string, value: string): HtmlEdit | undefined {
		if (site.kind !== 'attribute') {
			return undefined
		}
		if (name === 'charset') {
			return value.trim().toLowerCase() === 'utf-8' ? undefined : { markup: htmlAttributeMarkup('charset', 'utf-8') }
		}
		if (name !== 'content') {
			return undefined
		}
		const httpEquiv = site.element.attribute('http-equiv')?.trim().toLowerCase()
		switch (httpEquiv) {
			case 'refresh':
				// A navigation directive aimed at a URL that no longer exists. The
				// isolation layer refuses it too (measured: Chromium declines a
				// sandboxed document's meta refresh without `allow-scripts`), but a
				// navigation must not depend on one mechanism.
				stats.blockedReferences += 1
				warn({ type: 'blocked-reference', url: value, element: 'meta', attribute: 'content', reason: 'navigation' })
				return { markup: htmlAttributeMarkup('content', '') }
			case 'content-security-policy':
			case 'content-security-policy-report-only':
				// The archived page's own CSP names origins that no longer exist. It
				// cannot make the viewer safer — the viewer's policy is already
				// stricter — and it can stop the viewer's own resource URLs from
				// loading.
				return { markup: htmlAttributeMarkup('content', '') }
			case 'content-type':
				return { markup: htmlAttributeMarkup('content', 'text/html; charset=utf-8') }
			default:
				return undefined
		}
	}

	function visitLink(site: HtmlSite, name: string, value: string, baseUrl: string): HtmlEdit | undefined {
		if (site.kind !== 'attribute') {
			return undefined
		}
		if (name === 'imagesrcset') {
			// A `rel=preload` candidate list: a hint for resources that are gone.
			return neutralize('link', name, value, 'network-hint')
		}
		if (name !== 'href') {
			return undefined
		}
		const rels = new Set(
			(site.element.attribute('rel') ?? '')
				.trim()
				.toLowerCase()
				.split(/\s+/)
				.filter((token) => token.length > 0),
		)
		const relText = [...rels].join(' ')
		if (rels.has('stylesheet')) {
			// `refuse` for the same reason as a frame: a `data:text/css` sheet is
			// CSS this module never scanned, and its `@import`/`url()` targets are
			// live (measured).
			return resolveAttribute('link', name, value, baseUrl, (partIndex) => stylesheetUrl(partIndex, 0), 'refuse')
		}
		for (const rel of rels) {
			if (FETCHED_LINK_RELS.has(rel)) {
				return resolveAttribute('link', name, value, baseUrl, resourceUrl)
			}
		}
		// Every other rel a `<link href>` can carry is neutralized as a
		// network-hint/metadata-shaped reference: the known network hints
		// (`preload`, `prefetch`, `preconnect`, `dns-prefetch`, `modulepreload`,
		// `manifest`, …) name resources that no longer exist, and everything else
		// (`alternate`, `canonical`, `author`, an unknown token) is metadata the
		// browser does not fetch — neutralizing it costs nothing while removing
		// any doubt about whether some future browser might start fetching it.
		return neutralize('link', name, value, 'network-hint', relText.length === 0 ? 'href' : `href [rel=${relText}]`)
	}

	function neutralizeHyperlink(name: string, value: string, baseUrl: string): HtmlEdit | undefined {
		const resolved = resolveReference(index, value, baseUrl)
		if (resolved.kind === 'same-document') {
			// An in-page anchor still works, and should: it moves within the
			// document being viewed and can reach nothing else.
			return undefined
		}
		stats.neutralizedLinks += 1
		// `#` keeps the element a link — styled, focusable, with the cursor a
		// reader expects — while making a click a same-document no-op. The
		// original target is preserved next to it rather than discarded, so the
		// information is still in the reconstructed document.
		// A `cid:` hyperlink names a part rather than a URL, so the original
		// value is the only thing there is to preserve for it.
		const original = resolved.kind === 'part' ? (resolved.url ?? value) : resolved.url
		return { markup: `${htmlAttributeMarkup(name, '#')} ${htmlAttributeMarkup(`${PRESERVED_ATTRIBUTE_PREFIX}${name.replace(':', '-')}`, original)}` }
	}

	function rewriteSrcset(tag: string, name: string, value: string, baseUrl: string): HtmlEdit | undefined {
		const candidates = parseSrcset(value)
		if (candidates.length === 0) {
			return undefined
		}
		const rewritten = candidates.map((candidate) => ({ url: rewriteSrcsetCandidate(tag, name, candidate.url, baseUrl), descriptor: candidate.descriptor }))
		return { markup: htmlAttributeMarkup(name, formatSrcset(rewritten)) }
	}

	/** One srcset candidate's URL, resolved the same way a single-URL attribute is. */
	function rewriteSrcsetCandidate(tag: string, name: string, value: string, baseUrl: string): string {
		const resolved = resolveReference(index, value, baseUrl)
		switch (resolved.kind) {
			case 'same-document':
			case 'self-contained':
				return value
			case 'part':
				return resourceUrl(resolved.partIndex)
			case 'unresolved':
				stats.unresolvedReferences += 1
				warn({ type: 'unresolved-reference', url: resolved.url, element: tag, attribute: name })
				return NEUTRALIZED_URL
			case 'rejected':
				stats.blockedReferences += 1
				warn({ type: 'blocked-reference', url: resolved.url, element: tag, attribute: name, reason: 'unsafe-scheme' })
				return NEUTRALIZED_URL
		}
	}

	const rootPart = document.parts[document.rootPartIndex]
	const rootLocation = rootPart?.location
	let rootUrl: string | undefined
	if (rootPart === undefined || !isHtmlPart(rootPart)) {
		diagnostics.push({ type: 'unsupported-feature', feature: `main resource is not HTML (${rootPart?.mimeType ?? 'no root part'}), so it has no viewable document` })
	} else {
		rootUrl = documentUrl(document.rootPartIndex, 0)
		if (rootUrl === NEUTRALIZED_URL) {
			rootUrl = undefined
		}
	}

	if (omittedWarnings > 0) {
		warnings.push({ type: 'warnings-truncated', omitted: omittedWarnings })
	}

	return { rootUrl, rootLocation, warnings, diagnostics, stats }
}
