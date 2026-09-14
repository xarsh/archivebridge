/**
 * Ambient declarations for exactly the `browser.*` APIs the Firefox
 * adapter calls — nothing more, and for the same reasons
 * `chrome/chrome-api.d.ts` gives: `@types/firefox-webext-browser` would
 * declare every namespace to type the handful used here, and this file
 * doubles as the reviewable list of platform APIs this adapter depends on,
 * so widening it is a visible edit.
 *
 * It is a separate file from `chrome-api.d.ts`, not an extension of it,
 * because the two namespaces genuinely differ where it matters: Firefox
 * spells the context menu `browser.menus` (`contextMenus` is `undefined`
 * under MV3), its background is an event page rather than a service
 * worker, its `runtime.onMessage` resolves a returned promise instead of
 * taking a `sendResponse` callback, and it has `permissions.request` as a
 * gesture-bound part of the capture's normal flow. Merging them would mean
 * typing the union of two platforms and losing exactly the differences that
 * make the adapters separate.
 *
 * The risk of hand-written types disagreeing with the runtime is covered
 * the same way Chrome's is: every declaration here is exercised against a
 * real Firefox in `e2e/firefox/`.
 */

interface FirefoxEvent<Listener extends (...args: never[]) => unknown> {
	addListener(listener: Listener): void
	removeListener(listener: Listener): void
}

interface FirefoxMessageSender {
	readonly id?: string
	readonly url?: string
}

interface FirefoxTab {
	readonly id?: number
	readonly active?: boolean
}

/** `menus.onClicked`'s first argument, narrowed to the one field the command path reads. */
interface FirefoxMenuClickInfo {
	readonly menuItemId: string | number
}

/** A `DownloadItem`, as much of one as the save path reads. */
interface FirefoxDownloadItem {
	readonly id: number
	readonly url: string
	/** Absolute path of the file Firefox actually wrote — not necessarily the name that was requested, since the chooser lets the user rename it. */
	readonly filename: string
	readonly state: string
	readonly error?: string
	readonly totalBytes: number
}

interface FirefoxDownloadDelta {
	readonly id: number
	readonly state?: { readonly current?: string }
}

/** One frame's result from `scripting.executeScript`. `result` is whatever the injected function returned, structured-cloned, and is therefore `unknown` until it is narrowed. */
interface FirefoxInjectionResult {
	readonly frameId?: number
	readonly result?: unknown
	readonly error?: unknown
}

declare const browser: {
	readonly runtime: {
		/**
		 * Firefox resolves the value a listener *returns* (or the promise it
		 * returns) back to the sender — there is no `sendResponse` callback and
		 * no "return true to keep the channel open" protocol. That is a real
		 * difference from Chrome's MV3 `onMessage`, not a spelling one.
		 */
		readonly onMessage: FirefoxEvent<(message: unknown, sender: FirefoxMessageSender) => unknown>
		readonly onInstalled: FirefoxEvent<() => void>
		readonly onStartup: FirefoxEvent<() => void>
		sendMessage(message: unknown): Promise<unknown>
		getManifest(): { readonly version: string; readonly name: string }
	}
	readonly tabs: {
		query(queryInfo: { active?: boolean; currentWindow?: boolean }): Promise<readonly FirefoxTab[]>
	}
	readonly action: {
		setBadgeText(details: { text: string }): Promise<void>
		setBadgeBackgroundColor(details: { color: string }): Promise<void>
		setTitle(details: { title: string }): Promise<void>
	}
	/** Firefox's spelling of the context menu. `browser.contextMenus` is `undefined` under MV3 (measured). */
	readonly menus: {
		create(properties: { id: string; title: string; contexts: readonly string[] }): void
		removeAll(): Promise<void>
		readonly onClicked: FirefoxEvent<(info: FirefoxMenuClickInfo, tab: FirefoxTab | undefined) => void>
	}
	readonly permissions: {
		/**
		 * **Must be called synchronously from a user-gesture handler, before
		 * any `await`** — Firefox's transient activation does not survive one,
		 * and the call then rejects rather than prompting. See
		 * `host-permissions.ts`.
		 */
		request(permissions: { readonly origins?: readonly string[]; readonly permissions?: readonly string[] }): Promise<boolean>
	}
	readonly scripting: {
		executeScript<Argument, Result>(injection: {
			target: { tabId: number; frameIds?: readonly number[]; allFrames?: boolean }
			world?: 'ISOLATED' | 'MAIN'
			func: (argument: Argument) => Result
			args?: readonly [Argument]
		}): Promise<readonly FirefoxInjectionResult[]>
	}
	readonly downloads: {
		download(options: { url: string; filename: string; saveAs: boolean }): Promise<number>
		search(query: { id: number }): Promise<readonly FirefoxDownloadItem[]>
		readonly onChanged: FirefoxEvent<(delta: FirefoxDownloadDelta) => void>
	}
}
