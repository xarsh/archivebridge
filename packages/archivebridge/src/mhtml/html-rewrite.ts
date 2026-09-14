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
 * **Two ways to say which occurrence to rewrite, for two kinds of caller.**
 * A *converter* knows frames by URL — a `.webarchive` gives it no other
 * join key — and uses {@link rewriteFrameSrcAttributes}, whose callback
 * sees each current value. A *producer* capturing a live page knows them by
 * identity instead, and identity is what URLs cannot express: two
 * `<iframe>`s may share one `src`. {@link rewriteFrameContainerSrcAttributes}
 * is for that caller, keyed by a frame container's position in the document
 * rather than by its value. Both go through the same located-span splice,
 * so neither can reserialize anything.
 *
 * **Each function parses independently, on purpose.** A conversion can
 * parse the same HTML up to three times: once for
 * {@link findFrameSrcLocations} as a "does this document have frames at
 * all" predicate, once for {@link resolveDocumentBaseUrl}, and once inside
 * each rewrite entry point, which re-derives the locations itself.
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
import type { Diagnostic } from '../model/archive.ts'

interface FrameSrcLocation {
	readonly value: string
	readonly startOffset: number
	readonly endOffset: number
}

/**
 * One frame container in the document, whether or not it turned out to
 * have a `src` this module can rewrite.
 *
 * The containers *without* a rewritable `src` are the reason this type
 * exists rather than {@link FrameSrcLocation} alone: they still occupy a
 * position, and a positional rewrite that skipped them would silently
 * rewrite the wrong element. An `<iframe srcdoc>` sitting before an
 * `<iframe src>` is exactly that case.
 */
