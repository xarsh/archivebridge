import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { MAX_FRAME_DEPTH } from '../limits.ts'
import type { Diagnostic } from '../model/archive.ts'
import type { MhtmlDocument, MhtmlPart } from '../model/mhtml.ts'
import { buildFrameTree, decodeCidUri, encodeCidUri, findFrameRootReferences } from './frames.ts'
import { parseMhtml } from './parse.ts'

function loadFixture(name: string): Uint8Array {
	const path = fileURLToPath(new URL(`../../../../fixtures/mhtml/${name}`, import.meta.url))
	return readFileSync(path)
}

function htmlPart(contentId: string, html: string, overrides: Partial<MhtmlPart> = {}): MhtmlPart {
	return { contentId, location: `https://example.invalid/${contentId}.html`, mimeType: 'text/html', textEncoding: 'utf-8', data: new TextEncoder().encode(html), ...overrides }
}

test('decodeCidUri / encodeCidUri round-trip and reject non-cid: values', () => {
	assert.equal(decodeCidUri('cid:frame-1@archivebridge'), 'frame-1@archivebridge')
	assert.equal(decodeCidUri('https://example.invalid/'), undefined)
	assert.equal(encodeCidUri('frame-1@archivebridge'), 'cid:frame-1%40archivebridge')
	assert.equal(decodeCidUri(encodeCidUri('frame-1@archivebridge')), 'frame-1@archivebridge')
})

test('findFrameRootReferences decodes a legacy charset (ucs2, an iconv-lite-only alias TextDecoder does not recognize) the same way converters do, correctly finding a cid:-linked iframe', () => {
	// 'ucs2' is real iconv-lite-supported UTF-16LE alias that TextDecoder throws on
	// (see text-codec.test.ts). Before decodePartText delegated to textCodecFor, this function
	// used a raw `new TextDecoder(part.textEncoding)` that would throw on 'ucs2' and silently fall
	// back to decoding these UTF-16LE bytes *as UTF-8* instead — which does not just mangle
	// non-ASCII text, it corrupts the markup structure itself: every originally-ASCII byte in a
	// UTF-16LE stream is followed by a 0x00 byte, and UTF-8 decodes each of those as its own
	// separate NUL character, so "<iframe" would decode as "<\x00i\x00f\x00r\x00a\x00m\x00e\x00"
	// — not a recognizable tag at all, so the iframe reference would silently vanish rather than
	// being found. Sharing textCodecFor's decoding (which does still resolve 'ucs2' via
	// iconv-lite, unlike TextDecoder) fixes that.
	const html = '<iframe src="cid:child@archivebridge"></iframe>'
	const utf16leBytes = new Uint8Array(html.length * 2)
	for (let i = 0; i < html.length; i += 1) {
		utf16leBytes[i * 2] = html.charCodeAt(i)
		utf16leBytes[i * 2 + 1] = 0
	}
	const document: MhtmlDocument = {
		parts: [htmlPart('root@archivebridge', '', { textEncoding: 'ucs2', data: utf16leBytes }), htmlPart('child@archivebridge', '<p>child</p>')],
		rootPartIndex: 0,
	}
	const diagnostics: Diagnostic[] = []
	const adjacency = findFrameRootReferences(document, diagnostics)

	assert.deepEqual(diagnostics, [])
	assert.deepEqual(adjacency.get(0), [1])
})

test('findFrameRootReferences finds a cid:-linked iframe in fixtures/mhtml/frames-nested.chrome.mhtml', () => {
	const { document } = parseMhtml(loadFixture('frames-nested.chrome.mhtml'))
	assert.ok(document)

	const diagnostics: Diagnostic[] = []
	const adjacency = findFrameRootReferences(document, diagnostics)
	assert.deepEqual(diagnostics, [])
	const rootChildren = adjacency.get(document.rootPartIndex)
	assert.equal(rootChildren?.length, 1)

	const midIndex = rootChildren?.[0]
	assert.equal(document.parts[midIndex ?? -1]?.location, 'http://127.0.0.1:8091/iframe-nested/mid.html')

	const midChildren = adjacency.get(midIndex ?? -1)
	assert.equal(midChildren?.length, 1)
	assert.equal(document.parts[midChildren?.[0] ?? -1]?.location, 'http://127.0.0.1:8091/iframe-nested/leaf.html')
})

test('buildFrameTree builds the same 2-level shape from fixtures/mhtml/frames-nested.chrome.mhtml', () => {
	const { document } = parseMhtml(loadFixture('frames-nested.chrome.mhtml'))
	assert.ok(document)

	const adjacency = findFrameRootReferences(document, [])
	const diagnostics: Diagnostic[] = []
	const tree = buildFrameTree(document.rootPartIndex, adjacency, diagnostics)

	assert.deepEqual(diagnostics, [])
	assert.equal(tree.partIndex, document.rootPartIndex)
	assert.equal(tree.children.length, 1)
	assert.equal(tree.children[0]?.children.length, 1)
	assert.equal(tree.children[0]?.children[0]?.children.length, 0)
})

test('findFrameRootReferences drops a self-referencing cid: (A -> A) from the adjacency map and reports it as cyclic-frame-reference', () => {
	const document: MhtmlDocument = { parts: [htmlPart('root@archivebridge', '<iframe src="cid:root@archivebridge"></iframe>')], rootPartIndex: 0 }
	const diagnostics: Diagnostic[] = []
	const adjacency = findFrameRootReferences(document, diagnostics)

	assert.deepEqual([...adjacency.entries()], [])
	assert.deepEqual(diagnostics, [{ type: 'cyclic-frame-reference', partIndex: 0 }])
})

