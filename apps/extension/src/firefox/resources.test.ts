/**
 * The capture's network policy, asserted directly.
 *
 * `classifyResourceUrl` is the gate that keeps a capture from becoming a
 * general-purpose privileged fetcher and keeps the user's cookies from
 * following a `<all_urls>` grant off-site. Both are security invariants
 * (docs/architecture.md, "Capture-side security assumptions"), and an
 * invariant that is only checked by reading the code is one that drifts.
 *
 * `acquireResources` needs no browser: it uses the platform `fetch` and
 * nothing else, so the same production code runs here against an ordinary
 * local server.
 *
 * **What this file can and cannot prove about credentials.** Node has no
 * cookie jar, so `credentials: 'include'` is inert here and no assertion
 * below can observe a cookie. What it *can* observe is the request shape
 * that makes the leak impossible: which requests are made, in which order,
 * and that the credentialed one never reaches a redirect's target. That
 * shape is also what makes the *scope* observable — a credentialed request
 * is the one that stops at a redirect rather than following it, so "which
 * document's origin was this reference measured against" is answerable from
 * the server's own log. The cookies themselves are asserted in a real
 * Firefox, against a real jar, by `e2e/firefox/phase-1.test.ts` — which
 * injects the very function under test here.
 */

import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import test from 'node:test'
import type { NetworkResourceReference } from './page-capture.ts'
import {
	acquireResources,
	classifyResourceUrl,
	credentialScopeForDocumentUrl,
	fetchResourceWithoutCredentialLeak,
	type ResourceAcquisitionResult,
	type ResourceFetchLimits,
} from './resources.ts'

const PAGE = 'https://example.invalid/page'

/** The scope every reference in a one-document capture carries — Phase 1's whole world, and the default for the tests that are about something else. */
const PAGE_SCOPE = credentialScopeForDocumentUrl(PAGE)

/**
 * `capture.ts`'s Phase 1 call, as a helper: one document, so one scope,
 * attached to every reference it made.
 *
 * The tests below that are *not* about the credential boundary keep calling
 * it, which is deliberate — they assert budget, bounds and cancellation
 * behaviour, and the scope is noise to them. The ones that *are* about the
 * boundary call `acquireResources` directly, with a scope per reference,
 * because that is the distinction a single page URL could not make.
 */
function acquireFromDocument(references: readonly NetworkResourceReference[], documentUrl: string, limits: ResourceFetchLimits): Promise<ResourceAcquisitionResult> {
	const credentialScope = credentialScopeForDocumentUrl(documentUrl)
	return acquireResources(
		references.map((reference) => ({ ...reference, credentialScope })),
		limits,
	)
}

/** Generous enough not to interfere with a test that is about something else. */
const NO_LIMIT: ResourceFetchLimits = { maxResourceBytes: 8 * 1024 * 1024, maxTotalBytes: 32 * 1024 * 1024 }

/** One request the test server received, in arrival order. */
interface ReceivedRequest {
	readonly path: string
	readonly host: string
}

interface Fixture {
	readonly origin: string
	readonly crossOrigin: string
	readonly received: ReceivedRequest[]
	/** Settles when the client hangs up on `/error-body`, which is the whole assertion of the test that uses it. */
	readonly errorBodyHungUpOn: Promise<void>
	/** How much of `/error-body` the server got to write before that happened. */
	errorBodyBytesWritten(): number
}

/**
 * How long the server waits, after it has arranged the state a test needs,
 * for the client to act on it.
 *
 * **It is a guard on cross-connection arrival order, not a stand-in for a
 * condition that could be observed.** The states these tests depend on are
 * established by server-side barriers — `heldHeaders >= 4`, then
 * `tinyAnswered === 2` — and each response is sent only once its barrier is
 * met. What the server cannot see is the step in between: a worker claims
 * the shared budget in the microtask checkpoint after its `fetch` resolves,
 * and `acquireResources` sends no request at that point, or ever again, so
 * "a worker has claimed" reaches this file through no channel that exists.
 * The only way to interlock it exactly would be a claim callback in
 * `resources.ts`, which is a branch in `src/` for a test's benefit
 * (CONTRIBUTING.md) and is not worth having.
 *
 * So what is left to cover is that four header arrivals on four connections
 * are all processed before a fifth arrival on a fifth — which the ordering
 * of the writes already all but decides, and which 50 ms of loopback makes
 * a margin of three orders of magnitude rather than a race. Measured: 25
 * runs idle and 15 under twelve-way CPU saturation, no failures, the whole
 * file settling in ~250-350 ms.
 */
