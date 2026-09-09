/**
 * Locates every frame-navigation `src` attribute in an HTML document
 * (`<iframe src>`, and the legacy frameset `<frame src>` — MHTML is not
 * only produced from modern pages) and rewrites its value, without
 * touching a single other byte of the document. Also resolves the
 * document's effective base URL (`<base href>`, per the HTML Standard),
 * needed by callers to resolve a relative frame `src` correctly.
 *
 * Approach: use `parse5` (the WHATWG-spec-conformant HTML parser also used
 * by jsdom and Deno) with `sourceCodeLocationInfo: true` purely to find the
 * exact source-string offsets of each frame element's `src` attribute —
 * then splice just that span. The parsed DOM tree itself is discarded;
 * this never re-serializes the document, so nothing about attribute
 * quoting style, entity encoding, whitespace, or element formatting
 * anywhere else in the document can change. See docs/architecture.md,
 * "Frame representation" for the reasoning behind choosing `parse5` here:
 *
 * - **Correctness / spec conformance**: parse5 implements the real HTML5
 *   tokenizer/tree-construction algorithm, so tag/attribute boundaries are
 *   found exactly as a real browser would find them — not an
 *   approximation of HTML parsing syntax.
 * - **Safety against adversarial input**: verified against real captured
 *   HTML (docs/architecture.md's frame fixtures) plus hand-written
 *   adversarial cases — an unquoted value, a single-quoted value, a
 *   duplicate `src` attribute (per spec, only the first is honored — the
 *   same one a real browser would use, so an attacker can't smuggle a
 *   second `src` past this), tag/attribute case variation, a fake frame
 *   tag inside an HTML comment or a `<script>` raw-text element
 *   (correctly not matched — RAWTEXT/comment tokenizer states are handled
 *   for real), a `>` inside a quoted attribute value, and a malformed/
 *   unterminated quote (parser degrades per spec rather than throwing or
 *   hanging, and simply yields no match — a fail-safe outcome, not an
 *   incorrect rewrite).
 * - **Round-trip behavior**: since only the located attribute span is
 *   spliced, every other byte of the document — including any encoding
 *   quirks — passes through unchanged in this module. (Whether the
 *   *caller* can re-encode a changed value back into the document's
 *   original declared charset is a separate concern this module has no
 *   opinion on — see `mhtml/text-codec.ts`.)
 * - **Dependency cost**: one small, single-dependency (`entities`),
 *   widely-used package — justified the same way `plist` is justified in
 *   CONTRIBUTING.md's dependency policy: untrusted HTML input, being
 *   thorough about tokenizer edge cases, is exactly the case where a
 *   battle-tested implementation beats a hand-rolled one.
 *
 * **Declarative Shadow DOM.** A `<template shadowrootmode="open">` (or
 * `"closed"`) represents a real, navigable part of the document tree once
 * attached — real Chrome MHTML capture includes shadow tree content this
 * way (docs/architecture.md, "Format vs. capture semantics": "Attached
 * shadow roots *are* captured, via declarative Shadow DOM"). parse5 parses
 * a `<template>` element's content into a separate `content` DocumentFragment
 * regardless of `shadowrootmode`, not into the template's own `childNodes` —
 * so a frame inside *any* template is invisible to a walk that only follows
 * `childNodes`. This module deliberately only descends into a template's
 * `content` when that template declares `shadowrootmode`: an *ordinary*
 * inert `<template>` (no `shadowrootmode`) is inactive markup a page's own
 * script would clone and use later, not part of the live, navigable
 * document — rewriting a frame reference inside it would be acting on
 * content that isn't actually a frame yet.
 *
 * **Each function parses independently, on purpose.** A conversion can
 * parse the same HTML up to three times: once for
 * {@link findFrameSrcLocations} as a "does this document have frames at
 * all" predicate, once for {@link resolveDocumentBaseUrl}, and once inside
 * {@link rewriteFrameSrcAttributes}, which re-derives the locations itself.
 * Collapsing those into a single parse producing a reusable
 * `{ frameSrcLocations, effectiveBaseUrl }` analysis was considered and
 * rejected:
 *
 * - It would require a rewrite entry point that accepts caller-supplied
 *   offsets, which moves the "these offsets must belong to exactly this
 *   string" invariant from something structurally impossible to violate
 *   (each function parses the string it is handed) into a caller
 *   obligation. Splicing with offsets computed from a *different* string
 *   silently corrupts the document, which is the one failure mode this
 *   module exists to prevent.
 * - The two parses genuinely differ: location tracking is only requested
 *   where offsets are needed, so a merged parse would always pay for
 *   `sourceCodeLocationInfo` even when only `<base href>` is wanted.
 * - The cost is not material at saved-page sizes. Converting the real
 *   multi-frame fixture end to end takes well under a millisecond; even a
 *   1 MB single HTML document — far above a typical capture — spends on the
 *   order of 100 ms across all three parses, in a one-shot CLI or extension
 *   operation. Resource base64 decoding dominates real archives.
 *
 * If a profile ever shows HTML parsing dominating a real workload, the fix
 * is the analysis-result refactor above, and it should come with a test
 * that offsets and spliced string cannot drift apart.
 */

import { parse } from 'parse5'

interface FrameSrcLocation {
	readonly value: string
	readonly startOffset: number
	readonly endOffset: number
}

const FRAME_TAG_NAMES = new Set(['iframe', 'frame'])

interface Parse5Element {
	tagName: string
	attrs: { name: string; value: string }[]
	sourceCodeLocation?: { attrs?: Record<string, { startOffset: number; endOffset: number }> } | null
	content?: { childNodes: readonly unknown[] }
}

function isElementNode(node: unknown): node is Parse5Element {
	return typeof node === 'object' && node !== null && 'tagName' in node
}

