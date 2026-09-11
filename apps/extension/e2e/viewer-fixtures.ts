/**
 * The archive files the viewer E2E suite opens, and how each one is made.
 *
 * There are two kinds, for two different reasons:
 *
 * - **Captured.** A live deterministic page goes through the real Chrome
 *   pipeline — `chrome.pageCapture.saveAsMHTML` in the extension's own
 *   service worker, then `@xarsh/archivebridge`'s converter — and lands on
 *   disk as a `.webarchive`. This is the flow that matters most (a real
 *   browser capture, really converted, really opened), and it is what the
 *   fidelity tests use.
 * - **Hand-built.** Blink's capture **strips `<script>` elements** and
 *   rewrites references as it serializes (docs/architecture.md, "Format vs.
 *   capture semantics"), so a captured archive cannot carry the hostile
 *   content the security tests need to prove is inert. Real `.webarchive`
 *   files come from Safari, whose capture keeps live script and external
 *   references — and whose *renderer* runs them (measured). So the hostile
 *   fixture is built the way a real Safari archive would look, through the
 *   library's own public `serializeWebArchive`, with no test hook anywhere.
 *
 * Every URL in a hand-built fixture points at the local beacon server, so
 * "the viewer made no network request" is a claim the server itself can
 * confirm or refute.
 */

import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { convertMhtmlToWebArchive, parseMhtml, serializeWebArchive, type WebArchiveDocument, type WebArchiveResource } from '@xarsh/archivebridge'
import type { Worker } from 'playwright'

const encoder = new TextEncoder()

/** A directory that lives as long as the test run, holding the archive files navigated to. */
export async function createFixtureDirectory(): Promise<string> {
	return await mkdtemp(join(tmpdir(), 'archivebridge-viewer-'))
}

/** Writes `bytes` into `directory` as `name` and returns the `file:` URL to navigate to. */
export async function writeFixture(directory: string, name: string, bytes: Uint8Array): Promise<string> {
	const path = join(directory, name)
	await writeFile(path, bytes)
	return pathToFileURL(path).href
}

/**
 * Captures `tabId` as MHTML through the extension's own service worker.
 *
 * The bytes cross into Node as base64 because a Playwright `evaluate`
 * result is JSON: a `Uint8Array` would arrive as an object with one key
 * per byte (the same platform fact that forces the offscreen document's
 * `BroadcastChannel` handoff — see `chrome/blob-url-channel.ts`).
 */
export async function captureMhtmlBytes(serviceWorker: Worker, tabId: number): Promise<Uint8Array> {
	const base64 = await serviceWorker.evaluate(async (id) => {
		const blob = await chrome.pageCapture.saveAsMHTML({ tabId: id })
		const bytes = new Uint8Array(await blob.arrayBuffer())
		let binary = ''
		for (const byte of bytes) {
			binary += String.fromCharCode(byte)
		}
		return btoa(binary)
	}, tabId)
	return Uint8Array.from(atob(base64), (character) => character.charCodeAt(0))
}

/** Converts captured MHTML into WebArchive bytes with the library, exactly as the extension's Save as WebArchive command does. */
export function toWebArchiveBytes(mhtml: Uint8Array): Uint8Array {
	const parsed = parseMhtml(mhtml)
	if (parsed.document === undefined) {
		throw new Error(`the capture could not be parsed: ${parsed.diagnostics.map((diagnostic) => diagnostic.type).join(', ')}`)
	}
	return serializeWebArchive(convertMhtmlToWebArchive(parsed.document).document)
}

function resource(url: string, mimeType: string, data: Uint8Array | string, textEncoding?: string): WebArchiveResource {
	return {
		url,
		mimeType,
		data: typeof data === 'string' ? encoder.encode(data) : data,
		textEncoding: textEncoding ?? (typeof data === 'string' ? 'UTF-8' : undefined),
		frameName: undefined,
		response: undefined,
		extra: new Map(),
	}
}

function webArchive(main: WebArchiveResource, subresources: readonly WebArchiveResource[] = [], subframeArchives: readonly WebArchiveDocument[] = []): WebArchiveDocument {
	return { mainResource: main, subresources, subframeArchives, extra: new Map() }
}

/** A 1x1 transparent GIF: the smallest thing that is unambiguously a decodable image. */
const GIF_1X1 = Uint8Array.from(atob('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'), (character) => character.charCodeAt(0))