test('buildFrameTree still bounds a self-cycle (A -> A) discovered via findFrameRootReferences: the root has no children', () => {
	const document: MhtmlDocument = { parts: [htmlPart('root@archivebridge', '<iframe src="cid:root@archivebridge"></iframe>')], rootPartIndex: 0 }
	const diagnostics: Diagnostic[] = []
	const adjacency = findFrameRootReferences(document, diagnostics)
	const tree = buildFrameTree(document.rootPartIndex, adjacency, diagnostics)

	assert.deepEqual(diagnostics, [{ type: 'cyclic-frame-reference', partIndex: 0 }])
	assert.deepEqual(tree, { partIndex: 0, children: [] })
})

test('findFrameRootReferences treats a Content-ID claimed by two parts as ambiguous: no cid: reference resolves to either, and duplicate-content-id is reported once', () => {
	const document: MhtmlDocument = {
		parts: [
			htmlPart('root@archivebridge', '<iframe src="cid:dup@archivebridge"></iframe><iframe src="cid:dup@archivebridge"></iframe>'),
			htmlPart('dup@archivebridge', '<p>first</p>'),
			htmlPart('dup@archivebridge', '<p>second</p>'),
		],
		rootPartIndex: 0,
	}
	const diagnostics: Diagnostic[] = []
	const adjacency = findFrameRootReferences(document, diagnostics)

	assert.deepEqual(adjacency.get(0), undefined)
	assert.deepEqual(diagnostics, [{ type: 'duplicate-content-id', contentId: 'dup@archivebridge' }])
})

test('buildFrameTree drops a 2-node cid: cycle (A -> B -> A) as a cyclic-frame-reference, without duplicating A as a child of B', () => {
	const document: MhtmlDocument = {
		parts: [htmlPart('a@archivebridge', '<iframe src="cid:b@archivebridge"></iframe>'), htmlPart('b@archivebridge', '<iframe src="cid:a@archivebridge"></iframe>')],
		rootPartIndex: 0,
	}
	const adjacency = findFrameRootReferences(document, [])
	const diagnostics: Diagnostic[] = []
	const tree = buildFrameTree(document.rootPartIndex, adjacency, diagnostics)

	assert.deepEqual(diagnostics, [{ type: 'cyclic-frame-reference', partIndex: 0 }])
	// a -> b, and b's own children are empty: the cyclic edge back to a is dropped entirely,
	// not kept as a hollow duplicate "a" node under b.
	assert.equal(tree.children.length, 1)
	assert.equal(tree.children[0]?.partIndex, 1)
	assert.equal(tree.children[0]?.children.length, 0)
})

test('buildFrameTree drops a direct self-cycle (A -> A) the same way, via a hand-constructed adjacency map', () => {
	// findFrameRootReferences already filters a literal self-reference out of the adjacency map
	// it produces (see the test above), so this exercises buildFrameTree's own cycle safety
	// directly against an adjacency map that still contains one.
	const adjacency = new Map<number, readonly number[]>([[0, [0]]])
	const diagnostics: Diagnostic[] = []
	const tree = buildFrameTree(0, adjacency, diagnostics)

	assert.deepEqual(diagnostics, [{ type: 'cyclic-frame-reference', partIndex: 0 }])
	assert.deepEqual(tree, { partIndex: 0, children: [] })
})

test('buildFrameTree expands a legitimate diamond (two parents referencing the same child) without treating it as a cycle', () => {
	const document: MhtmlDocument = {
		parts: [
			htmlPart('root@archivebridge', '<iframe src="cid:left@archivebridge"></iframe><iframe src="cid:right@archivebridge"></iframe>'),
			htmlPart('left@archivebridge', '<iframe src="cid:shared@archivebridge"></iframe>'),
			htmlPart('right@archivebridge', '<iframe src="cid:shared@archivebridge"></iframe>'),
			htmlPart('shared@archivebridge', '<p>leaf</p>'),
		],
		rootPartIndex: 0,
	}
	const adjacency = findFrameRootReferences(document, [])
	const diagnostics: Diagnostic[] = []
	const tree = buildFrameTree(document.rootPartIndex, adjacency, diagnostics)

	assert.deepEqual(diagnostics, [])
	assert.equal(tree.children.length, 2)
	assert.equal(tree.children[0]?.children[0]?.partIndex, 3)
	assert.equal(tree.children[1]?.children[0]?.partIndex, 3)
})

test('buildFrameTree still bounds a long, non-cyclic chain at MAX_FRAME_DEPTH, reporting frame-depth-exceeded rather than a cyclic-frame-reference', () => {
	const chainLength = MAX_FRAME_DEPTH + 3
	const adjacency = new Map<number, readonly number[]>(Array.from({ length: chainLength - 1 }, (_, i) => [i, [i + 1]] as const))
	const diagnostics: Diagnostic[] = []
	const tree = buildFrameTree(0, adjacency, diagnostics)

	assert.equal(diagnostics.length, 1)
	assert.deepEqual(diagnostics[0], { type: 'frame-depth-exceeded', depth: MAX_FRAME_DEPTH + 1 })

	// The chain up to (and including) the depth limit is still expanded normally; only the one
	// part index that would have exceeded the bound is truncated instead of duplicated.
	let depth = 0
	let node = tree
	while (node.children.length > 0) {
		const next = node.children[0]
		if (next === undefined) {
			break
		}
		node = next
		depth += 1
	}
	assert.equal(depth, MAX_FRAME_DEPTH + 1)
	assert.equal(node.partIndex, MAX_FRAME_DEPTH + 1)
})
