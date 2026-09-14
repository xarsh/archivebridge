/**
 * MHTML `cid:` references across conversion to WebArchive.
 *
 * The regression these cover is not exotic: WebKit's resource loader never
 * attempts a `cid:` URL, so a `cid:` reference carried into a `.webarchive`
 * verbatim names a resource that is in the archive and never loads. Blink
 * writes every inlined `<style>` as a `cid:`-located part, so that was every
 * Chrome capture with an inline stylesheet.
 *
 * Measured against real WebKit (a `WKWebView` loading the converted
 * `fixtures/mhtml/cid-references.mhtml`): before the fix every `<img>` was
 * `naturalWidth: 0`, the linked stylesheet never applied and the `cid:`
 * frame was empty; after it, all three resolve. That harness is a one-off
 * Swift program and deliberately not part of this suite — everything below
 * is browser-independent.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { parseMhtml } from '../mhtml/parse.ts'
import { serializeMhtml } from '../mhtml/serialize.ts'
import type { MhtmlDocument, MhtmlPart } from '../model/mhtml.ts'
import type { WebArchiveDocument } from '../model/webarchive.ts'
import { parseWebArchive } from '../webarchive/parse.ts'
import { serializeWebArchive } from '../webarchive/serialize.ts'
import { CONTENT_ID_URL_ORIGIN, contentIdUrl } from './cid-references.ts'
import { convertWebArchiveToMhtml } from './to-mhtml.ts'
import { convertMhtmlToWebArchive } from './to-web-archive.ts'

const encoder = new TextEncoder()
const decoder = new TextDecoder()

function html(body: string, overrides: Partial<MhtmlPart> = {}): MhtmlPart {
	return { contentId: 'root@archivebridge.test', location: 'https://example.invalid/', mimeType: 'text/html', textEncoding: 'utf-8', data: encoder.encode(body), ...overrides }
}

function png(overrides: Partial<MhtmlPart> = {}): MhtmlPart {
	return { contentId: 'pixels@archivebridge.test', location: undefined, mimeType: 'image/png', textEncoding: undefined, data: Uint8Array.of(0x89, 0x50, 0x4e, 0x47), ...overrides }
}

function convert(parts: readonly MhtmlPart[]): {
	readonly document: WebArchiveDocument
	readonly rootHtml: string
	readonly diagnostics: readonly ReturnType<typeof convertMhtmlToWebArchive>['diagnostics'][number][]
} {
	const document: MhtmlDocument = { parts, rootPartIndex: 0 }
	const result = convertMhtmlToWebArchive(document)
	return { document: result.document, rootHtml: decoder.decode(result.document.mainResource.data), diagnostics: [...result.diagnostics] }
}

const PIXELS_URL = contentIdUrl('pixels@archivebridge.test')

test('the synthetic namespace is absolute, https, RFC 2606-unresolvable, deterministic, and one-to-one with the Content-ID', () => {
	assert.equal(PIXELS_URL, 'https://content-id.archivebridge.invalid/pixels%40archivebridge.test')
	assert.equal(contentIdUrl('pixels@archivebridge.test'), PIXELS_URL, 'the same Content-ID always produces the same URL')
	assert.notEqual(contentIdUrl('a'), contentIdUrl('b'))

	const url = new URL(PIXELS_URL)
	assert.equal(url.protocol, 'https:', 'WebKit only substitutes a resource for a scheme its loader would actually attempt')
	assert.ok(url.hostname.endsWith('.invalid'), 'RFC 2606 reserves .invalid, so this can never reach a real server')
	// The minted string is already canonical, so the reference written into the
	// markup and the WebResourceURL written into the plist stay the same URL
	// however a consumer parses them. That holds for every Content-ID except
	// the two dot segments at the bottom of this file, which is why collision
	// safety rests on a canonical comparison rather than on this property.
	assert.equal(url.href, PIXELS_URL, 'URL normalization must not change the minted string, or the reference and the WebResourceURL would stop matching')

	// A Content-ID is only checked for MIME header representability, so it may
	// contain characters that are not URL-safe at all.
	assert.equal(new URL(contentIdUrl('a/b?c#d e')).href, contentIdUrl('a/b?c#d e'))
	assert.ok(contentIdUrl('a/b?c#d e').startsWith(`${CONTENT_ID_URL_ORIGIN}/`))
})

test('every HTML reference site that can name a part by Content-ID is rewritten to that part’s WebArchive URL', () => {
	const { rootHtml, diagnostics } = convert([
		html(
			[
				'<!DOCTYPE html><html><head>',
				'<link rel="stylesheet" href="cid:sheet@archivebridge.test">',
				'<style>#a { background-image: url(cid:pixels@archivebridge.test); }</style>',
				'</head><body background="cid:pixels@archivebridge.test">',
				'<img src="cid:pixels@archivebridge.test">',
				'<img srcset="cid:pixels@archivebridge.test 1x, cid:pixels@archivebridge.test 2x">',
				'<div style="background-image: url(cid:pixels@archivebridge.test)"></div>',
				'<video poster="cid:pixels@archivebridge.test"></video>',
				'<svg><image href="cid:pixels@archivebridge.test"/><rect fill="url(cid:pixels@archivebridge.test)"/></svg>',
				'<iframe src="cid:child@archivebridge.test"></iframe>',
				'</body></html>',
			].join('\n'),
		),
		png(),
		{ contentId: 'sheet@archivebridge.test', location: undefined, mimeType: 'text/css', textEncoding: 'utf-8', data: encoder.encode('p{}') },
		html('<p>child</p>', { contentId: 'child@archivebridge.test', location: 'https://example.invalid/child.html' }),
	])

	assert.deepEqual(diagnostics, [])
	assert.ok(!rootHtml.includes('cid:'), `no cid: reference may survive: ${rootHtml}`)
	assert.match(rootHtml, /<link rel="stylesheet" href="https:\/\/content-id\.archivebridge\.invalid\/sheet%40archivebridge\.test">/)
	assert.match(rootHtml, /<img src="https:\/\/content-id\.archivebridge\.invalid\/pixels%40archivebridge\.test">/)
	assert.match(
		rootHtml,
		/srcset="https:\/\/content-id\.archivebridge\.invalid\/pixels%40archivebridge\.test 1x, https:\/\/content-id\.archivebridge\.invalid\/pixels%40archivebridge\.test 2x"/,
	)
	assert.match(rootHtml, /<video poster="https:\/\/content-id\.archivebridge\.invalid\/pixels%40archivebridge\.test">/)
	assert.match(rootHtml, /background="https:\/\/content-id\.archivebridge\.invalid\/pixels%40archivebridge\.test"/)
	assert.match(rootHtml, /<image href="https:\/\/content-id\.archivebridge\.invalid\/pixels%40archivebridge\.test"\/>/)
	assert.match(rootHtml, /fill="url\(&quot;https:\/\/content-id\.archivebridge\.invalid\/pixels%40archivebridge\.test&quot;\)"/)
	assert.match(rootHtml, /<iframe src="https:\/\/example\.invalid\/child\.html">/)
	// The inline `<style>` body and the `style=` attribute go through the same
	// CSS scanner the viewer uses, so both are covered without either being
	// named as a special case.
	assert.equal([...rootHtml.matchAll(/url\((&quot;)?"?https:\/\/content-id/g)].length, 3)
})

test('a legacy frameset <frame src="cid:..."> is rewritten, and a stray <frame> outside a frameset is correctly not a site at all', () => {
	const child = html('<p>child</p>', { contentId: 'child@archivebridge.test', location: 'https://example.invalid/child.html' })
	const frameset = convert([html('<!DOCTYPE html><html><head></head><frameset><frame src="cid:child@archivebridge.test"></frameset></html>'), child])
	assert.deepEqual(frameset.diagnostics, [])
	assert.match(frameset.rootHtml, /<frame src="https:\/\/example\.invalid\/child\.html">/)

	// A `<frame>` in a body is dropped by HTML tree construction — it is not a
	// frame, so parse5 records no attribute for it and there is nothing to
	// rewrite. Recorded so the asymmetry above reads as intended, not as a gap.
	const stray = convert([html('<!DOCTYPE html><html><body><frame src="cid:child@archivebridge.test"></body></html>'), child])
	assert.match(stray.rootHtml, /<frame src="cid:child@archivebridge\.test">/)
})

test('an SVG xlink:href naming a part is rewritten too', () => {
	const { rootHtml } = convert([html('<svg><image xlink:href="cid:pixels@archivebridge.test"/></svg>'), png()])
	assert.match(rootHtml, /xlink:href="https:\/\/content-id\.archivebridge\.invalid\/pixels%40archivebridge\.test"/)
})

test('a cid: reference is rewritten the same whether or not its Content-ID is percent-encoded (RFC 2392)', () => {
	const { rootHtml } = convert([html('<img src="cid:pixels%40archivebridge.test"><img src="cid:pixels@archivebridge.test">'), png()])
	assert.equal([...rootHtml.matchAll(/https:\/\/content-id\.archivebridge\.invalid\/pixels%40archivebridge\.test/g)].length, 2)
})

test('a url(cid:...) inside a text/css part is rewritten, not only one inside a <style> element', () => {
	const { document } = convert([
		html('<link rel="stylesheet" href="cid:sheet@archivebridge.test">'),
		{
			contentId: 'sheet@archivebridge.test',
			location: undefined,
			mimeType: 'text/css',
			textEncoding: 'utf-8',
			data: encoder.encode('#a { background: url(cid:pixels@archivebridge.test); }\n@import "cid:sheet-two@archivebridge.test";'),
		},
		png(),
		{ contentId: 'sheet-two@archivebridge.test', location: undefined, mimeType: 'text/css', textEncoding: 'utf-8', data: encoder.encode('p{}') },
	])
	const sheet = document.subresources.find((resource) => resource.url === contentIdUrl('sheet@archivebridge.test'))
	assert.ok(sheet)
	assert.match(decoder.decode(sheet.data), /background: url\("https:\/\/content-id\.archivebridge\.invalid\/pixels%40archivebridge\.test"\)/)
	assert.match(decoder.decode(sheet.data), /@import url\("https:\/\/content-id\.archivebridge\.invalid\/sheet-two%40archivebridge\.test"\)/)
})

test('a part carrying only a Content-ID gets the synthetic URL; one carrying a real Content-Location keeps it', () => {
	const { document } = convert([
		html('<img src="cid:pixels@archivebridge.test"><img src="cid:located@archivebridge.test">'),
		png(),
		png({ contentId: 'located@archivebridge.test', location: 'https://example.invalid/located.png' }),
	])
	assert.deepEqual(
		document.subresources.map((resource) => resource.url),
		[PIXELS_URL, 'https://example.invalid/located.png'],
	)
})

test('a part carrying BOTH a Content-ID and a Content-Location is named by its Content-Location, and a cid: reference to it resolves there', () => {
	const { document, rootHtml } = convert([
		html('<img src="cid:located@archivebridge.test">'),
		png({ contentId: 'located@archivebridge.test', location: 'https://example.invalid/located.png' }),
	])
	assert.equal(document.subresources[0]?.url, 'https://example.invalid/located.png')
	assert.match(rootHtml, /<img src="https:\/\/example\.invalid\/located\.png">/)
})

test('a part whose only identity is a synthetic cid: Content-Location — the shape every Blink capture writes for an inlined stylesheet — is reachable and gets a loadable URL', () => {
	const { document, rootHtml, diagnostics } = convert([
		html('<link rel="stylesheet" href="cid:css-1@mhtml.blink">'),
		{ contentId: undefined, location: 'cid:css-1@mhtml.blink', mimeType: 'text/css', textEncoding: 'utf-8', data: encoder.encode('body{color:red}') },
	])
	assert.deepEqual(diagnostics, [])
	assert.equal(document.subresources[0]?.url, contentIdUrl('css-1@mhtml.blink'))
	assert.match(rootHtml, /href="https:\/\/content-id\.archivebridge\.invalid\/css-1%40mhtml\.blink"/)
})

test('the real Chrome golden fixture’s inlined stylesheet comes out linked rather than stranded behind a cid: URL', () => {
	const bytes = readFileSync(fileURLToPath(new URL('../../../../fixtures/mhtml/example-com.chrome.mhtml', import.meta.url)))
	const { document } = parseMhtml(bytes)
	assert.ok(document)
	const { document: webArchive, diagnostics } = convertMhtmlToWebArchive(document)

	assert.deepEqual(diagnostics, [])
	const stylesheetUrl = contentIdUrl('css-26e12f97-5991-48e5-8947-8f89db6bc3fa@mhtml.blink')
	assert.equal(webArchive.subresources[0]?.url, stylesheetUrl)
	// The rewrite must not have changed the part's declared encoding to apply
	// the edit (this part declares none, so neither may the converted resource).
	assert.equal(webArchive.mainResource.textEncoding, document.parts[document.rootPartIndex]?.textEncoding)
	const mainHtml = Array.from(webArchive.mainResource.data, (byte) => String.fromCharCode(byte)).join('')
	assert.ok(mainHtml.includes(`href="${stylesheetUrl}"`), mainHtml)
	assert.ok(!mainHtml.includes('cid:'))
})

test('multiple different Content-IDs get distinct URLs, and each reference lands on its own part', () => {
	const { document, rootHtml } = convert([
		html('<img src="cid:one@archivebridge.test"><img src="cid:two@archivebridge.test"><img src="cid:three@archivebridge.test">'),
		png({ contentId: 'one@archivebridge.test', data: Uint8Array.of(1) }),
		png({ contentId: 'two@archivebridge.test', data: Uint8Array.of(2) }),
		png({ contentId: 'three@archivebridge.test', data: Uint8Array.of(3) }),
	])
	const urls = document.subresources.map((resource) => resource.url)
	assert.equal(new Set(urls).size, 3)
	for (const contentId of ['one', 'two', 'three']) {
		assert.ok(rootHtml.includes(contentIdUrl(`${contentId}@archivebridge.test`)))
	}
})

test('an ambiguous Content-ID resolves to neither part: the reference is left as written, with duplicate-content-id and unresolved-resource', () => {
	const { rootHtml, diagnostics } = convert([
		html('<img src="cid:dup@archivebridge.test">'),
		png({ contentId: 'dup@archivebridge.test', data: Uint8Array.of(1) }),
		png({ contentId: 'dup@archivebridge.test', data: Uint8Array.of(2) }),
	])
	assert.ok(diagnostics.some((diagnostic) => diagnostic.type === 'duplicate-content-id' && diagnostic.contentId === 'dup@archivebridge.test'))
	assert.ok(diagnostics.some((diagnostic) => diagnostic.type === 'unresolved-resource' && diagnostic.url === 'cid:dup@archivebridge.test'))
	assert.match(rootHtml, /<img src="cid:dup@archivebridge\.test">/, 'an ambiguous reference is inert as written, and inventing a target would be worse')
})

test('a Content-ID claimed by one part’s header and another part’s cid: Content-Location is ambiguous, not silently resolved to whichever came first', () => {
	const { rootHtml, diagnostics } = convert([
		html('<img src="cid:shared@archivebridge.test">'),
		png({ contentId: 'shared@archivebridge.test' }),
		{ contentId: undefined, location: 'cid:shared@archivebridge.test', mimeType: 'text/css', textEncoding: 'utf-8', data: encoder.encode('p{}') },
	])
	assert.ok(diagnostics.some((diagnostic) => diagnostic.type === 'duplicate-content-id' && diagnostic.contentId === 'shared@archivebridge.test'))
	assert.match(rootHtml, /<img src="cid:shared@archivebridge\.test">/)
})

test('a cid: reference naming no part is left exactly as written, with one unresolved-resource each', () => {
	const { rootHtml, diagnostics } = convert([html('<img src="cid:absent@archivebridge.test"><img src="cid:absent@archivebridge.test"><img src="cid:">')])
	assert.deepEqual(
		diagnostics.filter((diagnostic) => diagnostic.type === 'unresolved-resource'),
		[
			{ type: 'unresolved-resource', url: 'cid:absent@archivebridge.test' },
			{ type: 'unresolved-resource', url: 'cid:absent@archivebridge.test' },
			{ type: 'unresolved-resource', url: 'cid:' },
		],
	)
	assert.match(rootHtml, /<img src="cid:absent@archivebridge\.test"><img src="cid:absent@archivebridge\.test"><img src="cid:">/)
})

test('a crafted Content-Location inside the synthetic namespace cannot shadow another part’s resource', () => {
	const { document, rootHtml, diagnostics } = convert([
		html('<img src="cid:pixels@archivebridge.test">'),
		// A hostile archive claiming exactly the URL the part below would be given.
		png({ contentId: undefined, location: PIXELS_URL, data: Uint8Array.of(0xff) }),
		png({ data: Uint8Array.of(0x01) }),
	])
	const urls = document.subresources.map((resource) => resource.url)
	assert.equal(new Set(urls).size, 2, `two parts must never share one WebResourceURL: ${JSON.stringify(urls)}`)
	assert.ok(diagnostics.some((diagnostic) => diagnostic.type === 'duplicate-content-location' && diagnostic.url === PIXELS_URL))
	// The reference still names the part that actually holds the Content-ID.
	const referenced = rootHtml.match(/src="([^"]+)"/)?.[1]
	const resolved = document.subresources.find((resource) => resource.url === referenced)
	assert.deepEqual(resolved?.data, Uint8Array.of(0x01))
})

test('conversion translates rather than sanitizes: a cid: script reference is rewritten like any other, because refusing archived script is the viewer’s job', () => {
	const { rootHtml } = convert([
		html('<script src="cid:code@archivebridge.test"></script>'),
		{ contentId: 'code@archivebridge.test', location: undefined, mimeType: 'text/javascript', textEncoding: 'utf-8', data: encoder.encode('/* archived */') },
	])
	assert.match(rootHtml, /<script src="https:\/\/content-id\.archivebridge\.invalid\/code%40archivebridge\.test">/)
})

