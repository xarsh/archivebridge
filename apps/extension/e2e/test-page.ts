/**
 * The deterministic local page the extension E2E tests capture.
 *
 * Everything here is fixed: the markup, the CSS, the image bytes and the
 * frame tree. That is the point — assertions can name exact URLs, exact
 * part counts and exact frame nesting, so a failure means the pipeline
 * changed rather than that the internet did. No test ever reaches a real
 * site (CONTRIBUTING.md/architecture.md: no external network in normal
 * CI).
 *
 * The server records every request it receives **and every TCP connection
 * opened to it**, which is what turns the viewer's "no external network
 * fallback" rule into an assertion rather than an aspiration. Both are
 * needed: an HTTP request covers `<img>`, `fetch`, a stylesheet and a
 * frame, but `<link rel=preconnect>` and `rel=dns-prefetch` open a
 * connection *without* sending a request, and no CSP fetch directive
 * governs them — so a viewer that only counted requests would call itself
 * silent while talking to a server. See docs/architecture.md, "Archive
 * viewer".
 *
 * One origin is served on two hostnames so the page can embed a genuinely
 * cross-origin frame: `127.0.0.1` and `localhost` are different origins to
 * the browser even on the same port.
 */

import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { deflateSync } from 'node:zlib'

/** Side length of the generated PNG. 1024x1024 of incompressible RGB is ~3 MB, which makes the captured MHTML a realistic multi-megabyte payload rather than a toy one. */
const IMAGE_SIDE = 1024

const CRC_TABLE = (() => {
	const table = new Uint32Array(256)
	for (let n = 0; n < 256; n += 1) {
		let c = n
		for (let k = 0; k < 8; k += 1) {
			c = (c & 1) === 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
		}
		table[n] = c >>> 0
	}
	return table
})()

function crc32(bytes: Uint8Array): number {
	let c = 0xffffffff
	for (const byte of bytes) {
		c = (CRC_TABLE[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8)
	}
	return (c ^ 0xffffffff) >>> 0
}

function pngChunk(type: string, data: Uint8Array): Buffer {
	const typeBytes = Buffer.from(type, 'latin1')
	const out = Buffer.alloc(8 + data.length + 4)
	out.writeUInt32BE(data.length, 0)
	typeBytes.copy(out, 4)
	Buffer.from(data).copy(out, 8)
	out.writeUInt32BE(crc32(Buffer.concat([typeBytes, Buffer.from(data)])), 8 + data.length)
	return out
}

/**
 * A valid PNG of `side`x`side` pixels whose content is a fixed linear
 * congruential sequence: deterministic across runs and machines, and
 * incompressible, so the file size is predictable and the capture is
 * genuinely large rather than large-then-compressed-to-nothing.
 */
function deterministicPng(side: number): Buffer {
	const stride = side * 3 + 1
	const raw = Buffer.alloc(side * stride)
	let x = 1
	for (let y = 0; y < side; y += 1) {
		const rowStart = y * stride
		for (let i = 0; i < side * 3; i += 1) {
			x = (x * 1664525 + 1013904223) >>> 0
			raw[rowStart + 1 + i] = (x >>> 24) & 0xff
		}
	}
	const header = Buffer.alloc(13)
	header.writeUInt32BE(side, 0)
	header.writeUInt32BE(side, 4)
	header[8] = 8 // bit depth
	header[9] = 2 // colour type: truecolour
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		pngChunk('IHDR', header),
		pngChunk('IDAT', deflateSync(raw, { level: 0 })),
		pngChunk('IEND', Buffer.alloc(0)),
	])
}

/**
 * A valid PNG of `side`x`side` pixels in one flat colour.
 *
 * The opposite of {@link deterministicPng} and for the opposite reason: a
 * test that asks *which* image reached a canvas needs an answer it can read
 * off a single pixel, not a byte sequence it has to compare whole.
 */
function solidPng(side: number, [red, green, blue]: readonly [number, number, number]): Buffer {
	const stride = side * 3 + 1
	const raw = Buffer.alloc(side * stride)
	for (let y = 0; y < side; y += 1) {
		for (let x = 0; x < side; x += 1) {
			const at = y * stride + 1 + x * 3
			raw[at] = red
			raw[at + 1] = green
			raw[at + 2] = blue
		}
	}
	const header = Buffer.alloc(13)
	header.writeUInt32BE(side, 0)
	header.writeUInt32BE(side, 4)
	header[8] = 8
	header[9] = 2
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		pngChunk('IHDR', header),
		pngChunk('IDAT', deflateSync(raw, { level: 0 })),
		pngChunk('IEND', Buffer.alloc(0)),
	])
}

/** The exact PNG the test page serves. Exported so a test can assert the archived copy is byte-identical. */
export const imageBytes: Buffer = deterministicPng(IMAGE_SIDE)

/** A small version of the same deterministic PNG, for the Firefox fixture — whose archive crosses a browser-automation boundary as text, where three megabytes would be nothing but cost. */
export const smallImageBytes: Buffer = deterministicPng(16)

/** The exact bytes behind the Firefox fixture's `blob:` image. Exported so a test can assert they survived a round trip only the page principal could have started. */
export const firefoxBlobResourceBytes: Buffer = Buffer.from(
	'<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="#00ff00"/></svg>',
	'utf8',
)

/** The 1x1 transparent GIF the Firefox fixture references inline. A `data:` reference carries its own bytes, so the archive must keep it as written and must *not* mint a MIME part for it. */
export const FIREFOX_DATA_IMAGE_URL = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'

const STYLESHEET = 'body { background: #fff; color: #111; font-family: system-ui, sans-serif; }\n'

/** The Firefox fixture whose canvases mostly cannot be snapshotted — the one the capture's *attempt* bound is measured against. */
export const CANVAS_BOUNDS_PATH = '/firefox/canvas-bounds.html'
/** How many ordinary, snapshottable canvases that page builds, before the unreadable ones. */
export const CANVAS_BOUNDS_PLAIN = 2
/** How many unreadable canvases follow them. Enough that a bound counted in successful snapshots would be visibly exceeded. */
export const CANVAS_BOUNDS_UNREADABLE = 8
/** What that page renames itself to once every canvas exists and it has confirmed how many of them refuse to be read. */
export const CANVAS_BOUNDS_READY_TITLE = `canvas bounds ready: ${CANVAS_BOUNDS_UNREADABLE} unreadable`

/**
 * The fixture behind the tainted-canvas permission matrix: two canvases
 * built the same way out of two different origins.
 *
 * `#tainted` is drawn from an image on the server's *other* hostname, with
 * no CORS headers anywhere, so the page's own principal loses it — which
 * the page confirms about itself before renaming itself ready, so a test
 * can tell "the extension read something privileged" from "there was
 * nothing to be privileged about". `#clean` is the control, drawn the same
 * way from the page's own origin, and must survive every permission state
 * unchanged.
 *
 * Each canvas is a backdrop with its image covering one quarter of it, so a
 * single archived pixel says which content reached the archive and a second
 * one says the rest of the canvas came too.
 */
