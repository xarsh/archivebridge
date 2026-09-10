/**
 * Launches a real Chromium with the real built extension loaded, and
 * exposes the pieces a test needs to drive it.
 *
 * Why Playwright rather than a hand-written CDP harness: loading an
 * unpacked MV3 extension, waiting for its service worker to register,
 * evaluating in that worker, and opening extension pages are all things
 * Playwright documents and maintains for Chromium (`launchPersistentContext`
 * plus the `serviceworker` event). Reimplementing that over raw CDP means
 * owning browser launch, target discovery, worker attach/detach, execution
 * contexts and their races — several hundred lines of exactly the code most
 * likely to be flaky, for a dependency graph of two packages
 * (`playwright` -> `playwright-core`). Note that `playwright`, not
 * `@playwright/test`, is the dependency: the runner stays `node:test`, per
 * CONTRIBUTING.md's testing rules.
 *
 * Two launch details are not incidental:
 *
 * - `channel: 'chromium'` selects the full Chrome for Testing build. The
 *   default `chromium-headless-shell` cannot load extensions at all.
 * - Headless is fine, and more than fine: `chrome.downloads.download({
 *   saveAs: true })` *completes* under headless (measured) because there is
 *   no native chooser to show. The production save path therefore runs
 *   unmodified in these tests — there is no test-only branch anywhere in
 *   `src/`.
 *
 * Playwright routes downloads to its own artifacts directory under opaque
 * names, so tests read the resulting file through the path
 * `chrome.downloads.search()` reports rather than by predicting it. The
 * *requested* file name is asserted in `src/core/file-name.test.ts`, where
 * it is a pure function.
 *
 * **That routing is Playwright replacing Chrome's download pipeline**
 * (`Browser.setDownloadBehavior` with `allowAndName`), and it is why
 * `saveAs: true` completes headless: there is no chooser *and* no
 * filename-determination step, so `chrome.downloads.onDeterminingFilename`
 * never fires either (measured). A test that needs a download to sit
 * pending has to hand the pipeline back to Chrome — see
 * {@link ExtensionSessionOptions.useChromeDownloadPipeline}.
 *
 * One capability is not Playwright's own: **terminating the extension's
 * service worker**, which the save-lifecycle tests need in order to
 * reproduce what Chrome does to a long save on its own. That lives in the
 * `Target` CDP domain, which is browser-level, so it goes through
 * `browser.newBrowserCDPSession()` — still Playwright's connection, no
 * second browser launch and no extra dependency. `Target.closeTarget` on a
 * `service_worker` target stops that worker and leaves the browser, its
 * pages and the extension's offscreen document running (measured), which is
 * exactly the state Chrome leaves behind when it kills a worker itself.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type BrowserContext, type CDPSession, chromium, type Page, type Worker } from 'playwright'

const extensionDir = join(dirname(dirname(fileURLToPath(import.meta.url))), 'dist')

export interface ExtensionSession {
	readonly context: BrowserContext
	/** The extension's MV3 service worker, as it was when the session started. Dead once {@link ExtensionSession.terminateServiceWorker} has been called; use {@link ExtensionSession.waitForServiceWorker} to reach whichever one is running now. */
	readonly serviceWorker: Worker
	/** The extension's own ID, as Chromium assigned it. */
	readonly extensionId: string
	/** Whether a service worker for this extension is running right now, asked of the browser rather than of the extension (so it cannot itself wake one). */
	isServiceWorkerRunning(): Promise<boolean>
	/** The running service worker, waiting for Chrome to start one if none is. */
	waitForServiceWorker(): Promise<Worker>
	/** Stops the running service worker the way Chrome's own idle/timeout termination does, leaving everything else alive. */
	terminateServiceWorker(): Promise<void>
	close(): Promise<void>
}

/** The built `dist/` directory that gets loaded. Exported so a test can read the built `manifest.json` and assert on what actually ships. */
export const builtExtensionDir = extensionDir

