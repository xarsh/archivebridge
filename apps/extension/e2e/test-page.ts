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
 * The server also records every request it receives. Nothing asserts on
 * that yet, but it is the hook the eventual archive viewer needs: the
 * viewer must make *zero* requests for archived content, and the only
 * honest way to test "no network fallback" is to have a server that can
 * say it was never called. See docs/architecture.md, "Archive viewer".
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

/** The exact PNG the test page serves. Exported so a test can assert the archived copy is byte-identical. */
export const imageBytes: Buffer = deterministicPng(IMAGE_SIDE)

const STYLESHEET = 'body { background: #fff; color: #111; font-family: system-ui, sans-serif; }\n'

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
	])
}

export interface TestServer {
	/** Origin the page under test is loaded from. */
	readonly origin: string
	/** A different origin serving the same server, for the cross-origin frame. */
	readonly crossOrigin: string
	/** Every path requested so far, in order. The hook for future "the viewer made no requests" assertions. */
	readonly requests: readonly string[]
	/** URLs the captured archive is expected to contain a part for. */
	readonly expectedResourceUrls: readonly string[]
	close(): Promise<void>
}

/** Starts the test server on an ephemeral port. */
export async function startTestServer(): Promise<TestServer> {
	const requests: string[] = []
	let routes: ReadonlyMap<string, { readonly contentType: string; readonly body: string | Buffer }> = new Map()

	const server: Server = createServer((request, response) => {
		const path = (request.url ?? '/').split('?')[0] ?? '/'
		requests.push(path)
		const route = routes.get(path)
		if (route === undefined) {
			response.writeHead(404, { 'content-type': 'text/plain' })
			response.end('not found')
			return
		}
		response.writeHead(200, { 'content-type': route.contentType, 'cache-control': 'no-store' })
		response.end(route.body)
	})

	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
	const { port } = server.address() as AddressInfo
	const origin = `http://127.0.0.1:${port}`
	const crossOrigin = `http://localhost:${port}`
	routes = pages(origin, crossOrigin)

	return {
		origin,
		crossOrigin,
		requests,
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