export const TAINTED_CANVAS_PATH = '/firefox/tainted-canvas.html'
/** The canvases' bitmap side, in pixels. */
export const TAINTED_CANVAS_SIDE = 32
/** Colour of the cross-origin image drawn into `#tainted`: the content only a privileged reader can extract. */
export const TAINTED_CANVAS_CROSS_ORIGIN_RGB = [255, 0, 255] as const
/** Colour of the same-origin image drawn into `#clean`. */
export const TAINTED_CANVAS_SAME_ORIGIN_RGB = [0, 0, 255] as const
/** Backdrop of `#tainted`, under and around the cross-origin image. */
export const TAINTED_CANVAS_TAINTED_BACKDROP_RGB = [0, 255, 0] as const
/** Backdrop of `#clean`. */
export const TAINTED_CANVAS_CLEAN_BACKDROP_RGB = [255, 255, 0] as const
/** What that page renames itself to once it has drawn both canvases and found that exactly one of them is beyond its own reach. */
export const TAINTED_CANVAS_READY_TITLE = 'tainted canvas ready: 1 unreadable by the page'
/** The cross-origin image `#tainted` is drawn from, served on the server's second hostname. */
export const taintedCanvasCrossOriginImageBytes: Buffer = solidPng(16, TAINTED_CANVAS_CROSS_ORIGIN_RGB)
/** The same-origin image `#clean` is drawn from. */
export const taintedCanvasSameOriginImageBytes: Buffer = solidPng(16, TAINTED_CANVAS_SAME_ORIGIN_RGB)

/**
 * The page the *viewer* tests capture, at `/viewer/`.
 *
 * It is deliberately separate from `/`: the save suite asserts on exactly
 * what `/` produces, and a viewer needs things a save test does not (an
 * attached shadow root, a `srcset`, a CSS background image, a nested
 * frame at a different path). Keeping them apart means neither suite's
 * fixture drifts because the other one needed something.
 *
 * Everything here is fixed, so a rendered assertion can name an exact
 * colour, an exact string and an exact size.
 *
 * It deliberately has no `srcset`: Blink's capture **drops the attribute
 * entirely** (measured — the element survives with neither `srcset` nor
 * `src`), so a responsive image here could only ever assert a capture gap.
 * `srcset` resolution is covered against a hand-built fixture instead, in
 * `viewer-fixtures.ts`, which is also where a real Safari-produced one
 * would come from.
 */
function viewerPages(origin: string): ReadonlyMap<string, { readonly contentType: string; readonly body: string | Buffer }> {
	return new Map([
		[
			'/viewer/',
			{
				contentType: 'text/html; charset=utf-8',
				body: `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>ArchiveBridge viewer fixture</title><link rel="stylesheet" href="${origin}/viewer/style.css"></head>
<body>
<h1 id="heading">viewer fixture</h1>
<p id="painted">painted</p>
<img id="image" src="${origin}/image.png" width="64" height="64" alt="deterministic">
<iframe id="frame" src="${origin}/viewer/frame.html"></iframe>
<div id="shadow-host"></div>
<a id="external-link" href="https://example.invalid/away" target="_top">away</a>
<script>
	document.getElementById('shadow-host').attachShadow({ mode: 'open' }).innerHTML =
		'<p id="in-shadow">shadow content</p><img id="shadow-image" src="${origin}/image.png" width="16" height="16">'
	addEventListener('load', () => { document.title = 'ArchiveBridge test page ready' })
</script>
</body>
</html>
`,
			},
		],
		[
			'/viewer/style.css',
			{
				contentType: 'text/css; charset=utf-8',
				// The colour and the background image are what a rendered assertion
				// checks: the first proves an archived stylesheet applied at all, the
				// second that a url() inside it resolved to archived bytes.
				body: `h1{color:rgb(1,2,3)}\n#painted{background-image:url(${origin}/image.png);width:11px}\n`,
			},
		],
		[
			'/viewer/frame.html',
			{
				contentType: 'text/html; charset=utf-8',
				body: '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>viewer frame</title></head><body><p id="framed">framed content</p></body></html>\n',
			},
		],
	])
}

/**
 * The page the **Firefox** capture tests capture, at `/firefox/`.
 *
 * Separate from `/` and `/viewer/` for the reason those two are separate
 * from each other, and for one more: this fixture exists to exercise
 * everything Chrome's *native* capture cannot record, which is precisely
 * what an ArchiveBridge-authored capture is for. Every piece of it is an
 * assertion in `e2e/firefox/phase-1.test.ts`:
 *
 * - live form state that differs from the served markup, in both
 *   directions (a checkbox turned on, a `checked` radio turned off);
 * - controls whose live state must **never** reach the archive: a password
 *   and a one-time-code input, each given a served value *and* a different
 *   live value, so a test can tell "the policy held" from "nothing
 *   happened" — and, for the password, "refused the live value" from
 *   "deleted the markup", which a valueless password input could not
 *   distinguish; plus two hidden CSRF-shaped fields, one with a served value
 *   and one with none, because a hidden input's live value *is* its content
 *   attribute (the `value` setter writes it) and so the only thing a
 *   capture can get wrong there is inventing one;
 * - an `input[type=file]` with a file genuinely selected in it. Firefox
 *   allows a page to select one deterministically by assigning a
 *   `DataTransfer`'s `files` (measured: `files.length` becomes 1 and
 *   `value` becomes `C:\\fakepath\\private.txt`), so the exclusion is
 *   exercised against a control that really is holding a user's file rather
 *   than against an empty one. The page records that the selection took
 *   effect in a neutral marker attribute, so the assertion can tell a
 *   holding policy from a failed setup without putting the file's own name
 *   in the markup;
 * - attributes whose values merely *look* like resource references —
 *   `data-private`, an `<input value>`, a `title` and an `<a href>`, each
 *   holding a real `blob:` URL with distinct secret bytes behind it. A
 *   browser would never load any of them, so the capture must not read them
 *   either; they are the counterpart to the real `blob:` image above;
 * - a `<canvas>` whose CSS box (64x16) deliberately disagrees with its
 *   bitmap (32x32) and whose top-right and bottom-left quadrants are left
 *   fully transparent;
 * - an open shadow root;
 * - a `blob:` image, readable only by the page principal;
 * - a `data:` image, which must stay inline;
 * - an ordinary stylesheet and an ordinary image, which must become parts;
 * - and one `<iframe>` — not to capture, but to prove Phase 1 does not
 *   *claim* to have captured it. `FRAMED_CONTENT` must appear nowhere in
 *   the archive.
 *
 * The page mutates itself before capture and renames itself on `load`, so
 * a test can wait for a settled page and then assert the capture reflects
 * the post-script DOM rather than the served markup.
 *
 * Two more pages live beside it rather than in it, for the reason `/` and
 * `/viewer/` are separate at all — each needs the main fixture to be
 * something it is not. `/firefox/legacy-doctype.html` has to be in quirks
 * mode; {@link CANVAS_BOUNDS_PATH} has to be a page whose canvases mostly
 * fail, which is the opposite of the one canvas the fidelity assertions
 * above need to succeed.
 */