/**
 * A `.webarchive` shaped like one a hostile page saved from Safari: live
 * inline and external script, inline event handlers, every kind of
 * external reference, a form, escaping links, and an archived script the
 * viewer *has* the bytes for and must still refuse to load.
 *
 * It also carries the references that need **no script at all** to reach the
 * network, each of which was measured to load in Chromium 153 and to defeat
 * an earlier version of the rewrite:
 *
 * - CSS `url()` and `@import` spelled with escapes (`u\72l(`, `@\69mport`),
 *   which the browser decodes before comparing and a keyword matcher misses.
 * - A bare `<string>` in `image-set()`, which is a URL with no `url()` —
 *   including one written inside a `var()`/`env()` fallback in the same
 *   declaration, which substitution puts in the same place.
 * - SVG SMIL (`<set>`, `<animate>`) assigning a fresh URL to an `href` the
 *   rewrite had already neutralized — declarative, so the sandbox's missing
 *   `allow-scripts` does not stop it.
 * - The obsolete `background` attribute on `<body>` and table sections.
 * - SVG presentation attributes (`fill`, `stroke`, `filter`, `mask`,
 *   `clip-path`, `marker-*`), which are CSS values in attribute form and
 *   fetch a `url()` with no stylesheet and no `style=` involved.
 * - An SVG `<use>` naming another archived document, whose own external
 *   references Chromium instantiates in *this* document.
 * - A `data:text/css` stylesheet and a `data:text/html` frame, whose nested
 *   content is live even though a `data:` URL "carries its own bytes".
 *
 * What is deliberately **not** here is the one construct the rewrite cannot
 * see — a URL string reached through the CSS cascade — which has its own
 * fixture ({@link buildCspBackstopWebArchive}) precisely so this one can
 * assert *zero* CSP violations.
 *
 * `beaconOrigin` is the local test server. Nothing here may reach it.
 */
