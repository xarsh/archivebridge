/**
 * End-to-end tests for what happens to a save when Chrome takes the
 * service worker away in the middle of it.
 *
 * This is not hypothetical. Measured on Chrome for Testing 153, with the
 * real native Save As chooser open in a headed browser: the initiating MV3
 * worker is kept alive well past the 30-second idle timeout, and then
 * terminated anyway at ~6 minutes — Chrome's ceiling on how long a single
 * request may take — while the chooser is still up, the offscreen document
 * and its `blob:` URL are still alive, and the `DownloadItem` is still
 * `in_progress`. A user who spends longer than that picking a folder is a
 * user whose save has to survive a worker restart.
 *
 * Reproducing that state needs two things, and neither is a test-only
 * branch in `src/`:
 *
 * - **A download that stays pending.** A
 *   `chrome.downloads.onDeterminingFilename` deferral, registered from a
 *   *test-owned* extension page, holds the `DownloadItem` in the same
 *   observable state the chooser holds it in — `in_progress`, empty
 *   `filename`, bytes staged — and releases it on cue. It needs Chrome's
 *   own download pipeline, hence `useChromeDownloadPipeline`, and the
 *   consequence is that a `saveAs` download in this session can only ever
 *   end as `interrupted`/`USER_CANCELED`: there is no chooser to accept it.
 *   That the bytes reach disk when a chooser *does* accept them is the
 *   other suite's job (and, for the real chooser after a worker
 *   termination, a headed measurement — never a CI gate).
 * - **A worker termination.** `session.terminateServiceWorker()` stops the
 *   worker through the browser's `Target` CDP domain, leaving the pages and
 *   the offscreen document running exactly as Chrome's own termination
 *   does (measured).
 *
 * The first two tests fail on the pre-fix implementation (verified by
 * building it and running them): the first because a starting worker closed
 * the offscreen document unconditionally, freeing archive bytes that a
 * download of this extension's own was still nominally reading; the second
 * because the completion handling lived inside the save path, where it
 * cannot outlive its worker, so nothing ever released the bytes or reported
 * the outcome.
 *
 * On the first: Chrome turns out to read a `blob:` URL eagerly, before the
 * chooser is answered (measured at 200 MB), so releasing early does not
 * actually lose the file today. The test pins the invariant rather than a
 * demonstrated loss — see `save.ts`'s header for why the invariant is worth
 * keeping regardless.
 *
 * A third test reuses both of the above plus one thing neither needs: two
 * saves in the *same* restarted worker whose outcomes must not be confused
 * with each other. Save B (this worker's own) is a capture failure against a
 * closed tab, deliberately chosen for its distinct, fast, and fully
 * deterministic outcome text — no `saveAs` chooser involved at all, so it
 * cannot be mistaken for Save A's eventual `interrupted`/`USER_CANCELED`
 * outcome. That distinctness is what makes it possible to tell, from the
 * toolbar alone, whether a later-settling Save A was allowed to overwrite it.
 */

import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import { type ExtensionSession, openTestPage, startExtensionSession } from './extension-session.ts'
import { startTestServer, type TestServer } from './test-page.ts'

/** How long to wait for a held download to settle once released. */
const SETTLE_TIMEOUT_MS = 20_000

interface HeldDownload {
	readonly id: number
	readonly url: string
}

interface DownloadSnapshot {
	readonly state: string
	readonly filename: string
	readonly error?: string
}

