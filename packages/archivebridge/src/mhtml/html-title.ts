/**
 * Extracts the page title — the HTML Standard's document-title notion,
 * restricted to the `<title>` element itself (no Open Graph, no
 * `twitter:*`, no `<h1>`) — from an `MhtmlDocument`'s root part, for
 * `apps/extension/src/core/file-name.ts`'s title-first file naming.
 *
 * This is deliberately a function over an already-parsed `MhtmlDocument`,
 * not a new field on it or on `MhtmlPart`: a page title is a file-naming
 * concern, not part of what an MHTML document *is* (docs/architecture.md,
 * "MHTML-native representation"), so it stays a derived, on-demand value —
 * the same shape of decision `mhtml/frames.ts` already made for frame
 * relationships.
 *
 * Reuses `parse5` (already a dependency for frame `src` rewriting, see
 * `mhtml/html-rewrite.ts`) rather than a `/<title>.../` regex: `<title>` is
 * an RCDATA element, so a regex would have to reimplement RCDATA
 * tokenization (character references decoded, `<` otherwise literal) to
 * avoid mis-extracting a title that itself contains `<` or `&`. parse5
 * already does this correctly, and the result is discarded except for the
 * one element's text content — nothing here re-serializes the document.
 */

import { parse } from 'parse5'
import type { MhtmlDocument } from '../model/mhtml.ts'
import { decodePartText } from './frames.ts'

interface Parse5Node {
	readonly tagName?: string
	readonly value?: string
	readonly childNodes?: readonly Parse5Node[]
}

/** Collapses a run of HTML whitespace (space, tab, LF, FF, CR) to a single space, and trims the ends. */
function normalizeTitleWhitespace(text: string): string {
	return text.replace(/[\t\n\f\r ]+/g, ' ').trim()
}

/** A parse5 text node has a string `value` and no `tagName`; an element has `tagName` and no `value`. */
function textContentOf(node: Parse5Node): string {
	if (typeof node.value === 'string') {
		return node.value
	}
	if (node.childNodes === undefined) {
		return ''
	}
	return node.childNodes.map(textContentOf).join('')
}

/** Finds the first `<title>` element in tree order, per the HTML Standard's document-title steps. parse5 gives a `<template>` element's children a separate `content` fragment rather than `childNodes` (see `mhtml/html-rewrite.ts`'s doc comment), so this walk never descends into inert template content — an inactive title inside a `<template>` correctly never matches. */
function findTitleElement(node: Parse5Node): Parse5Node | undefined {
	if (node.tagName === 'title') {
		return node
	}
	for (const child of node.childNodes ?? []) {
		const found = findTitleElement(child)
		if (found !== undefined) {
			return found
		}
	}
	return undefined
}

/**
 * Extracts and normalizes the first `<title>` element's text content from
 * `html` (already-decoded to a JS string). Returns `undefined` when there
 * is no `<title>`, or its text is empty/whitespace-only once normalized.
 * Never throws: parse5 tolerantly parses arbitrary/malformed HTML per
 * spec, and this is called on untrusted archive content.
 */
export function extractHtmlTitle(html: string): string | undefined {
	let document: Parse5Node
	try {
		document = parse(html) as Parse5Node
	} catch {
		return undefined
	}
	const titleElement = findTitleElement(document)
	if (titleElement === undefined) {
		return undefined
	}
	const normalized = normalizeTitleWhitespace(textContentOf(titleElement))
	return normalized.length === 0 ? undefined : normalized
}

/**
 * Extracts the page title from `document`'s root part. `undefined` when
 * the root part isn't `text/html` (media type comparison is
 * case-insensitive per MIME's own rule, matching `mhtml/frames.ts`'s
 * `isHtmlMimeType`) or carries no usable title — both cases a caller
 * treats identically: fall back to URL-derived naming.
 */
export function extractMhtmlRootTitle(document: MhtmlDocument): string | undefined {
	const rootPart = document.parts[document.rootPartIndex]
	if (rootPart === undefined || rootPart.mimeType.toLowerCase() !== 'text/html') {
		return undefined
	}
	return extractHtmlTitle(decodePartText(rootPart))
}
