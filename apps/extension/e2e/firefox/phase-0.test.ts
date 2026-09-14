/**
 * Firefox Phase 0: the lane itself.
 *
 * This proves the *harness*, and the production build it drives — that the
 * real `dist-firefox/` installs into a real headless Firefox over WebDriver
 * BiDi, that its background event page loads, that its popup loads, that a
 * message reaches the background and that the background's real answer
 * comes back. What that answer *says* about a page is `phase-1.test.ts`'s
 * subject; here the assertion is only that the real command path answered
 * at all.
 *
 * Nothing here reaches into `src/`. Everything is driven through the
 * extension's own popup page, exactly as the Chrome lane drives the
 * production path through its popup.
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { builtFirefoxExtensionDir, type FirefoxSession, startFirefoxSession } from './bidi-session.ts'

/** Evaluated in the popup page: click a save button and report what the status line ends up saying. */
const CLICK_SAVE_AND_READ_STATUS = `(async () => {
	const status = document.getElementById('status')
	const button = document.getElementById('save-mhtml')
	button.click()
	const deadline = Date.now() + 10000
	while (Date.now() < deadline) {
		if (status.textContent !== '' && !button.disabled) {
			break
		}
		await new Promise((resolve) => setTimeout(resolve, 50))
	}
	return JSON.stringify({ text: status.textContent, isError: status.classList.contains('error') })
})()`

test('Firefox Phase 0: the built extension installs, loads and answers its own popup', async (t) => {
	let session: FirefoxSession | undefined
	t.after(async () => {
		await session?.close()
	})
	session = await startFirefoxSession()

	await t.test('the built manifest is the Firefox one, with the id the profile pinned', async () => {
		const manifest = JSON.parse(await readFile(join(builtFirefoxExtensionDir, 'manifest.json'), 'utf8'))
		assert.equal(manifest.manifest_version, 3)
		assert.equal(manifest.browser_specific_settings.gecko.id, session?.extensionId)
		// The floor the architecture doc names, enforced by the browser itself:
		// `content_scripts.world` — which a later phase's MAIN-world pass needs
		// — requires 128.
		assert.equal(manifest.browser_specific_settings.gecko.strict_min_version, '128.0')
		// The capture's permissions, and no web origin among them: the host
		// access is optional and asked for from the user's own gesture. What
		// each of those four is for is asserted in `phase-1.test.ts`.
		assert.deepEqual(manifest.permissions, ['scripting', 'downloads', 'menus', 'activeTab'])
		assert.equal(manifest.host_permissions, undefined)
		assert.deepEqual(manifest.optional_host_permissions, ['<all_urls>'])
	})

	await t.test('the extension page opens at the pinned moz-extension: UUID', async () => {
		const context = await session.openPage(session.extensionUrl('popup.html'))
		const origin = await session.evaluate(context, 'location.origin')
		assert.equal(origin, `moz-extension://${session.extensionUuid}`)
	})

	await t.test('the popup is the real production page, running the real bundle', async () => {
		const context = await session.openPage(session.extensionUrl('popup.html'))
		const report = await session.evaluate(
			context,
			`JSON.stringify({
				version: browser.runtime.getManifest().version,
				buttons: [...document.querySelectorAll('button')].map((button) => button.id),
				// The bundle ran: the popup's own script is what disables the
				// buttons, and it only attaches listeners once it has found them.
				listenersAttached: document.getElementById('save-mhtml') !== null && !document.getElementById('save-mhtml').disabled,
			})`,
		)
		const parsed = JSON.parse(String(report))
		const manifest = JSON.parse(await readFile(join(builtFirefoxExtensionDir, 'manifest.json'), 'utf8'))
		assert.equal(parsed.version, manifest.version)
		assert.deepEqual(parsed.buttons, ['save-mhtml', 'save-webarchive'])
		assert.equal(parsed.listenersAttached, true)
	})

	await t.test('the background event page is alive and answers the popup over the real message path', async () => {
		const context = await session.openPage(session.extensionUrl('popup.html'))
		// `script.evaluate` takes an expression, not a module body, so there is
		// no top-level `await` here; `awaitPromise` resolves the IIFE's promise.
		// A tab id that names nothing, so the command fails at its first real
		// step and comes back promptly. What is asserted is the round trip and
		// that the browser's own reason survives it — not any particular
		// wording, which is Firefox's to choose.
		const reply = await session.evaluate(context, "(async () => JSON.stringify(await browser.runtime.sendMessage({ type: 'save', format: 'mhtml', tabId: 999999 })))()")
		const parsed = JSON.parse(String(reply))
		assert.equal(parsed.ok, false, 'a save of a tab that does not exist must fail')
		assert.match(
			String(parsed.message),
			/tab/i,
			'the background must report the real reason rather than a generic failure, which is what proves the message crossed and came back from src/firefox/capture.ts',
		)
	})

	await t.test('a click that carries no user gesture degrades to a reported failure, not an unhandled rejection', async () => {
		const context = await session.openPage(session.extensionUrl('popup.html'))
		// `element.click()` from the automation is a DOM click with no transient
		// activation behind it, so `permissions.request` rejects immediately
		// with "may only be called from a user input handler" — the exact thing
		// that happens in production when a gesture has been spent. The command
		// must survive that: continue without the optional permission, fail on
		// something real (here, an extension page it may not capture), and say
		// so. A real gesture is exercised in `phase-1.test.ts`.
		const status = JSON.parse(String(await session.evaluate(context, CLICK_SAVE_AND_READ_STATUS)))
		assert.equal(status.isError, true)
		assert.notEqual(String(status.text), '', 'the popup must show why the save failed')

		// `showOutcome` swallows its own failures so a save's result still
		// reaches the caller, which means a wrong `browser.action` declaration
		// in `firefox-api.d.ts` would be invisible from the popup alone. Asking
		// the browser what the badge actually says is what exercises those
		// three hand-written declarations against the real runtime.
		const badge = await session.evaluate(context, '(async () => JSON.stringify({ text: await browser.action.getBadgeText({}), title: await browser.action.getTitle({}) }))()')
		const parsed = JSON.parse(String(badge))
		assert.equal(parsed.text, '!')
		assert.match(String(parsed.title), /^ArchiveBridge — /)
	})
})