describe('Chrome extension save lifecycle', () => {
	let server: TestServer
	let session: ExtensionSession
	let testPageTabId: number
	/**
	 * An extension page of the test's own. It holds the download, watches the
	 * extension from outside the worker — `chrome.downloads`/`chrome.offscreen`
	 * calls from a page do not wake a worker (measured), so observing costs
	 * nothing — and is the only context from which a test can send the worker a
	 * `chrome.runtime` message.
	 */
	let labPage: Awaited<ReturnType<typeof openTestPage>>

	before(async () => {
		server = await startTestServer()
		session = await startExtensionSession({ useChromeDownloadPipeline: true })
		const testPage = await openTestPage(session.context, `${server.origin}/`)
		await testPage.bringToFront()
		testPageTabId = await (await session.waitForServiceWorker()).evaluate(async () => {
			const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
			if (tab?.id === undefined) {
				throw new Error('no active tab')
			}
			return tab.id
		})
		labPage = await session.context.newPage()
		await labPage.goto(`chrome-extension://${session.extensionId}/popup.html`)
		// Chrome allows only a small number of onDeterminingFilename listeners
		// per extension, so the hold is installed once for the whole suite.
		await labPage.evaluate(() => {
			globalThis.archivebridgeLab = { held: [], release: [] }
			chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
				globalThis.archivebridgeLab?.release.push(suggest)
				globalThis.archivebridgeLab?.held.push({ id: item.id, url: item.url })
				return true
			})
		})
	})

	after(async () => {
		await session?.close()
		await server?.close()
	})

	/** Starts a real save and resolves once its download is pending and unnamed — the chooser-open state. */
	async function startHeldSave(): Promise<HeldDownload> {
		const alreadyHeld = await labPage.evaluate(() => globalThis.archivebridgeLab?.held.length ?? 0)
		await labPage.evaluate((tabId) => {
			const lab = globalThis.archivebridgeLab
			if (lab === undefined) {
				throw new Error('the hold was never installed')
			}
			lab.result = undefined
			// Deliberately not awaited here: this message is answered when the save
			// finishes, which is after everything the test does next — if the
			// worker survives to answer it at all. The answer is kept anyway, so
			// that a save which fails *before* the download shows up as its own
			// error rather than as a timeout on the hold.
			void chrome.runtime
				.sendMessage({ type: 'save', format: 'mhtml', tabId })
				.then((response) => {
					lab.result = response
				})
				.catch((error: Error) => {
					lab.result = { ok: false, message: error.message }
				})
		}, testPageTabId)
		const deadline = Date.now() + 60_000
		for (;;) {
			const seen = await labPage.evaluate((at) => ({ held: globalThis.archivebridgeLab?.held[at], result: globalThis.archivebridgeLab?.result }), alreadyHeld)
			if (seen.held !== undefined) {
				return seen.held
			}
			if (seen.result !== undefined) {
				throw new Error(`the save ended before its download was held: ${JSON.stringify(seen.result)}`)
			}
			if (Date.now() > deadline) {
				throw new Error('the save never reached a pending download')
			}
			await new Promise((resolve) => setTimeout(resolve, 100))
		}
	}

	/** The live `DownloadItem` for `id`, read from an extension page so that reading it cannot wake a worker. */
	async function downloadItem(id: number): Promise<DownloadSnapshot | undefined> {
		return await labPage.evaluate(async (downloadId) => {
			const [item] = await chrome.downloads.search({ id: downloadId })
			return item === undefined ? undefined : { state: item.state, filename: item.filename, ...(item.error === undefined ? {} : { error: item.error }) }
		}, id)
	}

	async function hasOffscreenDocument(): Promise<boolean> {
		return await labPage.evaluate(async () => await chrome.offscreen.hasDocument())
	}

	async function badgeTitle(): Promise<string> {
		return await labPage.evaluate(async () => await chrome.action.getTitle({}))
	}

	/** Polls `condition` until it holds. Explicit rather than `page.waitForFunction`, which takes a predicate evaluated *in the page* and so cannot poll the browser-side state these tests care about. */
	async function waitUntil(what: string, condition: () => Promise<boolean>, timeoutMs = 15_000): Promise<void> {
		const deadline = Date.now() + timeoutMs
		while (!(await condition())) {
			if (Date.now() > deadline) {
				throw new Error(`timed out waiting until ${what}`)
			}
			await new Promise((resolve) => setTimeout(resolve, 100))
		}
	}

	/** Lets the "user" answer the chooser, then waits for the download to leave `in_progress`. */
	async function releaseAndSettle(held: HeldDownload, index: number): Promise<DownloadSnapshot> {
		await labPage.evaluate((at) => {
			globalThis.archivebridgeLab?.release[at]?.({ filename: 'archivebridge-lifecycle.mhtml', conflictAction: 'uniquify' })
		}, index)
		const deadline = Date.now() + SETTLE_TIMEOUT_MS
		for (;;) {
			const item = await downloadItem(held.id)
			if (item !== undefined && item.state !== 'in_progress') {
				return item
			}
			if (Date.now() > deadline) {
				throw new Error(`the download never settled (last seen ${JSON.stringify(item)})`)
			}
			await new Promise((resolve) => setTimeout(resolve, 100))
		}
	}

	test('a worker that starts while a save is pending leaves the pending save alone', async () => {
		const held = await startHeldSave()
		// The only state that survives a worker: the DownloadItem, whose URL
		// names this extension. It is what a restarted worker has to read.
		assert.ok(held.url.startsWith(`blob:chrome-extension://${session.extensionId}/`), `expected a blob: URL of this extension, got ${held.url}`)
		assert.equal(await hasOffscreenDocument(), true)
		assert.equal((await downloadItem(held.id))?.state, 'in_progress')

		await session.terminateServiceWorker()
		assert.equal(await session.isServiceWorkerRunning(), false, 'the worker should be gone')
		assert.equal(await hasOffscreenDocument(), true, 'terminating the worker must not take the offscreen document with it')
		assert.equal((await downloadItem(held.id))?.state, 'in_progress', 'terminating the worker must not cancel the download')

		// Any extension event starts a new worker, and a popup click is the
		// realistic one: the popup has been showing the user a channel-closed
		// error since the moment its worker died.
		await labPage.evaluate(async () => await chrome.runtime.sendMessage({ type: 'not-a-save' }).catch(() => undefined))
		await session.waitForServiceWorker()
		assert.equal(await hasOffscreenDocument(), true, 'the new worker freed the archive bytes while a download of ours was still pending')
		assert.equal((await downloadItem(held.id))?.state, 'in_progress', 'the pending download did not survive the new worker')

		// Settle it, so it cannot count as "a save still in progress" later.
		const settled = await releaseAndSettle(held, 0)
		assert.equal(settled.state, 'interrupted', 'headless Chromium has no chooser to accept the download')
		assert.equal(settled.error, 'USER_CANCELED')
	})

	test('a save that outlives its worker is finished by a worker Chrome starts for it', async () => {
		// Put a different outcome on the badge first, so that "the restarted
		// worker reported this save" is an observable change rather than a no-op.
		await labPage.evaluate(async () => await chrome.runtime.sendMessage({ type: 'save', format: 'mhtml', tabId: 0x7ffffff }))
		assert.match(await badgeTitle(), /tab/i)
		await waitUntil('the failed save has released the offscreen document', async () => !(await hasOffscreenDocument()))

		const held = await startHeldSave()
		await session.terminateServiceWorker()
		assert.equal(await session.isServiceWorkerRunning(), false)
		assert.equal(await hasOffscreenDocument(), true)

		// Nothing here wakes the worker. Releasing the hold is the download's own
		// state change, and delivering that is Chrome's only reason to start one.
		const settled = await releaseAndSettle(held, 1)
		assert.equal(settled.state, 'interrupted')

		await session.waitForServiceWorker()
		await waitUntil('the restarted worker reports the adopted save', async () => (await badgeTitle()).includes('the download ended'))
		assert.match(await badgeTitle(), /the download ended as "interrupted" \(USER_CANCELED\)/)
		assert.equal(await labPage.evaluate(async () => await chrome.action.getBadgeText({})), '!')
		await waitUntil('the adopted save has released the offscreen document', async () => !(await hasOffscreenDocument()))
	})

	test('a newer save started in this worker keeps its toolbar outcome even after an older adopted save settles later', async () => {
		// Save A: starts in this worker, then the worker is killed with A's
		// download still pending — the same setup as the previous two tests.
		const heldA = await startHeldSave()
		await session.terminateServiceWorker()
		assert.equal(await session.isServiceWorkerRunning(), false)
		assert.equal(await hasOffscreenDocument(), true)

		// Save B: a whole new save, triggered the same way a real popup click
		// would be after A's original worker died — this wakes a new worker.
		// A closed tab is what makes B fast and its outcome text unmistakable:
		// it fails during capture, before any `chrome.downloads` call exists at
		// all, so its outcome cannot coincidentally match A's eventual
		// `SaveFailedError` text. `currentWorkerSaveStarted` is set the moment
		// this reaches `runSaveCommand`, regardless of how the save concludes —
		// which is the whole point: B only has to have *begun* in this worker.
		const resultB = await labPage.evaluate(async () => (await chrome.runtime.sendMessage({ type: 'save', format: 'mhtml', tabId: 0x7ffffff })) as { ok: boolean; message: string })
		assert.equal(resultB.ok, false)
		assert.match(resultB.message, /tab/i)
		assert.match(await badgeTitle(), /tab/i, 'expected B (a capture failure) to badge the toolbar')
		const titleAfterB = await badgeTitle()
		assert.equal(await labPage.evaluate(async () => await chrome.action.getBadgeText({})), '!')
		// B never touches `chrome.downloads` at all (it fails during capture), so
		// it never attempts its own release — the document stays open on A's
		// account the whole time, exactly as it did right after termination above.
		assert.equal(await hasOffscreenDocument(), true, 'B must not have touched the offscreen document A is still using')

		// Now let A finish. Headless Chromium has no chooser to accept it, so it
		// ends the same way it did in the previous two tests — the *same* text
		// `describeError`/`SaveFailedError` would also have produced for a failed
		// B, which is exactly why B had to fail a different way above.
		const settledA = await releaseAndSettle(heldA, 2)
		assert.equal(settledA.state, 'interrupted')
		assert.equal(settledA.error, 'USER_CANCELED')

		// A is still adopted and cleaned up: nothing else in this test releases
		// the offscreen document, so this is what proves adoption ran.
		await waitUntil('the adopted save A released the offscreen document', async () => !(await hasOffscreenDocument()))

		// But the toolbar still describes B, not A: a stale adopted failure must
		// not replace a newer command's own outcome, even though A settled and
		// was adopted strictly after B's outcome was already shown.
		assert.equal(await badgeTitle(), titleAfterB, 'a stale adopted outcome must not replace a newer save’s toolbar outcome')
		assert.equal(await labPage.evaluate(async () => await chrome.action.getBadgeText({})), '!')
	})
})