test('MHTML -> WebArchive -> MHTML keeps every resource reachable from the markup that references it', () => {
	const bytes = readFileSync(fileURLToPath(new URL('../../../../fixtures/mhtml/cid-references.mhtml', import.meta.url)))
	const { document: original, diagnostics: parseDiagnostics } = parseMhtml(bytes)
	assert.deepEqual(parseDiagnostics, [])
	assert.ok(original)

	const { document: webArchive, diagnostics: toWebArchive } = convertMhtmlToWebArchive(original)
	assert.deepEqual(toWebArchive, [{ type: 'unresolved-resource', url: 'cid:absent@archivebridge.test' }], 'only the deliberately-absent reference')

	const { document: reparsed } = parseWebArchive(serializeWebArchive(webArchive))
	assert.ok(reparsed)
	const { document: backToMhtml, diagnostics: toMhtml } = convertWebArchiveToMhtml(reparsed)
	assert.deepEqual(toMhtml, [])

	const { document: finalDocument, diagnostics: finalParse } = parseMhtml(serializeMhtml(backToMhtml))
	assert.deepEqual(finalParse, [])
	assert.ok(finalDocument)

	// Semantic linkage, not bytes: every reference in the final document's
	// markup still names a part the final document actually contains.
	const locations = new Set(finalDocument.parts.flatMap((part) => (part.location === undefined ? [] : [part.location])))
	const finalRootHtml = decoder.decode(finalDocument.parts[finalDocument.rootPartIndex]?.data ?? new Uint8Array())
	for (const identity of ['pixels', 'sheet']) {
		assert.ok(locations.has(contentIdUrl(`${identity}@archivebridge.test`)), `${identity} must still be a part`)
		assert.ok(finalRootHtml.includes(contentIdUrl(`${identity}@archivebridge.test`)), `${identity} must still be referenced`)
	}
	// The frame link is re-expressed as `cid:` again, which is what MHTML frame
	// linkage *is* — so it is checked by resolving it rather than by its text.
	const frameContentId = finalRootHtml.match(/<iframe id="child" src="cid:([^"]+)"/)?.[1]
	assert.ok(frameContentId, finalRootHtml)
	const frame = finalDocument.parts.find((part) => part.contentId === decodeURIComponent(frameContentId))
	assert.equal(frame?.location, 'https://cid-references.invalid/child.html')
	assert.ok(decoder.decode(frame?.data ?? new Uint8Array()).includes('child frame'))

	// The one reference the archive genuinely cannot satisfy stays inert rather
	// than acquiring an invented target on the way round.
	assert.ok(finalRootHtml.includes('src="cid:absent@archivebridge.test"'))
})