function firefoxPages(origin: string, crossOrigin: string): ReadonlyMap<string, { readonly contentType: string; readonly body: string | Buffer }> {
	return new Map([
		[
			'/firefox/',
			{
				contentType: 'text/html; charset=utf-8',
				body: `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>ArchiveBridge Firefox fixture</title><link rel="stylesheet" href="${origin}/firefox/style.css"></head>
<body>
<h1 id="heading">Firefox capture fixture</h1>
<p id="prose">PROSE_CONTENT</p>
<img id="image" src="${origin}/firefox/small.png" width="16" height="16" alt="deterministic">
<img id="data-image" src="${FIREFOX_DATA_IMAGE_URL}" alt="inline">
<img id="blob-image" alt="blob">
<div id="blob-in-data"></div>
<span id="blob-in-title">titled</span>
<a id="blob-in-href">link</a>
<form id="form">
<input id="text-input" name="text" value="ORIGINAL_TEXT">
<textarea id="textarea" name="notes">ORIGINAL_TEXTAREA</textarea>
<input id="checkbox" type="checkbox" name="check">
<input id="radio-a" type="radio" name="pick" value="a" checked>
<input id="radio-b" type="radio" name="pick" value="b">
<select id="select" name="choice"><option id="option-a" value="a" selected>alpha</option><option id="option-b" value="b">beta</option></select>
<input id="password" type="password" name="password" value="PASSWORD_ORIGINAL">
<input id="file-input" type="file" name="upload">
<input id="blob-in-value" name="blobbish">
<input id="hidden-field" type="hidden" name="csrf" value="HIDDEN_ORIGINAL">
<input id="hidden-untouched" type="hidden" name="untouched">
<input id="otp" name="otp" autocomplete="one-time-code" value="OTP_ORIGINAL">
</form>
<canvas id="canvas" width="32" height="32" style="width:64px;height:16px"></canvas>
<div id="shadow-host"></div>
<iframe id="child-frame" src="${origin}/firefox/frame.html"></iframe>
<script>
	document.getElementById('heading').dataset.mutated = 'yes'
	document.getElementById('text-input').value = 'TYPED_TEXT'
	document.getElementById('textarea').value = 'TYPED_TEXTAREA'
	document.getElementById('checkbox').checked = true
	document.getElementById('radio-b').checked = true
	document.getElementById('select').value = 'b'
	document.getElementById('password').value = 'SECRET_PASSWORD_VALUE'
	document.getElementById('otp').value = 'OTP_LIVE_SECRET'

	// A genuinely selected file. Firefox accepts an assigned DataTransfer
	// file list, so the capture meets a file input that is actually holding
	// one; the marker says the setup took effect, without naming the file.
	const fileInput = document.getElementById('file-input')
	try {
		const transfer = new DataTransfer()
		transfer.items.add(new File(['PRIVATE_FILE_CONTENT'], 'private.txt', { type: 'text/plain' }))
		fileInput.files = transfer.files
	} catch (error) {
		fileInput.dataset.fileSetupError = String(error)
	}
	fileInput.dataset.fileSelected = String(fileInput.files.length)

	const context = document.getElementById('canvas').getContext('2d')
	context.fillStyle = '#ff0000'
	context.fillRect(0, 0, 16, 16)
	context.fillStyle = '#0000ff'
	context.fillRect(16, 16, 16, 16)

	document.getElementById('shadow-host').attachShadow({ mode: 'open' }).innerHTML = '<p id="in-shadow">SHADOW_CONTENT</p>'

	document.getElementById('blob-image').src = URL.createObjectURL(new Blob([${JSON.stringify(firefoxBlobResourceBytes.toString('utf8'))}], { type: 'image/svg+xml' }))

	// Blob URLs at sites that are not resource references. Each holds bytes
	// no archive should ever contain, because nothing would ever load them.
	const blobFor = (secret) => URL.createObjectURL(new Blob([secret], { type: 'text/plain' }))
	document.getElementById('blob-in-data').dataset.private = blobFor('BLOB_SECRET_IN_DATA_ATTRIBUTE')
	document.getElementById('blob-in-title').setAttribute('title', blobFor('BLOB_SECRET_IN_TITLE'))
	document.getElementById('blob-in-href').setAttribute('href', blobFor('BLOB_SECRET_IN_HREF'))
	document.getElementById('blob-in-value').setAttribute('value', blobFor('BLOB_SECRET_IN_VALUE'))

	addEventListener('load', () => { document.title = 'ArchiveBridge Firefox fixture ready' })
</script>
</body>
</html>
`,
			},
		],
		['/firefox/style.css', { contentType: 'text/css; charset=utf-8', body: '#prose{color:rgb(4,5,6)}\n' }],
		[
			// A page whose doctype carries external identifiers, which is what
			// decides a browser's rendering mode. Kept out of `/firefox/` proper
			// so the main fixture stays in no-quirks mode and this one can be
			// captured on its own.
			'/firefox/legacy-doctype.html',
			{
				contentType: 'text/html; charset=utf-8',
				body: '<!DOCTYPE html PUBLIC "-//W3C//DTD HTML 4.01//EN" "http://www.w3.org/TR/html4/strict.dtd">\n<html lang="en"><head><meta charset="utf-8"><title>legacy doctype</title></head><body><p id="legacy">LEGACY_DOCTYPE_CONTENT</p></body></html>\n',
			},
		],
		[
			// A page whose canvases mostly *cannot* be snapshotted, which is what
			// the capture's canvas bound is actually about: it bounds snapshot
			// *attempts*, and a page chooses how many of its canvases fail. Two
			// ordinary ones come first, then eight that produce no image —
			// enough that a bound counted in successful snapshots would leave
			// every one of the eight attempted.
			//
			// **Zero-sized rather than tainted, and that is a measured
			// correction.** A canvas tainted by a cross-origin `drawImage` is
			// the textbook unreadable canvas, and it is not unreadable *here*:
			// measured against this fixture in a real Firefox, the capture — a
			// content script running with the extension's expanded principal and
			// `<all_urls>`, which the E2E session holds throughout — read all
			// eight tainted canvases and archived their pixels. Origin taint is
			// relative to who is asking, and `<all_urls>` is what decides the
			// answer for this extension (the `TAINTED_CANVAS_*` fixture is where
			// that is pinned). A canvas with a zero-width bitmap is unreadable
			// for everyone whatever the permission state: `toDataURL` answers
			// `data:,`, which is not a PNG, and the capture reports it as
			// unreadable without a `SecurityError` anywhere.
			//
			// The title reports how many the page itself found unreadable, so a
			// test can wait for a settled page and tell "the bound held" from
			// "the setup did not take".
			CANVAS_BOUNDS_PATH,
			{
				contentType: 'text/html; charset=utf-8',
				body: `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>ArchiveBridge canvas bounds fixture</title></head>
<body>
<p id="prose">CANVAS_BOUNDS_CONTENT</p>
<div id="canvases"></div>
<script>
	addEventListener('load', () => {
		const host = document.getElementById('canvases')
		const add = (id, readable) => {
			const canvas = document.createElement('canvas')
			canvas.id = id
			canvas.width = readable ? 8 : 0
			canvas.height = 8
			host.appendChild(canvas)
			const context = canvas.getContext('2d')
			context.fillStyle = '#ff0000'
			context.fillRect(0, 0, 8, 8)
		}
		for (let index = 0; index < ${CANVAS_BOUNDS_PLAIN}; index += 1) { add('plain-' + index, true) }
		for (let index = 0; index < ${CANVAS_BOUNDS_UNREADABLE}; index += 1) { add('unreadable-' + index, false) }

		let unreadable = 0
		for (const canvas of host.querySelectorAll('canvas')) {
			if (!canvas.toDataURL('image/png').startsWith('data:image/png;base64,')) { unreadable += 1 }
		}
		document.title = 'canvas bounds ready: ' + unreadable + ' unreadable'
	})
</script>
</body>
</html>
`,
			},
		],
		[
			// See the `TAINTED_CANVAS_*` constants for what this page is for. It
			// is the only fixture here that needs the server's *second* hostname,
			// because a canvas can only be tainted by an origin the page does not
			// have.
			TAINTED_CANVAS_PATH,
			{
				contentType: 'text/html; charset=utf-8',
				body: `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>tainted canvas loading</title></head>
<body>
<p id="prose">TAINTED_CANVAS_CONTENT</p>
<canvas id="tainted" width="${TAINTED_CANVAS_SIDE}" height="${TAINTED_CANVAS_SIDE}"></canvas>
<canvas id="clean" width="${TAINTED_CANVAS_SIDE}" height="${TAINTED_CANVAS_SIDE}"></canvas>
<script>
	const side = ${TAINTED_CANVAS_SIDE}
	const paint = (id, backdrop, image) => {
		const context = document.getElementById(id).getContext('2d')
		context.fillStyle = 'rgb(' + backdrop.join(',') + ')'
		context.fillRect(0, 0, side, side)
		context.drawImage(image, 0, 0, side / 2, side / 2)
	}
	const readable = (id) => {
		try { return document.getElementById(id).toDataURL('image/png').startsWith('data:image/png;base64,') } catch (error) { return false }
	}
	const crossOriginImage = new Image()
	const sameOriginImage = new Image()
	let loaded = 0
	const onLoad = () => {
		loaded += 1
		if (loaded < 2) { return }
		paint('tainted', ${JSON.stringify(TAINTED_CANVAS_TAINTED_BACKDROP_RGB)}, crossOriginImage)
		paint('clean', ${JSON.stringify(TAINTED_CANVAS_CLEAN_BACKDROP_RGB)}, sameOriginImage)
		// The page's own verdict on its own canvases, in its own realm: the
		// title is how a test knows the taint really took.
		const unreadable = ['tainted', 'clean'].filter((id) => !readable(id)).length
		document.title = 'tainted canvas ready: ' + unreadable + ' unreadable by the page'
	}
	crossOriginImage.addEventListener('load', onLoad)
	sameOriginImage.addEventListener('load', onLoad)
	crossOriginImage.src = '${crossOrigin}/firefox/cross-origin.png'
	sameOriginImage.src = '${origin}/firefox/same-origin.png'
</script>
</body>
</html>
`,
			},
		],
		['/firefox/cross-origin.png', { contentType: 'image/png', body: taintedCanvasCrossOriginImageBytes }],
		['/firefox/same-origin.png', { contentType: 'image/png', body: taintedCanvasSameOriginImageBytes }],
		['/firefox/small.png', { contentType: 'image/png', body: smallImageBytes }],
		[
			'/firefox/frame.html',
			{
				contentType: 'text/html; charset=utf-8',
				body: '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>child frame</title></head><body><p id="framed">FRAMED_CONTENT</p></body></html>\n',
			},
		],
	])
}