export function buildHostileWebArchive(beaconOrigin: string): Uint8Array {
	const page = 'https://hostile.invalid/index.html'
	const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>ORIGINAL_TITLE</title>
<meta http-equiv="refresh" content="0;url=${beaconOrigin}/meta-refresh">
<meta http-equiv="Content-Security-Policy" content="default-src ${beaconOrigin}">
<base href="${beaconOrigin}/base/">
<link rel="stylesheet" href="${beaconOrigin}/external.css">
<link rel="preconnect" href="${beaconOrigin}">
<link rel="dns-prefetch" href="${beaconOrigin}">
<link rel="preload" as="image" href="${beaconOrigin}/preload.png">
<link rel="icon" href="${beaconOrigin}/favicon.ico">
<style>@import url(${beaconOrigin}/import.css);#painted{background-image:url(${beaconOrigin}/css-background.png)}
/* CSS identifiers and at-keywords may be spelled with escapes, and the
   browser compares the *decoded* value: every spelling below was measured
   to load in Chromium 153, and a keyword-matching scanner misses them all. */
#css-escaped-url{background-image:u\\72l(${beaconOrigin}/css-escaped-url.png)}
#css-escaped-url-leading{background-image:\\75rl(${beaconOrigin}/css-escaped-url-leading.png)}
#css-escaped-url-all{background-image:\\75\\72\\6c(${beaconOrigin}/css-escaped-url-all.png)}
/* A bare string in image-set() is a URL with no url() around it. */
#css-image-set{background-image:image-set("${beaconOrigin}/css-image-set.png" 1x)}
#css-webkit-image-set{background-image:-webkit-image-set("${beaconOrigin}/css-webkit-image-set.png" 1x)}
/* var()/env() substitute their fallback into the image-set argument, where a
   bare string is a URL: both were measured to load in Chromium 153, and both
   are written right here, so the scanner can neutralize them. */
#css-image-set-var{background-image:image-set(var(--absent,"${beaconOrigin}/css-image-set-var.png") 1x)}
#css-image-set-env{background-image:image-set(env(--absent,"${beaconOrigin}/css-image-set-env.png") 1x)}</style>
<style>@\\69mport "${beaconOrigin}/css-escaped-import.css";#escaped-import{color:red}</style>
<!-- A data: URL carries its own bytes, but a data: *stylesheet* also carries
     its own live references: this nested CSS imports and paints from the
     beacon. Measured to load in Chromium 153 outside the viewer. -->
<style>@import "data:text/css,${encodeURIComponent(`@import "${beaconOrigin}/data-css-import.css";#data-css{background-image:url("${beaconOrigin}/data-css-url.png")}`)}";#after-data-import{color:red}</style>
<link id="data-stylesheet" rel="stylesheet" href="data:text/css,${encodeURIComponent(`#data-link{background-image:url("${beaconOrigin}/data-link-url.png")}`)}">
</head>
<body background="${beaconOrigin}/body-background.png">
<p id="marker">hostile archive</p>
<p id="painted">painted</p>
<script id="inline-script">
	document.title = 'INLINE_SCRIPT_RAN'
	document.documentElement.setAttribute('data-inline-script', 'ran')
	fetch('${beaconOrigin}/fetch')
	new Image().src = '${beaconOrigin}/image-constructor'
	if (navigator.sendBeacon) { navigator.sendBeacon('${beaconOrigin}/send-beacon', 'x') }
	try { new WebSocket('${beaconOrigin.replace('http://', 'ws://')}/socket') } catch (error) {}
	const request = new XMLHttpRequest()
	request.open('GET', '${beaconOrigin}/xhr')
	request.send()
</script>
<script src="${beaconOrigin}/external.js"></script>
<script src="https://hostile.invalid/archived.js"></script>
<img id="handler-image" src="${beaconOrigin}/broken.png" onerror="document.documentElement.setAttribute('data-handler','ran');fetch('${beaconOrigin}/onerror')" onload="fetch('${beaconOrigin}/onload')">
<img id="missing-image" src="${beaconOrigin}/never-archived.png">
<img id="responsive-missing" srcset="${beaconOrigin}/one.png 1x, ${beaconOrigin}/two.png 2x">
<iframe id="external-frame" src="${beaconOrigin}/frame.html"></iframe>
<iframe id="srcdoc-frame" srcdoc="&lt;img src=&quot;${beaconOrigin}/inside-srcdoc.png&quot;&gt;&lt;link rel=&quot;preconnect&quot; href=&quot;${beaconOrigin}&quot;&gt;"></iframe>
<object id="object-content" data="${beaconOrigin}/object"></object>
<embed id="embed-content" src="${beaconOrigin}/embed">
<form id="escape-form" action="${beaconOrigin}/form" method="get" target="_top"><input name="field" value="1"><button id="submit-button" type="submit">submit</button></form>
<a id="top-link" href="${beaconOrigin}/top-navigation" target="_top">top</a>
<a id="blank-link" href="${beaconOrigin}/new-window" target="_blank">blank</a>
<a id="javascript-link" href="javascript:document.documentElement.setAttribute('data-js-url','ran')">js</a>
<svg width="10" height="10"><image id="svg-image" href="${beaconOrigin}/svg.png" width="10" height="10"/><script>fetch('${beaconOrigin}/svg-script')</script></svg>
<!--
	SMIL needs no scripting, so "no allow-scripts" does not stop it: each of
	these was measured to put a live URL back on an attribute the rewrite had
	already neutralized, and to fetch it, inside sandbox="allow-same-origin".
-->
<svg width="30" height="10">
<image id="smil-set" href="${beaconOrigin}/smil-set.png" width="9" height="9"><set attributeName="href" to="${beaconOrigin}/smil-set-restored.png" begin="0s"/></image>
<image id="smil-animate" href="${beaconOrigin}/smil-animate.png" width="9" height="9"><animate attributeName="href" values="${beaconOrigin}/smil-animate-restored.png" begin="0s" dur="9s" fill="freeze"/></image>
<image id="smil-target" href="${beaconOrigin}/smil-target.png" width="9" height="9"/>
<set id="smil-external" href="#smil-target" attributeName="href" to="${beaconOrigin}/smil-external-restored.png" begin="0s"/>
<image id="smil-event" href="${beaconOrigin}/smil-event.png" width="9" height="9"><set attributeName="href" to="${beaconOrigin}/smil-event-restored.png" begin="smil-event.click;0s"/></image>
</svg>
<!--
	CSS values in attribute form. Measured in Chromium 153: exactly these eight
	SVG presentation attributes fetch a url() with no stylesheet, no style=
	attribute and no script anywhere.
-->
<svg width="40" height="40">
<rect id="pres-fill" width="9" height="9" fill="url(${beaconOrigin}/pres-fill.png)"/>
<rect id="pres-stroke" width="9" height="9" y="10" stroke="url(${beaconOrigin}/pres-stroke.png)" stroke-width="2"/>
<rect id="pres-effects" width="9" height="9" y="20" filter="url(${beaconOrigin}/pres-filter.png)" mask="url(${beaconOrigin}/pres-mask.png)" clip-path="url(${beaconOrigin}/pres-clip.png)"/>
<path id="pres-markers" d="M0 30 L9 39" stroke="black" marker-start="url(${beaconOrigin}/pres-marker-start.png)" marker-mid="url(${beaconOrigin}/pres-marker-mid.png)" marker-end="url(${beaconOrigin}/pres-marker-end.png)"/>
</svg>
<!--
	An SVG <use> naming another document does not read bytes from it: Chromium
	clones the referenced subtree into *this* document, where the archived
	SVG's own references load. The sprite below is really in the archive, so
	"we have the bytes" is again not a reason to instantiate them. A <use>
	naming this document's own symbol is the case that must keep working.
-->
<svg width="40" height="20">
<use id="use-external" href="https://hostile.invalid/sprite.svg#payload"/>
<use id="use-xlink" xlink:href="${beaconOrigin}/other-sprite.svg#payload" x="10"/>
<symbol id="local-symbol"><image id="use-local-image" href="https://hostile.invalid/local.gif" width="9" height="9"/></symbol>
<use id="use-local" href="#local-symbol" x="20"/>
</svg>
<!-- A data: frame is a document whose markup the rewrite never saw. -->
<iframe id="data-frame" src="data:text/html,${encodeURIComponent(`<img src="${beaconOrigin}/data-frame-image.png"><link rel="preconnect" href="${beaconOrigin}">`)}" width="40" height="40"></iframe>
<!-- The obsolete presentational attribute every engine still implements. -->
<table id="table-background" background="${beaconOrigin}/table-background.png"><tbody id="tbody-background" background="${beaconOrigin}/tbody-background.png"><tr id="tr-background" background="${beaconOrigin}/tr-background.png"><td id="td-background" background="${beaconOrigin}/td-background.png">cell</td></tr></tbody></table>
<video id="media" poster="${beaconOrigin}/poster.jpg"><source src="${beaconOrigin}/media.mp4"></video>
</body>
</html>
`
	return serializeWebArchive(
		webArchive(resource(page, 'text/html', html), [
			// The archive really does contain this script's bytes. The viewer must
			// still never load it: a resolvable script is the case where "we have
			// the bytes, so why not" would be the wrong answer.
			resource('https://hostile.invalid/archived.js', 'application/javascript', "document.title = 'ARCHIVED_SCRIPT_RAN'"),
			// Same answer for a `<use>` target the archive does contain: its
			// contents would be instantiated in the rendered document, external
			// references and all.
			resource(
				'https://hostile.invalid/sprite.svg',
				'image/svg+xml',
				`<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><symbol id="payload"><image href="${beaconOrigin}/sprite-image.png" width="9" height="9"/><rect width="5" height="5" fill="url(${beaconOrigin}/sprite-fill.png)"/></symbol></svg>`,
			),
			// The image a same-document `<use>` clones: it must still render, so
			// the refusal above is provably about *other documents* rather than
			// about `<use>`.
			resource('https://hostile.invalid/local.gif', 'image/gif', GIF_1X1),
		]),
	)
}

/**
 * A `.webarchive` carrying the one construct the reconstruction layer
 * deliberately does **not** neutralize, so the CSP's role can be asserted
 * rather than assumed.
 *
 * A bare `<string>` in `image-set()` is a URL, and CSS custom properties can
 * carry that string from anywhere in the cascade — another rule, another
 * sheet, an inline `style=`, an `@property` initial value. Each shape below
 * was measured to load in Chromium 153, and none of them is a reference in
 * the text the scanner reads: `--absent` is a URL only because some *other*
 * declaration substitutes it. Reconstructing that would mean evaluating the
 * cascade (docs/architecture.md, "The security contract, as rules"), so
 * `img-src blob: data:` is what stops it — which is exactly what the test
 * using this fixture asserts, including that the URL is still visibly there
 * in the rendered stylesheet.
 */
export function buildCspBackstopWebArchive(beaconOrigin: string): Uint8Array {
	const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>cascade fixture</title>
<style>
:root{--cascade:"${beaconOrigin}/cascade-root.png"}
#cascade-var{background-image:image-set(var(--cascade) 1x)}
#cascade-webkit{background-image:-webkit-image-set(var(--cascade) 1x)}
#cascade-mask{mask-image:image-set(var(--cascade-mask) 1x);--cascade-mask:"${beaconOrigin}/cascade-mask.png"}
@property --cascade-property{syntax:"<string>";inherits:false;initial-value:"${beaconOrigin}/cascade-property.png"}
#cascade-property{background-image:image-set(var(--cascade-property) 1x)}
div{width:20px;height:20px}
</style>
</head>
<body>
<p id="marker">cascade archive</p>
<div id="cascade-var">1</div>
<div id="cascade-webkit">2</div>
<div id="cascade-mask">3</div>
<div id="cascade-property">4</div>
<div id="cascade-inline" style='--cascade-inline:"${beaconOrigin}/cascade-inline.png";background-image:image-set(var(--cascade-inline) 1x)'>5</div>
</body>
</html>
`
	return serializeWebArchive(webArchive(resource('https://cascade.invalid/index.html', 'text/html', html)))
}

/**
 * A `.webarchive` exercising the resource graph rather than the threat
 * model: a font behind an `@font-face`, an `@import` chain, a `srcset`, a
 * `data:` URL, a same-document fragment reference, and one reference the
 * archive deliberately does not contain.
 *
 * Hand-built because every one of those has to be present with known bytes
 * for the assertion to be exact — a browser capture decides for itself
 * which of them it keeps.
 */
export function buildResourceWebArchive(beaconOrigin: string): Uint8Array {
	const origin = 'https://resources.invalid'
	const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>resource fixture</title>
<link rel="stylesheet" href="${origin}/outer.css">
<style>#inline-styled{background-image:url(${origin}/pixel.gif);width:13px}</style>
</head>
<body>
<p id="typeface">typeface</p>
<p id="inline-styled">styled</p>
<p id="imported">imported</p>
<img id="responsive" srcset="${origin}/pixel.gif 1x, ${origin}/pixel-2x.gif 2x" width="9" height="9">
<img id="inline-data" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" width="7" height="7">
<img id="absent" src="${beaconOrigin}/absent.gif">
<svg width="8" height="8"><rect width="8" height="8" fill="url(#gradient)"/><defs><linearGradient id="gradient"><stop offset="0" stop-color="red"/></linearGradient></defs></svg>
</body>
</html>
`
	// A `@font-face` src has to resolve to archived bytes for the rewrite to be
	// provable; whether those bytes are a font a rasterizer accepts is the
	// browser's business, not the resolver's.
	const outerCss = `@import url(${origin}/imported.css);\n@font-face{font-family:ArchiveBridgeTest;src:url(${origin}/typeface.woff2) format("woff2")}\n#typeface{font-family:ArchiveBridgeTest;color:rgb(4,5,6)}\n`
	const importedCss = '#imported{color:rgb(7,8,9)}\n'
	return serializeWebArchive(
		webArchive(resource(`${origin}/index.html`, 'text/html', html), [
			resource(`${origin}/outer.css`, 'text/css', outerCss),
			resource(`${origin}/imported.css`, 'text/css', importedCss),
			resource(`${origin}/pixel.gif`, 'image/gif', GIF_1X1),
			resource(`${origin}/pixel-2x.gif`, 'image/gif', GIF_1X1),
			resource(`${origin}/typeface.woff2`, 'font/woff2', new Uint8Array([0x77, 0x4f, 0x46, 0x32, 0, 0, 0, 0])),
		]),
	)
}

/** A second, visibly different archive, for asserting what happens to the first one's resources when the viewer moves on. */
export function buildSecondWebArchive(): Uint8Array {
	const origin = 'https://second.invalid'
	const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>second</title></head><body><p id="second-marker">second archive</p><img id="second-image" src="${origin}/pixel.gif" width="5" height="5"></body></html>`
	return serializeWebArchive(webArchive(resource(`${origin}/index.html`, 'text/html', html), [resource(`${origin}/pixel.gif`, 'image/gif', GIF_1X1)]))
}

/**
 * A `.webarchive` whose live external reference **cannot be rewritten**, so
 * the viewer has to refuse the document rather than show it.
 *
 * The mechanism is HTML's own tree construction: a second `<body>` start tag
 * does not create an element, it merges its attributes onto the `<body>` the
 * first one made. `parse5` records no source location for a merged
 * attribute, so there is no span for the renderer to splice — while Chromium
 * honours the attribute and loads it (both measured). That makes it the one
 * shape where "warn and ship it" would leave exactly the live external URL
 * the rewrite exists to remove, and it is why an unsplicable rewrite fails
 * the whole document closed.
 */
export function buildUnrewritableWebArchive(beaconOrigin: string): Uint8Array {
	const html = `<!doctype html><html lang="en"><body><p id="unrewritable-marker">should never be shown</p><body background="${beaconOrigin}/merged-body-background.png">`
	return serializeWebArchive(webArchive(resource('https://unrewritable.invalid/index.html', 'text/html', html)))
}

/** Bytes that announce themselves as a binary plist and are not one — the everyday "this file is broken" case, which must produce a message rather than anything else. */
export function buildMalformedWebArchive(): Uint8Array {
	return encoder.encode('bplist00 this is not a property list at all')
}