const CLIENT_SETTLE_MS = 50

/** Where `/error-body` gives up offering a body nobody wants. Far more than a client that hangs up should ever take, far less than a test should sit through if one does not. */
const ERROR_BODY_CAP = 16 * 1024 * 1024

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * A server answering on two origins at once — `127.0.0.1` and `localhost`
 * are different origins on the same port, which is what makes a redirect
 * between them a genuinely cross-origin one.
 */
async function startFixture(t: { after(fn: () => Promise<void> | void): void }): Promise<Fixture> {
	const received: ReceivedRequest[] = []
	let port = 0

	/** How many `/held` responses have flushed their headers — the point at which their reader has a response to claim budget for. */
	let heldHeaders = 0
	/** How many `/tiny` responses have been answered. */
	let tinyAnswered = 0
	let releaseHeldBodies = (): void => {}
	const heldBodiesReleased = new Promise<void>((resolve) => {
		releaseHeldBodies = resolve
	})
	/** Set once `/abort` has dropped its connection mid-body, so `/abort-follower` can answer strictly afterwards. */
	let abortDropped = false

	/** `/error-body`: how much of an unwanted body the server managed to send, and the hang-up that stopped it. */
	let errorBodyBytesWritten = 0
	let errorBodyHungUp = (): void => {}
	const errorBodyHungUpOn = new Promise<void>((resolve) => {
		errorBodyHungUp = resolve
	})

	const server: Server = createServer((request, response) => {
		const path = (request.url ?? '/').split('?')[0] ?? '/'
		received.push({ path, host: request.headers.host ?? '' })
		switch (path) {
			case '/held': {
				// Headers now, body later. `fetch` resolves on the headers, so a
				// reader is sitting on this response — holding whatever budget it
				// claimed — for as long as the body does not arrive.
				response.writeHead(200, { 'content-type': 'image/png' })
				response.write(Buffer.alloc(512, 1))
				heldHeaders += 1
				void heldBodiesReleased.then(() => response.end(Buffer.alloc(512, 1)))
				return
			}
			case '/tiny': {
				void (async () => {
					while (heldHeaders < 4) {
						await delay(5)
					}
					// Every held reader has had its turn at the budget before this
					// eleven-byte resource asks for its own.
					await delay(CLIENT_SETTLE_MS)
					response.writeHead(200, { 'content-type': 'image/png' })
					response.end(Buffer.alloc(11, 2))
					tinyAnswered += 1
					if (tinyAnswered === 2) {
						// And both tiny readers have had time to be starved, if this
						// implementation is one that starves them, before the held
						// bodies free the budget up again.
						await delay(CLIENT_SETTLE_MS)
						releaseHeldBodies()
					}
				})()
				return
			}
			case '/error-body': {
				// A non-ok response whose body keeps coming until somebody stops it.
				// The client is not supposed to want any of this, which is exactly
				// why the server has to keep offering it.
				response.writeHead(500, { 'content-type': 'text/plain' })
				const block = Buffer.alloc(64 * 1024, 9)
				let hungUp = false
				response.on('close', () => {
					hungUp = true
					errorBodyHungUp()
				})
				const pump = (): void => {
					if (hungUp || errorBodyBytesWritten >= ERROR_BODY_CAP) {
						if (!hungUp) {
							response.end()
						}
						return
					}
					errorBodyBytesWritten += block.byteLength
					if (response.write(block)) {
						setTimeout(pump, 1)
					} else {
						response.once('drain', pump)
					}
				}
				pump()
				return
			}
			case '/abort': {
				response.writeHead(200, { 'content-type': 'image/png' })
				response.write(Buffer.alloc(1024, 5))
				setTimeout(() => {
					abortDropped = true
					response.destroy()
				}, 20)
				return
			}
			case '/abort-follower': {
				void (async () => {
					while (!abortDropped) {
						await delay(5)
					}
					response.writeHead(200, { 'content-type': 'text/css' })
					response.end('body{color:red}')
				})()
				return
			}
			case '/style.css':
				response.writeHead(200, { 'content-type': 'text/css; charset=UTF-8' })
				response.end('body{color:red}')
				return
			case '/untyped':
				response.writeHead(200, { 'content-type': '' })
				response.end('plain')
				return
			case '/two-slashes':
				response.writeHead(200, { 'content-type': 'text/css/garbage' })
				response.end('body{color:blue}')
				return
			case '/redirect-cross':
				response.writeHead(302, { location: `http://localhost:${port}/target.css` })
				response.end()
				return
			case '/redirect-same':
				response.writeHead(302, { location: `http://127.0.0.1:${port}/target.css` })
				response.end()
				return
			case '/target.css':
				response.writeHead(200, { 'content-type': 'text/css' })
				response.end('body{color:green}')
				return
			case '/chunked-large': {
				// No `Content-Length` at all — the case a bounded reader exists for,
				// and the reason trusting the header would not be enough.
				response.writeHead(200, { 'content-type': 'image/png' })
				for (let chunk = 0; chunk < 8; chunk += 1) {
					response.write(Buffer.alloc(64 * 1024, 7))
				}
				response.end()
				return
			}
			case '/128k':
				response.writeHead(200, { 'content-type': 'image/png' })
				response.end(Buffer.alloc(128 * 1024, 3))
				return
			default:
				response.writeHead(404, { 'content-type': 'text/plain' })
				response.end('missing')
		}
	})
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
	port = (server.address() as AddressInfo).port
	t.after(() => new Promise<void>((resolve, reject) => server.close((error) => (error === undefined ? resolve() : reject(error)))))
	return {
		origin: `http://127.0.0.1:${port}`,
		crossOrigin: `http://localhost:${port}`,
		received,
		errorBodyHungUpOn,
		errorBodyBytesWritten: () => errorBodyBytesWritten,
	}
}