test('a reference on markup parse5 records no location for is reported and left inert, rather than failing the whole conversion', () => {
	// HTML tree construction merges a *second* `<body>` start tag's attributes
	// onto the element the first one created, and parse5 records no source
	// location for the merged attribute — there is no span to splice. The
	// viewer fails such a document closed because what survives there is a live
	// external URL; here what survives is an inert `cid:`, so conversion
	// continues and says so.
	const { rootHtml, diagnostics } = convert([html('<!DOCTYPE html><html><body><p>x</p><body background="cid:pixels@archivebridge.test"></body></html>'), png()])

	assert.ok(
		diagnostics.some((diagnostic) => diagnostic.type === 'malformed-resource' && diagnostic.url === 'cid:pixels@archivebridge.test'),
		JSON.stringify(diagnostics),
	)
	assert.match(rootHtml, /background="cid:pixels@archivebridge\.test"/)
})

test('an attribute that merely spells a cid: URI, but is not a reference site, is preserved byte for byte', () => {
	// Every one of these is page *data*, and every one of them names a part
	// this archive really contains — which is precisely the case a rewrite
	// driven by the shape of the value cannot tell from a reference. Rewriting
	// `id` alone would break every CSS selector and `#fragment` naming it;
	// rewriting `value` or `title` would change what the reader sees.
	const sites = [
		'<div id="cid:pixels@archivebridge.test"></div>',
		'<div class="cid:pixels@archivebridge.test"></div>',
		'<div data-key="cid:pixels@archivebridge.test"></div>',
		'<input value="cid:pixels@archivebridge.test">',
		'<div title="cid:pixels@archivebridge.test"></div>',
		'<div aria-label="cid:pixels@archivebridge.test"></div>',
		'<img alt="cid:pixels@archivebridge.test">',
		'<div name="cid:pixels@archivebridge.test"></div>',
		// CSS-shaped text in a non-CSS attribute is not CSS.
		'<div title="url(cid:pixels@archivebridge.test)"></div>',
		'<div data-expression="url(cid:pixels@archivebridge.test)"></div>',
		'<div id="url(cid:pixels@archivebridge.test)"></div>',
		// `<base href>` is a URL, but it is the *input* to reference
		// resolution rather than a reference: it names no part.
		'<base href="cid:pixels@archivebridge.test">',
	]
	const body = sites.join('\n')
	const { rootHtml, diagnostics } = convert([html(body), png()])

	assert.equal(rootHtml, body, 'a non-reference site must survive conversion unchanged')
	assert.deepEqual(diagnostics, [], 'and must not even be reported as a reference')
})

