/**
 * The `chrome.*` members the E2E tests poke at from inside the browser,
 * on top of what production code already declares in
 * `src/chrome/chrome-api.d.ts` (which `tsconfig.test.json` includes, so
 * these merge into the same `Chrome` interface rather than restating it).
 *
 * These belong to the tests, not to the extension: `chrome.permissions` in
 * particular exists here only so a test can *assert* that the extension
 * holds no host permissions. Production code must never need it.
 */

interface ChromePermissionSet {
	readonly permissions?: readonly string[]
	readonly origins?: readonly string[]
}

interface ChromePermissions {
	getAll(): Promise<ChromePermissionSet>
}

interface Chrome {
	readonly permissions: ChromePermissions
}

interface ChromeDownloads {
	/**
	 * Test-only: production code searches by id or by state, so
	 * `chrome-api.d.ts` declares only those forms. Tests need "the most recent
	 * download" to find the file the production path just wrote.
	 */
	search(query: { readonly orderBy?: readonly string[]; readonly limit?: number }): Promise<readonly ChromeDownloadItem[]>

	/**
	 * Test-only, and the save-lifecycle suite's whole reason for existing: an
	 * extension that defers this event holds a `DownloadItem` in exactly the
	 * state the native Save As chooser holds it in — `in_progress`, empty
	 * `filename`, bytes staged (measured against the real chooser in a headed
	 * browser) — and releases it on demand, which is what the chooser does
	 * when the user finally picks a file. Headless Chromium completes
	 * `saveAs: true` immediately, so this is the only way to reproduce a
	 * pending save in an automated test. Production never registers it.
	 *
	 * Chrome cancels a download whose filename stays undetermined for ~15
	 * seconds, so a test's hold is a short budget, not an indefinite pause.
	 */
	readonly onDeterminingFilename: ChromeEvent<
		(item: ChromeDownloadItem, suggest: (suggestion: { readonly filename: string; readonly conflictAction?: 'uniquify' | 'overwrite' | 'prompt' }) => void) => boolean | undefined
	>
}

interface ChromeTabs {
	/**
	 * Test-only: production code only ever *reads* the active tab via
	 * `query`. Tests need to *set* it, because the harness opens `popup.html`
	 * as an ordinary tab, which can steal "active" status that a real action
	 * popup would never hold in the first place.
	 */
	update(tabId: number, updateProperties: { readonly active?: boolean }): Promise<ChromeTab>
}

/** Test-only recorder, installed into the service worker by a test to observe the requests entry points send. Never set by production code. */
declare var archivebridgeObservedRequests: unknown[] | undefined

/** Test-only state the save-lifecycle suite keeps in its own extension page: the downloads it is holding, and the callbacks that release them. Never set by production code. */
declare var archivebridgeLab:
	| {
			held: { readonly id: number; readonly url: string }[]
			release: ((suggestion: { readonly filename: string; readonly conflictAction?: 'uniquify' | 'overwrite' | 'prompt' }) => void)[]
			/** What the command path answered, once it answers. Set so that a save failing before its download exists is diagnosable. */
			result?: unknown
	  }
	| undefined

interface ChromeAction {
	/** Test-only: production code only ever *sets* the badge. Reading it is how a test checks the failure surface that needs no `notifications` permission. */
	getBadgeText(details: Record<string, never>): Promise<string>
	/** Test-only, same reason: the tooltip is where the outcome message lands for a save with no popup left to render it. */
	getTitle(details: Record<string, never>): Promise<string>
}