test('only http(s) is ever requested, whatever the page put in the attribute', () => {
	for (const url of [
		'file:///etc/passwd',
		'moz-extension://abc/background.js',
		'javascript:fetch("https://evil.invalid")',
		'chrome://browser/content/browser.xhtml',
		'about:config',
		'data:text/html,<b>',
		'ws://example.invalid/socket',
		'not a url at all',
	]) {
		assert.equal(classifyResourceUrl(url, PAGE_SCOPE), undefined, `${url} must not be fetchable`)
	}
	assert.deepEqual(classifyResourceUrl('https://example.invalid/a.png', PAGE_SCOPE), { url: 'https://example.invalid/a.png', credentials: 'include' })
	assert.deepEqual(classifyResourceUrl('http://example.invalid/a.png', PAGE_SCOPE), { url: 'http://example.invalid/a.png', credentials: 'omit' })
})

test('credentials go to the page’s own origin and nowhere else', () => {
	assert.equal(classifyResourceUrl('https://example.invalid/deep/path?q=1', PAGE_SCOPE)?.credentials, 'include')
	// A different host, a different scheme and a different port are each a
	// different origin, and each must lose the cookies.
	assert.equal(classifyResourceUrl('https://cdn.example.invalid/a.png', PAGE_SCOPE)?.credentials, 'omit')
	assert.equal(classifyResourceUrl('http://example.invalid/a.png', PAGE_SCOPE)?.credentials, 'omit')
	assert.equal(classifyResourceUrl('https://example.invalid:8443/a.png', PAGE_SCOPE)?.credentials, 'omit')
})

test('a reference is same-origin to the document that made it, not to the capture’s top document', () => {
	// The Phase 2 shape, in the one form a unit test can hold: a top document
	// on origin A, and a reference that originated in a child document on
	// origin B.
	const topDocumentA = credentialScopeForDocumentUrl('https://a.invalid/page')
	const childDocumentB = credentialScopeForDocumentUrl('https://b.invalid/frame')

	// 1. B references a B resource: same-origin *to B*, so it may carry B's
	//    cookies — which the old one-page-url rule refused, because it only
	//    ever asked whether the target was A.
	assert.deepEqual(classifyResourceUrl('https://b.invalid/logo.png', childDocumentB), { url: 'https://b.invalid/logo.png', credentials: 'include' })

	// 2. B references an A resource: cross-origin *to B*. This is the one
	//    that matters. Under the old rule the target's origin matched the
	//    page URL's and the request went out with `include`, handing a
	//    document on B the user's authenticated session on A — an
	//    authenticated cross-origin read no document on the page could have
	//    performed for itself.
	assert.equal(classifyResourceUrl('https://a.invalid/private.json', childDocumentB)?.credentials, 'omit')

	// And the top document is unaffected by any of it: its own references are
	// judged against its own origin, exactly as before.
	assert.equal(classifyResourceUrl('https://a.invalid/private.json', topDocumentA)?.credentials, 'include')
	assert.equal(classifyResourceUrl('https://b.invalid/logo.png', topDocumentA)?.credentials, 'omit')
})

