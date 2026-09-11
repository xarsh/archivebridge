import assert from 'node:assert/strict'
import test from 'node:test'
import { MAX_FRAME_DEPTH, MAX_STYLESHEET_IMPORT_DEPTH } from '../limits.ts'
import type { MhtmlDocument, MhtmlPart } from '../model/mhtml.ts'
import { type MhtmlRenderResult, NEUTRALIZED_URL, type RenderWarning, renderMhtml } from './render.ts'

const PAGE = 'https://example.com/page.html'
const encoder = new TextEncoder()

function part(overrides: Partial<MhtmlPart> & { readonly mimeType: string }): MhtmlPart {
	return { contentId: undefined, location: undefined, textEncoding: undefined, data: new Uint8Array(), ...overrides }
}

function htmlPart(location: string, html: string, overrides: Partial<MhtmlPart> = {}): MhtmlPart {
	return part({ location, mimeType: 'text/html', data: encoder.encode(html), textEncoding: 'utf-8', ...overrides })
}

interface Minted {
	readonly url: string
	readonly mimeType: string
	readonly text: string
}

interface Rendered {
	readonly result: MhtmlRenderResult
	readonly minted: readonly Minted[]
	/** The text of whatever was minted at `url`, or '' — so an assertion can follow a reference the renderer produced. */
	content(url: string | undefined): string
}

/**
 * Renders with a deterministic URL factory (`mint:<n>:<mimeType>`). The
 * number is a mint counter, and nothing should depend on its value: a
 * document's own URL is minted *after* the resources it references, since
 * rewriting its HTML is what discovers them. Assertions therefore match on
 * the MIME type and follow URLs through {@link Rendered.content}.
 *
 * Real blob URLs are opaque and differ per run, so a deterministic
 * stand-in is what makes the whole rewrite path assertable byte for byte —
 * which is the reason minting is an injected function rather than a call
 * into the platform.
 */
function render(parts: readonly MhtmlPart[], rootPartIndex = 0): Rendered {
	const minted: Minted[] = []
	const document: MhtmlDocument = { parts, rootPartIndex }
	const result = renderMhtml(document, {
		createResourceUrl: (bytes, mimeType) => {
			const url = `mint:${minted.length}:${mimeType}`
			minted.push({ url, mimeType, text: new TextDecoder().decode(bytes) })
			return url
		},
	})
	return { result, minted, content: (url) => minted.find((entry) => entry.url === url)?.text ?? '' }
}

interface RenderedRoot {
	readonly html: string
	readonly result: MhtmlRenderResult
	readonly minted: readonly Minted[]
	content(url: string | undefined): string
}

function renderRoot(html: string, extraParts: readonly MhtmlPart[] = []): RenderedRoot {
	const rendered = render([htmlPart(PAGE, html), ...extraParts])
	return { html: rendered.content(rendered.result.rootUrl), result: rendered.result, minted: rendered.minted, content: rendered.content }
}

const PNG = part({ location: 'https://example.com/a.png', mimeType: 'image/png', data: new Uint8Array([1, 2, 3]) })
const CSS = part({ location: 'https://example.com/s.css', mimeType: 'text/css', data: encoder.encode('body{background:url(a.png)}'), textEncoding: 'utf-8' })

function warningTypes(result: MhtmlRenderResult): readonly string[] {
	return result.warnings.map((warning) => warning.type)
}

/** Every blocked reference as `element@attribute:reason`, the shape that makes a policy decision readable in an assertion. */
function blocked(result: MhtmlRenderResult): readonly string[] {
	return result.warnings
		.filter((warning): warning is Extract<RenderWarning, { type: 'blocked-reference' }> => warning.type === 'blocked-reference')
		.map((warning) => `${warning.element}@${warning.attribute}:${warning.reason}`)
}

test('the root document is minted as UTF-8 HTML and its URL returned', () => {
	const { result, minted } = renderRoot('<p>hello</p>')
	assert.equal(result.rootUrl, 'mint:0:text/html;charset=utf-8')
	assert.equal(result.rootLocation, PAGE)
	assert.match(minted[0]?.text ?? '', /<p>hello<\/p>/)
	assert.equal(result.stats.documents, 1)
	assert.deepEqual(result.warnings, [])
})

test('an archived image resolves to a resource URL carrying the archived bytes and MIME type', () => {
	const { html, minted } = renderRoot('<img src="a.png">', [PNG])
	assert.match(html, /<img src="mint:\d+:image\/png">/)
	assert.equal(minted.filter((entry) => entry.mimeType === 'image/png').length, 1)
})

test('one archive part is minted at most once, however often it is referenced', () => {
	const { html, result } = renderRoot('<img src="a.png"><img src="/a.png"><img src="https://example.com/a.png">', [PNG])
	assert.equal(result.stats.resources, 1)
	assert.equal(html.match(/mint:\d+:image\/png/g)?.length, 3)
})

test('a reference the archive has no part for becomes inert, with a warning naming it', () => {
	const { html, result } = renderRoot('<img src="https://elsewhere.example/x.png">')
	assert.equal(html, `<img src="${NEUTRALIZED_URL}">`)
	assert.equal(result.stats.unresolvedReferences, 1)
	assert.deepEqual(result.warnings, [{ type: 'unresolved-reference', url: 'https://elsewhere.example/x.png', element: 'img', attribute: 'src' }])
})

test('srcset candidates are resolved individually, descriptors intact', () => {
	const { html } = renderRoot('<img srcset="a.png 1x, https://elsewhere.example/b.png 2x" src="a.png">', [PNG])
	assert.match(html, /srcset="mint:\d+:image\/png 1x, about:invalid 2x"/)
})

test('duplicate srcset candidates collapse, because Chromium loads nothing for a srcset that repeats a URL', () => {
	const { html } = renderRoot('<img srcset="a.png 1x, a.png 2x"><img srcset="https://elsewhere.example/x.png 1x, https://elsewhere.example/y.png 2x">', [PNG])
	assert.match(html, /<img srcset="mint:\d+:image\/png 1x">/)
	// Two different missing candidates become the same inert URL, and collapse too.
	assert.match(html, /<img srcset="about:invalid 1x">/)
})

