/**
 * End-to-end tests for the two save commands, against a real Chromium
 * with the real built extension loaded.
 *
 * These exercise the production path unmodified — the same
 * `chrome.pageCapture` call, the same `@xarsh/archivebridge` conversion,
 * the same offscreen blob-URL handoff and the same
 * `chrome.downloads.download({ saveAs: true })` — and then verify the
 * bytes that reached disk by parsing them with `@xarsh/archivebridge`
 * itself. There is no fake `chrome` object anywhere, and no branch in
 * `src/` that exists for these tests.
 *
 * Requires the browser Playwright manages: `npx playwright install
 * chromium`. That is why this is `npm run test:e2e` and not part of `npm
 * test`/`npm run check` — see CONTRIBUTING.md, "Extension E2E tests".
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { detectArchiveFormatFromBytes, parseMhtml, parseWebArchive } from '@xarsh/archivebridge'
import { archiveBytesFrom } from '../src/core/archive-bytes.ts'
import { builtExtensionDir, type ExtensionSession, openTestPage, startExtensionSession } from './extension-session.ts'
import { imageBytes, startTestServer, type TestServer } from './test-page.ts'

describe('Chrome extension save commands', () => {
	let server: TestServer
	let session: ExtensionSession
	let testPageTabId: number
	/** The extension's own popup, opened as an ordinary tab: an extension page is the only context from which a test can send a `chrome.runtime` message to the service worker. */
	let popupPage: Awaited<ReturnType<typeof openTestPage>>

	before(async () => {
		server = await startTestServer()
		session = await startExtensionSession()
		await openTestPage(session.context, `${server.origin}/`)
		testPageTabId = await session.serviceWorker.evaluate(async () => {
			const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
			if (tab?.id === undefined) {
				throw new Error('no active tab')
			}
			return tab.id
		})
		popupPage = await session.context.newPage()
		await popupPage.goto(`chrome-extension://${session.extensionId}/popup.html`)
	})

	after(async () => {
		await session?.close()
		await server?.close()
	})

	/** Runs the real save command for `format` and returns the bytes it wrote to disk. */
	async function save(format: 'mhtml' | 'webarchive'): Promise<Uint8Array> {
		const result = await popupPage.evaluate(
			async ([requestedFormat, tabId]) => (await chrome.runtime.sendMessage({ type: 'save', format: requestedFormat, tabId })) as { ok: boolean; message: string },
			[format, testPageTabId] as const,
		)
		assert.equal(result.ok, true, `save as ${format} failed: ${result.message}`)

		const [item] = await session.serviceWorker.evaluate(async () => await chrome.downloads.search({ orderBy: ['-startTime'], limit: 1 }))
		assert.notEqual(item, undefined, 'no download item was created')
		assert.equal(item?.state, 'complete')
		const bytes = await readFile(item?.filename ?? '')
		assert.equal(bytes.byteLength, item?.totalBytes)
		return bytes
	}

	test('A. the built extension loads, and its service worker is the MV3 background', () => {
		assert.match(session.extensionId, /^[a-p]{32}$/)
		assert.equal(session.serviceWorker.url(), `chrome-extension://${session.extensionId}/background.js`)
	})

	test('B. the service worker runs with the permissions the manifest asks for', async () => {
		const surface = await session.serviceWorker.evaluate(() => ({
			pageCapture: typeof chrome.pageCapture?.saveAsMHTML,
			downloads: typeof chrome.downloads?.download,
			offscreen: typeof chrome.offscreen?.createDocument,
			contextMenus: typeof chrome.contextMenus?.create,
			// The constraint that forces the whole offscreen-document design.
			createObjectURL: typeof URL.createObjectURL,
		}))
		assert.deepEqual(surface, { pageCapture: 'function', downloads: 'function', offscreen: 'function', contextMenus: 'function', createObjectURL: 'undefined' })
	})

	test('H. saving still needs no web-origin permission of any kind', async () => {
		// The save path's permission claim is unchanged by the viewer: capture and
		// download of an ordinary `http(s)` tab need no host permission at all.
		// The one host permission the extension now holds is `file:///*`, which
		// exists solely so a local `.webarchive` can be intercepted and read (see
		// `e2e/viewer.test.ts` and `chrome/file-interception.ts`); it grants
		// nothing over any site.
		const manifest = JSON.parse(await readFile(join(builtExtensionDir, 'manifest.json'), 'utf8')) as {
			host_permissions?: readonly string[]
			optional_host_permissions?: unknown
			permissions?: unknown
		}
		assert.deepEqual(manifest.host_permissions, ['file:///*'])
		assert.equal(manifest.optional_host_permissions, undefined)
		assert.deepEqual(manifest.permissions, ['pageCapture', 'downloads', 'offscreen', 'contextMenus', 'declarativeNetRequest'])

		const granted = await session.serviceWorker.evaluate(async () => await chrome.permissions.getAll())
		assert.deepEqual(granted.origins, ['file:///*'])
		assert.deepEqual(
			[...(granted.origins ?? [])].filter((origin) => origin.startsWith('http')),
			[],
			'the save path must never acquire a web origin',
		)
		assert.deepEqual([...(granted.permissions ?? [])].sort(), ['contextMenus', 'declarativeNetRequest', 'downloads', 'offscreen', 'pageCapture'])
	})

	test('C+D. Save as MHTML writes a multi-megabyte capture that ArchiveBridge parses', async () => {
		const bytes = await save('mhtml')
		assert.ok(bytes.byteLength > 3_000_000, `expected a multi-megabyte capture, got ${bytes.byteLength} bytes`)
		assert.equal(detectArchiveFormatFromBytes(bytes), 'mhtml')

		const parsed = parseMhtml(bytes)
		assert.notEqual(parsed.document, undefined)
		assert.deepEqual(parsed.diagnostics, [])
		const root = parsed.document?.parts[parsed.document.rootPartIndex]
		assert.equal(root?.location, `${server.origin}/`)
		assert.equal(root?.mimeType, 'text/html')
	})

	test('G(mhtml). every resource and frame of the test page is in the capture', async () => {
		const parsed = parseMhtml(await save('mhtml'))
		const locations = new Set((parsed.document?.parts ?? []).map((part) => part.location))
		for (const url of server.expectedResourceUrls) {
			assert.ok(locations.has(url), `captured MHTML has no part for ${url}`)
		}
	})

	test('G(dom). the capture reflects the post-script DOM, not the served markup', async () => {
		const parsed = parseMhtml(await save('mhtml'))
		const root = parsed.document?.parts[parsed.document.rootPartIndex]
		const html = new TextDecoder().decode(root?.data ?? new Uint8Array())
		assert.match(html, /data-mutated="yes"/)
	})

	test('E+F. Save as WebArchive writes bytes ArchiveBridge parses as a WebArchive', async () => {
		const bytes = await save('webarchive')
		assert.equal(detectArchiveFormatFromBytes(bytes), 'webarchive')

		const parsed = parseWebArchive(bytes)
		assert.notEqual(parsed.document, undefined)
		assert.equal(parsed.document?.mainResource.url, `${server.origin}/`)
		assert.equal(parsed.document?.mainResource.mimeType, 'text/html')
	})

	test('G(webarchive). frames become nested WebSubframeArchives at the right depth', async () => {
		const parsed = parseWebArchive(await save('webarchive'))
		const subframes = parsed.document?.subframeArchives ?? []
		const subframeUrls = subframes.map((frame) => frame.mainResource.url).sort()
		// Sorted, so `127.0.0.1` precedes `localhost` regardless of frame order.
		assert.deepEqual(subframeUrls, [`${server.origin}/frame-outer.html`, `${server.crossOrigin}/frame-cross.html`])

		const outer = subframes.find((frame) => frame.mainResource.url === `${server.origin}/frame-outer.html`)
		assert.deepEqual(
			(outer?.subframeArchives ?? []).map((frame) => frame.mainResource.url),
			[`${server.origin}/frame-inner.html`],
		)
	})

	test('G(bytes). a binary subresource survives capture and conversion byte for byte', async () => {
		const parsed = parseWebArchive(await save('webarchive'))
		const image = (parsed.document?.subresources ?? []).find((resource) => resource.url === `${server.origin}/image.png`)
		assert.notEqual(image, undefined, 'the WebArchive has no part for the test image')
		assert.equal(image?.mimeType, 'image/png')
		assert.deepEqual(image?.data, new Uint8Array(imageBytes))
	})

	test('the popup offers exactly the two commands and routes both through the shared command path', async () => {
		const labels = await popupPage.locator('button').allTextContents()
		assert.deepEqual(labels, ['Save as MHTML…', 'Save as WebArchive…'])
		// No settings, no conversion UI: two buttons and one status line, nothing else.
		assert.equal(await popupPage.locator('button, input, select, a').count(), 2)

		// The harness opens popup.html as an ordinary tab (opening it, and every
		// earlier `popupPage.evaluate` in this suite, may have left it "active").
		// A real action popup is never itself a tab, so it can never hold that
		// status; reproduce that by explicitly activating the test page first.
		await session.serviceWorker.evaluate(async (tabId) => {
			await chrome.tabs.update(tabId, { active: true })
		}, testPageTabId)

		const resolvedTabId = await popupPage.evaluate(async () => {
			const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
			return tab?.id
		})
		assert.equal(resolvedTabId, testPageTabId, 'harness setup did not reproduce real popup active-tab semantics')

		await session.serviceWorker.evaluate(() => {
			globalThis.archivebridgeObservedRequests = []
			chrome.runtime.onMessage.addListener((message) => {
				globalThis.archivebridgeObservedRequests?.push(message)
				return undefined
			})
		})
		// Not `.click()`: a real Playwright click would foreground popupPage's
		// tab first, undoing the activation above before popup.ts's own
		// `chrome.tabs.query` ever runs. Invoking the listener directly runs the
		// same click handler without touching tab activation at all.
		await popupPage.evaluate(() => {
			document.getElementById('save-webarchive')?.click()
		})
		await popupPage.waitForFunction(() => (document.getElementById('status')?.textContent ?? '').length > 0)
		const observed = await session.serviceWorker.evaluate(() => globalThis.archivebridgeObservedRequests ?? [])
		assert.deepEqual(observed, [{ type: 'save', format: 'webarchive', tabId: testPageTabId }])
	})

	test('a save recovers when a stale offscreen document is already open', async () => {
		// A service worker terminated mid-save leaves its offscreen document behind.
		// Production closes the document after every save, so the only way to reach
		// that state in a test is to create one directly — which is a platform
		// manipulation, not a branch in `src/`.
		await session.serviceWorker.evaluate(async () => {
			if (!(await chrome.offscreen.hasDocument())) {
				await chrome.offscreen.createDocument({ url: 'offscreen.html', reasons: ['BLOBS'], justification: 'test: simulate a stale document' })
			}
		})
		assert.equal(await session.serviceWorker.evaluate(async () => await chrome.offscreen.hasDocument()), true)

		const bytes = await save('webarchive')
		assert.equal(detectArchiveFormatFromBytes(bytes), 'webarchive')
		// And it cleans up after itself rather than leaving a second one behind.
		assert.equal(await session.serviceWorker.evaluate(async () => await chrome.offscreen.hasDocument()), false)
	})

	test('a capture that cannot succeed reports a diagnosable error, and badges it', async () => {
		// A tab that no longer exists is the realistic failure this path has to
		// survive: the page is closed between the click and the capture starting.
		// No fault injection and no test-only branch — Chrome simply rejects, and
		// the production error path has to carry the reason out to the user. (An
		// extension page, for the record, *is* capturable, so the popup itself is
		// not a usable failure case.)
		const closedTabId = 0x7ffffff
		const result = await popupPage.evaluate(
			async (tabId) => (await chrome.runtime.sendMessage({ type: 'save', format: 'mhtml', tabId })) as { ok: boolean; message: string },
			closedTabId,
		)
		assert.equal(result.ok, false)
		assert.match(result.message, /tab/i)

		// Visible without the `notifications` permission: badge plus tooltip.
		const badge = await session.serviceWorker.evaluate(async () => await chrome.action.getBadgeText({}))
		assert.equal(badge, '!')

		// No offscreen document is left holding bytes after a failure.
		assert.equal(await session.serviceWorker.evaluate(async () => await chrome.offscreen.hasDocument()), false)
	})

	test('SaveResult names the file Chrome actually wrote, not merely the one requested', async () => {
		// Playwright's own download pipeline is what completes every `saveAs`
		// download in this suite (see extension-session.ts's module header), and
		// it writes each one under an opaque name of its own choosing inside its
		// own artifacts directory -- never the name this extension asked
		// `chrome.downloads.download` for (measured: `save()` above has been
		// reading its bytes back through `item.filename`, not the requested
		// name, all along). That is a real, entirely browser-driven case of
		// "Chrome settled on a name different from the one requested" -- the
		// same shape of event as a user renaming the file in the native Save As
		// chooser -- and, unlike a rename via the native chooser, it is fully
		// deterministic: no fake `chrome.downloads` and no test-only hook.
		const requestedName = `127.0.0.1-${new URL(server.origin).port}.webarchive`
		const result = await popupPage.evaluate(
			async ([requestedFormat, tabId]) => (await chrome.runtime.sendMessage({ type: 'save', format: requestedFormat, tabId })) as { ok: boolean; message: string },
			['webarchive', testPageTabId] as const,
		)
		assert.equal(result.ok, true, `save failed: ${result.message}`)

		const [item] = await session.serviceWorker.evaluate(async () => await chrome.downloads.search({ orderBy: ['-startTime'], limit: 1 }))
		assert.notEqual(item, undefined, 'no download item was created')
		const actualBaseName = (item?.filename ?? '').split(/[/\\]/).pop() ?? ''
		assert.notEqual(actualBaseName, requestedName, 'expected Chrome to settle on a name different from the one requested')
		assert.ok(
			result.message.startsWith(`Saved ${actualBaseName} (${item?.totalBytes.toLocaleString('en-US')} bytes)`),
			`expected the message to name Chrome's actual final file (${actualBaseName}), got: ${result.message}`,
		)
	})

	test('the same bytes run through the extension core outside the browser produce the same archives', async () => {
		const captured = await save('mhtml')
		const webarchive = archiveBytesFrom(captured, 'webarchive')
		assert.equal(webarchive.fileName, `127.0.0.1-${new URL(server.origin).port}.webarchive`)
		assert.equal(detectArchiveFormatFromBytes(webarchive.bytes), 'webarchive')
	})
})
