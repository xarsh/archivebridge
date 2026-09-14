import assert from 'node:assert/strict'
import test from 'node:test'
import { findFrameSrcLocations, resolveDocumentBaseUrl, rewriteFrameContainerSrcAttributes, rewriteFrameSrcAttributes } from './html-rewrite.ts'

/** The positional API's argument, from pairs — the tests below are about which container a replacement lands on, so the map building should not be in the way of reading that. */
const byOrdinal = (...entries: readonly (readonly [number, string])[]): ReadonlyMap<number, string> => new Map(entries)

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

test('rewriteFrameContainerSrcAttributes tells two containers with an identical src apart, by position', () => {
	// The case the value-keyed rewrite cannot express at all: same URL, same
	// markup, different captured documents behind them.
	const html = '<iframe src="child.html"></iframe><iframe src="child.html"></iframe>'
	const result = rewriteFrameContainerSrcAttributes(html, byOrdinal([0, 'cid:first@archivebridge'], [1, 'cid:second@archivebridge']))

	assert.equal(result.html, '<iframe src="cid:first@archivebridge"></iframe><iframe src="cid:second@archivebridge"></iframe>')
	assert.deepEqual(result.diagnostics, [])
})

test('rewriteFrameContainerSrcAttributes rewrites one of two identical-URL containers and leaves the other byte-for-byte', () => {
	const html = "<iframe src='child.html' title=a></iframe><iframe src='child.html' title=a></iframe>"
	const result = rewriteFrameContainerSrcAttributes(html, byOrdinal([1, 'cid:second@archivebridge']))

	// The untouched one keeps its single quotes and its unquoted attribute;
	// only the second container's span moved.
	assert.equal(result.html, `<iframe src='child.html' title=a></iframe><iframe src="cid:second@archivebridge" title=a></iframe>`)
	assert.deepEqual(result.diagnostics, [])
})

test('rewriteFrameContainerSrcAttributes leaves a container whose ordinal is absent from the map exactly as it was', () => {
	// A gap in the middle, which is the shape a capture produces when one
	// frame could not be captured: ordinals 0 and 2 are replaced, 1 is not
	// shifted into and not touched.
	const html = '<iframe src="a.html"></iframe><iframe src="b.html"></iframe><iframe src="c.html"></iframe>'
	const result = rewriteFrameContainerSrcAttributes(html, byOrdinal([2, 'cid:c@archivebridge'], [0, 'cid:a@archivebridge']))

	assert.equal(result.html, '<iframe src="cid:a@archivebridge"></iframe><iframe src="b.html"></iframe><iframe src="cid:c@archivebridge"></iframe>')
	assert.deepEqual(result.diagnostics, [])
})

test('rewriteFrameContainerSrcAttributes rewrites an unquoted or single-quoted src without disturbing the surrounding markup', () => {
	const html = '<div  class = "wrap" >\n\t<iframe src=child.html  loading=lazy ></iframe>\n\t<iframe  src=\'other.html\' name="n"></iframe>\n</div>'
	const result = rewriteFrameContainerSrcAttributes(html, byOrdinal([0, 'cid:one@archivebridge'], [1, 'cid:two@archivebridge']))

	// Whitespace, the unquoted `loading=lazy`, the `name` attribute and the
	// newlines all survive; each `src` becomes a double-quoted attribute in
	// place of exactly the span it occupied.
	assert.equal(
		result.html,
		'<div  class = "wrap" >\n\t<iframe src="cid:one@archivebridge"  loading=lazy ></iframe>\n\t<iframe  src="cid:two@archivebridge" name="n"></iframe>\n</div>',
	)
	assert.deepEqual(result.diagnostics, [])
})

test('rewriteFrameContainerSrcAttributes addresses legacy <frame> in a frameset positionally too, and only where the parser really puts one', () => {
	const html = '<frameset cols="50%,50%"><frame src=left.html><frame src="right.html" name=r></frameset>'
	const result = rewriteFrameContainerSrcAttributes(html, byOrdinal([1, 'cid:right@archivebridge']))

	assert.equal(result.html, '<frameset cols="50%,50%"><frame src=left.html><frame src="cid:right@archivebridge" name=r></frameset>')
	assert.deepEqual(result.diagnostics, [])

	// A `<frame>` outside a frameset is dropped by the HTML parser, so it is
	// not a container and occupies no ordinal — the same answer a browser
	// gives, arrived at by the same tokenizer rather than by a rule of ours.
	const strayFrame = '<div><frame src="stray.html"></div>'
	const stray = rewriteFrameContainerSrcAttributes(strayFrame, byOrdinal([0, 'cid:stray@archivebridge']))
	assert.equal(stray.html, strayFrame)
	assert.equal(stray.diagnostics.length, 1)
})

