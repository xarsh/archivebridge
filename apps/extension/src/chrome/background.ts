/**
 * MV3 service worker: the extension's one command path, the two entry
 * points that trigger it, and the one listener that can finish a save
 * after this worker's predecessor was killed.
 *
 * The pipeline is deliberately linear and lives in one place:
 *
 * ```text
 * captureMhtml(tabId)              chrome/capture.ts   (browser adapter)
 *   -> archiveBytesFrom(bytes, f)  core/archive-bytes.ts (browser-neutral)
 *   -> saveBytes(...)              chrome/save.ts      (browser adapter)
 * ```
 *
 * Only the two adapter ends are Chrome-specific. Adding Firefox later
 * means a different capture module and a different save module around the
 * same middle, not a second pipeline.
 *
 * Both the popup and the page context menu funnel into
 * {@link runSaveCommand}; neither has a path of its own. Commands are
 * serialized because two concurrent saves would race over each other's
 * blob URLs.
 *
 * The worker also registers this extension's two browser integrations on
 * install and on startup: the page context menu, and the
 * `declarativeNetRequest` rule that redirects a local `.webarchive`
 * navigation into the archive viewer (`chrome/file-interception.ts`).
 * Neither is part of the save path; both are registrations the browser
 * keeps for us.
 *
 * There is one more listener, and it is not an entry point but an *exit*:
 * a global-scope `downloads.onChanged` handler that finishes a save whose
 * worker Chrome terminated before the download was done. See its comment
 * below and `save.ts`'s header for why that case is ordinary rather than
 * exotic.
 *
 * There is no top-level `await` anywhere in this module's graph: a service
 * worker script that uses one fails to start at all. Startup work is
 * kicked off as a promise that the command path awaits instead.
 */

import { ArchiveConversionError, archiveBytesFrom } from '../core/archive-bytes.ts'
import type { SaveFormat } from '../core/file-name.ts'
import { captureMhtml } from './capture.ts'
import { installFileInterception } from './file-interception.ts'
import { type AdoptedSave, adoptSettledDownload, releaseOffscreenDocument, type SaveResult, saveBytes, settleAwaitedDownload } from './save.ts'

/** Context-menu item IDs. Also the wire form of a save request from the popup. */
const MENU_ITEM_IDS: Readonly<Record<SaveFormat, string>> = {
	mhtml: 'archivebridge.save.mhtml',
	webarchive: 'archivebridge.save.webarchive',
}

const MENU_TITLES: Readonly<Record<SaveFormat, string>> = {
	mhtml: 'Save as MHTML…',
	webarchive: 'Save as WebArchive…',
}

/** What the popup gets back. The popup renders `message` verbatim, which is the extension's primary error surface. */
export interface SaveCommandResult {
	readonly ok: boolean
	readonly message: string
}

function isSaveFormat(value: unknown): value is SaveFormat {
	return value === 'mhtml' || value === 'webarchive'
}

/**
 * Recovers from a previous run that was cut short — a service worker
 * termination mid-save leaves an offscreen document behind (measured: the
 * document, its `blob:` URL and the pending `DownloadItem` all outlive the
 * worker), and it would otherwise stay open for the rest of the browser
 * session holding bytes nobody can revoke.
 *
 * What it must not do is assume that a surviving document is *stale*. It
 * often is not: Chrome terminates a worker with the native chooser still
 * open (measured at ~6 minutes), leaving a save that is still going to
 * finish. `releaseOffscreenDocument` therefore asks the `DownloadItem`
 * before freeing anything, and leaves a live save's bytes alone. Command
 * serialization is not what makes this safe — it cannot be, since it lives
 * in the memory of the worker that died.
 */
const startupCleanup = releaseOffscreenDocument()

/**
 * Serializes command execution *within one worker*. Two saves at once would
 * race over each other's blob URLs, and so would a save and a release of
 * the offscreen document — which is why every release goes through here
 * too, not just every save.
 *
 * Saves in two different worker lifetimes cannot be serialized this way and
 * do not need to be: they only share the offscreen document, and what
 * protects a dead worker's pending save is its `DownloadItem`, not whose
 * turn it is.
 */
let pending: Promise<unknown> = startupCleanup

function serialize<T>(work: () => Promise<T>): Promise<T> {
	const result = pending.then(work, work)
	pending = result.catch(() => undefined)
	return result
}