interface FrameContainer {
	/** The container's `src` attribute span, absent when it has no `src` attribute or the parser recorded no source location for one. */
	readonly src: FrameSrcLocation | undefined
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

/**
 * Finds every frame container (`<iframe>`/`<frame>`) in `html`, in document
 * order — including inside declarative Shadow DOM, excluding ordinary inert
 * `<template>` content, and **including containers with no rewritable
 * `src`**, which is what makes an element's index in this list a stable
 * position rather than a position among rewritable elements only.
 *
 * `<object>` and `<embed>` are not frame containers here. They can host a
 * nested browsing context in a browser, but this module's subject is
 * frame-*navigation* `src`, and widening it would change which elements
 * existing conversions rewrite.
 */
function findFrameContainers(html: string): readonly FrameContainer[] {
	const document = parse(html, { sourceCodeLocationInfo: true })
	const containers: FrameContainer[] = []

	walkDocument(document, (node) => {
		if (!FRAME_TAG_NAMES.has(node.tagName)) {
			return
		}
		const srcAttr = node.attrs.find((attr) => attr.name === 'src')
		const srcLocation = node.sourceCodeLocation?.attrs?.src
		containers.push({
			src: srcAttr !== undefined && srcLocation !== undefined ? { value: srcAttr.value, startOffset: srcLocation.startOffset, endOffset: srcLocation.endOffset } : undefined,
		})
	})

	return containers
}

/** Finds every frame element's (`<iframe>`/`<frame>`) `src` attribute location in `html`, in document order (including inside declarative Shadow DOM, excluding ordinary inert `<template>` content). */
export function findFrameSrcLocations(html: string): readonly FrameSrcLocation[] {
	return findFrameContainers(html).flatMap((container) => (container.src === undefined ? [] : [container.src]))
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

/** One located `src` span and what should replace it. */
interface FrameSrcEdit {
	readonly startOffset: number
	readonly endOffset: number
	readonly value: string
}

/**
 * Applies `edits` — non-overlapping spans, in ascending source order — by
 * splicing the original string. The single place this module turns a
 * located span into changed bytes, so both entry points below get the same
 * "nothing outside the span moves" guarantee.
 */
function spliceFrameSrcEdits(html: string, edits: readonly FrameSrcEdit[]): string {
	let result = ''
	let cursor = 0
	for (const edit of edits) {
		result += html.slice(cursor, edit.startOffset)
		result += `src="${escapeHtmlAttributeValue(edit.value)}"`
		cursor = edit.endOffset
	}
	return result + html.slice(cursor)
}

/**
 * Rewrites every frame element's (`<iframe>`/`<frame>`) `src` attribute in
 * `html` using `rewrite` (called with each attribute's current value;
 * returning `undefined` leaves that occurrence untouched). Every other
 * byte of `html` is preserved exactly.
 */
export function rewriteFrameSrcAttributes(html: string, rewrite: (currentValue: string) => string | undefined): string {
	const edits: FrameSrcEdit[] = []
	for (const location of findFrameSrcLocations(html)) {
		const newValue = rewrite(location.value)
		if (newValue !== undefined) {
			edits.push({ startOffset: location.startOffset, endOffset: location.endOffset, value: newValue })
		}
	}
	return edits.length === 0 ? html : spliceFrameSrcEdits(html, edits)
}

/** What a positional frame-container rewrite produced, and what it refused to produce. */
export interface FrameContainerRewriteResult {
	/** `html` with each located container's `src` replaced, byte-identical to the input everywhere else. */
	readonly html: string
	/** One entry per requested replacement that could not be applied. Empty when every request was. */
	readonly diagnostics: readonly Diagnostic[]
}

/**
 * Rewrites the `src` of individual frame containers **by position**,
 * leaving every other container — and every other byte — exactly as it was.
 *
 * For archive *producers*. A capture that has just archived a page's frames
 * as parts of its own has to point each container at the part holding that
 * frame's document, and the association it holds is an identity, not a URL:
 * two `<iframe>`s can share one `src`, a frame may have navigated since
 * load, and a `srcdoc` frame has no `src` at all. So the key here is a
 * position, and {@link rewriteFrameSrcAttributes}'s value-keyed callback —
 * which cannot tell two identical `src`s apart — is not usable for it.
 *
 * **What the position is.** `replacementsByDomOrdinal` is keyed by a frame
 * container's **DOM ordinal**: its zero-based index among the
 * `<iframe>`/`<frame>` elements of this document in tree order, counting
 * every one of them — including containers with no `src`, whose ordinal is
 * therefore occupied but not rewritable. The elements counted are the ones
 * this module's frame walk finds: declarative shadow trees included,
 * ordinary inert `<template>` content excluded, `<object>`/`<embed>`
 * excluded, and nothing that merely looks like a frame inside a comment or
 * a raw-text element counted at all.
 *
 * **What the position is emphatically not.** It is *not* a browsing-context
 * index — not a position in `window.frames`. Those two orders differ in
 * practice, measured: an `<object>`/`<embed>` pair placed first in a
 * document's markup occupied `window.frames` indices 5 and 6. A library
 * that parses HTML can see a DOM ordinal and cannot see a browsing context
 * at all, so it takes the one it can verify and the caller — which is the
 * only side that knows both — owns the translation. The parameter is named
 * for the ordinal it really is, so that a caller passing the wrong one is a
 * mismatch a reader can notice rather than a silently wrong archive.
 *
 * **It fails closed.** A requested ordinal that names no container, or
 * names one whose `src` has no source location of its own (it has none, or
 * the markup is malformed enough that the parser recorded none), is not
 * guessed at and not applied to a neighbour: that container keeps its
 * original bytes and a `malformed-resource` diagnostic reports the
 * replacement that went unwritten. This mirrors the converter's handling of
 * an unrewritable `cid:` site, and is the reason the result is a pair
 * rather than a string.
 */
export function rewriteFrameContainerSrcAttributes(html: string, replacementsByDomOrdinal: ReadonlyMap<number, string>): FrameContainerRewriteResult {
	if (replacementsByDomOrdinal.size === 0) {
		return { html, diagnostics: [] }
	}

	const containers = findFrameContainers(html)
	const diagnostics: Diagnostic[] = []
	const edits: FrameSrcEdit[] = []

	// By ordinal rather than in the map's own iteration order, so that both
	// the splice order and the order diagnostics are reported in follow the
	// document rather than however the caller happened to build the map.
	for (const [domOrdinal, replacement] of [...replacementsByDomOrdinal].sort(([a], [b]) => a - b)) {
		const container = Number.isInteger(domOrdinal) && domOrdinal >= 0 ? containers[domOrdinal] : undefined
		if (container === undefined) {
			diagnostics.push({
				type: 'malformed-resource',
				url: replacement,
				message: `no frame container at DOM ordinal ${domOrdinal}: the document has ${containers.length}, so nothing was rewritten to point at this reference`,
			})
			continue
		}
		if (container.src === undefined) {
			diagnostics.push({
				type: 'malformed-resource',
				url: replacement,
				message: `the frame container at DOM ordinal ${domOrdinal} has no src attribute with a source location of its own, so it was left unchanged rather than rewritten to point at this reference`,
			})
			continue
		}
		edits.push({ startOffset: container.src.startOffset, endOffset: container.src.endOffset, value: replacement })
	}

	return { html: edits.length === 0 ? html : spliceFrameSrcEdits(html, edits), diagnostics }
}
