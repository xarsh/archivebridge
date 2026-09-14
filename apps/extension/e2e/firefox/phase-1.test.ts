/**
 * Firefox Phase 1: top-document capture, in a real Firefox, against a real
 * page.
 *
 * ## Where the observation boundary is, and why it is there
 *
 * Two measured facts decide the shape of this file.
 *
 * **A pending `saveAs: true` download is invisible.** With Firefox's native
 * chooser open, the `downloads.download` promise stays pending and
 * `downloads.search({})` returns *zero* items — no `DownloadItem` exists
 * until the user answers. Playwright's trick on the Chrome lane (it
 * replaces Chrome's download pipeline, so `saveAs` completes with no
 * chooser) has no equivalent here, and an OS file chooser must never be a
 * CI gate. So the saved bytes cannot be read back off disk, and weakening
 * `saveAs: true` in production to make that possible is not on the table.
 *
 * **`permissions.request()` needs a real input event.** BiDi's own
 * `userActivation: true` flag is not one; a synthesized pointer click is
 * (see `bidi-session.ts`).
 *
 * So this suite splits at the nearest observable browser API boundary:
 *
 * - the **capture** is driven through the real `browser.scripting`
 *   `executeScript` API, from the extension's own page, injecting the
 *   production capture function into the real fixture tab — the same call,
 *   the same isolated world, the same arguments `capture.ts` makes;
 * - **resource acquisition, assembly and conversion** then run the
 *   production modules directly (`resources.ts`, `mhtml-document.ts`,
 *   `archiveBytesFrom`), which they can because none of them needs a
 *   browser;
 * - and each **save command** is exercised end to end for real, and
 *   asserted on where it can be: that a genuine click acquires the host
 *   permission, that a command with no permission returns a controlled
 *   failure rather than an unhandled rejection, and that a command with one
 *   runs past capture and conversion and parks in the chooser.
 *
 * Nothing in `src/` has a branch for any of this.
 */

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, before, describe, test } from 'node:test'
import { detectArchiveFormatFromBytes, parseMhtml, parseWebArchive, renderMhtml, serializeMhtml } from '@xarsh/archivebridge'
import { archiveBytesFrom } from '../../src/core/archive-bytes.ts'
import { PAGE_CAPTURE_LIMITS, RESOURCE_FETCH_LIMITS } from '../../src/firefox/capture-limits.ts'
import { buildMhtmlDocument } from '../../src/firefox/mhtml-document.ts'
import { capturePageState, type PageCaptureOptions, type PageCaptureResult } from '../../src/firefox/page-capture.ts'
import { acquireResources, credentialScopeForDocumentUrl, fetchResourceWithoutCredentialLeak } from '../../src/firefox/resources.ts'
import {
	CANVAS_BOUNDS_PATH,
	CANVAS_BOUNDS_PLAIN,
	CANVAS_BOUNDS_READY_TITLE,
	CANVAS_BOUNDS_UNREADABLE,
	COOKIE_PATH,
	CROSS_ORIGIN_COOKIE,
	CROSS_ORIGIN_REDIRECT_PATH,
	CROSS_ORIGIN_TARGET_PATH,
	FIREFOX_DATA_IMAGE_URL,
	firefoxBlobResourceBytes,
	SAME_ORIGIN_COOKIE,
	smallImageBytes,
	startTestServer,
	TAINTED_CANVAS_CLEAN_BACKDROP_RGB,
	TAINTED_CANVAS_CROSS_ORIGIN_RGB,
	TAINTED_CANVAS_PATH,
	TAINTED_CANVAS_READY_TITLE,
	TAINTED_CANVAS_SAME_ORIGIN_RGB,
	TAINTED_CANVAS_SIDE,
	TAINTED_CANVAS_TAINTED_BACKDROP_RGB,
	type TestServer,
} from '../test-page.ts'
import { startFirefoxSession } from './bidi-session.ts'

const FIXTURE_READY_TITLE = 'ArchiveBridge Firefox fixture ready'

/** Base64 is the harness's transport, not the capture's: BiDi hands back a `RemoteValue`, so binary has to cross as text even though the world boundary underneath carries `Uint8Array`s natively. */
function bytesFromBase64(base64: string): Uint8Array {
	return new Uint8Array(Buffer.from(base64, 'base64'))
}

/** Reads a PNG's IHDR. Enough to tell what the archived canvas actually is: its bitmap size, and whether it kept an alpha channel. */
function readPngHeader(bytes: Uint8Array): { readonly width: number; readonly height: number; readonly colorType: number } {
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
	assert.equal(new TextDecoder().decode(bytes.subarray(12, 16)), 'IHDR', 'not a PNG')
	return { width: view.getUint32(16), height: view.getUint32(20), colorType: bytes[25] ?? -1 }
}

interface FixtureSession {
	readonly fixtureTabId: number
	/** Evaluates `expression` in the extension's own popup page and parses the JSON string it returns. */
	inPopup<T>(expression: string): Promise<T>
	/**
	 * Opens `url` in this Firefox and returns the tab id the extension sees
	 * for it. `readyTitle` waits for the page to rename itself to that, the
	 * way the main fixture is waited for: a page that builds what a test is
	 * about in its `load` handler is not ready when its tab exists.
	 */
	openTab(url: string, readyTitle?: string): Promise<number>
	/**
	 * Runs the production capture in `tabId` through the real
	 * `scripting.executeScript`, from the extension's own page — the same
	 * call, the same isolated world, the same argument shape `capture.ts`
	 * makes. `limits` overrides the production bounds, which is how a test
	 * proves a limit *works* without asking a fixture to allocate 32 MB to
	 * reach the real one.
	 */
	capture(tabId: number, canvasContentIdPrefix: string, limits?: Partial<Omit<PageCaptureOptions, 'canvasContentIdPrefix'>>): Promise<PageCaptureResult>
	/** Everything `browser.permissions.getAll()` reports. */
	grantedPermissions(): Promise<{ origins: string[]; permissions: string[] }>
	close(): Promise<void>
}

/**
 * Starts a Firefox with the built extension, opens the fixture page and the
 * popup, and acquires the optional host permission the way a user does.
 *
 * The permission-acquiring click is a genuine synthesized pointer event on
 * the production button, so `popup.ts`'s gesture ordering is what makes it
 * work. The command that click starts resolves the *active* tab — which,
 * because the popup here is an ordinary tab, is the popup itself, an
 * extension page the capture may not touch — so it fails fast instead of
 * parking in a file chooser. That controlled failure is asserted rather
 * than merely relied on.
 */
