import assert from 'node:assert/strict'
import test from 'node:test'
import { findFrameSrcLocations, resolveDocumentBaseUrl, rewriteFrameSrcAttributes } from './html-rewrite.ts'

test('findFrameSrcLocations finds a quoted src attribute', () => {
	const html = '<html><body><iframe src="http://example.com/a"></iframe></body></html>'
	const locations = findFrameSrcLocations(html)
	assert.equal(locations.length, 1)
	assert.equal(locations[0]?.value, 'http://example.com/a')
})

test('findFrameSrcLocations handles unquoted and single-quoted values', () => {
	assert.equal(findFrameSrcLocations('<iframe src=http://example.com/a width=10></iframe>')[0]?.value, 'http://example.com/a')
	assert.equal(findFrameSrcLocations("<iframe src='http://example.com/a'></iframe>")[0]?.value, 'http://example.com/a')
})

test('findFrameSrcLocations is case-insensitive on tag and attribute names', () => {
	const locations = findFrameSrcLocations('<IFRAME SRC="http://example.com/a"></IFRAME>')
	assert.equal(locations.length, 1)
	assert.equal(locations[0]?.value, 'http://example.com/a')
})

test('findFrameSrcLocations honors only the first of a duplicate src attribute, matching real browser/parser behavior', () => {
	const locations = findFrameSrcLocations('<iframe src="http://real.example/" src="http://evil.example/"></iframe>')
	assert.equal(locations.length, 1)
	assert.equal(locations[0]?.value, 'http://real.example/')
})

test('findFrameSrcLocations does not match a fake iframe tag inside an HTML comment', () => {
	assert.deepEqual(findFrameSrcLocations('<!-- <iframe src="http://should-not-match/"></iframe> --><p>ok</p>'), [])
})

test('findFrameSrcLocations does not match fake iframe text inside a <script> raw text element, and still finds a real iframe after it', () => {
	const html = '<script>var x = "<iframe src=\\"http://should-not-match/\\"></iframe>";</script><iframe src="http://real/"></iframe>'
	const locations = findFrameSrcLocations(html)
	assert.equal(locations.length, 1)
	assert.equal(locations[0]?.value, 'http://real/')
})

test('findFrameSrcLocations captures a > character inside a quoted attribute value in full', () => {
	const locations = findFrameSrcLocations('<iframe src="http://example.com/a?x=1>2"></iframe>')
	assert.equal(locations.length, 1)
	assert.equal(locations[0]?.value, 'http://example.com/a?x=1>2')
})

test('findFrameSrcLocations degrades safely (no match, no throw) on an unterminated attribute quote', () => {
	assert.doesNotThrow(() => findFrameSrcLocations('<iframe src="http://example.com/a></iframe><p>after</p>'))
	assert.deepEqual(findFrameSrcLocations('<iframe src="http://example.com/a></iframe><p>after</p>'), [])
})

test('findFrameSrcLocations also finds legacy <frame src> (frameset pages), in document order', () => {
	const html = '<html><frameset cols="50%,50%"><frame src="left.html" name="left"><frame src="right.html" name="right"></frameset></html>'
	const locations = findFrameSrcLocations(html)
	assert.deepEqual(
		locations.map((l) => l.value),
		['left.html', 'right.html'],
	)
})

test('findFrameSrcLocations is case-insensitive on <frame>/<FRAME> too', () => {
	const locations = findFrameSrcLocations('<frameset><FRAME SRC="a.html"></frameset>')
	assert.deepEqual(
		locations.map((l) => l.value),
		['a.html'],
	)
})

test('findFrameSrcLocations finds every <frame> in a nested frameset (main frameset containing a sub-frameset), in document order', () => {
	const html = '<frameset><frameset><frame src="a.html"><frame src="b.html"></frameset><frame src="c.html"></frameset>'
	const locations = findFrameSrcLocations(html)
	assert.deepEqual(
		locations.map((l) => l.value),
		['a.html', 'b.html', 'c.html'],
	)
})

test('findFrameSrcLocations does not treat <object>/<embed> as frame-navigation sources (out of scope)', () => {
	assert.deepEqual(findFrameSrcLocations('<object data="a.html"></object><embed src="b.html">'), [])
})

test('findFrameSrcLocations finds an <iframe> inside a declarative Shadow DOM template (real Chrome capture shape), but not inside an ordinary inert <template>', () => {
	// Mirrors real Chrome MHTML capture of an attached shadow root (docs/architecture.md,
	// "Format vs. capture semantics": "Attached shadow roots *are* captured, via declarative
	// Shadow DOM") — a hand-authored minimal reduction, since a live browser capture isn't
	// available in this environment; the shape (`<template shadowrootmode>` holding real markup)
	// matches the HTML Standard's declarative Shadow DOM serialization.
	const shadowHtml = '<div id="host"><template shadowrootmode="open"><iframe src="shadow-child.html"></iframe></template></div>'
	assert.deepEqual(
		findFrameSrcLocations(shadowHtml).map((l) => l.value),
		['shadow-child.html'],
	)

	const inertHtml = '<template><iframe src="inert-child.html"></iframe></template>'
	assert.deepEqual(findFrameSrcLocations(inertHtml), [])
})