test('a scope derived from a document URL is that URL’s origin, port and scheme included', () => {
	assert.deepEqual(credentialScopeForDocumentUrl('https://example.invalid/page?q=1#x'), { kind: 'origin', origin: 'https://example.invalid' })
	assert.deepEqual(credentialScopeForDocumentUrl('https://example.invalid:8443/page'), { kind: 'origin', origin: 'https://example.invalid:8443' })
	assert.deepEqual(credentialScopeForDocumentUrl('http://example.invalid/page'), { kind: 'origin', origin: 'http://example.invalid' })
})

test('a scope with no origin to name spends nobody’s credentials, and is not same-origin with another one', () => {
	// A URL that names no tuple origin. `URL.origin` renders each of these as
	// the *string* `"null"`, which is exactly the trap: comparing origins as
	// strings would make all of them same-origin with each other, and a
	// document whose URL merely failed to parse same-origin with a real site
	// called `null`.
	for (const documentUrl of ['about:blank', 'about:srcdoc', 'data:text/html,<b>', 'not a url at all']) {
		const scope = credentialScopeForDocumentUrl(documentUrl)
		assert.deepEqual(scope, { kind: 'opaque' }, documentUrl)
		// Still fetchable — the references are ordinary http(s) URLs the
		// document named — but never with credentials.
		assert.deepEqual(classifyResourceUrl('https://example.invalid/a.png', scope), { url: 'https://example.invalid/a.png', credentials: 'omit' })
		assert.equal(classifyResourceUrl('file:///etc/passwd', scope), undefined)
	}

	// Two opaque scopes are not each other's origin. This is a property of
	// the representation rather than a claim about any browser: what a
	// `srcdoc` or `about:blank` frame's *effective* origin is (it inherits
	// its parent's) is not something this module infers, and Phase 2 must
	// state it rather than arrive here with a URL.
	assert.notDeepEqual(classifyResourceUrl('https://example.invalid/a.png', credentialScopeForDocumentUrl('about:blank'))?.credentials, 'include')
})

test('acquireResources fetches what it can and reports what it cannot, without failing the capture', async (t) => {
	const { origin, received } = await startFixture(t)

	const result = await acquireFromDocument(
		[
			{ url: `${origin}/style.css`, kind: 'stylesheet' },
			{ url: `${origin}/untyped`, kind: 'stylesheet' },
			{ url: `${origin}/gone.png`, kind: 'image' },
			{ url: 'file:///etc/passwd', kind: 'image' },
		],
		`${origin}/page`,
		NO_LIMIT,
	)

	const byUrl = new Map(result.resources.map((resource) => [resource.url, resource]))
	assert.deepEqual(byUrl.get(`${origin}/style.css`)?.mimeType, 'text/css')
	assert.deepEqual(byUrl.get(`${origin}/style.css`)?.textEncoding, 'UTF-8')
	assert.deepEqual(new TextDecoder().decode(byUrl.get(`${origin}/style.css`)?.bytes ?? new Uint8Array()), 'body{color:red}')
	// No `Content-Type` falls back to where the reference was found, never to
	// sniffing the bytes.
	assert.equal(byUrl.get(`${origin}/untyped`)?.mimeType, 'text/css')
	assert.equal(byUrl.get(`${origin}/untyped`)?.textEncoding, undefined)

	// A 404 and a refused scheme are both ordinary outcomes: no part, no
	// invented resource, one diagnostic each.
	assert.equal(byUrl.has(`${origin}/gone.png`), false)
	assert.deepEqual(
		[...result.diagnostics].map((diagnostic) => diagnostic.type),
		['unresolved-resource', 'unresolved-resource'],
	)
	assert.deepEqual(
		result.diagnostics.map((diagnostic) => (diagnostic.type === 'unresolved-resource' ? diagnostic.url : '')).sort(),
		['file:///etc/passwd', `${origin}/gone.png`].sort(),
	)
	assert.equal(
		received.some((request) => request.path === '/etc/passwd'),
		false,
	)
})