async function openFixtureSession(server: TestServer): Promise<FixtureSession> {
	const session = await startFirefoxSession()
	try {
		const fixtureContext = await session.openPage(`${server.origin}/firefox/`)
		// The fixture renames itself on `load`, once its own script has run:
		// waiting for that is what makes "the capture reflects the post-script
		// DOM" an assertion about the capture rather than a race.
		for (let attempt = 0; attempt < 200; attempt += 1) {
			if (String(await session.evaluate(fixtureContext, 'document.title')) === FIXTURE_READY_TITLE) {
				break
			}
			await new Promise((resolve) => setTimeout(resolve, 50))
		}

		const popupContext = await session.openPage(session.extensionUrl('popup.html'))
		const inPopup = async <T>(expression: string): Promise<T> => JSON.parse(String(await session.evaluate(popupContext, expression))) as T

		const clickSave = async (format: 'mhtml' | 'webarchive') => {
			await session.click(popupContext, `#save-${format}`)
			for (let attempt = 0; attempt < 200; attempt += 1) {
				const state = await inPopup<{ busy: boolean; status: string; isError: boolean }>(
					"JSON.stringify({ busy: document.getElementById('save-mhtml').disabled, status: document.getElementById('status').textContent, isError: document.getElementById('status').classList.contains('error') })",
				)
				if (!state.busy) {
					return { status: state.status, isError: state.isError }
				}
				await new Promise((resolve) => setTimeout(resolve, 50))
			}
			throw new Error('the popup never left its busy state')
		}

		const settled = await clickSave('mhtml')
		assert.equal(settled.isError, true, 'a save of an extension page should report an error, not succeed silently')

		// `tab.url` is visible because the host permission was just granted —
		// no `tabs` permission is involved, and production never reads it.
		const tabs = await inPopup<{ id: number; url?: string }[]>('(async () => JSON.stringify(await browser.tabs.query({})))()')
		const fixtureTab = tabs.find((tab) => tab.url?.startsWith(`${server.origin}/firefox/`))
		assert.notEqual(fixtureTab, undefined, `no tab found for the fixture page; tabs were ${JSON.stringify(tabs)}`)

		// `tabs.query({ url })` is not an option: its `url` is a *match
		// pattern*, and a match pattern cannot carry a port, which every URL
		// this server serves has. So the tab is found the way the fixture tab
		// above is — by asking for all of them and matching the string.
		const openTab = async (url: string, readyTitle?: string): Promise<number> => {
			const context = await session.openPage(url)
			if (readyTitle !== undefined) {
				for (let attempt = 0; attempt < 200; attempt += 1) {
					if (String(await session.evaluate(context, 'document.title')) === readyTitle) {
						break
					}
					await new Promise((resolve) => setTimeout(resolve, 50))
				}
			}
			for (let attempt = 0; attempt < 100; attempt += 1) {
				const opened = await inPopup<{ id: number; url?: string }[]>('(async () => JSON.stringify(await browser.tabs.query({})))()')
				const tab = opened.find((candidate) => candidate.url === url)
				if (tab !== undefined) {
					return tab.id
				}
				await new Promise((resolve) => setTimeout(resolve, 50))
			}
			throw new Error(`no tab found for ${url}`)
		}

		return {
			fixtureTabId: fixtureTab?.id ?? -1,
			inPopup,
			openTab,
			capture: async (tabId, canvasContentIdPrefix, limits = {}) => await capturePage(inPopup, tabId, canvasContentIdPrefix, limits),
			grantedPermissions: async () => await inPopup<{ origins: string[]; permissions: string[] }>('(async () => JSON.stringify(await browser.permissions.getAll()))()'),
			close: async () => await session.close(),
		}
	} catch (error) {
		await session.close()
		throw error
	}
}

/**
 * One capture, run the way production runs it.
 *
 * Binary crosses BiDi as base64 because a `RemoteValue` is text; the world
 * boundary underneath still carries `Uint8Array`s natively, which is what
 * production depends on and what `capture.ts` narrows.
 */
async function capturePage(
	inPopup: FixtureSession['inPopup'],
	tabId: number,
	canvasContentIdPrefix: string,
	limits: Partial<Omit<PageCaptureOptions, 'canvasContentIdPrefix'>>,
): Promise<PageCaptureResult> {
	const raw = await inPopup<{
		url: string
		mimeType: string
		title: string
		html: string
		networkResources: PageCaptureResult['networkResources']
		canvases: { contentId: string; cidUrl: string; bytes: string }[]
		blobs: { url: string; contentType: string; bytes: string }[]
		notes: PageCaptureResult['notes']
	}>(`(async () => {
		const capturePageState = ${capturePageState.toString()}
		const [injection] = await browser.scripting.executeScript({
			target: { tabId: ${tabId}, frameIds: [0] },
			world: 'ISOLATED',
			func: capturePageState,
			args: [${JSON.stringify({ canvasContentIdPrefix, ...PAGE_CAPTURE_LIMITS, ...limits })}],
		})
		if (injection === undefined || injection.error !== undefined) {
			throw new Error('executeScript failed: ' + String(injection && injection.error))
		}
		const result = injection.result
		const encode = (bytes) => {
			let binary = ''
			for (const byte of bytes) { binary += String.fromCharCode(byte) }
			return btoa(binary)
		}
		return JSON.stringify({
			url: result.url,
			mimeType: result.mimeType,
			title: result.title,
			html: result.html,
			networkResources: result.networkResources,
			canvases: result.canvases.map((canvas) => ({ contentId: canvas.contentId, cidUrl: canvas.cidUrl, bytes: encode(canvas.bytes) })),
			blobs: result.blobs.map((blob) => ({ url: blob.url, contentType: blob.contentType, bytes: encode(blob.bytes) })),
			notes: result.notes,
		})
	})()`)

	return {
		url: raw.url,
		mimeType: raw.mimeType,
		title: raw.title,
		html: raw.html,
		networkResources: raw.networkResources,
		canvases: raw.canvases.map((canvas) => ({ ...canvas, bytes: bytesFromBase64(canvas.bytes) })),
		blobs: raw.blobs.map((blob) => ({ ...blob, bytes: bytesFromBase64(blob.bytes) })),
		notes: raw.notes,
	}
}