/** True for any node with children to recurse into: the root Document/DocumentFragment as well as every Element — not just elements, which is why this is checked separately from {@link isElementNode}. */
function hasChildNodes(node: unknown): node is { childNodes: readonly unknown[] } {
	return typeof node === 'object' && node !== null && Array.isArray((node as { childNodes?: unknown }).childNodes)
}

/** True for a `<template shadowrootmode="open"|"closed">` element — see the module doc comment's "Declarative Shadow DOM" section. Case-insensitive on the attribute value per the HTML Standard's enumerated-attribute matching. */
function isDeclarativeShadowRootTemplate(node: unknown): node is Parse5Element & { content: { childNodes: readonly unknown[] } } {
	if (!isElementNode(node) || node.tagName !== 'template') {
		return false
	}
	const mode = node.attrs.find((attr) => attr.name === 'shadowrootmode')?.value.toLowerCase()
	return (mode === 'open' || mode === 'closed') && node.content !== undefined && Array.isArray(node.content.childNodes)
}

/** Walks `document` in tree order, following ordinary `childNodes` plus (only) the `content` of a declarative-shadow-root `<template>` — never an ordinary inert template's content. */
function walkDocument(document: unknown, visit: (node: Parse5Element) => void): void {
	function walk(node: unknown): void {
		if (isElementNode(node)) {
			visit(node)
		}
		if (hasChildNodes(node)) {
			for (const child of node.childNodes) {
				walk(child)
			}
		}
		if (isDeclarativeShadowRootTemplate(node)) {
			for (const child of node.content.childNodes) {
				walk(child)
			}
		}
	}
	walk(document)
}

/** Finds every frame element's (`<iframe>`/`<frame>`) `src` attribute location in `html`, in document order (including inside declarative Shadow DOM, excluding ordinary inert `<template>` content). */
export function findFrameSrcLocations(html: string): readonly FrameSrcLocation[] {
	const document = parse(html, { sourceCodeLocationInfo: true })
	const results: FrameSrcLocation[] = []

	walkDocument(document, (node) => {
		if (!FRAME_TAG_NAMES.has(node.tagName)) {
			return
		}
		const srcAttr = node.attrs.find((attr) => attr.name === 'src')
		const srcLocation = node.sourceCodeLocation?.attrs?.src
		if (srcAttr !== undefined && srcLocation !== undefined) {
			results.push({ value: srcAttr.value, startOffset: srcLocation.startOffset, endOffset: srcLocation.endOffset })
		}
	})

	return results
}

/**
 * Resolves `html`'s effective base URL against `documentUrl`, per the HTML
 * Standard's "frozen base URL" algorithm: the first `<base>` element in
 * tree order with an `href` attribute (present, not necessarily valid)
 * determines the document's base URL; if that `href` fails to resolve
 * against `documentUrl`, the base URL falls back to `documentUrl` itself
 * (later `<base>` elements, if any, are not consulted — only the first one
 * with an `href` attribute counts, per spec). No `<base>` with an `href`
 * anywhere means the base URL is just `documentUrl`. A `<base>` inside an
 * inert `<template>` or a declarative shadow tree does not count: neither
 * is part of this document's own light-DOM tree for this purpose, mirroring
 * why {@link findFrameSrcLocations} treats ordinary template content as
 * inactive — but unlike frame lookup, shadow tree content is excluded too,
 * since a shadow tree's own `<base>` (if any) would affect only that
 * shadow tree, never the outer document.
 */
export function resolveDocumentBaseUrl(html: string, documentUrl: string): string {
	const document = parse(html, { sourceCodeLocationInfo: false })
	let hrefValue: string | undefined

	function walk(node: unknown): void {
		if (hrefValue !== undefined) {
			return
		}
		if (isElementNode(node) && node.tagName === 'base') {
			const hrefAttr = node.attrs.find((attr) => attr.name === 'href')
			if (hrefAttr !== undefined) {
				hrefValue = hrefAttr.value
				return
			}
		}
		if (hasChildNodes(node)) {
			for (const child of node.childNodes) {
				walk(child)
				if (hrefValue !== undefined) {
					return
				}
			}
		}
	}
	walk(document)

	if (hrefValue === undefined) {
		return documentUrl
	}
	try {
		return new URL(hrefValue, documentUrl).href
	} catch {
		return documentUrl
	}
}

/**
 * The replacement value is written into a fresh `src="..."` double-quoted
 * attribute regardless of the original attribute's quoting style — so it
 * must be escaped for that context. `rewrite`'s input can originate from
 * untrusted archive data (a WebArchive plist's `WebResourceURL`, or a
 * foreign MHTML's `cid:` text), which has no restriction against
 * containing `"` or `&`; writing it in unescaped would let untrusted data
 * break out of the attribute and inject arbitrary markup into the
 * rewritten HTML.
 */
function escapeHtmlAttributeValue(value: string): string {
	return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;')
}

/**
 * Rewrites every frame element's (`<iframe>`/`<frame>`) `src` attribute in
 * `html` using `rewrite` (called with each attribute's current value;
 * returning `undefined` leaves that occurrence untouched). Every other
 * byte of `html` is preserved exactly.
 */
export function rewriteFrameSrcAttributes(html: string, rewrite: (currentValue: string) => string | undefined): string {
	const locations = findFrameSrcLocations(html)
	if (locations.length === 0) {
		return html
	}

	let result = ''
	let cursor = 0
	for (const location of locations) {
		const newValue = rewrite(location.value)
		result += html.slice(cursor, location.startOffset)
		result += newValue === undefined ? html.slice(location.startOffset, location.endOffset) : `src="${escapeHtmlAttributeValue(newValue)}"`
		cursor = location.endOffset
	}
	result += html.slice(cursor)

	return result
}