test('a non-reference attribute is left alone on the very element whose reference attribute is rewritten', () => {
	// The two live on one element, so this fails if the rewrite is deciding by
	// element rather than by site.
	const { rootHtml } = convert([html('<img id="cid:pixels@archivebridge.test" alt="cid:pixels@archivebridge.test" src="cid:pixels@archivebridge.test">'), png()])
	assert.equal(rootHtml, `<img id="cid:pixels@archivebridge.test" alt="cid:pixels@archivebridge.test" src="${PIXELS_URL}">`)
})

test('an SVG declarative-animation value attribute is not a reference site: whether it holds a URL depends on its sibling attributeName', () => {
	// `to="cid:…"` is a string to assign to whatever `attributeName` names —
	// an id, a colour, a URL — so it is not unconditionally URL-valued and is
	// left as written. The viewer neutralizes the whole animation mechanism
	// (view/render.ts, SVG_ANIMATION_TAGS), so nothing can load from one either.
	const markup = '<svg><set attributeName="href" to="cid:pixels@archivebridge.test"/></svg>'
	const { rootHtml } = convert([html(markup), png()])
	assert.equal(rootHtml, markup)
})

test('an inline event handler is not a reference site, even when its whole value is a cid: URI', () => {
	const markup = '<div onclick="cid:pixels@archivebridge.test"></div>'
	const { rootHtml } = convert([html(markup), png()])
	assert.equal(rootHtml, markup)
})

