/**
 * Walks an archived HTML document and lets a caller replace any
 * attribute — or the text of any `<style>` element — by exact source
 * offset, preserving every other byte.
 *
 * This is the same technique, and the same reasoning, as
 * `mhtml/html-rewrite.ts`: `parse5` is used only to find where things are
 * in the source string (`sourceCodeLocationInfo`), never to re-serialize
 * the document. The parsed tree is discarded as soon as the offsets have
 * been collected, so attribute quoting, entity spelling, whitespace and
 * every untouched element survive exactly. What is different here is
 * *scope*: `mhtml/html-rewrite.ts` locates one attribute (a frame `src`),
 * while this module offers the whole attribute surface and leaves the
 * policy — which attributes matter, and what they become — entirely to its
 * caller.
 *
 * **It has two callers, and only one of them is the viewer.** `view/render.ts`
 * uses it to reach every reference a browser would load and to apply the
 * viewer's security policy to each one; `convert/cid-references.ts` uses it
 * to reach every `cid:` reference in an MHTML part and rewrite it to the
 * URL that part's resource receives in a WebArchive. Sharing the walk is
 * deliberate: a second "find every reference site" implementation is
 * exactly how one of them would end up quietly missing a site the other
 * covers. Nothing in here is viewer policy, and nothing may become so.
 *
 * Three parsing decisions are load-bearing:
 *
 * - **`scriptingEnabled: false`.** The reconstructed document is rendered
 *   in a sandbox with no `allow-scripts`, so the *browser* will parse
 *   `<noscript>` content as live markup rather than as raw text. Parsing it
 *   here the same way is what lets the references inside it be rewritten;
 *   parsing with scripting enabled (parse5's default) would leave
 *   `<noscript>` a single opaque text node and ship its original external
 *   references — including ones no CSP directive covers, such as
 *   `<link rel=preconnect>` — straight into the rendered document.
 * - **Declarative shadow roots are walked, ordinary `<template>`s are
 *   not.** `parse5` puts every template's children in a separate
 *   `content` fragment, so a walk that follows only `childNodes` misses
 *   them. A declarative shadow root is a real, rendered part of the
 *   document once hydrated and its references do load; an ordinary inert
 *   template is markup that only a script could ever activate, and no
 *   script runs here. This mirrors `mhtml/html-rewrite.ts`'s rule, with
 *   one addition: Blink writes captured shadow roots with the legacy
 *   `shadowmode` attribute (docs/architecture.md, "Format vs. capture
 *   semantics"), and the viewer normalizes those into real shadow roots —
 *   so a `shadowmode` template's content is live for the viewer's purposes
 *   too, and is walked.
 * - **Namespaces are reported, not flattened.** `<image>` in SVG is not
 *   `<img>` in HTML and `<svg><style>` is not `<style>`; the caller needs
 *   to tell them apart, and `parse5` already has the answer.
 */

import { parse } from 'parse5'

/** The element namespaces this module distinguishes. `other` covers MathML and any foreign content the caller has no rules for. */
export type HtmlNamespace = 'html' | 'svg' | 'other'

/** An attribute as written, with the source key its location is filed under (`xlink:href`, not `href`). */
export interface HtmlAttribute {
	/** Lowercased qualified name as it appears in the source — the form callers match on and the key `sourceCodeLocation.attrs` uses. */
	readonly name: string
	readonly value: string
}

/** The element an edit site belongs to, with enough context for a caller to decide what the site means. */
export interface HtmlElementContext {
	/** Lowercased tag name (`img`, `iframe`, `image` for SVG's). */
	readonly tagName: string
	readonly namespace: HtmlNamespace
	/** Another attribute of the same element, by lowercased qualified name — `rel` for a `<link>`, `type` for an `<input>`. */
	attribute(name: string): string | undefined
}

/** One rewritable place in the document: an attribute, or the text content of a `<style>` element. */
export type HtmlSite =
	| {
			readonly kind: 'attribute'
			readonly element: HtmlElementContext
			readonly attribute: HtmlAttribute
	  }
	| {
			readonly kind: 'style-text'
			readonly element: HtmlElementContext
			readonly text: string
	  }

/**
 * What to put in a site's place. `markup` replaces the located span
 * verbatim: for an attribute site that span is the whole `name="value"`
 * (so the name can change, or one attribute can become two), and for a
 * `style-text` site it is the element's text content.
 *
 * Building `markup` for an attribute site by hand is a mistake waiting to
 * happen — use {@link htmlAttributeMarkup}, which escapes the value for
 * the double-quoted attribute context it writes.
 */