test('a media type the serializer could not write falls back instead of reaching it', async (t) => {
	const { origin } = await startFixture(t)
	const result = await acquireFromDocument([{ url: `${origin}/two-slashes`, kind: 'stylesheet' }], `${origin}/page`, NO_LIMIT)
	// `text/css/garbage` used to come back verbatim and take the whole save
	// down inside `serializeMhtml`.
	assert.equal(result.resources[0]?.mimeType, 'text/css')
})

test('a credentialed request does not follow a redirect; the retry that does carries no credentials', async (t) => {
	const { origin, crossOrigin, received } = await startFixture(t)

	const attempt = await fetchResourceWithoutCredentialLeak(`${origin}/redirect-cross`, 'include')
	assert.equal(attempt.credentialsWithheld, true, 'the credentialed attempt should have been abandoned at the redirect')
	assert.equal(attempt.response.ok, true, 'the uncredentialed retry should still have produced the resource')
	assert.equal(attempt.response.url, `${crossOrigin}/target.css`)

	// Two requests to the original URL — the credentialed one that stopped at
	// the redirect, then the uncredentialed one that followed it — and the
	// cross-origin target reached exactly once, by the second chain.
	assert.deepEqual(
		received.map((request) => request.path),
		['/redirect-cross', '/redirect-cross', '/target.css'],
	)
	assert.equal(received.filter((request) => request.host.startsWith('localhost')).length, 1)
	// The one request that could have carried cookies was the first, and it
	// was made to the page's own origin.
	assert.equal(received[0]?.host.startsWith('127.0.0.1'), true)
})

test('a same-origin redirect is refused the same way, because the platform does not say where it leads', async (t) => {
	const { origin, received } = await startFixture(t)
	// Firefox answers `redirect: 'manual'` with an opaque-redirect response —
	// status 0, no `Location` (measured) — so "same-origin redirect" is not a
	// case this code can recognise, and treating an unknown target as
	// cross-origin is the only safe reading of it.
	const attempt = await fetchResourceWithoutCredentialLeak(`${origin}/redirect-same`, 'include')
	assert.equal(attempt.credentialsWithheld, true)
	assert.equal(await attempt.response.text(), 'body{color:green}')
	assert.deepEqual(
		received.map((request) => request.path),
		['/redirect-same', '/redirect-same', '/target.css'],
	)
})

test('a request that does not redirect keeps its credentials and costs one request', async (t) => {
	const { origin, crossOrigin, received } = await startFixture(t)

	const credentialed = await fetchResourceWithoutCredentialLeak(`${origin}/style.css`, 'include')
	assert.equal(credentialed.credentialsWithheld, false)
	assert.equal(credentialed.response.status, 200)
	assert.equal(await credentialed.response.text(), 'body{color:red}')

	// An uncredentialed request has nothing to protect, so it follows
	// redirects in one go — the platform bounds that chain itself.
	const anonymous = await fetchResourceWithoutCredentialLeak(`${crossOrigin}/redirect-cross`, 'omit')
	assert.equal(anonymous.credentialsWithheld, false)
	assert.equal(anonymous.response.url, `${crossOrigin}/target.css`)

	assert.deepEqual(
		received.map((request) => request.path),
		['/style.css', '/redirect-cross', '/target.css'],
	)
})

test('a redirected resource keeps the URL the markup names, and says the credentials were withheld', async (t) => {
	const { origin } = await startFixture(t)
	const result = await acquireFromDocument([{ url: `${origin}/redirect-cross`, kind: 'stylesheet' }], `${origin}/page`, NO_LIMIT)

	// The archived markup points at the URL the page referenced, so that is
	// the part's identity. Where the redirect led is diagnostic information,
	// never a silent replacement for it.
	assert.equal(result.resources[0]?.url, `${origin}/redirect-cross`)
	assert.equal(new TextDecoder().decode(result.resources[0]?.bytes ?? new Uint8Array()), 'body{color:green}')
	assert.deepEqual(
		result.diagnostics.map((diagnostic) => diagnostic.type),
		['unsupported-feature'],
	)
	assert.match(result.diagnostics[0]?.type === 'unsupported-feature' ? result.diagnostics[0].feature : '', /redirected.*without credentials/)
})