test('a srcset with no descriptor and stray commas still parses', () => {
	const { html } = renderRoot('<picture><source srcset=",,a.png,"><img src="a.png"></picture>', [PNG])
	assert.match(html, /srcset="mint:\d+:image\/png"/)
})

test('an archived stylesheet is rewritten and served as CSS', () => {
	const rendered = renderRoot('<link rel="stylesheet" href="s.css">', [CSS, PNG])
	const sheetUrl = rendered.html.match(/href="([^"]+)"/)?.[1]
	assert.match(sheetUrl ?? '', /^mint:\d+:text\/css;charset=utf-8$/)
	assert.match(rendered.content(sheetUrl), /body\{background:url\("mint:\d+:image\/png"\)\}/)
	assert.equal(rendered.result.stats.stylesheets, 1)
})

test('url() inside an archived stylesheet resolves against the stylesheet, not the document', () => {
	const sheet = part({ location: 'https://example.com/deep/s.css', mimeType: 'text/css', data: encoder.encode('body{background:url(a.png)}'), textEncoding: 'utf-8' })
	const deepPng = part({ location: 'https://example.com/deep/a.png', mimeType: 'image/png', data: new Uint8Array([9]) })
	const rendered = render([htmlPart(PAGE, '<link rel="stylesheet" href="deep/s.css">'), sheet, deepPng, PNG])
	const sheetUrl = rendered.content(rendered.result.rootUrl).match(/href="([^"]+)"/)?.[1]
	assert.match(rendered.content(sheetUrl), /url\("mint:\d+:image\/png"\)/)
	// The document-relative sibling exists too, and was correctly not chosen.
	assert.equal(rendered.result.stats.unresolvedReferences, 0)
	assert.equal(rendered.minted.filter((entry) => entry.mimeType === 'image/png').length, 1)
})

test('a <style> block and a style attribute are both rewritten', () => {
	const { html } = renderRoot('<style>body{background:url(a.png)}</style><div style="background:url(a.png)">x</div>', [PNG])
	assert.match(html, /<style>body\{background:url\("mint:\d+:image\/png"\)\}<\/style>/)
	assert.match(html, /style="background:url\(&quot;mint:\d+:image\/png&quot;\)"/)
})

test('@import pulls in another archived stylesheet, rewritten in turn', () => {
	const outer = part({ location: 'https://example.com/o.css', mimeType: 'text/css', data: encoder.encode('@import url(i.css);'), textEncoding: 'utf-8' })
	const inner = part({ location: 'https://example.com/i.css', mimeType: 'text/css', data: encoder.encode('body{background:url(a.png)}'), textEncoding: 'utf-8' })
	const rendered = render([htmlPart(PAGE, '<link rel="stylesheet" href="o.css">'), outer, inner, PNG])
	const outerUrl = rendered.content(rendered.result.rootUrl).match(/href="([^"]+)"/)?.[1]
	const innerUrl = rendered.content(outerUrl).match(/url\("([^"]+)"\)/)?.[1]
	assert.match(rendered.content(innerUrl), /url\("mint:\d+:image\/png"\)/)
	assert.equal(rendered.result.stats.stylesheets, 2)
})

test('a stylesheet that imports itself terminates instead of recursing forever', () => {
	const loop = part({ location: 'https://example.com/l.css', mimeType: 'text/css', data: encoder.encode('@import url(l.css);body{color:red}'), textEncoding: 'utf-8' })
	const rendered = render([htmlPart(PAGE, '<link rel="stylesheet" href="l.css">'), loop])
	assert.equal(rendered.result.stats.stylesheets, 1)
	const sheetUrl = rendered.content(rendered.result.rootUrl).match(/href="([^"]+)"/)?.[1]
	assert.match(rendered.content(sheetUrl), /@import url\("about:invalid"\);body\{color:red\}/)
})

test('a script reference is never resolved, even when the archive contains the bytes', () => {
	const script = part({ location: 'https://example.com/x.js', mimeType: 'application/javascript', data: encoder.encode('alert(1)') })
	const { html, result } = renderRoot('<script src="x.js"></script>', [script])
	assert.equal(html, `<script src="${NEUTRALIZED_URL}"></script>`)
	assert.equal(result.stats.resources, 0)
	assert.deepEqual(blocked(result), ['script@src:script'])
})

test('an SVG script href is neutralized too', () => {
	const { html, result } = renderRoot('<svg><script xlink:href="x.js"/></svg>')
	assert.match(html, /xlink:href="about:invalid"/)
	assert.deepEqual(blocked(result), ['script@xlink:href:script'])
})

test('inline event handlers are renamed out of the handler namespace', () => {
	const { html, result } = renderRoot('<img src="a.png" onerror="fetch(1)"><p onclick="x()">c</p>', [PNG])
	assert.match(html, /data-archivebridge-onerror="fetch\(1\)"/)
	assert.match(html, /data-archivebridge-onclick="x\(\)"/)
	assert.doesNotMatch(html, /\son[a-z]+=/)
	assert.deepEqual(blocked(result), ['img@onerror:script', 'p@onclick:script'])
})

test('a javascript: URL is rejected wherever it appears', () => {
	const { html, result } = renderRoot('<iframe src="javascript:parent.x()"></iframe><img src="javascript:1">')
	assert.match(html, /<iframe src="about:invalid">/)
	assert.match(html, /<img src="about:invalid">/)
	assert.deepEqual(blocked(result), ['iframe@src:unsafe-scheme', 'img@src:unsafe-scheme'])
})

test('a file: URL cannot be named by an archive', () => {
	const { html, result } = renderRoot('<img src="file:///etc/passwd">')
	assert.match(html, /src="about:invalid"/)
	assert.deepEqual(blocked(result), ['img@src:unsafe-scheme'])
})

test('plugin content is neutralized', () => {
	const { html, result } = renderRoot('<object data="x.swf"></object><embed src="y.swf">')
	assert.match(html, /<object data="about:invalid">/)
	assert.match(html, /<embed src="about:invalid">/)
	assert.deepEqual(blocked(result), ['object@data:plugin', 'embed@src:plugin'])
})