export interface HtmlEdit {
	readonly markup: string
}

/**
 * Escapes `value` for a double-quoted attribute and returns the whole
 * `name="value"` attribute source.
 *
 * `&` and `"` must be escaped or an attacker-controlled archive value
 * could close the attribute and inject markup. `<` and `>` are escaped as
 * well: they are legal in an attribute value, but escaping them keeps a
 * rewritten value from ever *looking* like a tag boundary to anything that
 * later reads the reconstructed HTML with something less rigorous than an
 * HTML parser.
 */
export function htmlAttributeMarkup(name: string, value: string): string {
	const escaped = value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
	return `${name}="${escaped}"`
}

/** One `srcset` candidate: the URL, and the descriptor text (`2x`, `640w`, or nothing) that followed it. */
export interface SrcsetCandidate {
	readonly url: string
	readonly descriptor: string
}

/**
 * Splits an `srcset` attribute into its candidates, per the HTML
 * Standard's "parse a srcset attribute" algorithm, reduced to what a
 * rewrite needs: each candidate's URL and the descriptor text that follows
 * it. A URL in `srcset` cannot contain whitespace, and a leading/trailing
 * comma belongs to the list rather than to the URL — the two rules a naive
 * `split(',')` gets wrong.
 *
 * Shared by the viewer (`view/render.ts`) and the MHTML->WebArchive
 * converter (`convert/cid-references.ts`) so the one attribute whose value
 * is a *list* of references is parsed one way. How the candidates are
 * written back is each caller's own business — the viewer deduplicates
 * (see `formatSrcset` there, a workaround for a measured Chromium
 * behaviour), the converter does not.
 */