/**
 * Whether a real save command has begun in *this* worker instance.
 *
 * A save adopted from a predecessor worker (see the `downloads.onChanged`
 * listener below) can settle at any time relative to a save this worker
 * itself started — including after that newer save has already shown its
 * own outcome, since adoption is serialized behind whatever this worker is
 * currently doing. Once this is `true`, the adopted save is *older* by
 * definition and must not clobber the toolbar with a stale result.
 *
 * Deliberately a single flag, not a per-save sequence number: nothing here
 * needs to compare two adopted saves against each other, only "has this
 * worker's own, newer save command already begun". It resets to `false` on
 * every worker restart along with the rest of this module's state, which is
 * exactly right — a fresh worker with no command of its own yet has nothing
 * newer for an inherited save to lose to.
 */
let currentWorkerSaveStarted = false

/**
 * Chrome currently reports this exact, undocumented error message when
 * pageCapture.saveAsMHTML cannot capture a structurally restricted page
 * such as chrome:// or the Chrome Web Store.
 *
 * There is no structured error code for this case, so this intentionally
 * uses an exact string match. If Chrome changes the wording, the safe
 * fallback is that the ordinary error badge is shown again.
 *
 * Do not broaden this to fuzzy matching: a false positive could hide a
 * genuinely unexpected capture failure.
 */
const UNCAPTURABLE_PAGE_MESSAGE = "Don't have permissions required to capture this page."

function isUncapturablePageError(error: unknown): boolean {
	return error instanceof Error && error.message === UNCAPTURABLE_PAGE_MESSAGE
}

/** Turns anything thrown along the pipeline into one line a human can act on. */
function describeError(error: unknown): string {
	if (error instanceof ArchiveConversionError) {
		const details = error.diagnostics.map((diagnostic) => diagnostic.type).join(', ')
		return details.length === 0 ? error.message : `${error.message} [${details}]`
	}
	if (error instanceof Error) {
		return error.message
	}
	return String(error)
}

/**
 * Surfaces an outcome without asking for the `notifications` permission:
 * the toolbar badge and its tooltip are always available, and the popup
 * additionally renders the returned message inline. A failure therefore
 * stays visible after the popup closes, and the full error text is one
 * hover away.
 *
 * Best-effort and non-throwing: this is an error-reporting side effect of
 * a save that already succeeded or failed, not part of the save itself. If
 * a `chrome.action` call rejects, `runSaveCommand`'s result must still
 * reach `sendResponse` (and the context-menu path's `void runSaveCommand`
 * must not become an unhandled rejection).
 */
async function showOutcome(result: SaveCommandResult): Promise<void> {
	try {
		await chrome.action.setBadgeText({ text: result.ok ? '' : '!' })
		await chrome.action.setBadgeBackgroundColor({ color: '#b3261e' })
		await chrome.action.setTitle({ title: result.ok ? 'ArchiveBridge' : `ArchiveBridge — ${result.message}` })
	} catch (error) {
		console.error('ArchiveBridge: could not update the toolbar badge/title', error)
	}
}

/** The message a finished save shows, in the popup's status line and the toolbar tooltip. */
function describeSaved(saved: SaveResult): string {
	return `Saved ${saved.fileName} (${saved.byteLength.toLocaleString('en-US')} bytes)`
}

/** The one path both entry points take: capture, convert if the format asks for it, save. */
async function runSaveCommand(format: SaveFormat, tabId: number): Promise<SaveCommandResult> {
	// Marks this worker as having a save of its own in flight before it even
	// queues behind `serialize` — an adopted save settling from here on is
	// necessarily reporting something older. See `currentWorkerSaveStarted`.
	currentWorkerSaveStarted = true
	return await serialize(async () => {
		let result: SaveCommandResult
		let uncapturablePage = false
		try {
			const captured = await captureMhtml(tabId)
			const archive = archiveBytesFrom(captured, format)
			for (const diagnostic of archive.diagnostics) {
				console.warn('ArchiveBridge: diagnostic while saving', diagnostic)
			}
			const saved = await saveBytes(archive.bytes, archive.fileName, archive.mimeType)
			result = { ok: true, message: describeSaved(saved) }
		} catch (error) {
			console.error('ArchiveBridge: save failed', error)
			result = { ok: false, message: describeError(error) }
			uncapturablePage = isUncapturablePageError(error)
		}
		// The popup still renders `result.message`; only the toolbar-wide badge
		// is skipped, since a page Chrome will never let any extension capture
		// is not evidence of a save this extension could have gotten right.
		if (!uncapturablePage) {
			await showOutcome(result)
		}
		return result
	})
}

