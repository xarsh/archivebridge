/**
 * Ambient declarations for exactly the `chrome.*` APIs this extension
 * calls — nothing more.
 *
 * `@types/chrome` was the obvious alternative and was rejected: it
 * declares 90+ API namespaces to type the eight members used here, and
 * this repository's dependency policy (CONTRIBUTING.md) asks for a stated
 * reason before any dependency, including type-only ones. A hand-written
 * declaration of the used surface is also better documentation than a
 * dependency would be — this file *is* the list of platform APIs the
 * extension depends on, so widening that list is a visible, reviewable
 * edit rather than an invisible one.
 *
 * The risk of hand-writing types is that they can disagree with the real
 * runtime and TypeScript would never notice. That risk is covered by
 * exercising every declaration below against a real Chromium build in
 * `e2e/` rather than by trusting the declarations themselves.
 *
 * Members are typed as narrowly as the call sites need. Optional
 * properties are `?`-optional (not `| undefined` unions) because that is
 * what `exactOptionalPropertyTypes` requires of an object literal passed
 * to these functions.
 */

interface ChromeRuntimeMessageSender {
	readonly id?: string
	readonly url?: string
}

interface ChromeEvent<Listener extends (...args: never[]) => unknown> {
	addListener(listener: Listener): void
	removeListener(listener: Listener): void
}

interface ChromeRuntime {
	/** The extension's own ID. Reading it is the standard way to check whether an extension context is still valid. */
	readonly id: string
	getURL(path: string): string
	sendMessage(message: unknown): Promise<unknown>
	readonly onMessage: ChromeEvent<(message: unknown, sender: ChromeRuntimeMessageSender, sendResponse: (response: unknown) => void) => boolean | undefined>
	readonly onInstalled: ChromeEvent<() => void>
	readonly onStartup: ChromeEvent<() => void>
}

interface ChromePageCapture {
	/** Serializes a tab to MHTML. Requires only the `pageCapture` permission — no host permissions (measured; see docs/architecture.md, "Browser extension"). The resolved `Blob` has an empty `type`, so callers must not branch on it. */
	saveAsMHTML(details: { tabId: number }): Promise<Blob>
}

/** Offscreen-document reasons this extension uses. Chrome defines more; only the one that is actually passed is declared. */
type ChromeOffscreenReason = 'BLOBS'

interface ChromeOffscreen {
	createDocument(parameters: { url: string; reasons: readonly ChromeOffscreenReason[]; justification: string }): Promise<void>
	/** Chrome 116+. */
	hasDocument(): Promise<boolean>
	closeDocument(): Promise<void>
}

interface ChromeDownloadItem {
	readonly id: number
	readonly filename: string
	/** The URL the bytes come from. For a save in flight this is the `blob:` URL the offscreen document minted, which is how a restarted worker tells its own downloads apart from the user's. */
	readonly url: string
	readonly bytesReceived: number
	readonly totalBytes: number
	readonly state: 'in_progress' | 'complete' | 'interrupted'
	readonly error?: string
}

interface ChromeDownloadDelta {
	readonly id: number
	readonly state?: { readonly previous?: string; readonly current?: string }
	readonly error?: { readonly previous?: string; readonly current?: string }
}

interface ChromeDownloads {
	download(options: { url: string; filename: string; saveAs: boolean; conflictAction?: 'uniquify' | 'overwrite' | 'prompt' }): Promise<number>
	/** Both forms the save adapter needs: one item by id, and every download still running (to find a save that outlived the worker that started it). */
	search(query: { readonly id?: number; readonly state?: ChromeDownloadItem['state'] }): Promise<readonly ChromeDownloadItem[]>
	readonly onChanged: ChromeEvent<(delta: ChromeDownloadDelta) => void>
}

interface ChromeContextMenuClickData {
	readonly menuItemId: string | number
}

interface ChromeTab {
	/** Absent for a tab that cannot host content (a devtools window, for instance). */
	readonly id?: number
}

interface ChromeContextMenus {
	create(properties: { id: string; title: string; contexts: readonly ('page' | 'frame' | 'selection' | 'link' | 'image')[] }): void
	removeAll(): Promise<void>
	readonly onClicked: ChromeEvent<(info: ChromeContextMenuClickData, tab: ChromeTab | undefined) => void>
}

interface ChromeTabs {
	query(queryInfo: { active?: boolean; currentWindow?: boolean }): Promise<readonly ChromeTab[]>
}

interface ChromeAction {
	setBadgeText(details: { text: string }): Promise<void>
	setBadgeBackgroundColor(details: { color: string }): Promise<void>
	setTitle(details: { title: string }): Promise<void>
}

interface Chrome {
	readonly runtime: ChromeRuntime
	readonly pageCapture: ChromePageCapture
	readonly offscreen: ChromeOffscreen
	readonly downloads: ChromeDownloads
	readonly contextMenus: ChromeContextMenus
	readonly tabs: ChromeTabs
	readonly action: ChromeAction
}

declare const chrome: Chrome