export function parseSrcset(value: string): readonly SrcsetCandidate[] {
	const candidates: SrcsetCandidate[] = []
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

/* ------------------------------------------------------------------ *
 * What a site's value is
 * ------------------------------------------------------------------ */

/**
 * What kind of reference a URL-valued site is — a classification of the
 * site, not a policy about what to do with it. Every role names HTML or
 * SVG markup whose value has URI/reference semantics: bytes to fetch, a
 * stylesheet, a nested frame, executable script, a plugin/external-object
 * resource, a hyperlink or other navigation target, a resource the browser
 * only hints at fetching, or an SVG `<use>` reference. `base` is the one
 * role that is not itself a reference: it defines the resolution *context*
 * other references resolve against, rather than naming a resource of its
 * own.
 *
 * The roles are kept apart because callers legitimately treat them
 * differently (the viewer refuses script and navigation, the converter
 * translates both) — that split is each caller's policy, not a claim made
 * here about which roles a browser actually loads from in every
 * circumstance.
 */
export type HtmlUrlRole =
	/** Bytes the browser fetches and renders or decodes: an image, a media file, a poster, an icon. */
	| 'resource'
	/** A stylesheet: fetched *and parsed*, so its own references become live. */
	| 'stylesheet'
	/** A nested document: `<iframe src>`, `<frame src>`. */
	| 'frame'
	/** Executable script: `<script src>`, SVG `<script href>`. */
	| 'script'
	/** A plugin/external-object resource: `<object data>`, `<embed src>`, `<applet code|archive>`. */
	| 'plugin'
	/** A hyperlink the reader can follow: `<a href>`, `<area href>`. */
	| 'hyperlink'
	/** Somewhere to navigate or submit to without a click: `<form action>`, `ping`, `cite`, `longdesc`, `manifest`. */
	| 'navigation'
	/** A resource the browser is only *hinted* to fetch: `<link rel=preload|prefetch|…>`, and every other `rel` it does not fetch. */
	| 'network-hint'
	/** SVG `<use href>`, which instantiates another document's markup rather than reading bytes from it. */
	| 'svg-use'
	/** `<base href>` — an *input* to reference resolution, not a reference. */
	| 'base'

/**
 * What one {@link HtmlSite}'s value is, syntactically, and for a URL what
 * the browser does with it.
 *
 * **This is the one description of the reference surface, and it is
 * policy-neutral.** Everything in it is a statement about what a browser
 * does with a value, most of it measured (see {@link RESOURCE_ATTRIBUTES}
 * and {@link SVG_URL_PRESENTATION_ATTRIBUTES}); nothing in it is a decision
 * about what *should* happen. The viewer and the MHTML->WebArchive
 * converter both ask this question and then answer it differently:
 * `view/render.ts` neutralizes a `script` or `navigation` role and mints a
 * viewer-owned URL for a `resource` one, while `convert/cid-references.ts`
 * translates a `cid:` reference in *any* role that names a part and leaves
 * `none` strictly alone.
 *
 * The `none` case is load-bearing for the converter and worth stating
 * plainly: `id`, `class`, `data-*`, `value`, `title`, `alt` and
 * `aria-label` are page *data*. A converter that rewrote them because they
 * happened to spell a `cid:` URI would be mutating the archived page's
 * content, not translating a format.
 */
export type HtmlSiteClass =
	| { readonly kind: 'url'; readonly role: HtmlUrlRole }
	/** A comma-separated candidate list; split it with {@link parseSrcset}. */
	| { readonly kind: 'srcset'; readonly role: 'image' | 'preload' }
	/** A CSS value or stylesheet body, which may contain `url()` or `@import`: `style=`, an SVG URL-valued presentation attribute, a `<style>` element's text. */
	| { readonly kind: 'css' }
	/** Nested document markup: `<iframe srcdoc>`. */
	| { readonly kind: 'html' }
	/** Not a reference site. The value is page data and means nothing to the resource loader. */
	| { readonly kind: 'none' }

const NONE: HtmlSiteClass = { kind: 'none' }

/**
 * Attributes that name a resource to load, per element. Frame and
 * stylesheet sites are classified separately, since a caller acting on them
 * produces documents and rewritten CSS rather than opaque bytes.
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

/** `rel` values whose `href` is a real resource the browser fetches. Everything else a `<link>` can say is classified `network-hint`. */
const FETCHED_LINK_RELS = new Set(['stylesheet', 'icon', 'shortcut icon', 'apple-touch-icon', 'apple-touch-icon-precomposed', 'mask-icon'])

/** SVG elements whose `href`/`xlink:href` names a resource. `<use>` is deliberately absent — it gets its own role, because it instantiates markup rather than reading bytes. */
const SVG_RESOURCE_TAGS = new Set(['image', 'feimage', 'filter', 'pattern', 'lineargradient', 'radialgradient', 'textpath', 'mpath', 'tref', 'animate', 'set'])

const SVG_USE_TAG = 'use'

/**
 * SVG presentation attributes whose value is a CSS value that may contain
 * `url()`, and which therefore hold CSS rather than a bare URL.
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

/** Elements whose `href` is a hyperlink the reader can follow. */
const HYPERLINK_TAGS = new Set(['a', 'area'])

/**
 * Attributes that name somewhere to navigate or submit to, rather than a
 * resource to render. Reaching any of them means leaving the archive.
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

/** The `rel` tokens of a `<link>`, lowercased, in source order. */
export function linkRelTokens(element: HtmlElementContext): readonly string[] {
	return (element.attribute('rel') ?? '')
		.trim()
		.toLowerCase()
		.split(/\s+/)
		.filter((token) => token.length > 0)
}

/**
 * Classifies one site: what its value is, and — for a URL — what the
 * browser does with it. See {@link HtmlSiteClass}.
 *
 * **Deliberately *not* classified as references**, each for a reason:
 *
 * - an inline event handler (`on*`), whose value is script rather than a
 *   URL. The viewer refuses it as script; nothing else may treat the
 *   expression inside it as a reference to resolve.
 * - SVG's declarative-animation value attributes (`to`, `from`, `by`,
 *   `values`). Whether they hold a URL depends on the sibling
 *   `attributeName`, so they are not URL-valued sites — and the viewer
 *   neutralizes the whole mechanism anyway, so nothing can ever load from
 *   one.
 * - `<meta content>`, including `http-equiv=refresh`'s `0;url=…`. It is a
 *   directive whose URL is embedded in a larger grammar, not a URL-valued
 *   attribute.
 * - `<template shadowrootmode>` and friends, which are enumerated
 *   attributes.
 *
 * A caller that wants to act on any of those is describing its own policy
 * and must say so at its own site, not by widening this function.
 */
export function classifyHtmlSite(site: HtmlSite): HtmlSiteClass {
	if (site.kind === 'style-text') {
		return { kind: 'css' }
	}

	const tag = site.element.tagName
	const name = site.attribute.name
	const html = site.element.namespace === 'html'
	const svg = site.element.namespace === 'svg'

	// `style` is a CSS value on every element in every namespace.
	if (name === 'style') {
		return { kind: 'css' }
	}

	if (html && tag === 'base' && name === 'href') {
		return { kind: 'url', role: 'base' }
	}
	if ((html && tag === 'script' && (name === 'src' || name === 'href')) || (svg && tag === 'script' && (name === 'href' || name === 'xlink:href'))) {
		return { kind: 'url', role: 'script' }
	}
	if (html && ((tag === 'object' && name === 'data') || (tag === 'embed' && name === 'src') || (tag === 'applet' && (name === 'code' || name === 'archive')))) {
		return { kind: 'url', role: 'plugin' }
	}
	if (html && tag === 'link') {
		if (name === 'imagesrcset') {
			return { kind: 'srcset', role: 'preload' }
		}
		if (name !== 'href') {
			return NONE
		}
		const rels = new Set(linkRelTokens(site.element))
		if (rels.has('stylesheet')) {
			return { kind: 'url', role: 'stylesheet' }
		}
		for (const rel of rels) {
			if (FETCHED_LINK_RELS.has(rel)) {
				return { kind: 'url', role: 'resource' }
			}
		}
		return { kind: 'url', role: 'network-hint' }
	}
	if (html && FRAME_TAGS.has(tag)) {
		if (name === 'src') {
			return { kind: 'url', role: 'frame' }
		}
		if (name === 'srcdoc') {
			return { kind: 'html' }
		}
		return NONE
	}
	if (HYPERLINK_TAGS.has(tag) && (name === 'href' || (svg && name === 'xlink:href'))) {
		return { kind: 'url', role: 'hyperlink' }
	}
	if (html && NAVIGATION_ATTRIBUTES.get(tag)?.has(name) === true) {
		return { kind: 'url', role: 'navigation' }
	}
	if (html && SRCSET_ATTRIBUTES.get(tag)?.has(name) === true) {
		return { kind: 'srcset', role: 'image' }
	}
	if (html && RESOURCE_ATTRIBUTES.get(tag)?.has(name) === true) {
		return { kind: 'url', role: 'resource' }
	}
	if (svg && tag === SVG_USE_TAG && (name === 'href' || name === 'xlink:href')) {
		return { kind: 'url', role: 'svg-use' }
	}
	if (svg && SVG_RESOURCE_TAGS.has(tag) && (name === 'href' || name === 'xlink:href')) {
		return { kind: 'url', role: 'resource' }
	}
	if (svg && SVG_URL_PRESENTATION_ATTRIBUTES.has(name)) {
		// A presentation attribute is a CSS declaration value, not a bare URL:
		// `fill="url(x.png) red"` has a URL *and* a fallback paint.
		return { kind: 'css' }
	}

	return NONE
}
const SHADOW_ROOT_MODES = new Set(['open', 'closed'])

interface Parse5Attribute {
	readonly name: string
	readonly value: string
	readonly prefix?: string | undefined
}

interface Parse5Location {
	readonly startOffset: number
	readonly endOffset: number
}

interface Parse5Element {
	readonly tagName: string
	readonly namespaceURI?: string
	readonly attrs: readonly Parse5Attribute[]
	readonly sourceCodeLocation?: { readonly attrs?: Record<string, Parse5Location> } | null
	readonly content?: { readonly childNodes: readonly unknown[] }
	readonly childNodes?: readonly unknown[]
}

interface Parse5Text {
	readonly nodeName: '#text'
	readonly value: string
	readonly sourceCodeLocation?: Parse5Location | null
}

function isElementNode(node: unknown): node is Parse5Element {
	return typeof node === 'object' && node !== null && 'tagName' in node && Array.isArray((node as { attrs?: unknown }).attrs)
}

function isTextNode(node: unknown): node is Parse5Text {
	return typeof node === 'object' && node !== null && (node as { nodeName?: unknown }).nodeName === '#text'
}

function hasChildNodes(node: unknown): node is { readonly childNodes: readonly unknown[] } {
	return typeof node === 'object' && node !== null && Array.isArray((node as { childNodes?: unknown }).childNodes)
}

/** The key `sourceCodeLocation.attrs` files an attribute under: the lowercased qualified name, which for a namespaced SVG attribute keeps its prefix (`xlink:href`) even though `attrs[].name` has dropped it. */
function sourceKeyOf(attribute: Parse5Attribute): string {
	const qualified = attribute.prefix === undefined || attribute.prefix.length === 0 ? attribute.name : `${attribute.prefix}:${attribute.name}`
	return qualified.toLowerCase()
}

function namespaceOf(node: Parse5Element): HtmlNamespace {
	switch (node.namespaceURI) {
		case 'http://www.w3.org/1999/xhtml':
		case undefined:
			return 'html'
		case 'http://www.w3.org/2000/svg':
			return 'svg'
		default:
			return 'other'
	}
}

/**
 * The declarative-shadow-root mode a `<template>` declares, if any —
 * either the standard `shadowrootmode` or the legacy `shadowmode` real
 * Blink capture writes. Returns undefined for an ordinary inert template
 * and for a mode value that is neither `open` nor `closed` (an
 * enumerated-attribute mismatch, which no browser hydrates either).
 */
function declarativeShadowRootMode(node: Parse5Element): { readonly attribute: string; readonly mode: string } | undefined {
	if (node.tagName !== 'template') {
		return undefined
	}
	for (const attributeName of ['shadowrootmode', 'shadowmode']) {
		const value = node.attrs.find((attribute) => sourceKeyOf(attribute) === attributeName)?.value.toLowerCase()
		if (value !== undefined && SHADOW_ROOT_MODES.has(value)) {
			return { attribute: attributeName, mode: value }
		}
	}
	return undefined
}

function elementContext(node: Parse5Element): HtmlElementContext {
	return {
		tagName: node.tagName.toLowerCase(),
		namespace: namespaceOf(node),
		attribute: (name) => node.attrs.find((attribute) => sourceKeyOf(attribute) === name)?.value,
	}
}

interface Edit extends Parse5Location {
	readonly markup: string
}

/**
 * Rewrites `html` by asking `visit` about every attribute of every element
 * in the live document tree, plus the text content of every `<style>`
 * element, and splicing in whatever it returns. Returning `undefined`
 * leaves that site exactly as written.
 *
 * A site whose source location `parse5` did not record cannot be spliced;
 * `onUnlocatable` is called for it instead, so a caller that depends on a
 * site being rewritten can report the gap rather than silently shipping
 * the original.
 */
export function rewriteHtmlSites(html: string, visit: (site: HtmlSite) => HtmlEdit | undefined, onUnlocatable?: (site: HtmlSite) => void): string {
	const document = parse(html, { sourceCodeLocationInfo: true, scriptingEnabled: false })
	const edits: Edit[] = []

	function visitElement(node: Parse5Element): void {
		const element = elementContext(node)
		const locations = node.sourceCodeLocation?.attrs
		for (const attribute of node.attrs) {
			const name = sourceKeyOf(attribute)
			const site: HtmlSite = { kind: 'attribute', element, attribute: { name, value: attribute.value } }
			const edit = visit(site)
			if (edit === undefined) {
				continue
			}
			const location = locations?.[name]
			if (location === undefined) {
				onUnlocatable?.(site)
				continue
			}
			edits.push({ ...location, markup: edit.markup })
		}
		if (element.tagName !== 'style') {
			return
		}
		for (const child of node.childNodes ?? []) {
			if (!isTextNode(child)) {
				continue
			}
			const site: HtmlSite = { kind: 'style-text', element, text: child.value }
			const edit = visit(site)
			if (edit === undefined) {
				continue
			}
			if (child.sourceCodeLocation === undefined || child.sourceCodeLocation === null) {
				onUnlocatable?.(site)
				continue
			}
			edits.push({ startOffset: child.sourceCodeLocation.startOffset, endOffset: child.sourceCodeLocation.endOffset, markup: edit.markup })
		}
	}

	function walk(node: unknown): void {
		if (isElementNode(node)) {
			visitElement(node)
			const shadow = declarativeShadowRootMode(node)
			if (shadow !== undefined && node.content !== undefined) {
				for (const child of node.content.childNodes) {
					walk(child)
				}
				return
			}
		}
		if (hasChildNodes(node)) {
			for (const child of node.childNodes) {
				walk(child)
			}
		}
	}

	walk(document)

	if (edits.length === 0) {
		return html
	}
	edits.sort((left, right) => left.startOffset - right.startOffset)
	let out = ''
	let copiedTo = 0
	for (const edit of edits) {
		if (edit.startOffset < copiedTo) {
			// Attribute and text spans within one document never overlap, so this
			// is unreachable for a tree parse5 produced; skipping rather than
			// splicing keeps a future caller's mistake from corrupting the output.
			continue
		}
		out += html.slice(copiedTo, edit.startOffset)
		out += edit.markup
		copiedTo = edit.endOffset
	}
	out += html.slice(copiedTo)
	return out
}