test('findFrameSrcLocations treats shadowrootmode="closed" the same as "open", case-insensitively', () => {
	assert.deepEqual(
		findFrameSrcLocations('<template shadowrootmode="CLOSED"><iframe src="c.html"></iframe></template>').map((l) => l.value),
		['c.html'],
	)
})

test('rewriteFrameSrcAttributes replaces only the located span, leaving the rest of the document byte-identical', () => {
	const html = '<!DOCTYPE html><html><body><h1>root</h1><iframe src="cid:old@archivebridge" width="400"></iframe></body></html>'
	const rewritten = rewriteFrameSrcAttributes(html, () => 'cid:new@archivebridge')

	assert.equal(rewritten, '<!DOCTYPE html><html><body><h1>root</h1><iframe src="cid:new@archivebridge" width="400"></iframe></body></html>')
})

test('rewriteFrameSrcAttributes leaves an occurrence untouched when rewrite returns undefined', () => {
	const html = '<iframe src="http://example.com/a"></iframe>'
	assert.equal(
		rewriteFrameSrcAttributes(html, () => undefined),
		html,
	)
})

test('rewriteFrameSrcAttributes rewrites multiple iframes independently, in document order', () => {
	const html = '<iframe src="a"></iframe><iframe src="b"></iframe>'
	const seen: string[] = []
	const rewritten = rewriteFrameSrcAttributes(html, (value) => {
		seen.push(value)
		return `rewritten-${value}`
	})
	assert.deepEqual(seen, ['a', 'b'])
	assert.equal(rewritten, '<iframe src="rewritten-a"></iframe><iframe src="rewritten-b"></iframe>')
})

test('rewriteFrameSrcAttributes rewrites legacy <frame src> the same way as <iframe src>', () => {
	const html = '<frameset><frame src="left.html"><frame src="right.html"></frameset>'
	const rewritten = rewriteFrameSrcAttributes(html, (value) => `rewritten-${value}`)
	assert.equal(rewritten, '<frameset><frame src="rewritten-left.html"><frame src="rewritten-right.html"></frameset>')
})

test('rewriteFrameSrcAttributes HTML-escapes an untrusted replacement value to prevent attribute injection', () => {
	const html = '<iframe src="old"></iframe>'
	const rewritten = rewriteFrameSrcAttributes(html, () => '"><script>alert(1)</script>')
	assert.equal(rewritten, '<iframe src="&quot;><script>alert(1)</script>"></iframe>')
	// Re-parsing confirms the injected markup did not escape the attribute: still one iframe, no script element as a sibling.
	const reparsed = findFrameSrcLocations(rewritten)
	assert.equal(reparsed.length, 1)
	assert.equal(reparsed[0]?.value, '"><script>alert(1)</script>')
})

test('resolveDocumentBaseUrl returns the document URL when there is no <base>', () => {
	assert.equal(resolveDocumentBaseUrl('<html><body>no base here</body></html>', 'https://example.invalid/dir/page.html'), 'https://example.invalid/dir/page.html')
})

test('resolveDocumentBaseUrl resolves a relative iframe src against a real <base href>, not the document URL', () => {
	const html = '<html><head><base href="https://other.invalid/elsewhere/"></head><body></body></html>'
	assert.equal(resolveDocumentBaseUrl(html, 'https://example.invalid/dir/page.html'), 'https://other.invalid/elsewhere/')
})

test('resolveDocumentBaseUrl resolves a relative <base href> against the document URL', () => {
	const html = '<html><head><base href="other/"></head></html>'
	assert.equal(resolveDocumentBaseUrl(html, 'https://example.invalid/dir/page.html'), 'https://example.invalid/dir/other/')
})

test('resolveDocumentBaseUrl only honors the first <base> with an href, per the HTML Standard', () => {
	const html = '<base href="https://first.invalid/"><base href="https://second.invalid/">'
	assert.equal(resolveDocumentBaseUrl(html, 'https://example.invalid/'), 'https://first.invalid/')
})

test('resolveDocumentBaseUrl falls back to the document URL when the first <base href> is invalid, without trying a later <base>', () => {
	const html = '<base href="http://[invalid"><base href="https://second.invalid/">'
	assert.equal(resolveDocumentBaseUrl(html, 'https://example.invalid/'), 'https://example.invalid/')
})

test('resolveDocumentBaseUrl ignores a fake <base> inside a comment or <script>, and one inside an inert <template>', () => {
	const html =
		'<!-- <base href="https://should-not-match.invalid/"> --><script>var x = "<base href=\\"https://should-not-match.invalid/\\">"</script><template><base href="https://template-should-not-match.invalid/"></template>'
	assert.equal(resolveDocumentBaseUrl(html, 'https://example.invalid/'), 'https://example.invalid/')
})