test('an <iframe srcdoc> is a nested document, so references inside it are rewritten rather than pattern-matched', () => {
	const { rootHtml } = convert([html('<iframe srcdoc="&lt;img src=&quot;cid:pixels@archivebridge.test&quot;&gt;"></iframe>'), png()])
	assert.match(rootHtml, /srcdoc="&lt;img src=&quot;https:\/\/content-id\.archivebridge\.invalid\/pixels%40archivebridge\.test&quot;&gt;"/)
})

test('a non-reference attribute inside an <iframe srcdoc> is preserved there too', () => {
	const markup = '<iframe srcdoc="&lt;div id=&quot;cid:pixels@archivebridge.test&quot;&gt;"></iframe>'
	const { rootHtml } = convert([html(markup), png()])
	assert.equal(rootHtml, markup)
})

/**
 * The CSS half of the same rule. `url(...)` is only a reference where the
 * value really is CSS — a `style=` attribute, a `<style>` element, an SVG
 * presentation attribute, a `text/css` part — and finding `url(cid:…)` by
 * scanning any value that happens to contain it would rewrite page data
 * just as surely as matching a bare `cid:` would.
 */
test('a url(cid:...) is only CSS where the site really is CSS: the same text is rewritten in a CSS context and left alone everywhere else', () => {
	// A `url()` wrapper is CSS grammar, not URL grammar. In a URL-valued
	// attribute the whole value *is* the URL, so `url(cid:…)` there is simply
	// not a `cid:` URI and names nothing.
	assert.equal(convert([html('<img src="url(cid:pixels@archivebridge.test)">'), png()]).rootHtml, '<img src="url(cid:pixels@archivebridge.test)">')

	// `fill` is a CSS-valued presentation attribute only in SVG's namespace.
	// The identical attribute on an HTML element is inert page data — so this
	// pair fails if the rewrite ever decides by attribute name alone.
	assert.match(
		convert([html('<svg><rect fill="url(cid:pixels@archivebridge.test)"/></svg>'), png()]).rootHtml,
		/fill="url\(&quot;https:\/\/content-id\.archivebridge\.invalid\/pixels%40archivebridge\.test&quot;\)"/,
	)
	assert.equal(convert([html('<div fill="url(cid:pixels@archivebridge.test)"></div>'), png()]).rootHtml, '<div fill="url(cid:pixels@archivebridge.test)"></div>')
})