describe('Firefox Phase 1: top-document capture', () => {
	let server: TestServer
	let fixture: FixtureSession

	/** The archived bytes every fidelity assertion below reads, produced once through the production path. */
	let mhtmlBytes: Uint8Array
	/** The archived root document, decoded — most assertions are about what is and is not in here. */
	let archivedHtml: string
	let capture: PageCaptureResult

	before(async () => {
		server = await startTestServer()
		fixture = await openFixtureSession(server)

		// The production capture function, injected into the real fixture tab
		// through the real `scripting.executeScript` call, from the extension's
		// own page — exactly as `capture.ts` invokes it, with exactly the
		// bounds `capture.ts` passes.
		const canvasContentIdPrefix = `canvas-${randomUUID()}@archivebridge`
		capture = await fixture.capture(fixture.fixtureTabId, canvasContentIdPrefix)

		const topDocumentScope = credentialScopeForDocumentUrl(capture.url)
		const acquired = await acquireResources(
			capture.networkResources.map((reference) => ({ ...reference, credentialScope: topDocumentScope })),
			RESOURCE_FETCH_LIMITS,
		)
		const built = buildMhtmlDocument(capture, acquired.resources, canvasContentIdPrefix)
		assert.deepEqual([...acquired.diagnostics, ...built.diagnostics], [], 'the deterministic fixture must capture with no diagnostics at all')
		mhtmlBytes = serializeMhtml(built.document)
		archivedHtml = new TextDecoder().decode(parseMhtml(mhtmlBytes).document?.parts[0]?.data ?? new Uint8Array())
	})

	after(async () => {
		await fixture?.close()
		await server?.close()
	})

	/**
	 * The whole archive as text — every part, headers and decoded bodies
	 * alike. "This string is not in the root document" is a weaker claim than
	 * "it is not in the archive at all", and for a secret the second one is
	 * what is worth asserting.
	 */
	function mhtmlText(): string {
		const parts = parseMhtml(mhtmlBytes).document?.parts ?? []
		return [new TextDecoder().decode(mhtmlBytes), ...parts.map((part) => new TextDecoder().decode(part.data))].join('\n')
	}

	test('A. the built extension asks for the Phase 1 permission shape and nothing more', async () => {
		const declared = await fixture.inPopup<{ permissions: string[]; optional_host_permissions: string[]; host_permissions?: string[] }>(
			'JSON.stringify(browser.runtime.getManifest())',
		)
		assert.deepEqual(declared.permissions, ['scripting', 'downloads', 'menus', 'activeTab'])
		// Optional, not required: a fresh install asks for nothing and the first
		// save explains itself in context.
		assert.deepEqual(declared.optional_host_permissions, ['<all_urls>'])
		// Firefox normalizes an absent `host_permissions` to an empty array in
		// `getManifest()`; that the *file* declares none is asserted against the
		// built manifest itself in `phase-0.test.ts`.
		assert.deepEqual(declared.host_permissions ?? [], [])
		// The permissions the research said not to take, still not taken.
		for (const refused of ['tabs', 'webRequest', 'declarativeNetRequest', 'webNavigation', 'offscreen']) {
			assert.equal(declared.permissions.includes(refused), false, `${refused} must not be requested`)
		}
	})

	test('B. a real click on the production button acquires the optional host permission', async () => {
		// The click happened in `before`. What is asserted here is that
		// `permissions.request` was reached from the gesture at all — if
		// `popup.ts` awaited anything before calling it, Firefox would have
		// rejected the call with "may only be called from a user input handler"
		// and this would be empty.
		const granted = await fixture.grantedPermissions()
		assert.deepEqual(granted.origins, ['<all_urls>'])
		assert.deepEqual([...granted.permissions].sort(), ['activeTab', 'downloads', 'menus', 'scripting'])
	})

	test('C. the captured bytes are MHTML, and ArchiveBridge parses them with no diagnostics', () => {
		assert.equal(detectArchiveFormatFromBytes(mhtmlBytes), 'mhtml')
		const parsed = parseMhtml(mhtmlBytes)
		assert.notEqual(parsed.document, undefined)
		assert.deepEqual(parsed.diagnostics, [])
	})

	test('D. the root part is the page, and the capture is of the post-script DOM', () => {
		const parsed = parseMhtml(mhtmlBytes)
		const root = parsed.document?.parts[parsed.document.rootPartIndex]
		assert.equal(root?.location, `${server.origin}/firefox/`)
		assert.equal(root?.mimeType, 'text/html')
		assert.equal(root?.textEncoding, 'utf-8')
		assert.match(archivedHtml, /data-mutated="yes"/)
		assert.match(archivedHtml, /PROSE_CONTENT/)
		assert.equal(capture.title, FIXTURE_READY_TITLE)
	})

	test('E. script elements are stripped and no script bytes are archived', () => {
		assert.equal(/<script/i.test(archivedHtml), false, 'the archived markup still contains a <script> element')
		// And the mutation it performed is still there, which is what proves the
		// stripping happened after execution rather than instead of it.
		assert.match(archivedHtml, /data-mutated="yes"/)
		for (const part of parseMhtml(mhtmlBytes).document?.parts ?? []) {
			assert.equal(/javascript|ecmascript/i.test(part.mimeType), false, `a script resource was archived as ${part.mimeType}`)
		}
	})

	test('F. visible live form state is preserved, in both directions', () => {
		assert.match(archivedHtml, /id="text-input"[^>]*value="TYPED_TEXT"/)
		assert.equal(archivedHtml.includes('ORIGINAL_TEXT'), false, 'the served value survived instead of the typed one')
		assert.match(archivedHtml, /<textarea[^>]*id="textarea"[^>]*>TYPED_TEXTAREA<\/textarea>/)
		assert.equal(archivedHtml.includes('ORIGINAL_TEXTAREA'), false)

		// Turned on by script, with no `checked` attribute in the markup.
		assert.match(archivedHtml, /id="checkbox"[^>]*checked/)
		// Turned *off* by script, with a `checked` attribute in the markup: the
		// direction a capture that only ever adds attributes would get wrong.
		assert.equal(/id="radio-a"[^>]*checked/.test(archivedHtml), false, 'a radio the user deselected is still checked in the archive')
		assert.match(archivedHtml, /id="radio-b"[^>]*checked/)

		assert.equal(/id="option-a"[^>]*selected/.test(archivedHtml), false)
		assert.match(archivedHtml, /id="option-b"[^>]*selected/)
	})

	test('G. a password keeps what the page served and never what the user typed', () => {
		// The two halves are what tell "the policy held" from "the control was
		// stripped": the served value survives untouched, the live one is
		// nowhere. A password input with no served value could not distinguish
		// them, which is why the fixture gives it one.
		assert.match(archivedHtml, /id="password"[^>]*value="PASSWORD_ORIGINAL"/)
		assert.equal(archivedHtml.includes('SECRET_PASSWORD_VALUE'), false, 'the archive contains the live password')
		assert.equal(mhtmlText().includes('SECRET_PASSWORD_VALUE'), false, 'the live password is somewhere in the archive outside its root document')
	})

	test('G2. a file input that really is holding a file contributes neither its state nor its bytes', () => {
		// The fixture selects a file through a `DataTransfer`, which Firefox
		// allows (measured: `files.length` becomes 1 and `value` becomes
		// `C:\\fakepath\\private.txt`). The marker proves the selection took
		// effect, so what this asserts is a policy holding rather than an empty
		// control being empty.
		assert.match(archivedHtml, /id="file-input"[^>]*data-file-selected="1"/)
		assert.equal(archivedHtml.includes('data-file-setup-error'), false, 'the fixture could not select a file, so this test proves nothing')

		const archivedInput = /<input id="file-input"[^>]*>/.exec(archivedHtml)?.[0] ?? ''
		assert.notEqual(archivedInput, '', 'the file input is missing from the archive')
		assert.equal(/\svalue=/.test(archivedInput), false, `the capture wrote a file input's value: ${archivedInput}`)
		// Neither the file's name nor its contents, anywhere in the archive —
		// not merely absent from the root document.
		const archive = mhtmlText()
		assert.equal(archive.includes('PRIVATE_FILE_CONTENT'), false, 'the selected file’s bytes are in the archive')
		assert.equal(archive.includes('private.txt'), false, 'the selected file’s name is in the archive')
		assert.equal(archive.includes('fakepath'), false, 'the file input’s live value is in the archive')
	})

	test('H. hidden fields are recorded as the document holds them, and the capture adds nothing to them', () => {
		// `<input type=hidden>`'s `value` IDL attribute is in the spec's
		// "default" mode: the setter writes the *content attribute*, so a page
		// that assigns `.value` has already changed its own markup, and a live
		// hidden value that differs from the attribute is not a state that can
		// exist. There is therefore nothing for the exclusion to strip — and
		// stripping anyway would corrupt a legitimately-served hidden value.
		// What the exclusion does guarantee is that the capture never *adds*
		// hidden state, which is what the second half checks.
		assert.match(archivedHtml, /id="hidden-field"[^>]*value="HIDDEN_ORIGINAL"/)
		const untouched = /<input id="hidden-untouched"[^>]*>/.exec(archivedHtml)?.[0] ?? ''
		assert.notEqual(untouched, '', 'the valueless hidden input is missing from the archive')
		assert.equal(/value=/.test(untouched), false, 'the capture invented a value attribute on a hidden input that had none')
	})

	test('I. a one-time-code control keeps what the page served, not what script put in it', () => {
		assert.match(archivedHtml, /id="otp"[^>]*value="OTP_ORIGINAL"/)
		assert.equal(archivedHtml.includes('OTP_LIVE_SECRET'), false, 'the archive contains a one-time code')
	})

	test('J. the canvas becomes an image resource at its rendered size', () => {
		// The element is gone and an <img> stands in its place — the accepted
		// cost of the representation that actually renders (measured in
		// ArchiveBridge's viewer and in Chrome's own native MHTML viewer, where
		// `background-image: url(cid:…)` renders in neither).
		assert.equal(/<canvas/i.test(archivedHtml), false, 'the canvas element was left in place')
		const replacement = /<img[^>]*id="canvas"[^>]*>/.exec(archivedHtml)?.[0] ?? ''
		assert.notEqual(replacement, '', `no replacement <img> for the canvas in: ${archivedHtml.slice(0, 400)}`)
		assert.match(replacement, /src="cid:/)
		// The CSS box the live page was rendering (64x16), carried explicitly:
		// without it the element collapses to 0x0 when the document is loaded as
		// MHTML, in every viewer measured.
		assert.match(replacement, /width:64px/)
		assert.match(replacement, /height:16px/)
		// ...and not the bitmap's own 32x32, which is what copying the canvas's
		// content attributes across would have produced.
		assert.equal(/\swidth="32"/.test(replacement), false)
		assert.equal(/\sheight="32"/.test(replacement), false)

		const pixels = parseMhtml(mhtmlBytes).document?.parts.find((part) => part.mimeType === 'image/png' && part.location === undefined)
		assert.notEqual(pixels, undefined, 'the canvas pixels are not in the archive')
		const header = readPngHeader(pixels?.data ?? new Uint8Array())
		assert.deepEqual({ width: header.width, height: header.height }, { width: 32, height: 32 }, 'the archived bitmap is not the canvas bitmap')
		// Colour type 6 is RGBA: the fixture leaves two quadrants fully
		// transparent, and a capture that flattened them would come back as 2.
		assert.equal(header.colorType, 6, 'the canvas snapshot lost its alpha channel')
	})

	test('K. an open shadow root is archived as a standard declarative shadow root', () => {
		assert.match(archivedHtml, /<template shadowrootmode="open">/)
		assert.match(archivedHtml, /SHADOW_CONTENT/)
		// Not Blink's legacy spelling: ArchiveBridge-authored MHTML carries the
		// standard attribute, so the viewer's `shadowmode` normalization has
		// nothing to do here.
		assert.equal(archivedHtml.includes('shadowmode='), false)
	})

	test('L. ordinary referenced resources are archived, and a data: reference stays inline', () => {
		const byLocation = new Map((parseMhtml(mhtmlBytes).document?.parts ?? []).map((part) => [part.location, part]))
		assert.equal(byLocation.get(`${server.origin}/firefox/style.css`)?.mimeType, 'text/css')
		assert.equal(byLocation.get(`${server.origin}/firefox/style.css`)?.textEncoding, 'utf-8')
		assert.deepEqual(byLocation.get(`${server.origin}/firefox/small.png`)?.data, new Uint8Array(smallImageBytes))

		// A `data:` reference carries its own bytes: it stays exactly as written
		// and must not be duplicated into a MIME part.
		assert.ok(archivedHtml.includes(FIREFOX_DATA_IMAGE_URL), 'the inline data: image was rewritten or dropped')
		assert.equal(
			[...byLocation.keys()].some((location) => location?.startsWith('data:') === true),
			false,
			'a data: reference became a redundant MIME part',
		)
	})

	test('M. blob-backed bytes, which only the page could read, survive into the archive', () => {
		const blobPart = (parseMhtml(mhtmlBytes).document?.parts ?? []).find((part) => part.location?.startsWith('blob:') === true)
		assert.notEqual(blobPart, undefined, 'the blob: resource is missing from the archive')
		assert.equal(blobPart?.mimeType, 'image/svg+xml')
		assert.deepEqual(blobPart?.data, new Uint8Array(firefoxBlobResourceBytes))
		// The reference in the markup and the part's identity are the same
		// string, so the archive resolves it without needing a URL that means
		// anything outside this file.
		assert.ok(archivedHtml.includes(blobPart?.location ?? 'missing'))
	})

	test('N. Phase 1 does not claim to have captured the child frame', () => {
		// The iframe survives as ordinary markup pointing at its original URL...
		assert.match(archivedHtml, new RegExp(`id="child-frame"[^>]*src="${server.origin.replace(/[.]/g, '\\.')}/firefox/frame\\.html"`))
		// ...with no cid: link and no part behind it, so nothing in the archive
		// says the frame's document is inside it.
		assert.equal(archivedHtml.includes('FRAMED_CONTENT'), false)
		assert.equal(
			(parseMhtml(mhtmlBytes).document?.parts ?? []).some((part) => part.location === `${server.origin}/firefox/frame.html`),
			false,
		)
	})

	test('O. the captured MHTML renders through ArchiveBridge’s own viewer', () => {
		const parsed = parseMhtml(mhtmlBytes)
		assert.notEqual(parsed.document, undefined)
		if (parsed.document === undefined) {
			return
		}
		let minted = 0
		const rendered = renderMhtml(parsed.document, {
			createResourceUrl: (bytes, mimeType) => {
				minted += 1
				return `resource:${minted}:${mimeType}:${bytes.byteLength}`
			},
		})
		assert.notEqual(rendered.rootUrl, undefined, 'the viewer found no root document to render')
		assert.equal(rendered.stats.documents, 1)
		// Every reference the archive was supposed to satisfy does resolve. The
		// one that does not is the child frame, which Phase 1 deliberately did
		// not capture — so it is named here rather than hidden by a loose
		// assertion.
		assert.deepEqual(
			rendered.warnings.filter((warning) => warning.type === 'unresolved-reference').map((warning) => (warning.type === 'unresolved-reference' ? warning.url : '')),
			[`${server.origin}/firefox/frame.html`],
		)
		// The legacy-spelling normalization has nothing to do on our own output.
		assert.equal(rendered.stats.normalizedShadowRoots, 0)
		assert.ok(rendered.stats.resources >= 3, `expected the image, the stylesheet, the blob and the canvas to be minted, got ${rendered.stats.resources}`)
	})

	test('P. the same bytes convert to a WebArchive that parses and keeps its linkage', () => {
		const webarchive = archiveBytesFrom(mhtmlBytes, 'webarchive')
		assert.deepEqual(webarchive.diagnostics, [])
		assert.equal(detectArchiveFormatFromBytes(webarchive.bytes), 'webarchive')

		const parsed = parseWebArchive(webarchive.bytes)
		assert.deepEqual(parsed.diagnostics, [])
		assert.equal(parsed.document?.mainResource.url, `${server.origin}/firefox/`)
		assert.deepEqual(parsed.document?.subframeArchives, [], 'Phase 1 captured no frames, so the WebArchive must claim none')

		const subresourceUrls = new Set((parsed.document?.subresources ?? []).map((resource) => resource.url))
		assert.ok(subresourceUrls.has(`${server.origin}/firefox/small.png`))
		assert.ok(subresourceUrls.has(`${server.origin}/firefox/style.css`))

		// The canvas had only a Content-ID in MHTML. Conversion mints it a
		// loadable URL in the synthetic namespace and rewrites the reference to
		// match, so the linkage survives even though the `cid:` spelling cannot.
		const converted = new TextDecoder().decode(parsed.document?.mainResource.data ?? new Uint8Array())
		const canvasResource = (parsed.document?.subresources ?? []).find((resource) => resource.url.startsWith('https://content-id.archivebridge.invalid/'))
		assert.notEqual(canvasResource, undefined, 'the canvas pixels lost their identity on conversion')
		assert.equal(readPngHeader(canvasResource?.data ?? new Uint8Array()).width, 32)
		assert.ok(converted.includes(canvasResource?.url ?? 'missing'), 'the converted markup does not point at the converted canvas resource')
		assert.equal(converted.includes('cid:'), false, 'a cid: reference survived into the WebArchive, where nothing can load one')
	})

	test('Q. the saved file is named from the archive’s own bytes, in both formats', () => {
		// `core/file-name.ts` derives it from the captured document, never from
		// tab metadata — which is why this extension needs no `tabs` permission
		// on either browser.
		assert.equal(archiveBytesFrom(mhtmlBytes, 'mhtml').fileName, `${FIXTURE_READY_TITLE}.mhtml`)
		assert.equal(archiveBytesFrom(mhtmlBytes, 'webarchive').fileName, `${FIXTURE_READY_TITLE}.webarchive`)
	})

	test('S. a blob: URL is read only where a browser would have loaded one', () => {
		// The real resource: an `<img src="blob:…">`, whose bytes exist nowhere
		// but in this page and therefore nowhere but in this archive.
		const blobParts = (parseMhtml(mhtmlBytes).document?.parts ?? []).filter((part) => part.location?.startsWith('blob:') === true)
		assert.equal(blobParts.length, 1, 'expected exactly the blob: image — one part, no more and no fewer')

		// The false positives. Each is a real blob URL in an attribute a
		// browser never loads; reading them made the capture archive page data
		// that merely looked like a reference — the same mistake as resolving a
		// `cid:`-shaped string found in an arbitrary attribute.
		const archive = mhtmlText()
		for (const secret of ['BLOB_SECRET_IN_DATA_ATTRIBUTE', 'BLOB_SECRET_IN_TITLE', 'BLOB_SECRET_IN_HREF', 'BLOB_SECRET_IN_VALUE']) {
			assert.equal(archive.includes(secret), false, `the capture read the bytes behind a blob: URL in a non-resource attribute (${secret})`)
		}
		// The attribute values themselves stay in the markup, because they are
		// page content. Refusing to *load* one is not redacting it.
		assert.match(archivedHtml, /id="blob-in-data"[^>]*data-private="blob:/)
		assert.match(archivedHtml, /id="blob-in-href"[^>]*href="blob:/)
	})

	test('T. the doctype keeps the external identifiers that decide the rendering mode', async () => {
		const legacyTabId = await fixture.openTab(`${server.origin}/firefox/legacy-doctype.html`)
		const legacy = await fixture.capture(legacyTabId, `canvas-${randomUUID()}@archivebridge`)
		// `<!DOCTYPE html>` alone would put a reader in no-quirks mode, which is
		// not the mode this document was captured in.
		assert.match(legacy.html, /^<!DOCTYPE html PUBLIC "-\/\/W3C\/\/DTD HTML 4\.01\/\/EN" "http:\/\/www\.w3\.org\/TR\/html4\/strict\.dtd">\n/)
		assert.match(legacy.html, /LEGACY_DOCTYPE_CONTENT/)
		// And the ordinary case still comes out as the ordinary spelling.
		assert.match(archivedHtml, /^<!DOCTYPE html>\n/)
	})

	test('U. every bound the page can push against holds, and costs a resource rather than the save', async () => {
		const capturePrefix = `canvas-${randomUUID()}@archivebridge`
		const notesOf = (captured: PageCaptureResult) => captured.notes.map((note) => note.kind)

		// A canvas past the pre-encoding pixel bound is never handed to
		// `toDataURL` at all, and stays an ordinary `<canvas>` in the archive.
		const tinyPixelBudget = await fixture.capture(fixture.fixtureTabId, capturePrefix, { maxCanvasPixels: 4 })
		assert.deepEqual(tinyPixelBudget.canvases, [])
		assert.deepEqual(notesOf(tinyPixelBudget), ['canvas-limit-reached'])
		assert.match(tinyPixelBudget.html, /<canvas/i, 'a canvas that could not be snapshotted must survive as itself')

		// Likewise for the canvas count.
		const noCanvases = await fixture.capture(fixture.fixtureTabId, capturePrefix, { maxCanvases: 0 })
		assert.deepEqual(noCanvases.canvases, [])
		assert.deepEqual(notesOf(noCanvases), ['canvas-limit-reached'])

		// A blob larger than one resource may contribute is refused by a reader
		// that stops, not by a `Blob` the page minted reporting its own size
		// after the body has already been produced.
		const tinyResource = await fixture.capture(fixture.fixtureTabId, capturePrefix, { maxResourceBytes: 8 })
		assert.deepEqual(tinyResource.blobs, [])
		assert.ok(notesOf(tinyResource).includes('blob-too-large'), `expected a blob-too-large note, got ${notesOf(tinyResource).join(', ')}`)

		// And that bound is exact on both sides of itself. At the ceiling the
		// blob is archived whole; one byte below it, the resource contributes
		// *nothing* — a truncated prefix archived as though it were the whole
		// resource is the failure this shape exists to prevent.
		const exactlyAtCeiling = await fixture.capture(fixture.fixtureTabId, capturePrefix, { maxResourceBytes: firefoxBlobResourceBytes.length })
		assert.deepEqual(
			exactlyAtCeiling.blobs.map((blob) => blob.bytes.byteLength),
			[firefoxBlobResourceBytes.length],
		)
		assert.deepEqual(exactlyAtCeiling.blobs[0]?.bytes, new Uint8Array(firefoxBlobResourceBytes))
		assert.equal(notesOf(exactlyAtCeiling).includes('blob-too-large'), false)

		const oneByteShort = await fixture.capture(fixture.fixtureTabId, capturePrefix, { maxResourceBytes: firefoxBlobResourceBytes.length - 1 })
		assert.deepEqual(oneByteShort.blobs, [])
		assert.ok(notesOf(oneByteShort).includes('blob-too-large'))
		// The rest of the capture is untouched by it: the canvas beside the blob
		// still came back, and so did the page.
		assert.equal(oneByteShort.canvases.length, 1)
		assert.match(oneByteShort.html, /PROSE_CONTENT/)

		// And a page that mints more blob URLs than the capture will read.
		const noBlobs = await fixture.capture(fixture.fixtureTabId, capturePrefix, { maxBlobResources: 0 })
		assert.deepEqual(noBlobs.blobs, [])
		assert.ok(notesOf(noBlobs).includes('blob-limit-reached'))

		// The budget that covers canvas pixels and blob bytes together, which
		// neither per-resource bound would catch on its own.
		const tinyTotal = await fixture.capture(fixture.fixtureTabId, capturePrefix, { maxCapturedBytes: 16 })
		assert.deepEqual(tinyTotal.canvases, [])
		assert.deepEqual(tinyTotal.blobs, [])
		assert.ok(notesOf(tinyTotal).includes('capture-byte-limit-reached'))
		// One note per limit however many times it is reached: a page with ten
		// thousand canvases must not answer a bound with an unbounded list of
		// complaints about it.
		assert.equal(notesOf(tinyTotal).filter((kind) => kind === 'capture-byte-limit-reached').length, 1)

		// The reference count, which Phase 1 already bounded, still holds.
		const oneResource = await fixture.capture(fixture.fixtureTabId, capturePrefix, { maxNetworkResources: 1 })
		assert.equal(oneResource.networkResources.length, 1)
		assert.ok(notesOf(oneResource).includes('resource-limit-reached'))

		// Every one of those captures still produced an archive: a limit costs
		// the resource that crossed it and nothing else.
		for (const captured of [tinyPixelBudget, noCanvases, tinyResource, oneByteShort, noBlobs, tinyTotal, oneResource]) {
			const built = buildMhtmlDocument(captured, [], capturePrefix)
			assert.doesNotThrow(() => serializeMhtml(built.document))
			assert.match(captured.html, /PROSE_CONTENT/)
		}
	})

	test('U2. the canvas bound counts snapshot attempts, so canvases that cannot be snapshotted are still bounded work', async () => {
		// A page of ten canvases: two ordinary ones, then eight that no
		// principal can read (see `test-page.ts` — a tainted canvas is readable
		// from the capture's own expanded principal while `<all_urls>` is held,
		// which it is here, and a zero-width one is not readable by anybody
		// under any permission). Waiting for the fixture's
		// own count of unreadable canvases is what makes "the bound held"
		// distinguishable from "the fixture did not set itself up".
		const canvasTabId = await fixture.openTab(`${server.origin}${CANVAS_BOUNDS_PATH}`, CANVAS_BOUNDS_READY_TITLE)
		const capturePrefix = `canvas-${randomUUID()}@archivebridge`
		const kindsOf = (captured: PageCaptureResult) => captured.notes.map((note) => note.kind)
		const countOf = (captured: PageCaptureResult, kind: string) => kindsOf(captured).filter((each) => each === kind).length
		const total = CANVAS_BOUNDS_PLAIN + CANVAS_BOUNDS_UNREADABLE

		// With room for every canvas, the two that can be read are read and the
		// eight that cannot are reported one for one — which is also what makes
		// the counts below mean what they say.
		const unbounded = await fixture.capture(canvasTabId, capturePrefix)
		assert.equal(unbounded.canvases.length, CANVAS_BOUNDS_PLAIN)
		assert.equal(countOf(unbounded, 'canvas-unreadable'), CANVAS_BOUNDS_UNREADABLE)
		assert.equal(countOf(unbounded, 'canvas-limit-reached'), 0)

		// **The bound itself.** Four attempts, against a page offering ten. The
		// first two succeed, attempts three and four cannot be read, and the
		// remaining six are never handed to `toDataURL` at all — so exactly two
		// canvases are reported unreadable rather than eight.
		const fourAttempts = await fixture.capture(canvasTabId, capturePrefix, { maxCanvases: 4 })
		assert.equal(fourAttempts.canvases.length, CANVAS_BOUNDS_PLAIN)
		assert.equal(countOf(fourAttempts, 'canvas-unreadable'), 2, 'a canvas past the attempt bound was still handed to toDataURL')
		// One diagnostic for the limit however many canvases are left behind.
		assert.equal(countOf(fourAttempts, 'canvas-limit-reached'), 1)

		// **The same bound when nothing succeeds.** A byte budget too small for
		// any snapshot means `canvases` never grows, which is precisely the
		// state in which a bound counted in successful snapshots bounds nothing:
		// the first two attempts encode a PNG and are refused by the budget, the
		// next two cannot be read, and the other six are again never attempted.
		const spentBudget = await fixture.capture(canvasTabId, capturePrefix, { maxCanvases: 4, maxCapturedBytes: 8 })
		assert.deepEqual(spentBudget.canvases, [])
		assert.equal(countOf(spentBudget, 'canvas-unreadable'), 2, 'the attempt bound stopped counting once the byte budget was spent')
		assert.equal(countOf(spentBudget, 'capture-byte-limit-reached'), 1)
		assert.equal(countOf(spentBudget, 'canvas-limit-reached'), 1)

		// Every canvas that was not snapshotted is still in the archive as
		// itself, and every capture still produces one.
		for (const captured of [fourAttempts, spentBudget]) {
			const remaining = captured.html.match(/<canvas/gi)?.length ?? 0
			assert.equal(remaining, total - captured.canvases.length, 'a canvas that was not snapshotted did not survive as markup')
			assert.match(captured.html, /CANVAS_BOUNDS_CONTENT/)
			assert.doesNotThrow(() => serializeMhtml(buildMhtmlDocument(captured, [], capturePrefix).document))
		}
	})

	test('V. a same-origin reference that redirects off-origin does not take the user’s cookies with it', async () => {
		// Both origins get a cookie of their own. `127.0.0.1` and `localhost`
		// are one server and two origins, which is the shape a CDN redirect
		// has.
		await fixture.openTab(`${server.origin}${COOKIE_PATH}`)
		await fixture.openTab(`${server.crossOrigin}${COOKIE_PATH}`)
		const redirectUrl = `${server.origin}${CROSS_ORIGIN_REDIRECT_PATH}`

		// **The platform behaviour this exists to stop**, measured rather than
		// taken from the spec: an ordinary credentialed fetch that follows the
		// redirect delivers the *target's* cookies to the target, so a page
		// needs only a same-origin reference to have the user's cookies for an
		// unrelated site sent to it. If this assertion ever fails, Firefox has
		// changed and the handling below can be revisited.
		server.resetTraffic()
		await fixture.inPopup<{ ok: boolean }>(
			`(async () => { const r = await fetch(${JSON.stringify(redirectUrl)}, { credentials: 'include', redirect: 'follow' }); return JSON.stringify({ ok: r.ok }) })()`,
		)
		const leaked = server.received.find((request) => request.path === CROSS_ORIGIN_TARGET_PATH)
		assert.equal(leaked?.cookie?.includes(CROSS_ORIGIN_COOKIE), true, `redirect: 'follow' no longer forwards credentials; the target received ${JSON.stringify(leaked)}`)

		// **The production path**, injected into the extension's own page and
		// run against the same cookie jar.
		server.resetTraffic()
		const acquired = await fixture.inPopup<{ withheld: boolean; ok: boolean; body: string }>(`(async () => {
			const fetchResourceWithoutCredentialLeak = ${fetchResourceWithoutCredentialLeak.toString()}
			const attempt = await fetchResourceWithoutCredentialLeak(${JSON.stringify(redirectUrl)}, 'include')
			return JSON.stringify({ withheld: attempt.credentialsWithheld, ok: attempt.response.ok, body: await attempt.response.text() })
		})()`)

		assert.equal(acquired.ok, true, 'the resource should still have been acquired, just without credentials')
		assert.equal(acquired.withheld, true)
		assert.equal(acquired.body, '#redirected{color:rgb(7,8,9)}')

		const hops = server.received.filter((request) => request.path === CROSS_ORIGIN_REDIRECT_PATH || request.path === CROSS_ORIGIN_TARGET_PATH)
		assert.deepEqual(
			hops.map((request) => request.path),
			[CROSS_ORIGIN_REDIRECT_PATH, CROSS_ORIGIN_REDIRECT_PATH, CROSS_ORIGIN_TARGET_PATH],
			'expected the credentialed hop to stop at the redirect, then one uncredentialed chain',
		)
		// The cookies went where the policy allowed them and nowhere else: the
		// page's own origin, on the one request that never left it.
		assert.equal(hops[0]?.cookie?.includes(SAME_ORIGIN_COOKIE), true, 'the same-origin request lost its cookies, which would make this test vacuous')
		assert.equal(hops[1]?.cookie, undefined)
		assert.equal(hops[2]?.cookie, undefined, `the redirect target received cookies: ${JSON.stringify(hops[2])}`)
	})

	test('W. a Uint8Array crosses the world boundary as a real Uint8Array of the realm that asked for it', async () => {
		// `asCapturedCanvas`/`asCapturedBlob` narrow a page's canvas and blob
		// bytes with `value instanceof Uint8Array`, which is load-bearing and
		// realm-sensitive: `instanceof` is false for a typed array belonging to
		// another realm, and every other E2E path reaches those bytes through
		// this harness's own base64 transport rather than through the real
		// `executeScript` return value. So the real thing is measured here.
		//
		// **Why the popup stands in for the background exactly.** Measured
		// through `runtime.getBackgroundPage()`: the result of an
		// `executeScript` made with the *background's* `browser` object is a
		// `Uint8Array` of the *background's* realm — `instanceof` true against
		// the background's constructor, false against the popup's. The clone
		// lands in the realm of the API object that made the call, and
		// `capture.ts` both makes the call and narrows the result in one realm.
		const boundary = await fixture.inPopup<{
			top: Record<string, unknown>
			nested: Record<string, unknown>
			inArray: Record<string, unknown>
			plainObject: Record<string, unknown>
		}>(`(async () => {
			const [injection] = await browser.scripting.executeScript({
				target: { tabId: ${fixture.fixtureTabId}, frameIds: [0] },
				world: 'ISOLATED',
				func: () => ({ bytes: new Uint8Array([1, 2, 3]), nested: { bytes: new Uint8Array([4, 5]) }, list: [new Uint8Array([6])], lookalike: { 0: 7, length: 1 } }),
			})
			const describe = (value) => ({
				isUint8Array: value instanceof Uint8Array,
				isView: ArrayBuffer.isView(value),
				bufferIsArrayBuffer: value.buffer instanceof ArrayBuffer,
				contents: Array.from(value.byteLength === undefined ? [] : value),
			})
			const result = injection.result
			return JSON.stringify({
				top: describe(result.bytes),
				nested: describe(result.nested.bytes),
				inArray: describe(result.list[0]),
				plainObject: { isUint8Array: result.lookalike instanceof Uint8Array, isView: ArrayBuffer.isView(result.lookalike) },
			})
		})()`)

		// Every site the capture actually puts bytes at: the object it returns,
		// an object inside it, and a member of one of its lists.
		assert.deepEqual(boundary.top, { isUint8Array: true, isView: true, bufferIsArrayBuffer: true, contents: [1, 2, 3] })
		assert.deepEqual(boundary.nested, { isUint8Array: true, isView: true, bufferIsArrayBuffer: true, contents: [4, 5] })
		assert.deepEqual(boundary.inArray, { isUint8Array: true, isView: true, bufferIsArrayBuffer: true, contents: [6] })
		// And the narrowing is not satisfied by something merely shaped like
		// bytes, which is why `instanceof` is the check rather than a duck-typed
		// one: a page returns whatever it likes here.
		assert.deepEqual(boundary.plainObject, { isUint8Array: false, isView: false })
	})

	test('R. a save with no host permission returns a controlled failure, not an unhandled rejection', async () => {
		// Revocation from `about:addons` is always possible with an optional
		// permission, so this is an ordinary state rather than an exotic one.
		const outcome = await fixture.inPopup<{ ok: boolean; message: string }>(`(async () => {
			await browser.permissions.remove({ origins: ['<all_urls>'] })
			return JSON.stringify(await browser.runtime.sendMessage({ type: 'save', format: 'mhtml', tabId: ${fixture.fixtureTabId} }))
		})()`)
		assert.equal(outcome.ok, false)
		assert.match(outcome.message, /permission|access|host/i, `expected a message naming the missing permission, got: ${outcome.message}`)
		assert.deepEqual((await fixture.grantedPermissions()).origins, [], 'the extension must not silently re-acquire a permission the user removed')
	})
})

/**
 * A canvas tainted by a cross-origin draw, against the permission states a
 * Firefox capture can really be in.
 *
 * **The capability is real, and it is narrower than it looks.** Measured
 * here, in a real Firefox, with the real built extension: the isolated world
 * reads a canvas the page itself cannot — but **only while the extension
 * holds `<all_urls>`**. Host permission for the very origin that tainted the
 * canvas is *not* enough: with `http://localhost/*` granted, the background
 * fetches that origin's bytes directly and `toDataURL` on the canvas they
 * tainted still answers `SecurityError`. And the check is made where the
 * pixels are read rather than where they were drawn, so a grant taken back
 * in between is honoured.
 *
 * That is why this needs no policy of ArchiveBridge's own. The privileged
 * read is exactly coextensive with the broad, explicit, revocable grant the
 * user makes for this extension — the same grant that lets the background
 * fetch any origin's bytes anyway — and Firefox is what enforces it, not a
 * judgement this code makes about which origins contributed to a canvas
 * (which nothing exposes, and which the capture therefore never guesses at).
 * What this file pins is that it stays that way: a build in which the read
 * began working *without* the grant would be a privilege ArchiveBridge never
 * asked the user for, and would otherwise change silently.
 *
 * The three states are visited in the one order that needs no revocation to
 * reach — a grant widens, and `permissions.request` cannot narrow one — and
 * `<all_urls>` is entered through the production popup button, so the real
 * gesture path is what widens it. Only the deliberately unproduction-like
 * narrow grant needs a button of the test's own; production asks for
 * `<all_urls>` and nothing else.
 *
 * **`activeTab` is not among the states, and cannot be.** It is granted by
 * invoking the browser action on a tab, which is chrome UI no automation
 * here reaches — the popup in this lane is an ordinary tab, so a click in it
 * grants `activeTab` for the popup, never for the fixture. The narrow-grant
 * state stands in for it: both are "reach for this page, no `<all_urls>`",
 * and the measurement above is that the read tracks `<all_urls>` alone.
 */
describe('Firefox Phase 1: a tainted canvas is read only under the broad host permission', () => {
	const PAGE_ORIGIN_PATTERN = 'http://127.0.0.1/*'
	const IMAGE_ORIGIN_PATTERN = 'http://localhost/*'

	let server: TestServer
	let session: Awaited<ReturnType<typeof startFirefoxSession>>
	let popupContext: string
	let inPopup: <T>(expression: string) => Promise<T>

	before(async () => {
		server = await startTestServer()
		session = await startFirefoxSession()
		popupContext = await session.openPage(session.extensionUrl('popup.html'))
		inPopup = async <T>(expression: string): Promise<T> => JSON.parse(String(await session.evaluate(popupContext, expression))) as T
	})

	after(async () => {
		await session?.close()
		await server?.close()
	})

	/** What `browser.permissions` actually reports, which is the only thing any assertion here reads a permission state from. */
	async function permissionState(): Promise<{ origins: string[]; allUrls: boolean; pageOrigin: boolean; imageOrigin: boolean }> {
		return await inPopup(`(async () => JSON.stringify({
			origins: (await browser.permissions.getAll()).origins,
			allUrls: await browser.permissions.contains({ origins: ['<all_urls>'] }),
			pageOrigin: await browser.permissions.contains({ origins: [${JSON.stringify(PAGE_ORIGIN_PATTERN)}] }),
			imageOrigin: await browser.permissions.contains({ origins: [${JSON.stringify(IMAGE_ORIGIN_PATTERN)}] }),
		}))()`)
	}

	/**
	 * Requests `origins` from a real synthesized pointer event on a button of
	 * the test's own.
	 *
	 * Only the per-origin state needs this: production asks for `<all_urls>`
	 * from its own button, which is what the next state uses. The gesture is
	 * the same one `bidi-session.ts` gives that button — this borrows the
	 * gesture path, not a shortcut around it, and nothing in `src/` knows it
	 * exists.
	 */
	async function grantThroughGesture(id: string, origins: readonly string[]): Promise<boolean> {
		await session.evaluate(
			popupContext,
			`(() => {
				const button = document.createElement('button')
				button.id = ${JSON.stringify(id)}
				button.textContent = 'grant'
				button.style.cssText = 'position:fixed;left:0;bottom:0;width:180px;height:40px;z-index:2147483647'
				button.addEventListener('click', () => {
					browser.permissions.request({ origins: ${JSON.stringify(origins)} }).then(
						(granted) => { window[${JSON.stringify(id)}] = String(granted) },
						(error) => { window[${JSON.stringify(id)}] = 'rejected: ' + error },
					)
				})
				document.body.appendChild(button)
				return 'added'
			})()`,
		)
		await session.click(popupContext, `#${id}`)
		for (let attempt = 0; attempt < 200; attempt += 1) {
			const outcome = String(await session.evaluate(popupContext, `String(window[${JSON.stringify(id)}] ?? '')`))
			if (outcome !== '') {
				return outcome === 'true'
			}
			await new Promise((resolve) => setTimeout(resolve, 50))
		}
		throw new Error(`permissions.request({ origins: ${JSON.stringify(origins)} }) never settled`)
	}

	/** The tab id the extension sees for `url`, found the way the rest of this file finds one. */
	async function tabIdFor(url: string): Promise<number> {
		for (let attempt = 0; attempt < 100; attempt += 1) {
			const tabs = await inPopup<{ id: number; url?: string }[]>('(async () => JSON.stringify(await browser.tabs.query({})))()')
			const tab = tabs.find((candidate) => candidate.url === url)
			if (tab !== undefined) {
				return tab.id
			}
			await new Promise((resolve) => setTimeout(resolve, 50))
		}
		throw new Error(`no tab found for ${url}`)
	}

	/**
	 * Two pixels off an archived canvas part, decoded by the browser.
	 *
	 * A PNG's *bytes* say nothing legible about which image reached it, and
	 * the question this file asks is precisely that. Decoding happens in the
	 * extension's own page, from a blob of the extension's own origin, so
	 * nothing about the reading is privileged — only the archiving was.
	 */
	async function archivedPixels(bytes: Uint8Array): Promise<{ size: string; inner: number[]; outer: number[] }> {
		const quarter = Math.floor(TAINTED_CANVAS_SIDE / 4)
		return await inPopup(`(async () => {
			const binary = atob(${JSON.stringify(Buffer.from(bytes).toString('base64'))})
			const bytes = new Uint8Array(binary.length)
			for (let index = 0; index < binary.length; index += 1) { bytes[index] = binary.charCodeAt(index) }
			const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }))
			const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
			const context = canvas.getContext('2d')
			context.drawImage(bitmap, 0, 0)
			const at = (x, y) => Array.from(context.getImageData(x, y, 1, 1).data).slice(0, 3)
			return JSON.stringify({ size: bitmap.width + 'x' + bitmap.height, inner: at(${quarter}, ${quarter}), outer: at(${quarter * 3}, ${quarter * 3}) })
		})()`)
	}

	/** Can the extension's own privileged `fetch` have the cross-origin image's bytes directly? The question that separates "no reach" from "no permission to extract". */
	async function backgroundCanFetchCrossOriginImage(): Promise<boolean> {
		const outcome = await inPopup<{ ok: boolean }>(`(async () => {
			try {
				const response = await fetch(${JSON.stringify(`${server.crossOrigin}/firefox/cross-origin.png`)}, { credentials: 'omit', redirect: 'follow' })
				await response.body.cancel()
				return JSON.stringify({ ok: response.ok })
			} catch (error) { return JSON.stringify({ ok: false }) }
		})()`)
		return outcome.ok
	}

	test('the isolated world extracts a tainted canvas only while `<all_urls>` is held, and degrades to markup and a diagnostic when it is not', async () => {
		// **State 1: permission for both origins, including the one that
		// tainted the canvas — but not `<all_urls>`.**
		assert.equal(await grantThroughGesture('probe-grant-origins', [PAGE_ORIGIN_PATTERN, IMAGE_ORIGIN_PATTERN]), true)
		const narrow = await permissionState()
		assert.equal(narrow.allUrls, false)
		assert.equal(narrow.pageOrigin, true)
		assert.equal(narrow.imageOrigin, true, 'the state this case is about is permission for the tainting origin specifically')

		const pageUrl = `${server.origin}${TAINTED_CANVAS_PATH}`
		const pageContext = await session.openPage(pageUrl)
		for (let attempt = 0; attempt < 200; attempt += 1) {
			if (String(await session.evaluate(pageContext, 'document.title')) === TAINTED_CANVAS_READY_TITLE) {
				break
			}
			await new Promise((resolve) => setTimeout(resolve, 50))
		}
		const tabId = await tabIdFor(pageUrl)

		// The extension can have the tainting origin's bytes for the asking, so
		// whatever refuses the canvas below is not about reach.
		assert.equal(await backgroundCanFetchCrossOriginImage(), true, 'the granted image origin should be fetchable, or this case proves nothing')

		const refusedPrefix = `canvas-${randomUUID()}@archivebridge`
		const refused = await capturePage(inPopup, tabId, refusedPrefix, {})
		// The page's own verdict on its own canvases, carried in the title it
		// renamed itself to: exactly one of the two is beyond the page. Without
		// this, "the extension read it" and "there was nothing to read" look the
		// same.
		assert.equal(refused.title, TAINTED_CANVAS_READY_TITLE, 'the fixture did not taint its canvas, so this test is vacuous')
		assert.equal(refused.canvases.length, 1, 'a tainted canvas was extracted without `<all_urls>`')
		assert.deepEqual(refused.notes, [{ kind: 'canvas-unreadable', detail: 'The operation is insecure.' }])
		// The one canvas that was archived is the same-origin control, whole.
		assert.deepEqual(await archivedPixels(refused.canvases[0]?.bytes ?? new Uint8Array()), {
			size: `${TAINTED_CANVAS_SIDE}x${TAINTED_CANVAS_SIDE}`,
			inner: [...TAINTED_CANVAS_SAME_ORIGIN_RGB],
			outer: [...TAINTED_CANVAS_CLEAN_BACKDROP_RGB],
		})
		// **The degradation, in full**: the canvas that could not be read stays
		// in the archive as the ordinary element it is, the control became an
		// `<img src="cid:…">`, and the save is a save.
		assert.match(refused.html, /<canvas id="tainted"/)
		assert.equal(/<canvas id="clean"/.test(refused.html), false)
		assert.match(refused.html, /<img id="clean"[^>]*src="cid:/)
		assert.match(refused.html, /TAINTED_CANVAS_CONTENT/)
		const degraded = buildMhtmlDocument(refused, [], refusedPrefix)
		assert.deepEqual(
			degraded.diagnostics.map((diagnostic) => diagnostic.type),
			['unsupported-feature'],
			`expected the unreadable canvas to be the only thing reported, got ${JSON.stringify(degraded.diagnostics)}`,
		)
		assert.match(degraded.diagnostics.map((diagnostic) => (diagnostic.type === 'unsupported-feature' ? diagnostic.feature : '')).join(''), /canvas pixels could not be read/)
		// A lost canvas costs its own pixels and nothing else: the archive is
		// still an archive, and still parses.
		const degradedBytes = serializeMhtml(degraded.document)
		assert.equal(detectArchiveFormatFromBytes(degradedBytes), 'mhtml')
		assert.deepEqual(parseMhtml(degradedBytes).diagnostics, [])

		// **State 2: `<all_urls>`, granted through the production button.**
		await session.click(popupContext, '#save-mhtml')
		for (let attempt = 0; attempt < 200; attempt += 1) {
			if ((await permissionState()).allUrls) {
				break
			}
			await new Promise((resolve) => setTimeout(resolve, 50))
		}
		const broad = await permissionState()
		assert.equal(broad.allUrls, true, 'the production button did not acquire `<all_urls>`')

		const extracted = await capturePage(inPopup, tabId, `canvas-${randomUUID()}@archivebridge`, {})
		// Same page, same canvas, same taint — the page still cannot read it.
		assert.equal(extracted.title, TAINTED_CANVAS_READY_TITLE)
		assert.equal(extracted.canvases.length, 2, 'the tainted canvas was not extracted under `<all_urls>`')
		assert.deepEqual(extracted.notes, [])
		// And the pixels really are the cross-origin image's, which is what
		// makes this a privileged flow rather than a technicality.
		assert.deepEqual(await archivedPixels(extracted.canvases[0]?.bytes ?? new Uint8Array()), {
			size: `${TAINTED_CANVAS_SIDE}x${TAINTED_CANVAS_SIDE}`,
			inner: [...TAINTED_CANVAS_CROSS_ORIGIN_RGB],
			outer: [...TAINTED_CANVAS_TAINTED_BACKDROP_RGB],
		})
		assert.equal(/<canvas/.test(extracted.html), false, 'both canvases should have become images')

		// **State 3: `<all_urls>` taken back, the per-origin grants left in
		// place.** The permission is optional, so this is an ordinary state and
		// not an exotic one — and the pixels were drawn while the broad grant
		// was held, so this is also where "checked at read time" is decided.
		const revoked = await inPopup<{ removed: boolean }>("(async () => JSON.stringify({ removed: await browser.permissions.remove({ origins: ['<all_urls>'] }) }))()")
		assert.equal(revoked.removed, true)
		const afterRevocation = await permissionState()
		assert.equal(afterRevocation.allUrls, false)
		assert.equal(afterRevocation.imageOrigin, true, 'the per-origin grants should have survived, or state 3 is just state 1 again')

		const refusedAgain = await capturePage(inPopup, tabId, `canvas-${randomUUID()}@archivebridge`, {})
		assert.equal(refusedAgain.canvases.length, 1, 'a canvas drawn while `<all_urls>` was held stayed extractable after it was taken back')
		assert.deepEqual(refusedAgain.notes, [{ kind: 'canvas-unreadable', detail: 'The operation is insecure.' }])
		assert.match(refusedAgain.html, /<canvas id="tainted"/)
	})
})

/**
 * The two save commands, driven for real and asserted where they can be.
 *
 * Each format gets its own Firefox, because the command it starts parks in
 * the native file chooser and never returns — which is the correct
 * behaviour, and which holds the background's command queue for as long as
 * the browser lives. A fresh browser per format is the cheap way to observe
 * both.
 */
describe('Firefox Phase 1: the two save commands', () => {
	let server: TestServer

	before(async () => {
		server = await startTestServer()
	})

	after(async () => {
		await server?.close()
	})

	for (const format of ['mhtml', 'webarchive'] as const) {
		test(`the "Save as ${format}" command runs the real capture and conversion, then waits on the file chooser`, async (t) => {
			const fixture = await openFixtureSession(server)
			t.after(async () => await fixture.close())

			// The contrast that makes "still pending" mean something, established
			// before the real command starts (commands are serialized, so anything
			// queued behind one waiting on a chooser would wait forever): this same
			// command path settles promptly when it cannot capture.
			const impossible = await fixture.inPopup<{ ok: boolean; message: string }>(
				`(async () => JSON.stringify(await browser.runtime.sendMessage({ type: 'save', format: '${format}', tabId: 999999 })))()`,
			)
			assert.equal(impossible.ok, false)
			assert.notEqual(impossible.message, '')

			// Now a command that *can* capture. Everything before
			// `downloads.download` — injection, fetching from a local server,
			// assembly, serialization and, for WebArchive, the whole
			// `archiveBytesFrom` conversion — is bounded and completes in well
			// under a second on this fixture. So a command still running seconds
			// later has got past all of it and is waiting on the native chooser,
			// which is exactly where a `saveAs: true` save is supposed to wait and
			// the one place no headless automation may answer.
			await fixture.inPopup<string>(`(() => {
				globalThis.archivebridgePendingSave = 'pending'
				browser.runtime.sendMessage({ type: 'save', format: '${format}', tabId: ${fixture.fixtureTabId} }).then(
					(result) => { globalThis.archivebridgePendingSave = 'settled:' + JSON.stringify(result) },
					(error) => { globalThis.archivebridgePendingSave = 'rejected:' + error.message },
				)
				return JSON.stringify('started')
			})()`)
			await new Promise((resolve) => setTimeout(resolve, 6_000))
			const state = await fixture.inPopup<string>('JSON.stringify(globalThis.archivebridgePendingSave)')
			assert.equal(state, 'pending', `the save should still be waiting on the chooser; it reported ${state}`)
		})
	}
})
