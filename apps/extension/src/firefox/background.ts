/**
 * Firefox MV3 background event page: the extension's one command path and
 * the two entry points that trigger it.
 *
 * ```text
 * captureMhtml(tabId)              firefox/capture.ts    (browser adapter)
 *   -> archiveBytesFrom(bytes, f)  core/archive-bytes.ts (browser-neutral)
 *   -> saveBytes(...)              firefox/save.ts       (browser adapter)
 * ```
 *
 * The middle of that pipeline is the same module Chrome's background calls,
 * unchanged — Firefox is a different capture and a different save around an
 * unchanged byte-generation core, not a second pipeline
 * (docs/architecture.md, "Capture and save vary independently").
 *
 * **This is deliberately parallel to `chrome/background.ts` rather than
 * shared with it.** The two differ in the things an abstraction would have
 * to hide: an event page versus a service worker, `browser.menus` versus
 * `chrome.contextMenus`, a returned promise versus `sendResponse`, a save
 * path with no offscreen document, and — the one with real consequences
 * below — a host permission acquired from the user's gesture.
 *
 * ## The gesture rule, which is why `menus.onClicked` looks the way it does
 *
 * `browser.permissions.request()` must be called **synchronously, as the
 * first thing a gesture handler does**. Firefox's transient activation does
 * not survive even a trivial `await`; the call then rejects immediately
 * with `permissions.request may only be called from a user input handler`
 * (measured). A `menus.onClicked` handler *is* a valid gesture, so the
 * context menu and the popup can behave identically — provided neither
 * looks anything up first. Hence the shape below: the request is started
 * before anything is awaited, and the promise it returns is handed to an
 * ordinary async function that does the rest. See `host-permissions.ts` for
 * why there is no helper wrapping that call.
 */

import { ArchiveConversionError, archiveBytesFrom } from '../core/archive-bytes.ts'
import type { SaveFormat } from '../core/file-name.ts'
import { captureMhtml } from './capture.ts'
import { CAPTURE_HOST_PERMISSIONS } from './host-permissions.ts'
import { SaveCanceledError, type SaveResult, saveBytes } from './save.ts'

/** Context-menu item IDs. */
const MENU_ITEM_IDS: Readonly<Record<SaveFormat, string>> = {
	mhtml: 'archivebridge.save.mhtml',
	webarchive: 'archivebridge.save.webarchive',
}

const MENU_TITLES: Readonly<Record<SaveFormat, string>> = {
	mhtml: 'Save as MHTML…',
	webarchive: 'Save as WebArchive…',
}

const SAVE_FORMATS = ['mhtml', 'webarchive'] as const

/** What the popup gets back. The popup renders `message` verbatim, which is the extension's primary error surface. */
export interface SaveCommandResult {
	readonly ok: boolean
	readonly message: string
}

function isSaveFormat(value: unknown): value is SaveFormat {
	return value === 'mhtml' || value === 'webarchive'
}

/** A save request from the popup. */
interface SaveRequest {
	readonly type: 'save'
	readonly format: SaveFormat
	readonly tabId: number
}

function isSaveRequest(message: unknown): message is SaveRequest {
	if (typeof message !== 'object' || message === null) {
		return false
	}
	const candidate = message as { type?: unknown; format?: unknown; tabId?: unknown }
	return candidate.type === 'save' && isSaveFormat(candidate.format) && typeof candidate.tabId === 'number'
}

/** Turns anything thrown along the pipeline into one line a human can act on. */
function describeError(error: unknown): string {
	if (error instanceof ArchiveConversionError) {
		const details = error.diagnostics.map((diagnostic) => diagnostic.type).join(', ')
		return details.length === 0 ? error.message : `${error.message} [${details}]`
	}
	if (error instanceof Error && error.message.length > 0) {
		return error.message
	}
	return 'Save failed.'
}

/**
 * Mirrors the outcome on the toolbar, for the entry point that has no popup
 * to render it. Failures here are swallowed on purpose: a save's result
 * must still reach the caller even if a `browser.action` call rejects.
 */
async function showOutcome(result: SaveCommandResult): Promise<void> {
	try {
		await browser.action.setBadgeText({ text: result.ok ? '' : '!' })
		await browser.action.setBadgeBackgroundColor({ color: '#b3261e' })
		await browser.action.setTitle({ title: result.ok ? 'ArchiveBridge' : `ArchiveBridge — ${result.message}` })
	} catch (error) {
		console.error('ArchiveBridge: could not update the toolbar badge/title', error)
	}
}