test('rewriteFrameContainerSrcAttributes counts no frame container in a comment or in RAWTEXT, so ordinals are not shifted by markup that only looks like one', () => {
	// Three things that read like frame containers and are not: one in a
	// comment, one in a `<script>`'s raw text, and one inside an ordinary
	// inert `<template>`. If any of them were counted, ordinal 0 would land
	// on the wrong element — which is the failure mode a positional API has
	// to be adversarial about.
	const html =
		'<!-- <iframe src="comment.html"></iframe> --><script>var s = \'<iframe src="script.html"></iframe>\'</script><template><iframe src="inert.html"></iframe></template><iframe src="real.html"></iframe>'
	const result = rewriteFrameContainerSrcAttributes(html, byOrdinal([0, 'cid:real@archivebridge']))

	assert.equal(
		result.html,
		'<!-- <iframe src="comment.html"></iframe> --><script>var s = \'<iframe src="script.html"></iframe>\'</script><template><iframe src="inert.html"></iframe></template><iframe src="cid:real@archivebridge"></iframe>',
	)
	assert.deepEqual(result.diagnostics, [])
	// And there is exactly one container to address, so ordinal 1 is a gap.
	assert.equal(rewriteFrameContainerSrcAttributes(html, byOrdinal([1, 'cid:x@archivebridge'])).diagnostics.length, 1)
})

test('rewriteFrameContainerSrcAttributes counts a declarative-shadow-DOM container in the same ordinal space as the light-DOM ones', () => {
	// Consistent with `findFrameSrcLocations`, which descends into a
	// `<template shadowrootmode>` and not into an inert one: the shadow
	// container is ordinal 1, in tree order, and is rewritable like any other.
	const html = '<iframe src="light.html"></iframe><div id="host"><template shadowrootmode="open"><iframe src="shadow.html"></iframe></template></div>'
	const result = rewriteFrameContainerSrcAttributes(html, byOrdinal([1, 'cid:shadow@archivebridge']))

	assert.equal(result.html, '<iframe src="light.html"></iframe><div id="host"><template shadowrootmode="open"><iframe src="cid:shadow@archivebridge"></iframe></template></div>')
	assert.deepEqual(result.diagnostics, [])
})

test('rewriteFrameContainerSrcAttributes occupies an ordinal for a container it cannot rewrite, rather than letting the next one take it', () => {
	// An `<iframe srcdoc>` has no `src` to rewrite, and a positional API that
	// skipped it would silently write the first replacement into the *second*
	// container. It keeps its ordinal and fails closed instead.
	const html = '<iframe srcdoc="<p>inline"></iframe><iframe src="child.html"></iframe>'
	const result = rewriteFrameContainerSrcAttributes(html, byOrdinal([0, 'cid:inline@archivebridge'], [1, 'cid:child@archivebridge']))

	assert.equal(result.html, '<iframe srcdoc="<p>inline"></iframe><iframe src="cid:child@archivebridge"></iframe>')
	assert.equal(result.diagnostics.length, 1)
	assert.deepEqual(result.diagnostics[0]?.type, 'malformed-resource')
	assert.equal(result.diagnostics[0]?.type === 'malformed-resource' ? result.diagnostics[0].url : '', 'cid:inline@archivebridge')
	assert.match(result.diagnostics[0]?.type === 'malformed-resource' ? result.diagnostics[0].message : '', /ordinal 0 has no src attribute/)
})

test('rewriteFrameContainerSrcAttributes fails closed on an ordinal that names no container, and on malformed markup that yields no location', () => {
	const html = '<iframe src="a.html"></iframe>'

	// Past the end, and the document is returned unchanged.
	const past = rewriteFrameContainerSrcAttributes(html, byOrdinal([1, 'cid:missing@archivebridge']))
	assert.equal(past.html, html)
	assert.equal(past.diagnostics.length, 1)
	assert.match(past.diagnostics[0]?.type === 'malformed-resource' ? past.diagnostics[0].message : '', /no frame container at DOM ordinal 1: the document has 1/)

	// Not an ordinal at all. Nothing is rewritten "near" it.
	for (const ordinal of [-1, 1.5, Number.NaN]) {
		const bogus = rewriteFrameContainerSrcAttributes(html, byOrdinal([ordinal, 'cid:bogus@archivebridge']))
		assert.equal(bogus.html, html, `ordinal ${ordinal} rewrote something`)
		assert.equal(bogus.diagnostics.length, 1)
	}

	// An unterminated quote: the parser degrades per spec and records no
	// `src` location, so the request is refused rather than spliced against
	// an offset nobody can vouch for.
	const malformed = '<iframe src="a.html></iframe>'
	const unlocatable = rewriteFrameContainerSrcAttributes(malformed, byOrdinal([0, 'cid:x@archivebridge']))
	assert.equal(unlocatable.html, malformed)
	assert.equal(unlocatable.diagnostics.length, 1)
})

test('rewriteFrameContainerSrcAttributes preserves entities and unrelated attributes, and escapes an untrusted replacement', () => {
	const html = '<iframe data-note="a &amp; b" src="x.html?a=1&amp;b=2" allow="fullscreen"></iframe>'
	const result = rewriteFrameContainerSrcAttributes(html, byOrdinal([0, '"><script>alert(1)</script>']))

	assert.equal(result.html, '<iframe data-note="a &amp; b" src="&quot;><script>alert(1)</script>" allow="fullscreen"></iframe>')
	// The injected markup did not break out: still one container, and its
	// value is the untrusted string itself rather than markup.
	const reparsed = findFrameSrcLocations(result.html)
	assert.equal(reparsed.length, 1)
	assert.equal(reparsed[0]?.value, '"><script>alert(1)</script>')
})

test('rewriteFrameContainerSrcAttributes with no replacements returns the input document itself', () => {
	const html = '<iframe src="a.html"></iframe>'
	const result = rewriteFrameContainerSrcAttributes(html, byOrdinal())
	assert.equal(result.html, html)
	assert.deepEqual(result.diagnostics, [])
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