/**
 * The fixture the Firefox frame-identity probe measures, at
 * {@link FRAME_IDENTITY_PATH}.
 *
 * Frame capture links a captured child document to the element that owns
 * it by *position*, never by URL — two frames can share a `src`, a
 * `srcdoc` frame has none, and a frame may have navigated since load. So
 * the thing that has to be measured is whether three separate positional
 * numberings agree, and where they do not:
 *
 * - the child's own index in `window.parent.frames`;
 * - the parent's index for that container, from
 *   `container.contentWindow === window.frames[i]`;
 * - the container's ordinal in the **serialized HTML**, which is the only
 *   position a library rewriting archived markup can see.
 *
 * Every hostile case this fixture holds is there because it makes one of
 * those three disagree, or because it is a frame kind whose identity is
 * not keyed on a URL at all:
 *
 * - an `<object>` and an `<embed>` **first in the document**, before any
 *   `<iframe>`, because a nested browsing context they host occupies a
 *   `window.frames` index while *not* being a frame container any
 *   `<iframe>`/`<frame>` ordinal counts — which is what makes DOM ordinal
 *   and browsing-context index different numbers rather than the same
 *   number twice;
 * - an `<iframe>` inside an **open shadow root**, placed between two
 *   ordinary ones, because it is absent from `document.querySelectorAll`
 *   but present in the serialized snapshot (the capture emits shadow roots
 *   as `<template shadowrootmode>`), so a naive light-DOM ordinal and the
 *   serialized ordinal diverge from there on;
 * - **two siblings with an identical `src`**, the case URL matching cannot
 *   distinguish at all;
 * - `srcdoc`, a no-`src` `about:blank` written into by its parent, and a
 *   `sandbox=""` frame — three documents whose origin does not come from a
 *   URL;
 * - a **cross-origin** frame and a nested tree that crosses origin in both
 *   directions, since `window.frameElement` is `null` cross-origin and the
 *   parent cannot read the child at all;
 * - a frame pointed at {@link FRAME_IDENTITY_FAILED_URL}, which occupies a
 *   position with no document behind it.
 *
 * Ordinary markup sits between the containers so no ordinal can accidentally
 * be right because the frames happened to be adjacent, and every document
 * names itself in `data-ab-frame` so the probe identifies a frame by what it
 * *is* rather than by where it was expected.
 */
export const FRAME_IDENTITY_PATH = '/firefox/frame-identity.html'

/** What {@link FRAME_IDENTITY_PATH} renames itself to once every frame it owns has settled and its scripted frames have been built. */
export const FRAME_IDENTITY_READY_TITLE = 'frame identity ready'

/** The legacy `<frameset>` fixture. Separate because a frameset document has no `<body>`, so it cannot be a section of any other page. */
export const FRAME_IDENTITY_FRAMESET_PATH = '/firefox/identity/frameset.html'

/** What {@link FRAME_IDENTITY_FRAMESET_PATH} renames itself to once both its frames have loaded. */
export const FRAME_IDENTITY_FRAMESET_READY_TITLE = 'frameset ready'

/** A frame source nothing answers: port 9 is discard, closed on this loopback interface, so the load fails without a timeout. The one frame position in the fixture with no document behind it. */
export const FRAME_IDENTITY_FAILED_URL = 'http://127.0.0.1:9/never.html'