export interface ExtensionSessionOptions {
	/**
	 * Gives downloads back to Chrome's own pipeline, so that
	 * `chrome.downloads.onDeterminingFilename` fires and a test can hold a
	 * `DownloadItem` pending — the only way to reproduce the native chooser's
	 * state in an automated browser.
	 *
	 * The trade is that no `saveAs: true` download can *complete*: with
	 * Chrome in charge and no chooser to show, headless Chromium ends the
	 * download as `interrupted` / `USER_CANCELED` (measured). Nothing is
	 * written to disk, so nothing lands in the real download directory
	 * either. Tests that assert on written bytes use the default pipeline;
	 * tests about worker lifetime use this one.
	 */
	readonly useChromeDownloadPipeline?: boolean
}

/** A browser-level CDP session, for the `Target` domain (see this module's header). */
async function openBrowserCdpSession(context: BrowserContext): Promise<CDPSession> {
	const browser = context.browser()
	if (browser === null) {
		throw new Error('no Browser for this persistent context, so the Target CDP domain is out of reach')
	}
	return await browser.newBrowserCDPSession()
}

/** Launches Chromium with `dist/` loaded as an unpacked extension and waits for its service worker. */
export async function startExtensionSession(options: ExtensionSessionOptions = {}): Promise<ExtensionSession> {
	const userDataDir = await mkdtemp(join(tmpdir(), 'archivebridge-e2e-'))
	const context = await chromium.launchPersistentContext(userDataDir, {
		channel: 'chromium',
		args: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`],
	})
	try {
		const existing = context.serviceWorkers()
		const serviceWorker = existing[0] ?? (await context.waitForEvent('serviceworker', { timeout: 30_000 }))
		if (options.useChromeDownloadPipeline === true) {
			const session = await openBrowserCdpSession(context)
			await session.send('Browser.setDownloadBehavior', { behavior: 'default' })
			await session.detach()
		}

		const extensionId = new URL(serviceWorker.url()).host
		const workerUrl = `chrome-extension://${extensionId}/background.js`

		// Playwright drops a worker from context.serviceWorkers() when it stops,
		// so that list is the liveness signal for `waitForServiceWorker`. The
		// browser's own target list is used for assertions instead, because
		// reading it cannot start a worker.
		const findWorkerTarget = async (session: CDPSession) => {
			const { targetInfos } = await session.send('Target.getTargets')
			return targetInfos.find((target) => target.type === 'service_worker' && target.url === workerUrl)
		}

		return {
			context,
			serviceWorker,
			extensionId,
			isServiceWorkerRunning: async () => {
				const session = await openBrowserCdpSession(context)
				try {
					return (await findWorkerTarget(session)) !== undefined
				} finally {
					await session.detach()
				}
			},
			waitForServiceWorker: async () => {
				const running = context.serviceWorkers().find((worker) => worker.url() === workerUrl)
				if (running !== undefined) {
					return running
				}
				return await context.waitForEvent('serviceworker', { predicate: (worker) => worker.url() === workerUrl, timeout: 30_000 })
			},
			terminateServiceWorker: async () => {
				const session = await openBrowserCdpSession(context)
				try {
					const target = await findWorkerTarget(session)
					if (target === undefined) {
						throw new Error('no service worker to terminate')
					}
					await session.send('Target.closeTarget', { targetId: target.targetId })
					// Teardown is asynchronous, and the caller's next assertion is
					// usually "the worker is gone", so wait for it here.
					const deadline = Date.now() + 10_000
					while ((await findWorkerTarget(session)) !== undefined) {
						if (Date.now() > deadline) {
							throw new Error('the service worker did not stop')
						}
						await new Promise((resolve) => setTimeout(resolve, 50))
					}
				} finally {
					await session.detach()
				}
			},
			close: async () => {
				await context.close()
				await rm(userDataDir, { recursive: true, force: true })
			},
		}
	} catch (error) {
		await context.close()
		await rm(userDataDir, { recursive: true, force: true })
		throw error
	}
}

/** Opens `url` and waits for the test page to finish loading (its `load` handler renames the document). */
export async function openTestPage(context: BrowserContext, url: string): Promise<Page> {
	const page = await context.newPage()
	await page.goto(url, { waitUntil: 'load' })
	await page.waitForFunction(() => document.title === 'ArchiveBridge test page ready', undefined, { timeout: 30_000 })
	return page
}