/**
 * The third way a save reaches its end, after the popup and the context
 * menu: a download that outlived the worker that started it.
 *
 * Registered at global scope, and that is the whole point — Chrome
 * dispatches an event to a *new* worker only for listeners that exist
 * during initial script evaluation, so this is what lets the browser start
 * a worker to finish a save whose original worker it already killed. A
 * listener added inside the save path cannot do that (measured: once the
 * worker that registered it dynamically was gone, download activity started
 * no new one).
 *
 * It sees every download in the browser, not just ArchiveBridge's, and the
 * split below is not cosmetic. A delta a save in *this* worker is waiting
 * for has to be delivered straight away, because that save is what the
 * serialization queue is currently busy with — putting the delivery in the
 * queue would deadlock it. Everything else goes through `serialize`, so
 * that freeing the archive bytes can never overlap a save that is minting a
 * URL of its own.
 *
 * Serializing an adoption behind whatever this worker is doing is correct
 * for resource cleanup, but it means an adopted save can settle *after* a
 * newer save this worker started on its own has already shown its outcome.
 * `currentWorkerSaveStarted` is what keeps that adoption from clobbering the
 * toolbar with a stale result — adoption and cleanup still happen, only the
 * `showOutcome` call is skipped.
 */
chrome.downloads.onChanged.addListener((delta) => {
	if (settleAwaitedDownload(delta)) {
		return
	}
	void serialize(async () => await adoptSettledDownload(delta)).then(
		async (adopted: AdoptedSave | undefined) => {
			if (adopted === undefined) {
				return
			}
			if (currentWorkerSaveStarted) {
				// This worker has since started a save of its own, which is
				// necessarily newer than anything inherited from a predecessor —
				// adoption and cleanup above already ran, but the toolbar must keep
				// describing the newer command instead.
				return
			}
			// The popup that asked for this save lost its message channel when its
			// worker died, so the badge and its tooltip are the only surface left.
			await showOutcome(adopted.ok ? { ok: true, message: describeSaved(adopted) } : { ok: false, message: adopted.reason })
		},
		(error: unknown) => {
			console.error('ArchiveBridge: could not finish a save that outlived its worker', error)
		},
	)
})

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
	const request = message as { readonly type?: unknown; readonly format?: unknown; readonly tabId?: unknown }
	if (request.type !== 'save') {
		return undefined
	}
	if (!isSaveFormat(request.format) || typeof request.tabId !== 'number') {
		sendResponse({ ok: false, message: 'malformed save request' } satisfies SaveCommandResult)
		return undefined
	}
	runSaveCommand(request.format, request.tabId).then(sendResponse)
	// Keeps the message channel open for the async `sendResponse` above.
	return true
})

/** (Re)creates the context-menu entries. `removeAll` first so a reload of an unpacked extension does not fail on duplicate IDs. */
function installContextMenus(): void {
	chrome.contextMenus.removeAll().then(() => {
		for (const format of ['mhtml', 'webarchive'] as const) {
			chrome.contextMenus.create({ id: MENU_ITEM_IDS[format], title: MENU_TITLES[format], contexts: ['page'] })
		}
	})
}

/**
 * Everything this extension registers with the browser rather than does on
 * demand: the two context-menu entries, and the `declarativeNetRequest` rule
 * that turns opening a local `.webarchive` into an ArchiveBridge viewer tab.
 *
 * Both run on install *and* on browser startup. Neither needs to run on every
 * worker start — a context menu and a dynamic DNR rule both outlive the
 * worker — and re-registering is idempotent, so running twice costs nothing
 * while never running would leave the feature missing.
 */
function installBrowserIntegrations(): void {
	installContextMenus()
	installFileInterception().catch((error: unknown) => {
		console.error('ArchiveBridge: could not install local .webarchive interception', error)
	})
}

chrome.runtime.onInstalled.addListener(installBrowserIntegrations)
chrome.runtime.onStartup.addListener(installBrowserIntegrations)

chrome.contextMenus.onClicked.addListener((info, tab) => {
	const format = (['mhtml', 'webarchive'] as const).find((candidate) => MENU_ITEM_IDS[candidate] === info.menuItemId)
	if (format === undefined) {
		return
	}
	if (tab?.id === undefined) {
		void showOutcome({ ok: false, message: 'no page to save (the context menu fired without a tab)' })
		return
	}
	void runSaveCommand(format, tab.id)
})