/** The marker each fixture document carries in `data-ab-frame`, in the browsing-context order the probe is expected to find them. Exported so the probe asserts on names rather than on positions it also computed. */
export const FRAME_IDENTITY_MARKERS = {
	top: 'top',
	objectSvg: 'object-svg',
	embedSvg: 'embed-svg',
	sameOrigin: 'same-origin',
	crossOrigin: 'cross-origin',
	duplicate: 'duplicate',
	nestedParent: 'nested-parent',
	nestedSame: 'nested-same',
	nestedCross: 'nested-cross',
	nestedDeep: 'nested-deep',
	srcdoc: 'srcdoc',
	aboutBlank: 'about-blank',
	sandboxed: 'sandboxed',
	inShadow: 'in-shadow',
	inShadowCross: 'in-shadow-cross',
	inDeclarativeShadow: 'in-declarative-shadow',
	framesetTop: 'frameset-top',
	framesetA: 'frameset-a',
	framesetB: 'frameset-b',
} as const

/** One fixture document, naming itself in `data-ab-frame` so the probe can tell which frame answered without trusting a URL. */
function identityDocument(marker: string, title: string, body: string): { readonly contentType: string; readonly body: string } {
	return {
		contentType: 'text/html; charset=utf-8',
		body: `<!doctype html>\n<html lang="en" data-ab-frame="${marker}">\n<head><meta charset="utf-8"><title>${title}</title></head>\n<body>\n${body}\n</body>\n</html>\n`,
	}
}

/** An SVG document for the `<object>`/`<embed>` pair, which is the measured way to make Firefox give one of those elements a nested browsing context. */
function identitySvg(marker: string): { readonly contentType: string; readonly body: string } {
	return {
		contentType: 'image/svg+xml',
		body: `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" data-ab-frame="${marker}"><rect width="40" height="40" fill="#cccccc"></rect></svg>\n`,
	}
}

function frameIdentityPages(origin: string, crossOrigin: string): ReadonlyMap<string, { readonly contentType: string; readonly body: string | Buffer }> {
	const marker = FRAME_IDENTITY_MARKERS
	return new Map([
		[
			FRAME_IDENTITY_PATH,
			{
				contentType: 'text/html; charset=utf-8',
				body: `<!doctype html>
<html lang="en" data-ab-frame="${marker.top}">
<head><meta charset="utf-8"><title>ArchiveBridge frame identity fixture</title></head>
<body>
<h1 id="heading">Frame identity fixture</h1>
<p class="filler">FRAME_IDENTITY_CONTENT</p>
<div id="declarative-shadow-host"><template shadowrootmode="open"><p>declarative shadow</p><iframe id="in-declarative-shadow" src="${origin}/firefox/identity/in-declarative-shadow.html"></iframe></template></div>
<p class="filler">between the declarative shadow root and the object</p>
<object id="object-svg" type="image/svg+xml" data="${origin}/firefox/identity/object.svg" width="40" height="40"></object>
<p class="filler">between the object and the embed</p>
<embed id="embed-svg" type="image/svg+xml" src="${origin}/firefox/identity/embed.svg" width="40" height="40">
<p class="filler">between the embed and the first iframe</p>
<iframe id="same-origin" src="${origin}/firefox/identity/same-origin.html"></iframe>
<p class="filler">before the shadow root, whose frames the two sides of the join disagree about</p>
<div id="shadow-host"></div>
<p class="filler">between the shadow root and the cross-origin frame</p>
<iframe id="cross-origin" src="${crossOrigin}/firefox/identity/cross-origin.html"></iframe>
<p class="filler">before the two frames that share a src</p>
<iframe id="duplicate-a" src="${origin}/firefox/identity/duplicate.html"></iframe>
<iframe id="duplicate-b" src="${origin}/firefox/identity/duplicate.html"></iframe>
<p class="filler">before the nested tree</p>
<iframe id="nested-parent" src="${origin}/firefox/identity/nested-parent.html"></iframe>
<p class="filler">before the frames with no URL of their own</p>
<iframe id="srcdoc" srcdoc='<!doctype html><html lang="en" data-ab-frame="${marker.srcdoc}"><head><meta charset="utf-8"><title>srcdoc frame</title></head><body><p id="framed">SRCDOC_CONTENT</p></body></html>'></iframe>
<iframe id="about-blank"></iframe>
<p class="filler">before the sandboxed frame</p>
<iframe id="sandboxed" sandbox="" src="${origin}/firefox/identity/sandboxed.html"></iframe>
<p class="filler">before the frame that cannot load</p>
<iframe id="failed" src="${FRAME_IDENTITY_FAILED_URL}"></iframe>
<script>
	// The shadow root is attached, and its frames created, synchronously
	// here rather than on \`load\`: they have to exist before the page
	// settles, because what they are here to disturb is the *ordering*
	// every other frame is numbered in. The root sits between the
	// same-origin and the cross-origin frame precisely so that a numbering
	// which counts its frames and one which does not cannot agree about
	// anything after it.
	//
	// Two of them, one per origin: whether a shadow frame can be identified
	// at all has a different answer when its parent can reach it through
	// \`frameElement\` than when it cannot.
	document.getElementById('shadow-host').attachShadow({ mode: 'open' }).innerHTML =
		'<p>in shadow</p>' +
		'<iframe id="in-shadow" src="${origin}/firefox/identity/in-shadow.html"></iframe>' +
		'<iframe id="in-shadow-cross" src="${crossOrigin}/firefox/identity/in-shadow-cross.html"></iframe>'

	// The one document in this fixture with no URL and no markup of its
	// own: an \`about:blank\` frame its parent writes into, which is the
	// case a capture exists for and a URL can say nothing about.
	const blank = document.getElementById('about-blank')
	try {
		const blankDocument = blank.contentDocument
		blankDocument.documentElement.dataset.abFrame = '${marker.aboutBlank}'
		blankDocument.body.innerHTML = '<p id="framed">ABOUT_BLANK_CONTENT</p>'
	} catch (error) {
		blank.dataset.setupError = String(error)
	}

	addEventListener('load', () => { document.title = '${FRAME_IDENTITY_READY_TITLE}' })
</script>
</body>
</html>
`,
			},
		],
		['/firefox/identity/object.svg', identitySvg(marker.objectSvg)],
		['/firefox/identity/embed.svg', identitySvg(marker.embedSvg)],
		['/firefox/identity/same-origin.html', identityDocument(marker.sameOrigin, 'same-origin frame', '<p id="framed">SAME_ORIGIN_CONTENT</p>')],
		['/firefox/identity/cross-origin.html', identityDocument(marker.crossOrigin, 'cross-origin frame', '<p id="framed">CROSS_ORIGIN_CONTENT</p>')],
		// Served once, embedded twice, and therefore the only thing in this
		// fixture that two frames can be confused for each other by.
		['/firefox/identity/duplicate.html', identityDocument(marker.duplicate, 'duplicate frame', '<p id="framed">DUPLICATE_CONTENT</p>')],
		[
			'/firefox/identity/nested-parent.html',
			identityDocument(
				marker.nestedParent,
				'nested parent frame',
				`<p class="filler">before the nested frames</p>
<iframe id="nested-same" src="${origin}/firefox/identity/nested-same.html"></iframe>
<p class="filler">between them</p>
<iframe id="nested-cross" src="${crossOrigin}/firefox/identity/nested-cross.html"></iframe>`,
			),
		],
		['/firefox/identity/nested-same.html', identityDocument(marker.nestedSame, 'nested same-origin frame', '<p id="framed">NESTED_SAME_CONTENT</p>')],
		[
			// Crosses origin a second time, back to where the top document
			// came from: a parent that cannot read its child, inside a child
			// its own parent cannot read.
			'/firefox/identity/nested-cross.html',
			identityDocument(
				marker.nestedCross,
				'nested cross-origin frame',
				`<p id="framed">NESTED_CROSS_CONTENT</p>\n<iframe id="nested-deep" src="${origin}/firefox/identity/nested-deep.html"></iframe>`,
			),
		],
		['/firefox/identity/nested-deep.html', identityDocument(marker.nestedDeep, 'nested deep frame', '<p id="framed">NESTED_DEEP_CONTENT</p>')],
		['/firefox/identity/sandboxed.html', identityDocument(marker.sandboxed, 'sandboxed frame', '<p id="framed">SANDBOXED_CONTENT</p>')],
		['/firefox/identity/in-shadow.html', identityDocument(marker.inShadow, 'frame in a shadow root', '<p id="framed">IN_SHADOW_CONTENT</p>')],
		['/firefox/identity/in-shadow-cross.html', identityDocument(marker.inShadowCross, 'cross-origin frame in a shadow root', '<p id="framed">IN_SHADOW_CROSS_CONTENT</p>')],
		[
			'/firefox/identity/in-declarative-shadow.html',
			identityDocument(marker.inDeclarativeShadow, 'frame in a declarative shadow root', '<p id="framed">IN_DECLARATIVE_SHADOW_CONTENT</p>'),
		],
		[
			// A frameset document, which cannot be part of any other page:
			// `<frameset>` replaces `<body>`. Its own `load` fires once both
			// frames have, which is what the ready title reports.
			FRAME_IDENTITY_FRAMESET_PATH,
			{
				contentType: 'text/html; charset=utf-8',
				body: `<!doctype html>
<html lang="en" data-ab-frame="${marker.framesetTop}">
<head><meta charset="utf-8"><title>ArchiveBridge frameset fixture</title>
<script>addEventListener('load', () => { document.title = '${FRAME_IDENTITY_FRAMESET_READY_TITLE}' })</script>
</head>
<frameset cols="50%,50%">
<frame id="frameset-a" src="${origin}/firefox/identity/frameset-a.html">
<frame id="frameset-b" src="${origin}/firefox/identity/frameset-b.html">
</frameset>
</html>
`,
			},
		],
		['/firefox/identity/frameset-a.html', identityDocument(marker.framesetA, 'frameset frame a', '<p id="framed">FRAMESET_A_CONTENT</p>')],
		['/firefox/identity/frameset-b.html', identityDocument(marker.framesetB, 'frameset frame b', '<p id="framed">FRAMESET_B_CONTENT</p>')],
	])
}