/** The message a finished save shows, in the popup's status line and the toolbar tooltip. */
function describeSaved(saved: SaveResult): string {
	return `Saved ${saved.fileName} (${saved.byteLength.toLocaleString('en-US')} bytes)`
}

/** Serializes command execution: two saves at once would race over each other's blob URLs. */
let pending: Promise<unknown> = Promise.resolve()

function serialize<T>(work: () => Promise<T>): Promise<T> {
	const result = pending.then(work, work)
	pending = result.catch(() => undefined)
	return result
}

/** The one path every entry point takes: capture, convert if the format asks for it, save. */
async function runSaveCommand(format: SaveFormat, tabId: number): Promise<SaveCommandResult> {
	return await serialize(async () => {
		let result: SaveCommandResult
		let canceled = false
		try {
			const captured = await captureMhtml(tabId)
			const archive = archiveBytesFrom(captured, format)
			for (const diagnostic of archive.diagnostics) {
				console.warn('ArchiveBridge: diagnostic while saving', diagnostic)
			}
			const saved = await saveBytes(archive.bytes, archive.fileName, archive.mimeType)
			result = { ok: true, message: describeSaved(saved) }
		} catch (error) {
			canceled = error instanceof SaveCanceledError
			if (!canceled) {
				console.error('ArchiveBridge: save failed', error)
			}
			result = { ok: false, message: describeError(error) }
		}
		// The popup still renders `result.message`, so the user is told either
		// way; only the toolbar-wide badge is skipped. Dismissing a file chooser
		// is the user saying no, not a failure worth flagging until they next
		// look at the toolbar.
		if (!canceled) {
			await showOutcome(result)
		}
		return result
	})
}

/**
 * The rest of a context-menu command, once its permission request is
 * already in flight.
 *
 * Split out for one reason only: everything in here awaits something, and
 * none of it may run before `permissions.request` has been called. Keeping
 * it in a separate function makes the listener below short enough that the
 * ordering is visible at a glance rather than asserted in a comment.
 */
async function completeMenuCommand(format: SaveFormat, tabId: number | undefined, permission: Promise<boolean>): Promise<void> {
	try {
		// Awaited, not ignored: an unhandled rejection here would be the
		// difference between "the user declined" and a broken extension. A
		// refusal — or a rejection, which is what a lost gesture looks like —
		// degrades to whatever `activeTab` already covers, which for Phase 1's
		// top-document capture is the page itself.
		await permission
	} catch (error) {
		console.warn('ArchiveBridge: host permission was not granted, continuing with activeTab only', error)
	}
	if (tabId === undefined) {
		await showOutcome({ ok: false, message: 'no page to save (the context menu fired without a tab)' })
		return
	}
	await runSaveCommand(format, tabId)
}

/** (Re)creates the context-menu entries. `removeAll` first so reloading a temporary extension does not fail on duplicate IDs. */
function installContextMenus(): void {
	browser.menus.removeAll().then(
		() => {
			for (const format of SAVE_FORMATS) {
				browser.menus.create({ id: MENU_ITEM_IDS[format], title: MENU_TITLES[format], contexts: ['page'] })
			}
		},
		(error: unknown) => {
			console.error('ArchiveBridge: could not install the page context menu', error)
		},
	)
}

browser.runtime.onInstalled.addListener(installContextMenus)
browser.runtime.onStartup.addListener(installContextMenus)

browser.menus.onClicked.addListener((info, tab) => {
	const format = SAVE_FORMATS.find((candidate) => MENU_ITEM_IDS[candidate] === info.menuItemId)
	if (format === undefined) {
		return
	}
	// FIRST, and before any `await`: this click is the user gesture the
	// permission request has to be spent on, and it does not survive one.
	// Everything else this command needs — the tab, the capture, the save —
	// happens inside `completeMenuCommand`, after the request exists.
	const permission = browser.permissions.request(CAPTURE_HOST_PERMISSIONS)
	void completeMenuCommand(format, tab?.id, permission)
})

browser.runtime.onMessage.addListener((message) => {
	if (!isSaveRequest(message)) {
		return undefined
	}
	// Firefox resolves the promise a listener returns back to the sender;
	// there is no `sendResponse` callback and no "return true" protocol here.
	// The popup has already spent its own gesture on the permission request
	// before sending this (see `popup.ts`), so nothing here asks again.
	return runSaveCommand(message.format, message.tabId)
})