test('a text part that is not text/css is not scanned for url(cid:...), however much it looks like a stylesheet', () => {
	// Part-level CSS rewriting keys off the declared media type, not off the
	// bytes: `isRewritableTextPart` answers `css` for `text/css` alone. A
	// `text/plain` part is data the page merely stored, and a converter that
	// rewrote it would be editing archived content.
	const stylesheetText = 'a{background:url(cid:pixels@archivebridge.test)}'
	const notCss: MhtmlPart = { contentId: 'notes@archivebridge.test', location: undefined, mimeType: 'text/plain', textEncoding: 'utf-8', data: encoder.encode(stylesheetText) }
	const { document } = convert([html('<p>root</p>'), notCss, png()])
	assert.equal(decoder.decode(document.subresources[0]?.data ?? new Uint8Array()), stylesheetText)
})

/**
 * A WebArchive consumer matches a load against `WebResourceURL` after
 * parsing both as URLs, so two entries that differ only in ways URL
 * canonicalization erases are one resource, not two. Each spelling below is
 * one a hostile archive can put in a `Content-Location` to try to shadow the
 * synthetic URL a real part is about to receive — and each is verified to be
 * canonically equal first, so the test proves a property rather than
 * asserting a string.
 */
for (const [label, hostile] of [
	['an uppercase host and an explicit default port', 'https://CONTENT-ID.ARCHIVEBRIDGE.INVALID:443/pixels%40archivebridge.test'],
	['a mixed-case host alone', 'https://Content-ID.ArchiveBridge.invalid/pixels%40archivebridge.test'],
	['an explicit :443 alone', 'https://content-id.archivebridge.invalid:443/pixels%40archivebridge.test'],
	['dot segments that resolve into the namespace', 'https://content-id.archivebridge.invalid/a/../pixels%40archivebridge.test'],
	['a single dot segment', 'https://content-id.archivebridge.invalid/./pixels%40archivebridge.test'],
] as const) {
	test(`a crafted Content-Location using ${label} cannot shadow the synthetic URL it canonicalizes to`, () => {
		assert.equal(new URL(hostile).href, new URL(PIXELS_URL).href, 'the premise: these are one URL after parsing')
		assert.notEqual(hostile, PIXELS_URL, 'and the premise that raw string equality would have missed it')

		const { document, rootHtml, diagnostics } = convert([
			html('<img src="cid:pixels@archivebridge.test">'),
			// The hostile part comes first, so a rewrite that lost this race would
			// hand the reference the attacker's bytes.
			png({ contentId: undefined, location: hostile, data: Uint8Array.of(0xff) }),
			png({ data: Uint8Array.of(0x01) }),
		])

		const urls = document.subresources.map((resource) => resource.url)
		assert.equal(new Set(urls.map((url) => new URL(url).href)).size, 2, `two parts must never receive one canonical URL: ${JSON.stringify(urls)}`)
		assert.ok(
			diagnostics.some((diagnostic) => diagnostic.type === 'duplicate-content-location'),
			JSON.stringify(diagnostics),
		)

		// The crafted Content-Location is still written exactly as the archive
		// spelled it: only the collision *key* is normalized, because what a part
		// claims its URL was is archive data.
		assert.equal(urls[0], hostile)

		// And the reference still lands on the part that actually holds the
		// Content-ID, not on the attacker's.
		const referenced = rootHtml.match(/src="([^"]+)"/)?.[1]
		assert.ok(referenced !== undefined && referenced !== hostile)
		assert.deepEqual(document.subresources.find((resource) => resource.url === referenced)?.data, Uint8Array.of(0x01))
	})
}