/**
 * The fixture the Firefox **document identity** probe measures, at
 * {@link DOCUMENT_IDENTITY_PATH}.
 *
 * `FRAME_IDENTITY_PATH` measures which *browsing context* a captured
 * document belongs to. This one measures a different question that the
 * frame-identity answer cannot reach: whether the document captured out of
 * that browsing context is **still the document the container holds** when
 * the parent is serialized afterwards. A frame id names a frame for as long
 * as the frame exists; a frame that navigates keeps it while replacing its
 * Document underneath. So the hostile sequence this fixture exists to
 * reproduce is not a DOM mutation at all:
 *
 * ```text
 *   capture child document A out of frame 42
 *   the page navigates frame 42 to document B
 *   serialize the parent; its container still reports frame 42
 *   attach A to a container now holding B          ← silently wrong
 * ```
 *
 * Every container here is therefore one that **keeps its element identity
 * across a navigation** — the test holds a direct node reference in the
 * page's own world and re-checks it afterwards, so "same container" is a
 * measured fact rather than an assumption about `id` attributes. What
 * varies between them is the document-identity case each one covers:
 *
 * - `#nav-same` — the plain race: same-origin A replaced by same-origin B.
 * - `#nav-cross` — the same race across an **origin transition**, since a
 *   document's identity must not be something only a same-origin parent can
 *   read.
 * - `#nav-sandbox` — a `sandbox=""` container, whose documents have opaque
 *   origins and cannot be reached through `contentDocument` at all.
 * - `#nav-srcdoc` — a `srcdoc` document, which has no URL of its own,
 *   replaced by one that does.
 * - `#nav-blank` — an `about:blank` document **written by its parent**,
 *   replaced by a loaded one. This is the case a capture exists for and the
 *   case a URL can say nothing whatsoever about: before the navigation the
 *   container's `src` is absent and the child's URL is `about:blank`.
 * - `#nav-shadow` — a container inside an **open shadow root**, which
 *   `document.querySelectorAll` cannot see and `parent.frames` does not
 *   index.
 * - `#same-doc` — the **control**, and the reason the others mean anything:
 *   a fragment navigation and a `history.pushState()` change this frame's
 *   URL without creating a new Document, and a reload creates one at the
 *   *same* URL. An identity that tracked URLs rather than Document lifetime
 *   would get all three backwards.
 * - `#cross-static` and the `#nested-parent` tree (cross origin, then back
 *   to the first origin at depth 3) — never navigated, so they measure that
 *   a document identity is stable for documents that did **not** move, and
 *   that a child can name its parent *document* across origin boundaries.
 *
 * Each document names itself in `data-ab-frame`, exactly as the
 * frame-identity fixture does, so a probe identifies which document
 * answered by what it is rather than by a URL it was expected at — URL
 * equality is the thing being avoided, and may never be the thing doing
 * the identifying.
 */
export const DOCUMENT_IDENTITY_PATH = '/firefox/document-identity.html'

/** What {@link DOCUMENT_IDENTITY_PATH} renames itself to once every frame it owns has settled. */
export const DOCUMENT_IDENTITY_READY_TITLE = 'document identity ready'

/**
 * The documents {@link DOCUMENT_IDENTITY_PATH} starts with and navigates
 * to. Served on **both** of the test server's origins, so a test picks the
 * origin and thereby whether a navigation crosses one; the `cross-b`
 * navigation is the same path fetched from the other hostname.
 */
export const DOCUMENT_IDENTITY_DOCS = {
	sameA: '/firefox/document-identity/same-a.html',
	sameB: '/firefox/document-identity/same-b.html',
	crossA: '/firefox/document-identity/cross-a.html',
	crossB: '/firefox/document-identity/cross-b.html',
	sandboxA: '/firefox/document-identity/sandbox-a.html',
	sandboxB: '/firefox/document-identity/sandbox-b.html',
	shadowA: '/firefox/document-identity/shadow-a.html',
	shadowB: '/firefox/document-identity/shadow-b.html',
	srcdocB: '/firefox/document-identity/srcdoc-b.html',
	blankB: '/firefox/document-identity/blank-b.html',
	sameDoc: '/firefox/document-identity/same-doc.html',
	crossStatic: '/firefox/document-identity/cross-static.html',
	nestedParent: '/firefox/document-identity/nested-parent.html',
	nestedCross: '/firefox/document-identity/nested-cross.html',
	nestedDeep: '/firefox/document-identity/nested-deep.html',
} as const