test('network hints are neutralized, including the connection hints no CSP directive covers', () => {
	const markup = [
		'<link rel="preload" as="image" href="https://elsewhere.example/p.png">',
		'<link rel="preconnect" href="https://elsewhere.example/">',
		'<link rel="dns-prefetch" href="https://elsewhere.example/">',
		'<link rel="prefetch" href="https://elsewhere.example/x">',
		'<link rel="modulepreload" href="https://elsewhere.example/m.js">',
		'<link rel="manifest" href="/m.json">',
		'<link rel="preload" imagesrcset="https://elsewhere.example/q.png 1x">',
	].join('')
	const { html, result } = renderRoot(markup)
	assert.equal(html.match(/about:invalid/g)?.length, 7)
	assert.equal(result.stats.blockedReferences, 7)
	assert.deepEqual(
		blocked(result).filter((entry) => !entry.endsWith(':network-hint')),
		[],
	)
})

test('a stylesheet link is still fetched, and an icon link too', () => {
	const icon = part({ location: 'https://example.com/i.ico', mimeType: 'image/x-icon', data: new Uint8Array([7]) })
	const { html } = renderRoot('<link rel="stylesheet" href="s.css"><link rel="icon" href="i.ico">', [CSS, icon])
	assert.match(html, /rel="stylesheet" href="mint:\d+:text\/css;charset=utf-8"/)
	assert.match(html, /rel="icon" href="mint:\d+:image\/x-icon"/)
})

test('a link rel the browser does not fetch is neutralized rather than left pointing outward', () => {
	const { html, result } = renderRoot('<link rel="alternate" type="application/rss+xml" href="https://elsewhere.example/feed">')
	assert.match(html, /href="about:invalid"/)
	assert.deepEqual(blocked(result), ['link@href [rel=alternate]:network-hint'])
})

test('hyperlinks keep their affordance, lose their destination, and keep the original in a data attribute', () => {
	const { html, result } = renderRoot('<a href="https://elsewhere.example/x">out</a>')
	assert.equal(html, '<a href="#" data-archivebridge-href="https://elsewhere.example/x">out</a>')
	assert.equal(result.stats.neutralizedLinks, 1)
})

test('an in-page anchor still works', () => {
	const { html, result } = renderRoot('<a href="#section">in</a><h2 id="section">s</h2>')
	assert.equal(html, '<a href="#section">in</a><h2 id="section">s</h2>')
	assert.equal(result.stats.neutralizedLinks, 0)
})

test('form and other navigation targets are neutralized', () => {
	const { html, result } = renderRoot(
		'<form action="https://elsewhere.example/f"><button formaction="https://elsewhere.example/g"></button></form><a href="#a" ping="https://elsewhere.example/p">x</a>',
	)
	assert.match(html, /<form action="about:invalid">/)
	assert.match(html, /formaction="about:invalid"/)
	assert.match(html, /ping="about:invalid"/)
	assert.deepEqual([...blocked(result)].sort(), ['a@ping:navigation', 'button@formaction:navigation', 'form@action:navigation'])
})

test('base href stops affecting the reconstructed document, but is applied while resolving it', () => {
	const based = part({ location: 'https://example.com/assets/a.png', mimeType: 'image/png', data: new Uint8Array([4]) })
	const { html } = renderRoot('<base href="/assets/"><img src="a.png">', [based])
	assert.match(html, /data-archivebridge-base-href="\/assets\/"/)
	assert.doesNotMatch(html, /<base href=/)
	assert.match(html, /<img src="mint:\d+:image\/png">/)
})

test('meta refresh, an archived CSP and a declared charset are all normalized', () => {
	const { html, result } = renderRoot(
		'<meta http-equiv="refresh" content="0;url=https://elsewhere.example/"><meta http-equiv="Content-Security-Policy" content="default-src https://elsewhere.example"><meta charset="shift_jis"><meta http-equiv="content-type" content="text/html; charset=shift_jis"><meta name="viewport" content="width=device-width">',
	)
	assert.match(html, /http-equiv="refresh" content=""/)
	assert.match(html, /http-equiv="Content-Security-Policy" content=""/)
	assert.match(html, /<meta charset="utf-8">/)
	assert.match(html, /http-equiv="content-type" content="text\/html; charset=utf-8"/)
	// An unrelated meta is left exactly alone.
	assert.match(html, /name="viewport" content="width=device-width"/)
	assert.deepEqual(blocked(result), ['meta@content:navigation'])
})

test('a legacy Blink shadowmode template becomes a declarative shadow root, faithfully for each mode', () => {
	const { html, result } = renderRoot('<div><template shadowmode="open"><p>o</p></template></div><div><template shadowmode="closed"><p>c</p></template></div>')
	assert.match(html, /<template shadowrootmode="open">/)
	assert.match(html, /<template shadowrootmode="closed">/)
	assert.equal(result.stats.normalizedShadowRoots, 2)
})

test('Blink shadowdelegatesfocus is normalized alongside the mode it belongs to', () => {
	const { html } = renderRoot('<div><template shadowmode="open" shadowdelegatesfocus=""><p>o</p></template></div>')
	assert.match(html, /<template shadowrootmode="open" shadowrootdelegatesfocus="">/)
})

test('a standard declarative shadow root is left exactly as it is, and no mode is ever invented', () => {
	const already = renderRoot('<div><template shadowrootmode="open"><p>o</p></template></div>')
	assert.match(already.html, /<template shadowrootmode="open">/)
	assert.equal(already.result.stats.normalizedShadowRoots, 0)

	const plain = renderRoot('<template><p>inert</p></template>')
	assert.equal(plain.html, '<template><p>inert</p></template>')
	assert.equal(plain.result.stats.normalizedShadowRoots, 0)

	const nonsense = renderRoot('<div><template shadowmode="sideways"><p>x</p></template></div>')
	assert.match(nonsense.html, /shadowmode="sideways"/)
	assert.equal(nonsense.result.stats.normalizedShadowRoots, 0)
})

test('references inside a normalized shadow root are rewritten, because the content becomes live', () => {
	const { html } = renderRoot('<div><template shadowmode="open"><img src="a.png"><style>p{background:url(a.png)}</style></template></div>', [PNG])
	assert.match(html, /<img src="mint:\d+:image\/png">/)
	assert.match(html, /url\("mint:\d+:image\/png"\)/)
})