test('a crafted Content-Location differing only in percent-escape case is treated as a collision, though the URL parser alone would not', () => {
	// `encodeURIComponent` only ever emits upper-case escapes, so widening the
	// key this way can never merge two synthetic URLs — it can only catch a
	// hostile spelling, in case a consumer normalizes hex case where the WHATWG
	// parser does not. Being too eager costs a suffix; being too lax costs a
	// shadowed resource.
	const contentId = 'inline[1]@blink'
	const synthetic = contentIdUrl(contentId)
	assert.equal(synthetic, 'https://content-id.archivebridge.invalid/inline%5B1%5D%40blink')
	const hostile = synthetic.toLowerCase()
	assert.notEqual(new URL(hostile).href, new URL(synthetic).href, 'the WHATWG parser alone treats these as distinct')

	const { document } = convert([
		html(`<img src="cid:${contentId}">`),
		png({ contentId: undefined, location: hostile, data: Uint8Array.of(0xff) }),
		png({ contentId, data: Uint8Array.of(0x01) }),
	])
	const urls = document.subresources.map((resource) => resource.url)
	assert.equal(new Set(urls).size, 2)
	assert.notEqual(urls[1], synthetic, 'the real part is moved aside rather than sharing the namespace slot')
})

test('two parts legitimately sharing one real Content-Location still share it: canonical comparison must not start disambiguating real URLs', () => {
	// Two frames that each fetched the same stylesheet is real, measured WebKit
	// output, and is not an error (see assignWebArchiveUrls, case 1).
	const { document, diagnostics } = convert([
		html('<p>root</p>'),
		png({ contentId: undefined, location: 'https://example.invalid/shared.png', data: Uint8Array.of(1) }),
		png({ contentId: undefined, location: 'https://example.invalid/shared.png', data: Uint8Array.of(2) }),
	])
	assert.deepEqual(
		document.subresources.map((resource) => resource.url),
		['https://example.invalid/shared.png', 'https://example.invalid/shared.png'],
	)
	assert.deepEqual(diagnostics, [])
})

