/**
 * Walks a reconstructed-for-viewing HTML document and lets a caller
 * replace any attribute — or the text of any `<style>` element — by exact
 * source offset, preserving every other byte.
 *
 * This is the same technique, and the same reasoning, as
 * `mhtml/html-rewrite.ts`: `parse5` is used only to find where things are
 * in the source string (`sourceCodeLocationInfo`), never to re-serialize
 * the document. The parsed tree is discarded as soon as the offsets have
 * been collected, so attribute quoting, entity spelling, whitespace and
 * every untouched element survive exactly. What is different here is
 * *scope*: conversion needs one attribute (a frame `src`), while the
 * viewer has to reach every reference a browser would load, so this module
 * offers the whole attribute surface and leaves the policy — which
 * attributes matter, and what they become — entirely to its caller
 * (`view/render.ts`).
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