test('a frame resolves through its cid: link to a reconstructed child document', () => {
	const child = htmlPart('https://example.com/frame.html', '<p id="child">child</p><img src="a.png">', { contentId: 'child@x' })
	const rendered = render([htmlPart(PAGE, '<iframe src="cid:child@x"></iframe>'), child, PNG])
	const childUrl = rendered.content(rendered.result.rootUrl).match(/src="([^"]+)"/)?.[1]
	assert.match(rendered.content(childUrl), /<p id="child">child<\/p>/)
	assert.match(rendered.content(childUrl), /<img src="mint:\d+:image\/png">/)
	assert.equal(rendered.result.stats.documents, 2)
})

test('nested frames are reconstructed all the way down', () => {
	const inner = htmlPart('https://example.com/inner.html', '<p>inner</p>', { contentId: 'inner@x' })
	const outer = htmlPart('https://example.com/outer.html', '<iframe src="cid:inner@x"></iframe>', { contentId: 'outer@x' })
	const rendered = render([htmlPart(PAGE, '<iframe src="cid:outer@x"></iframe>'), outer, inner])
	const outerUrl = rendered.content(rendered.result.rootUrl).match(/src="([^"]+)"/)?.[1]
	const innerUrl = rendered.content(outerUrl).match(/src="([^"]+)"/)?.[1]
	assert.match(rendered.content(innerUrl), /<p>inner<\/p>/)
	assert.equal(rendered.result.stats.documents, 3)
})

test('a frame whose document is missing from the archive is left unloadable, not fetched', () => {
	const { html, result } = renderRoot('<iframe src="https://elsewhere.example/f.html"></iframe>')
	assert.equal(html, `<iframe src="${NEUTRALIZED_URL}"></iframe>`)
	assert.deepEqual(warningTypes(result), ['unresolved-reference'])
})

test('a frame cycle is cut and reported, not expanded', () => {
	const a = htmlPart(PAGE, '<iframe src="cid:b@x"></iframe>', { contentId: 'a@x' })
	const b = htmlPart('https://example.com/b.html', '<iframe src="cid:a@x"></iframe>', { contentId: 'b@x' })
	const rendered = render([a, b])
	assert.equal(rendered.result.stats.documents, 2)
	assert.ok(warningTypes(rendered.result).includes('cyclic-frame-reference'))
	assert.deepEqual(rendered.result.diagnostics, [{ type: 'cyclic-frame-reference', partIndex: 0 }])
})

test('a frame that references itself is cut', () => {
	const rendered = render([htmlPart(PAGE, '<iframe src="cid:self@x"></iframe>', { contentId: 'self@x' })])
	assert.equal(rendered.result.stats.documents, 1)
	assert.ok(warningTypes(rendered.result).includes('cyclic-frame-reference'))
})

test('a frame chain longer than MAX_FRAME_DEPTH is truncated with a diagnostic', () => {
	const depth = MAX_FRAME_DEPTH + 4
	const parts: MhtmlPart[] = []
	for (let level = 0; level < depth; level += 1) {
		const body = level + 1 === depth ? '<p>leaf</p>' : `<iframe src="cid:level${level + 1}@x"></iframe>`
		parts.push(htmlPart(`https://example.com/${level}.html`, body, { contentId: `level${level}@x` }))
	}
	const rendered = render(parts)
	assert.ok(rendered.result.stats.documents <= MAX_FRAME_DEPTH + 1, `expected at most ${MAX_FRAME_DEPTH + 1} documents, got ${rendered.result.stats.documents}`)
	assert.ok(rendered.result.diagnostics.some((diagnostic) => diagnostic.type === 'frame-depth-exceeded'))
})

test('a diamond frame graph renders each document once rather than exponentially', () => {
	const leaf = htmlPart('https://example.com/leaf.html', '<p>leaf</p>', { contentId: 'leaf@x' })
	const left = htmlPart('https://example.com/left.html', '<iframe src="cid:leaf@x"></iframe><iframe src="cid:leaf@x"></iframe>', { contentId: 'left@x' })
	const right = htmlPart('https://example.com/right.html', '<iframe src="cid:leaf@x"></iframe><iframe src="cid:leaf@x"></iframe>', { contentId: 'right@x' })
	const rendered = render([htmlPart(PAGE, '<iframe src="cid:left@x"></iframe><iframe src="cid:right@x"></iframe>'), left, right, leaf])
	assert.equal(rendered.result.stats.documents, 4)
})