test('a real Content-Location is written exactly as the archive spelled it, never canonicalized', () => {
	// Normalizing what a part claims its URL *was* would rewrite archive
	// semantics to settle a question only the collision check asks.
	const spelled = 'https://EXAMPLE.invalid:443/a/../b.png'
	const { document } = convert([html('<p>root</p>'), png({ contentId: undefined, location: spelled })])
	assert.equal(document.subresources[0]?.url, spelled)
})

/**
 * The one place the synthetic namespace is *not* one-to-one by encoding
 * alone, and the reason the collision check may not be weakened into an
 * encoding argument.
 *
 * `encodeURIComponent` leaves `.` unescaped, so the Content-IDs `.` and `..`
 * mint `…invalid/.` and `…invalid/..` — two distinct strings that are both
 * *dot segments*, and so both canonicalize to the namespace root. Measured
 * over every Content-ID of one code point up to U+02FF plus the obvious
 * multi-character dot and percent shapes, these two are the only inputs
 * whose minted URL is not already canonical; percent-escaping the dot does
 * not help, because the URL Standard counts `%2e` as a dot segment too.
 *
 * That is exactly why {@link collisionKey} compares canonical forms: the
 * encoding cannot carry the guarantee on its own.
 */
test('two Content-IDs that mint dot segments canonicalize to one URL, and are still given separate resources', () => {
	assert.equal(new URL(contentIdUrl('.')).href, new URL(contentIdUrl('..')).href, 'the premise: distinct Content-IDs, one canonical URL')
	assert.notEqual(contentIdUrl('.'), contentIdUrl('..'), 'and the premise that raw string equality would have missed it')

	const { document, rootHtml, diagnostics } = convert([
		html('<img id="first" src="cid:."><img id="second" src="cid:..">'),
		png({ contentId: '.', data: Uint8Array.of(1) }),
		png({ contentId: '..', data: Uint8Array.of(2) }),
	])

	const urls = document.subresources.map((resource) => resource.url)
	assert.equal(new Set(urls.map((url) => new URL(url).href)).size, 2, `two parts must never receive one canonical URL: ${JSON.stringify(urls)}`)
	assert.ok(
		diagnostics.some((diagnostic) => diagnostic.type === 'duplicate-content-location'),
		JSON.stringify(diagnostics),
	)

	// Each reference still lands on the bytes of the part that actually holds
	// its Content-ID, which is the property that matters.
	const bytesFor = (id: string) => {
		const referenced = rootHtml.match(new RegExp(`id="${id}" src="([^"]+)"`))?.[1]
		return document.subresources.find((resource) => resource.url === referenced)?.data
	}
	assert.deepEqual(bytesFor('first'), Uint8Array.of(1))
	assert.deepEqual(bytesFor('second'), Uint8Array.of(2))
})

test('a real Content-Location on the namespace root cannot shadow a part whose Content-ID mints a dot segment', () => {
	// The hostile part comes first and claims the root the `.` part's minted
	// URL canonicalizes to — the collision a raw-string check would miss,
	// since `…invalid/` and `…invalid/.` are different strings.
	const { document, rootHtml } = convert([
		html('<img src="cid:.">'),
		png({ contentId: undefined, location: `${CONTENT_ID_URL_ORIGIN}/`, data: Uint8Array.of(0xff) }),
		png({ contentId: '.', data: Uint8Array.of(1) }),
	])

	const urls = document.subresources.map((resource) => resource.url)
	assert.equal(urls[0], `${CONTENT_ID_URL_ORIGIN}/`, 'the real Content-Location is still written as spelled')
	assert.equal(new Set(urls.map((url) => new URL(url).href)).size, 2, JSON.stringify(urls))

	const referenced = rootHtml.match(/src="([^"]+)"/)?.[1]
	assert.deepEqual(
		document.subresources.find((resource) => resource.url === referenced)?.data,
		Uint8Array.of(1),
		'the reference must reach the part holding the Content-ID, not the attacker’s',
	)
})