/** The marker each fixture document carries in `data-ab-frame`. A navigation is confirmed by the *replacement document naming itself*, never by the container's URL having changed. */
export const DOCUMENT_IDENTITY_MARKERS = {
	top: 'doc-top',
	sameA: 'doc-same-a',
	sameB: 'doc-same-b',
	crossA: 'doc-cross-a',
	crossB: 'doc-cross-b',
	sandboxA: 'doc-sandbox-a',
	sandboxB: 'doc-sandbox-b',
	shadowA: 'doc-shadow-a',
	shadowB: 'doc-shadow-b',
	srcdocA: 'doc-srcdoc-a',
	srcdocB: 'doc-srcdoc-b',
	blankA: 'doc-blank-a',
	blankB: 'doc-blank-b',
	sameDoc: 'doc-same-doc',
	crossStatic: 'doc-cross-static',
	nestedParent: 'doc-nested-parent',
	nestedCross: 'doc-nested-cross',
	nestedDeep: 'doc-nested-deep',
} as const

function documentIdentityPages(origin: string, crossOrigin: string): ReadonlyMap<string, { readonly contentType: string; readonly body: string | Buffer }> {
	const marker = DOCUMENT_IDENTITY_MARKERS
	const doc = DOCUMENT_IDENTITY_DOCS
	return new Map([
		[
			DOCUMENT_IDENTITY_PATH,
			{
				contentType: 'text/html; charset=utf-8',
				body: `<!doctype html>
<html lang="en" data-ab-frame="${marker.top}">
<head><meta charset="utf-8"><title>ArchiveBridge document identity fixture</title></head>
<body>
<h1 id="heading">Document identity fixture</h1>
<p class="filler">DOCUMENT_IDENTITY_CONTENT</p>
<iframe id="nav-same" src="${origin}${doc.sameA}"></iframe>
<p class="filler">between the same-origin navigable frame and the cross-origin one</p>
<iframe id="nav-cross" src="${origin}${doc.crossA}"></iframe>
<p class="filler">before the sandboxed navigable frame</p>
<iframe id="nav-sandbox" sandbox="" src="${origin}${doc.sandboxA}"></iframe>
<p class="filler">before the two frames with no URL of their own</p>
<iframe id="nav-srcdoc" srcdoc='<!doctype html><html lang="en" data-ab-frame="${marker.srcdocA}"><head><meta charset="utf-8"><title>srcdoc before</title></head><body><p id="framed">SRCDOC_A_CONTENT</p></body></html>'></iframe>
<iframe id="nav-blank"></iframe>
<p class="filler">before the shadow root</p>
<div id="shadow-host"></div>
<p class="filler">before the same-document control</p>
<iframe id="same-doc" src="${origin}${doc.sameDoc}"></iframe>
<p class="filler">before the frames that are never navigated</p>
<iframe id="cross-static" src="${crossOrigin}${doc.crossStatic}"></iframe>
<iframe id="nested-parent" src="${origin}${doc.nestedParent}"></iframe>
<script>
	// Attached synchronously, before the page settles: a container inside a
	// shadow root has to be present for the baseline pass, because what it
	// is here to show is that a *navigation* of such a container is
	// observable from the parent's side even though the container is
	// invisible to \`document.querySelectorAll\` and its browsing context is
	// absent from \`parent.frames\`.
	document.getElementById('shadow-host').attachShadow({ mode: 'open' }).innerHTML =
		'<p>in shadow</p><iframe id="nav-shadow" src="${origin}${doc.shadowA}"></iframe>'

	// The one document here with no URL and no markup of its own. Its
	// replacement is an ordinary loaded document, so this container spans
	// the widest gap the fixture contains: from a parent-written
	// \`about:blank\` with no \`src\` attribute at all, to a real URL.
	const blank = document.getElementById('nav-blank')
	try {
		const blankDocument = blank.contentDocument
		blankDocument.documentElement.dataset.abFrame = '${marker.blankA}'
		blankDocument.body.innerHTML = '<p id="framed">BLANK_A_CONTENT</p>'
	} catch (error) {
		blank.dataset.setupError = String(error)
	}

	addEventListener('load', () => { document.title = '${DOCUMENT_IDENTITY_READY_TITLE}' })
</script>
</body>
</html>
`,
			},
		],
		[doc.sameA, identityDocument(marker.sameA, 'same-origin before', '<p id="framed">SAME_A_CONTENT</p>')],
		[doc.sameB, identityDocument(marker.sameB, 'same-origin after', '<p id="framed">SAME_B_CONTENT</p>')],
		[doc.crossA, identityDocument(marker.crossA, 'origin transition before', '<p id="framed">CROSS_A_CONTENT</p>')],
		[doc.crossB, identityDocument(marker.crossB, 'origin transition after', '<p id="framed">CROSS_B_CONTENT</p>')],
		[doc.sandboxA, identityDocument(marker.sandboxA, 'sandboxed before', '<p id="framed">SANDBOX_A_CONTENT</p>')],
		[doc.sandboxB, identityDocument(marker.sandboxB, 'sandboxed after', '<p id="framed">SANDBOX_B_CONTENT</p>')],
		[doc.shadowA, identityDocument(marker.shadowA, 'shadow-hosted before', '<p id="framed">SHADOW_A_CONTENT</p>')],
		[doc.shadowB, identityDocument(marker.shadowB, 'shadow-hosted after', '<p id="framed">SHADOW_B_CONTENT</p>')],
		[doc.srcdocB, identityDocument(marker.srcdocB, 'srcdoc replacement', '<p id="framed">SRCDOC_B_CONTENT</p>')],
		[doc.blankB, identityDocument(marker.blankB, 'about:blank replacement', '<p id="framed">BLANK_B_CONTENT</p>')],
		// The control. Its fragment and `pushState` operations change this
		// document's URL without replacing the Document, and its reload
		// replaces the Document without changing the URL — so an identity
		// that tracked URLs would disagree with it in both directions.
		[doc.sameDoc, identityDocument(marker.sameDoc, 'same-document control', '<p id="framed">SAME_DOC_CONTENT</p>\n<p id="fragment-target">FRAGMENT_TARGET</p>')],
		[doc.crossStatic, identityDocument(marker.crossStatic, 'cross-origin never navigated', '<p id="framed">CROSS_STATIC_CONTENT</p>')],
		[
			doc.nestedParent,
			identityDocument(
				marker.nestedParent,
				'nested parent',
				`<p class="filler">before the nested cross-origin frame</p>\n<iframe id="nested-cross" src="${crossOrigin}${doc.nestedCross}"></iframe>`,
			),
		],
		[
			// Crosses origin, then back to the first origin: a parent that
			// cannot read its child, inside a child its own parent cannot
			// read. Whether a child can name its parent *document* across
			// that boundary is the question §2 of the research note asks.
			doc.nestedCross,
			identityDocument(marker.nestedCross, 'nested cross-origin', `<p id="framed">NESTED_CROSS_CONTENT</p>\n<iframe id="nested-deep" src="${origin}${doc.nestedDeep}"></iframe>`),
		],
		[doc.nestedDeep, identityDocument(marker.nestedDeep, 'nested deep', '<p id="framed">NESTED_DEEP_CONTENT</p>')],
	])
}
/** Path -> body/content type. The main page's `load` handler renames the document so a test can wait for a fully settled page before capturing. */
function pages(mainOrigin: string, crossOrigin: string): ReadonlyMap<string, { readonly contentType: string; readonly body: string | Buffer }> {
	return new Map([
		[
			'/',
			{
				contentType: 'text/html; charset=utf-8',
				body: `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>ArchiveBridge test page</title><link rel="stylesheet" href="${mainOrigin}/style.css"></head>
<body>
<h1 id="heading">ArchiveBridge test page</h1>
<img id="image" src="${mainOrigin}/image.png" width="64" height="64" alt="deterministic">
<iframe id="same-origin" src="${mainOrigin}/frame-outer.html"></iframe>
<iframe id="cross-origin" src="${crossOrigin}/frame-cross.html"></iframe>
<script>
	document.getElementById('heading').dataset.mutated = 'yes'
	addEventListener('load', () => { document.title = 'ArchiveBridge test page ready' })
</script>
</body>
</html>
`,
			},
		],
		[
			'/frame-outer.html',
			{
				contentType: 'text/html; charset=utf-8',
				body: `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>outer frame</title></head><body><p>outer frame</p><iframe id="inner" src="${mainOrigin}/frame-inner.html"></iframe></body></html>\n`,
			},
		],
		[
			'/frame-inner.html',
			{
				contentType: 'text/html; charset=utf-8',
				body: '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>inner frame</title></head><body><p>inner frame</p></body></html>\n',
			},
		],
		[
			'/frame-cross.html',
			{
				contentType: 'text/html; charset=utf-8',
				body: '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>cross-origin frame</title></head><body><p>cross-origin frame</p></body></html>\n',
			},
		],
		['/style.css', { contentType: 'text/css; charset=utf-8', body: STYLESHEET }],
		['/image.png', { contentType: 'image/png', body: imageBytes }],
		...viewerPages(mainOrigin),
		...firefoxPages(mainOrigin, crossOrigin),
		...frameIdentityPages(mainOrigin, crossOrigin),
		...documentIdentityPages(mainOrigin, crossOrigin),
	])
}