test('an iframe srcdoc is rewritten recursively rather than shipped as captured', () => {
	const { html } = renderRoot('<iframe srcdoc="&lt;img src=&quot;a.png&quot;&gt;&lt;link rel=&quot;preconnect&quot; href=&quot;https://elsewhere.example/&quot;&gt;"></iframe>', [
		PNG,
	])
	assert.match(html, /srcdoc="&lt;img src=&quot;mint:\d+:image\/png&quot;&gt;/)
	assert.match(html, /rel=&quot;preconnect&quot; href=&quot;about:invalid&quot;/)
})

test('a srcdoc frame chain has the exact same depth boundary as a src frame chain', () => {
	/** A chain of documents 0..finalLevel, each an `<iframe src>` to the next except the last, which gets `finalBody`. Level `n` renders at frame depth `n`. */
	function chain(finalLevel: number, finalBody: string): MhtmlPart[] {
		const parts: MhtmlPart[] = []
		for (let level = 0; level <= finalLevel; level += 1) {
			const body = level === finalLevel ? finalBody : `<iframe src="cid:level${level + 1}@x"></iframe>`
			parts.push(htmlPart(`https://example.com/${level}.html`, body, { contentId: `level${level}@x` }))
		}
		return parts
	}
	const leaf = htmlPart('https://example.com/leaf.html', '<p>leaf</p>', { contentId: 'leaf@x' })
	const srcdocLeaf = '<iframe srcdoc="&lt;p&gt;leaf&lt;/p&gt;"></iframe>'

	// A `src` frame at exactly MAX_FRAME_DEPTH is the deepest one allowed: the
	// chain plus the leaf is `root + MAX_FRAME_DEPTH` documents, and there is
	// no frame-depth-exceeded warning.
	const srcAtLimit = render([...chain(MAX_FRAME_DEPTH - 1, '<iframe src="cid:leaf@x"></iframe>'), leaf])
	assert.equal(srcAtLimit.result.stats.documents, MAX_FRAME_DEPTH + 1)
	assert.ok(!warningTypes(srcAtLimit.result).includes('frame-depth-exceeded'))

	// One level deeper is refused, with a warning naming the depth that was refused.
	const srcOverLimit = render([...chain(MAX_FRAME_DEPTH, '<iframe src="cid:leaf@x"></iframe>'), leaf])
	assert.equal(srcOverLimit.result.stats.documents, MAX_FRAME_DEPTH + 1)
	assert.deepEqual(srcOverLimit.result.warnings, [{ type: 'frame-depth-exceeded', depth: MAX_FRAME_DEPTH + 1 }])

	// The same boundary via `srcdoc`, exactly at the limit: allowed, and the
	// inline document is rewritten and kept.
	const srcdocAtLimit = render(chain(MAX_FRAME_DEPTH - 1, srcdocLeaf))
	assert.ok(!warningTypes(srcdocAtLimit.result).includes('frame-depth-exceeded'))
	assert.ok(srcdocAtLimit.minted.some((entry) => entry.text.includes('srcdoc="&lt;p&gt;leaf&lt;/p&gt;"')))

	// One level deeper via `srcdoc`: refused at the exact same depth as the
	// `src` case, and the srcdoc is emptied rather than shipped.
	const srcdocOverLimit = render(chain(MAX_FRAME_DEPTH, srcdocLeaf))
	assert.deepEqual(srcdocOverLimit.result.warnings, [{ type: 'frame-depth-exceeded', depth: MAX_FRAME_DEPTH + 1 }])
	assert.ok(srcdocOverLimit.minted.some((entry) => entry.text.includes('srcdoc=""')))
})

test('a legacy charset resource is decoded with its own encoding and re-emitted as UTF-8', () => {
	// Shift_JIS bytes for 日本, which UTF-8 decoding would turn into replacement characters.
	const shiftJis = new Uint8Array([0x3c, 0x70, 0x3e, 0x93, 0xfa, 0x96, 0x7b, 0x3c, 0x2f, 0x70, 0x3e])
	const rendered = render([part({ location: PAGE, mimeType: 'text/html', textEncoding: 'shift_jis', data: shiftJis })])
	assert.equal(rendered.content(rendered.result.rootUrl), '<p>日本</p>')
	assert.equal(rendered.minted[0]?.mimeType, 'text/html;charset=utf-8')
})

test('an untrustworthy MIME type never reaches the resource URL factory verbatim', () => {
	const nasty = part({ location: 'https://example.com/a.png', mimeType: 'image/png\r\nX-Injected: 1', data: new Uint8Array([1]) })
	const rendered = render([htmlPart(PAGE, '<img src="a.png">'), nasty])
	assert.deepEqual(
		rendered.minted.map((entry) => entry.mimeType),
		['application/octet-stream', 'text/html;charset=utf-8'],
	)
})

test('an archive whose main resource is not HTML has no viewable document, and says so', () => {
	const rendered = render([part({ location: 'https://example.com/a.pdf', mimeType: 'application/pdf', data: new Uint8Array([1]) })])
	assert.equal(rendered.result.rootUrl, undefined)
	assert.deepEqual(rendered.result.diagnostics, [{ type: 'unsupported-feature', feature: 'main resource is not HTML (application/pdf), so it has no viewable document' }])
})

test('a data: URL reference is left exactly as written', () => {
	const { html, result } = renderRoot('<img src="data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEAAAAALAAAAAABAAEAAAIBAAA=">')
	assert.match(html, /src="data:image\/gif;base64,/)
	assert.deepEqual(result.warnings, [])
})

test('warnings are capped, and the cap is reported rather than hidden', () => {
	const references = Array.from({ length: 260 }, (_, index) => `<img src="https://elsewhere.example/${index}.png">`).join('')
	const { result } = renderRoot(references)
	assert.equal(result.warnings.length, 201)
	assert.deepEqual(result.warnings.at(-1), { type: 'warnings-truncated', omitted: 60 })
	assert.equal(result.stats.unresolvedReferences, 260)
})

test('a hostile archive produces a document with no live reference of any kind', () => {
	const hostile = [
		'<base href="https://elsewhere.example/">',
		'<meta http-equiv="refresh" content="0;url=https://elsewhere.example/r">',
		'<link rel="stylesheet" href="https://elsewhere.example/s.css">',
		'<link rel="preconnect" href="https://elsewhere.example/">',
		'<script src="https://elsewhere.example/x.js"></script>',
		'<img src="https://elsewhere.example/i.png" onerror="fetch(&quot;https://elsewhere.example/e&quot;)">',
		'<iframe src="https://elsewhere.example/f.html"></iframe>',
		'<iframe srcdoc="&lt;img src=&quot;https://elsewhere.example/s.png&quot;&gt;"></iframe>',
		'<object data="https://elsewhere.example/o"></object>',
		'<embed src="https://elsewhere.example/e">',
		'<form action="https://elsewhere.example/p"><input name="a"></form>',
		'<a href="https://elsewhere.example/l" target="_top">l</a>',
		'<svg><image xlink:href="https://elsewhere.example/svg.png"/><script>x()</script></svg>',
		'<style>@import url(https://elsewhere.example/i.css);body{background:url(https://elsewhere.example/b.png)}</style>',
		'<video poster="https://elsewhere.example/p.jpg"><source src="https://elsewhere.example/v.mp4"></video>',
	].join('\n')
	const { html } = renderRoot(hostile)

	// No attribute a browser loads or navigates to still points outward. The
	// permitted survivors are the deliberately preserved originals, which are
	// all named `data-archivebridge-*` and are never fetched.
	const live = [...html.matchAll(/(?:^|[\s"'])(?:href|src|srcset|srcdoc|action|formaction|data|poster|ping|xlink:href)="([^"]*)"/g)]
		.map((match) => match[1] ?? '')
		.filter((value) => value.includes('elsewhere.example'))
	assert.deepEqual(live, [])
	assert.doesNotMatch(html, /url\("https:\/\/elsewhere\.example/)
	assert.doesNotMatch(html, /\son[a-z]+=/)
})

/** A chain of `length` stylesheets where each `@import`s the next, rooted at a document that links the first. */
function importChain(length: number): readonly MhtmlPart[] {
	const sheets = Array.from({ length }, (_unused, position) =>
		part({
			location: `https://example.com/s${position}.css`,
			mimeType: 'text/css',
			textEncoding: 'utf-8',
			data: encoder.encode(`${position + 1 < length ? `@import url(s${position + 1}.css);` : ''}#a${position}{color:red}`),
		}),
	)
	return [htmlPart(PAGE, '<link rel="stylesheet" href="s0.css">'), ...sheets]
}

test('an @import chain below the limit is followed all the way down', () => {
	const { result } = render(importChain(MAX_STYLESHEET_IMPORT_DEPTH))
	assert.equal(result.stats.stylesheets, MAX_STYLESHEET_IMPORT_DEPTH)
	assert.deepEqual(warningTypes(result), [])
})

test('an @import chain exactly at the limit is still followed completely', () => {
	// Depths 0..MAX are all allowed, so the deepest sheet that renders is the
	// (MAX + 1)th — one more than that is the first one cut.
	const { result } = render(importChain(MAX_STYLESHEET_IMPORT_DEPTH + 1))
	assert.equal(result.stats.stylesheets, MAX_STYLESHEET_IMPORT_DEPTH + 1)
	assert.deepEqual(warningTypes(result), [])
})

test('an @import chain past the limit is cut, reported, and everything above it still renders', () => {
	const { result, content } = render(importChain(MAX_STYLESHEET_IMPORT_DEPTH + 5))
	assert.equal(result.stats.stylesheets, MAX_STYLESHEET_IMPORT_DEPTH + 1)
	assert.deepEqual(warningTypes(result), ['stylesheet-import-depth-exceeded'])
	assert.deepEqual(result.warnings, [{ type: 'stylesheet-import-depth-exceeded', depth: MAX_STYLESHEET_IMPORT_DEPTH + 1 }])
	// The import that hit the limit is inert rather than missing or live, and
	// the rule beside it in the same sheet survived.
	const cut = [...Array(MAX_STYLESHEET_IMPORT_DEPTH + 1).keys()]
		.map((position) => content(`mint:${position}:text/css;charset=utf-8`))
		.find((text) => text.includes(NEUTRALIZED_URL))
	assert.match(cut ?? '', /@import url\("about:invalid"\)/)
	assert.match(cut ?? '', /color:red/)
})

test('a chain long enough to exhaust the stack without a limit reconstructs instead of throwing', () => {
	// Measured: this recursed once per link and threw RangeError at roughly
	// 2000 before the bound existed. A hostile archive of a few hundred KB.
	const { result } = render(importChain(5000))
	assert.equal(result.stats.stylesheets, MAX_STYLESHEET_IMPORT_DEPTH + 1)
	assert.notEqual(result.rootUrl, undefined)
	assert.deepEqual(warningTypes(result), ['stylesheet-import-depth-exceeded'])
})

test('a stylesheet that @imports itself resolves without recursing or warning about depth', () => {
	const { result } = render([
		htmlPart(PAGE, '<link rel="stylesheet" href="s.css">'),
		part({ location: 'https://example.com/s.css', mimeType: 'text/css', textEncoding: 'utf-8', data: encoder.encode('@import url(s.css);#a{color:red}') }),
	])
	assert.equal(result.stats.stylesheets, 1)
	assert.deepEqual(warningTypes(result), [])
})

test('an indirect @import cycle is cut by memoization, not by the depth limit', () => {
	const sheet = (name: string, next: string) =>
		part({ location: `https://example.com/${name}.css`, mimeType: 'text/css', textEncoding: 'utf-8', data: encoder.encode(`@import url(${next}.css);#${name}{color:red}`) })
	const { result } = render([htmlPart(PAGE, '<link rel="stylesheet" href="a.css">'), sheet('a', 'b'), sheet('b', 'c'), sheet('c', 'a')])
	assert.equal(result.stats.stylesheets, 3)
	assert.deepEqual(warningTypes(result), [])
})

test('a wide @import graph is not mistaken for a deep one, and a diamond stays linear', () => {
	// One sheet importing 50 siblings is depth 1, not depth 50.
	const leaves = Array.from({ length: 50 }, (_unused, position) =>
		part({ location: `https://example.com/leaf${position}.css`, mimeType: 'text/css', textEncoding: 'utf-8', data: encoder.encode(`#l${position}{color:red}`) }),
	)
	const hub = part({
		location: 'https://example.com/hub.css',
		mimeType: 'text/css',
		textEncoding: 'utf-8',
		data: encoder.encode(leaves.map((_unused, position) => `@import url(leaf${position}.css);`).join('')),
	})
	const wide = render([htmlPart(PAGE, '<link rel="stylesheet" href="hub.css">'), hub, ...leaves])
	assert.equal(wide.result.stats.stylesheets, 51)
	assert.deepEqual(warningTypes(wide.result), [])

	// A diamond reaches one sheet by two routes and still mints it once.
	const shared = part({ location: 'https://example.com/shared.css', mimeType: 'text/css', textEncoding: 'utf-8', data: encoder.encode('#s{color:red}') })
	const via = (name: string) => part({ location: `https://example.com/${name}.css`, mimeType: 'text/css', textEncoding: 'utf-8', data: encoder.encode('@import url(shared.css);') })
	const diamond = render([htmlPart(PAGE, '<link rel="stylesheet" href="x.css"><link rel="stylesheet" href="y.css">'), via('x'), via('y'), shared])
	assert.equal(diamond.result.stats.stylesheets, 3)
	assert.deepEqual(warningTypes(diamond.result), [])
})

test('a stylesheet @import depth budget is not spent by frame nesting', () => {
	// The two recursions are independent: a stylesheet linked from a deeply
	// nested frame still gets the whole import budget.
	const frames = Array.from({ length: 6 }, (_unused, position) =>
		htmlPart(`https://example.com/f${position}.html`, position < 5 ? `<iframe src="cid:f${position + 1}"></iframe>` : '<link rel="stylesheet" href="s0.css">', {
			contentId: `f${position}`,
		}),
	)
	const sheets = Array.from({ length: 10 }, (_unused, position) =>
		part({
			location: `https://example.com/s${position}.css`,
			mimeType: 'text/css',
			textEncoding: 'utf-8',
			data: encoder.encode(position < 9 ? `@import url(s${position + 1}.css);` : '#deep{color:red}'),
		}),
	)
	const { result } = render([htmlPart(PAGE, '<iframe src="cid:f0"></iframe>'), ...frames, ...sheets])
	assert.equal(result.stats.stylesheets, 10)
	assert.deepEqual(warningTypes(result), [])
})

// SVG declarative animation. SMIL runs with no scripting at all — measured
// inside sandbox="allow-same-origin" without allow-scripts, Chromium 153 —
// and can assign a live URL to an attribute this module already
// neutralized, so its operative attributes are renamed away.

test('an SVG <set> cannot restore a neutralized href, because its operative attributes are gone', () => {
	const { html, result } = renderRoot(
		'<svg><image href="https://elsewhere.example/x.png"><set attributeName="href" to="https://elsewhere.example/y.png" begin="0s"/></image></svg>',
	)
	// The value survives only under a data- name; no live attributeName/to remains.
	assert.doesNotMatch(html, /(?<![-\w])attributeName=/i)
	assert.doesNotMatch(html, /(?<![-\w])to=/)
	assert.match(html, /data-archivebridge-attributename="href"/)
	assert.match(html, /data-archivebridge-to="https:\/\/elsewhere\.example\/y\.png"/)
	// The element and its timing survive; only the ability to assign does not.
	assert.match(html, /begin="0s"/)
	assert.ok(blocked(result).includes('set@attributename:animation'))
	assert.ok(blocked(result).includes('set@to:animation'))
})

test('every SVG animation element and value attribute is made inert', () => {
	const { html } = renderRoot(
		'<svg>' +
			'<animate attributeName="href" values="https://elsewhere.example/a.png" fill="freeze"/>' +
			'<animateTransform attributeName="transform" from="0" to="1"/>' +
			'<animateMotion by="5"/>' +
			'<set attributeName="xlink:href" to="https://elsewhere.example/b.png"/>' +
			'</svg>',
	)
	// The negative lookbehind is what distinguishes a live attribute from the
	// `data-archivebridge-` renaming of the same one.
	for (const live of [/(?<![-\w])attributeName=/i, /(?<![-\w])values=/, /(?<![-\w])to=/, /(?<![-\w])from=/, /(?<![-\w])by=/]) {
		assert.doesNotMatch(html, live, `a live ${live.source} survived into the rendered document`)
	}
	assert.match(html, /data-archivebridge-values="https:\/\/elsewhere\.example\/a\.png"/)
	assert.match(html, /data-archivebridge-by="5"/)
})

test('an HTML element named like an SVG animation element is left alone', () => {
	// The rule is namespace-scoped: only real SVG animation elements lose
	// their attributes.
	const { html } = renderRoot('<p to="x" values="y">text</p>')
	assert.match(html, /<p to="x" values="y">/)
})

test('the legacy background attribute is rewritten wherever Chromium honors it', () => {
	const { html, result } = renderRoot(
		'<body background="a.png"><table background="https://elsewhere.example/t.png"><tbody background="a.png"><tr background="a.png"><td background="a.png">x</td><th background="a.png">y</th></tr></tbody></table></body>',
		[PNG],
	)
	assert.equal(html.match(/background="mint:\d+:image\/png"/g)?.length, 5)
	assert.match(html, /<table background="about:invalid">/)
	assert.equal(result.stats.unresolvedReferences, 1)
})

test('background on an element Chromium ignores it on is left alone', () => {
	// Measured: Chromium loads `background` on body and table sections only.
	const { html } = renderRoot('<div background="https://elsewhere.example/d.png">x</div>')
	assert.match(html, /<div background="https:\/\/elsewhere\.example\/d\.png">/)
})

// Fail-closed behavior. HTML tree construction merges the attributes of a
// second <html>/<body> start tag onto the element the first one created,
// and parse5 records no source location for a merged attribute — so there
// is no span to splice and the original reference would otherwise survive.

test('a reference that cannot be spliced refuses the document rather than shipping it live', () => {
	const { result, minted } = render([htmlPart(PAGE, '<html lang="en"><body><p>x</p><body background="https://elsewhere.example/b.png">')])
	assert.equal(result.rootUrl, undefined, 'a document with an unrewritable live reference must not be shown')
	assert.ok(warningTypes(result).includes('unrewritable-reference'))
	assert.deepEqual(
		minted.filter((entry) => entry.mimeType.startsWith('text/html')),
		[],
		'no document should have been minted at all',
	)
})

test('an unrewritable handler attribute fails the document closed too', () => {
	const { result } = render([htmlPart(PAGE, '<html lang="en"><body><p>x</p><body onload="fetch(1)">')])
	assert.equal(result.rootUrl, undefined)
	assert.deepEqual(
		result.warnings.filter((warning) => warning.type === 'unrewritable-reference'),
		[{ type: 'unrewritable-reference', element: 'body', attribute: 'onload' }],
	)
})

test('an unrewritable reference in a frame leaves only that frame unloadable', () => {
	const { html, result } = renderRoot('<iframe src="cid:child"></iframe>', [
		htmlPart('https://example.com/child.html', '<html lang="en"><body><p>x</p><body background="https://elsewhere.example/b.png">', { contentId: 'child' }),
	])
	assert.match(html, /<iframe src="about:invalid">/)
	assert.ok(warningTypes(result).includes('unrewritable-reference'))
	// The parent document itself is fine and still rendered.
	assert.notEqual(result.rootUrl, undefined)
})

test('an unrewritable reference inside an iframe srcdoc empties the srcdoc', () => {
	const { html, result } = renderRoot('<iframe srcdoc="&lt;body&gt;&lt;p&gt;x&lt;/p&gt;&lt;body background=&quot;https://elsewhere.example/b.png&quot;&gt;"></iframe>')
	assert.match(html, /<iframe srcdoc="">/)
	assert.ok(warningTypes(result).includes('unrewritable-reference'))
})

test('ordinary malformed markup with nothing to rewrite is still rendered', () => {
	// Failing closed must be driven by an unsplicable *rewrite*, not by
	// malformedness in general.
	const { result, html } = renderRoot(`<html lang="en"><body><p>x<body class="second"><i>y</div></i>`)
	assert.notEqual(result.rootUrl, undefined)
	assert.match(html, /<i>y<\/div><\/i>/)
	assert.deepEqual(warningTypes(result), [])
})

// SVG's `<use>` is the one reference that instantiates another document's
// content in this one, so an archived SVG's own references would load from
// bytes this module never rewrote (measured, Chromium 153 — see
// SVG_USE_TAG). Every other external SVG reference loads nothing from inside
// the referenced file.

test('an SVG <use> naming another document is refused, in either spelling', () => {
	const sprite = part({
		location: 'https://example.com/sprite.svg',
		mimeType: 'image/svg+xml',
		data: encoder.encode('<svg><symbol id="i"><image href="https://elsewhere.example/x.png"/></symbol></svg>'),
		textEncoding: 'utf-8',
	})
	const { html, result } = renderRoot('<svg><use href="sprite.svg#i"/><use xlink:href="https://elsewhere.example/other.svg#i"/></svg>', [sprite])
	assert.match(html, /<use href="about:invalid"\/>/)
	assert.match(html, /<use xlink:href="about:invalid"\/>/)
	// The archived SVG is not minted at all: nothing else referenced it.
	assert.equal(result.stats.resources, 0)
	assert.deepEqual(blocked(result), ['use@href:nested-content', 'use@xlink:href:nested-content'])
})

test('an SVG <use> naming a fragment of this document is left exactly alone', () => {
	const { html, result } = renderRoot('<svg><symbol id="i"><image href="a.png"/></symbol><use href="#i"/></svg>', [PNG])
	assert.match(html, /<use href="#i"\/>/)
	// And the content it clones is rewritten, because it is part of this document.
	assert.match(html, /<image href="mint:\d+:image\/png"\/>/)
	assert.deepEqual(result.warnings, [])
})

test('an archived SVG is still resolved for every reference that cannot instantiate it', () => {
	const svg = part({ location: 'https://example.com/i.svg', mimeType: 'image/svg+xml', data: encoder.encode('<svg/>'), textEncoding: 'utf-8' })
	const { html } = renderRoot('<img src="i.svg"><svg><image href="i.svg"/><feImage href="i.svg"/></svg>', [svg])
	assert.equal(html.match(/mint:\d+:image\/svg\+xml/g)?.length, 3)
})

// SVG presentation attributes are CSS declaration values in attribute form,
// and Chromium 153 fetches a url() in exactly these eight (measured).

test('a url() in an SVG presentation attribute is rewritten like any other CSS value', () => {
	const { html, result } = renderRoot(
		'<svg>' +
			'<rect fill="url(a.png)" stroke="url(https://elsewhere.example/s.png)"/>' +
			'<rect filter="url(https://elsewhere.example/f.png)" mask="url(https://elsewhere.example/m.png)" clip-path="url(https://elsewhere.example/c.png)"/>' +
			'<path marker-start="url(https://elsewhere.example/1.png)" marker-mid="url(https://elsewhere.example/2.png)" marker-end="url(https://elsewhere.example/3.png)"/>' +
			'</svg>',
		[PNG],
	)
	assert.match(html, /fill="url\(&quot;mint:\d+:image\/png&quot;\)"/)
	assert.equal(html.match(/url\(&quot;about:invalid&quot;\)/g)?.length, 7)
	assert.doesNotMatch(html, /elsewhere\.example/)
	assert.equal(result.stats.unresolvedReferences, 7)
})

test('an SVG presentation attribute that names this document, or no URL at all, is untouched', () => {
	const { html, result } = renderRoot('<svg><linearGradient id="g"/><rect fill="url(#g) red" stroke="black" clip-path="inset(1px)"/></svg>')
	assert.match(html, /<rect fill="url\(#g\) red" stroke="black" clip-path="inset\(1px\)"\/>/)
	assert.deepEqual(result.warnings, [])
})

test('an HTML attribute named like an SVG presentation attribute is left alone', () => {
	const { html } = renderRoot('<p fill="url(https://elsewhere.example/x.png)">text</p>')
	assert.match(html, /<p fill="url\(https:\/\/elsewhere\.example\/x\.png\)">/)
})

// `data:` URLs carry their own bytes, which is why they survive at an image,
// font or media site. At a site whose target the browser *parses*, they carry
// their own live references instead (measured, Chromium 153).

test('a data: stylesheet is refused, as a link and as an @import, because its own references are live', () => {
	const nested = 'data:text/css,%40import%20%22https%3A%2F%2Felsewhere.example%2Fn.css%22%3B'
	const { html, result } = renderRoot(`<link rel="stylesheet" href="${nested}"><style>@import "${nested}";body{color:red}</style>`)
	assert.match(html, /<link rel="stylesheet" href="about:invalid">/)
	assert.match(html, /<style>@import url\("about:invalid"\);body\{color:red\}<\/style>/)
	assert.deepEqual(blocked(result), ['link@href:nested-content', 'style@@import:nested-content'])
})

test('a data: frame document is refused, because the markup inside it was never rewritten', () => {
	const { html, result } = renderRoot('<iframe src="data:text/html,%3Cimg%20src%3D%22https%3A%2F%2Felsewhere.example%2Fx.png%22%3E"></iframe>')
	assert.match(html, /<iframe src="about:invalid">/)
	assert.deepEqual(blocked(result), ['iframe@src:nested-content'])
})

test('a data: image, font and media reference still survives verbatim', () => {
	const gif = 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEAAAAALAAAAAABAAEAAAIBAAA='
	const { html, result } = renderRoot(
		`<img src="${gif}" srcset="${gif} 2x"><video poster="${gif}"><source src="${gif}"></video>` +
			`<style>@font-face{src:url(${gif})}#a{background:url(${gif})}</style>` +
			`<svg><image href="${gif}"/><rect fill="url(${gif})"/></svg>`,
	)
	assert.equal(html.match(/data:image\/gif;base64,/g)?.length, 8)
	assert.deepEqual(result.warnings, [])
})