test('one capture makes two different credential decisions, each according to the document its reference came from', async (t) => {
	const { origin, crossOrigin, received } = await startFixture(t)

	// **Both targets live on `origin`.** The only thing that differs is which
	// document referenced them — and that is precisely what one page URL for
	// the whole capture could not express: whichever origin it named, one of
	// the two assertions below would be wrong.
	//
	// The credential mode is observable here without a cookie jar, because
	// the two modes make visibly different request shapes: a credentialed
	// request is the one that refuses to follow a redirect and so costs two
	// requests to the same URL, while an uncredentialed one follows in a
	// single chain.
	const result = await acquireResources(
		[
			{ url: `${origin}/redirect-cross`, kind: 'stylesheet', credentialScope: credentialScopeForDocumentUrl(`${origin}/top`) },
			{ url: `${origin}/redirect-same`, kind: 'stylesheet', credentialScope: credentialScopeForDocumentUrl(`${crossOrigin}/frame`) },
		],
		NO_LIMIT,
	)

	const requestsTo = (path: string): number => received.filter((request) => request.path === path).length
	assert.equal(requestsTo('/redirect-cross'), 2, 'a reference from its own origin should have been credentialed, and a credentialed request stops at the redirect')
	assert.equal(
		requestsTo('/redirect-same'),
		1,
		'a reference from another document’s origin should have carried no credentials, and an uncredentialed request follows the redirect in one chain',
	)

	// The same fact stated the other way round: exactly one of the two was
	// credentialed, so exactly one had credentials to withhold at a redirect.
	assert.deepEqual(
		result.diagnostics.map((diagnostic) => (diagnostic.type === 'unsupported-feature' ? diagnostic.feature : diagnostic.type)),
		[`${origin}/redirect-cross redirected, so it was re-fetched without credentials rather than sending them to wherever it redirected to`],
	)
	// And both resources were still acquired, under the URLs the markup names.
	assert.deepEqual(result.resources.map((resource) => resource.url).sort(), [`${origin}/redirect-cross`, `${origin}/redirect-same`].sort())
})

test('a response larger than one resource may allocate contributes nothing, and the rest of the capture continues', async (t) => {
	const { origin } = await startFixture(t)
	const result = await acquireFromDocument(
		[
			{ url: `${origin}/chunked-large`, kind: 'image' },
			{ url: `${origin}/style.css`, kind: 'stylesheet' },
		],
		`${origin}/page`,
		{ maxResourceBytes: 100 * 1024, maxTotalBytes: 10 * 1024 * 1024 },
	)

	// The oversized response carries no `Content-Length` at all, so only a
	// reader that stops could have bounded it.
	assert.deepEqual(
		result.resources.map((resource) => resource.url),
		[`${origin}/style.css`],
		'the oversized resource was archived, whole or in part',
	)
	assert.deepEqual(result.diagnostics.map((diagnostic) => diagnostic.type).sort(), ['unresolved-resource', 'unsupported-feature'])
	assert.match(result.diagnostics.map((diagnostic) => (diagnostic.type === 'unsupported-feature' ? diagnostic.feature : '')).join(''), /larger than this capture may allocate/)
})

test('a resource is refused for the total budget only by bytes actually retained, never by what another worker is holding', { timeout: 30_000 }, async (t) => {
	const { origin } = await startFixture(t)

	// Four resources whose responses arrive and then stall, and two tiny ones
	// behind them. The per-resource ceiling is a quarter of the total, so the
	// four stalled readers can claim the entire budget between them while
	// retaining nothing — which is exactly the state the tiny two must
	// survive. Everything this capture really retains (4 x 1 KB + 2 x 11 B)
	// is a fraction of the 256 KB it is allowed.
	const result = await acquireFromDocument(
		[
			{ url: `${origin}/held?1`, kind: 'image' },
			{ url: `${origin}/held?2`, kind: 'image' },
			{ url: `${origin}/held?3`, kind: 'image' },
			{ url: `${origin}/held?4`, kind: 'image' },
			{ url: `${origin}/tiny?5`, kind: 'image' },
			{ url: `${origin}/tiny?6`, kind: 'image' },
		],
		`${origin}/page`,
		{ maxResourceBytes: 64 * 1024, maxTotalBytes: 256 * 1024 },
	)

	assert.deepEqual(
		result.resources.map((resource) => resource.url).sort(),
		[`${origin}/held?1`, `${origin}/held?2`, `${origin}/held?3`, `${origin}/held?4`, `${origin}/tiny?5`, `${origin}/tiny?6`],
		'a temporary claim by one worker dropped a resource that fitted the budget with room to spare',
	)
	assert.deepEqual(result.diagnostics, [])
	// And the bytes really are all there: an eleven-byte resource read against
	// a zero-byte budget is the failure this guards, so its length is the
	// assertion.
	assert.deepEqual(
		result.resources.map((resource) => resource.bytes.byteLength).sort((a, b) => a - b),
		[11, 11, 1024, 1024, 1024, 1024],
	)
})