/** The cookie the server plants for whichever of its two origins is asked, and the paths that make a credentialed redirect observable. */
export const COOKIE_PATH = '/cookie-jar'
export const SAME_ORIGIN_COOKIE = 'ab_same=SAME_ORIGIN_COOKIE_VALUE'
export const CROSS_ORIGIN_COOKIE = 'ab_cross=CROSS_ORIGIN_COOKIE_VALUE'
/** Answers `302` to the *other* origin, so a same-origin reference leads off-origin — the shape a capture's credential policy has to survive. */
export const CROSS_ORIGIN_REDIRECT_PATH = '/redirect-to-cross-origin'
export const CROSS_ORIGIN_TARGET_PATH = '/cross-origin-target.css'

/** One request the server received, with the two things a credential test has to see: which origin it was addressed to, and what it carried. */
export interface ReceivedRequest {
	readonly path: string
	readonly host: string
	readonly cookie: string | undefined
}

export interface TestServer {
	/** Origin the page under test is loaded from. */
	readonly origin: string
	/** A different origin serving the same server, for the cross-origin frame. */
	readonly crossOrigin: string
	/** Every path requested so far, in order. Half of the "the viewer made no requests" assertion. */
	readonly requests: readonly string[]
	/** The same requests with their host and cookies, for the capture tests that are about *who* was asked and *with what* rather than about how many times. */
	readonly received: readonly ReceivedRequest[]
	/** How many TCP connections have been accepted. The other half: `preconnect`/`dns-prefetch` connect without ever sending a request. */
	connectionCount(): number
	/** Forgets every recorded request and connection, so a test can assert on one interaction rather than on the whole session. */
	resetTraffic(): void
	/** URLs the captured archive is expected to contain a part for. */
	readonly expectedResourceUrls: readonly string[]
	close(): Promise<void>
}

/** Starts the test server on an ephemeral port. */
export async function startTestServer(): Promise<TestServer> {
	const requests: string[] = []
	const received: ReceivedRequest[] = []
	let connections = 0
	let port = 0
	let routes: ReadonlyMap<string, { readonly contentType: string; readonly body: string | Buffer }> = new Map()

	const server: Server = createServer((request, response) => {
		const path = (request.url ?? '/').split('?')[0] ?? '/'
		const host = request.headers.host ?? ''
		requests.push(path)
		received.push({ path, host, cookie: request.headers.cookie })

		// Three routes that exist per *origin* rather than per page, because
		// what they are for is the difference between the two: planting a
		// cookie on each, and sending a request that starts on one and ends on
		// the other.
		if (path === COOKIE_PATH) {
			response.writeHead(200, {
				'content-type': 'text/html; charset=utf-8',
				'set-cookie': `${host.startsWith('127.0.0.1') ? SAME_ORIGIN_COOKIE : CROSS_ORIGIN_COOKIE}; Path=/; SameSite=Lax`,
			})
			response.end('<!doctype html><html lang="en"><head><meta charset="utf-8"><title>cookie jar</title></head><body>ok</body></html>')
			return
		}
		if (path === CROSS_ORIGIN_REDIRECT_PATH) {
			const elsewhere = host.startsWith('127.0.0.1') ? `http://localhost:${port}` : `http://127.0.0.1:${port}`
			response.writeHead(302, { location: `${elsewhere}${CROSS_ORIGIN_TARGET_PATH}` })
			response.end()
			return
		}
		if (path === CROSS_ORIGIN_TARGET_PATH) {
			response.writeHead(200, { 'content-type': 'text/css', 'cache-control': 'no-store' })
			response.end('#redirected{color:rgb(7,8,9)}')
			return
		}

		const route = routes.get(path)
		if (route === undefined) {
			response.writeHead(404, { 'content-type': 'text/plain' })
			response.end('not found')
			return
		}
		response.writeHead(200, { 'content-type': route.contentType, 'cache-control': 'no-store' })
		response.end(route.body)
	})

	server.on('connection', () => {
		connections += 1
	})

	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
	port = (server.address() as AddressInfo).port
	const origin = `http://127.0.0.1:${port}`
	const crossOrigin = `http://localhost:${port}`
	routes = pages(origin, crossOrigin)

	return {
		origin,
		crossOrigin,
		requests,
		received,
		connectionCount: () => connections,
		resetTraffic: () => {
			requests.length = 0
			received.length = 0
			connections = 0
		},
		expectedResourceUrls: [
			`${origin}/`,
			`${origin}/style.css`,
			`${origin}/image.png`,
			`${origin}/frame-outer.html`,
			`${origin}/frame-inner.html`,
			`${crossOrigin}/frame-cross.html`,
		],
		close: () =>
			new Promise<void>((resolve, reject) => {
				server.close((error) => (error === undefined ? resolve() : reject(error)))
			}),
	}
}