test('a body the capture will not read is hung up on, not left running', { timeout: 30_000 }, async (t) => {
	const fixture = await startFixture(t)

	// A non-ok response never reaches the bounded reader, so *nothing* in
	// `acquireResources` bounds what it transfers — the platform decides, and
	// in Firefox the platform decides to take all of it (measured: a 500 whose
	// body kept coming delivered 64 MB in 37 ms to a response nobody read).
	// The interlock is the server's own hang-up event rather than a wait: if
	// this ever stops cancelling, nothing hangs up and the test times out.
	const result = await acquireFromDocument([{ url: `${fixture.origin}/error-body`, kind: 'image' }], `${fixture.origin}/page`, NO_LIMIT)
	await fixture.errorBodyHungUpOn

	assert.ok(fixture.errorBodyBytesWritten() < ERROR_BODY_CAP, `the server sent its whole ${ERROR_BODY_CAP}-byte body, so the client took a body it had already refused`)
	// And the outcome for the archive is the ordinary one: no resource, one
	// diagnostic, no failed capture.
	assert.deepEqual(result.resources, [])
	assert.deepEqual(result.diagnostics, [{ type: 'unresolved-resource', url: `${fixture.origin}/error-body` }])
})

test('a read that throws gives its claim on the budget back, rather than stranding it', { timeout: 30_000 }, async (t) => {
	const { origin } = await startFixture(t)

	// The total is one resource's worth, so the second resource can only be
	// read if the first one's claim came back when its connection died. If it
	// did not, this does not fail an assertion — it waits forever, which is
	// what the timeout is for.
	const result = await acquireFromDocument(
		[
			{ url: `${origin}/abort`, kind: 'image' },
			{ url: `${origin}/abort-follower`, kind: 'stylesheet' },
		],
		`${origin}/page`,
		{ maxResourceBytes: 64 * 1024, maxTotalBytes: 64 * 1024 },
	)

	assert.deepEqual(
		result.resources.map((resource) => resource.url),
		[`${origin}/abort-follower`],
	)
	assert.equal(new TextDecoder().decode(result.resources[0]?.bytes ?? new Uint8Array()), 'body{color:red}')
	assert.deepEqual(result.diagnostics, [{ type: 'unresolved-resource', url: `${origin}/abort` }])
})

test('the capture’s total byte budget bounds many resources, not just one large one', async (t) => {
	const { origin } = await startFixture(t)
	const references = Array.from({ length: 6 }, () => ({ url: `${origin}/128k`, kind: 'image' as const }))
	// Six distinct references to the same 128 KB body, against a 300 KB total.
	const result = await acquireFromDocument(
		references.map((reference, index) => ({ ...reference, url: `${reference.url}?${index}` })),
		`${origin}/page`,
		{ maxResourceBytes: 1024 * 1024, maxTotalBytes: 300 * 1024 },
	)

	const archived = result.resources.reduce((total, resource) => total + resource.bytes.byteLength, 0)
	assert.ok(archived <= 300 * 1024, `the capture archived ${archived} bytes against a 307200-byte budget`)
	assert.ok(result.resources.length >= 2 && result.resources.length < 6, `expected some but not all resources, got ${result.resources.length}`)
	assert.ok(
		result.diagnostics.some((diagnostic) => diagnostic.type === 'unresolved-resource'),
		'a resource dropped for the budget must still be reported',
	)
})
