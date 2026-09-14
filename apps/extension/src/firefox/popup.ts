/**
 * Firefox popup: the same two commands and one status line the Chrome popup
 * offers, against `browser.*`.
 *
 * It shares `popup.html` with Chrome — the markup and the element IDs are
 * identical, and each build bundles its own `popup.js` into its own output
 * directory — but not the script, for the same reason the two backgrounds
 * are separate: the differences are per-platform, not cosmetic. This one
 * has no "Allow access to file URLs" note, because that toggle is a Chrome
 * concept and Firefox's local-archive story is a file picker instead
 * (docs/architecture.md, "Per-browser viewer reach").
 *
 * **The click handler's first statement is the permission request, and the
 * order is load-bearing.** Firefox's transient activation does not survive
 * an `await`, so resolving the active tab first — which is what this file
 * used to do, and the obvious way to write it — would make every
 * `permissions.request()` reject with `permissions.request may only be
 * called from a user input handler`. The lookup happens after the request
 * is already in flight. See `host-permissions.ts`.
 *
 * Resolving the active tab through `browser.tabs.query` needs no `tabs`
 * permission, because only `Tab.id` is read — `url`/`title` are the
 * permission-gated fields, and the file name is derived from the archive
 * bytes instead precisely so they are never needed (`core/file-name.ts`).
 */

import type { SaveFormat } from '../core/file-name.ts'
import { CAPTURE_HOST_PERMISSIONS } from './host-permissions.ts'

function requireElement<T extends Element>(id: string, elementType: new () => T): T {
	const element = document.getElementById(id)
	if (!(element instanceof elementType)) {
		throw new Error(`popup.html is missing element #${id}`)
	}
	return element
}

const status = requireElement('status', HTMLElement)
const buttons: readonly (readonly [SaveFormat, HTMLButtonElement])[] = [
	['mhtml', requireElement('save-mhtml', HTMLButtonElement)],
	['webarchive', requireElement('save-webarchive', HTMLButtonElement)],
]

function show(message: string, failed: boolean): void {
	status.textContent = message
	status.classList.toggle('error', failed)
}

function clearStatus(): void {
	status.textContent = ''
	status.classList.remove('error')
}

function setBusy(busy: boolean): void {
	for (const [, button] of buttons) {
		button.disabled = busy
	}
}

/**
 * Runs one save command, given a permission request that is already in
 * flight.
 *
 * Everything in here awaits something, which is exactly why it is not the
 * click handler: see the module header.
 */
async function requestSave(format: SaveFormat, permission: Promise<boolean>): Promise<void> {
	setBusy(true)
	clearStatus()
	try {
		try {
			// A refusal, a revocation, or a gesture that was already spent all
			// arrive here, and none of them is fatal: `activeTab` covers the top
			// document a Phase 1 capture reads, so the save continues and any
			// resource that needed the wider permission comes back as a
			// diagnostic instead.
			await permission
		} catch (error) {
			console.warn('ArchiveBridge: host permission was not granted, continuing with activeTab only', error)
		}
		const [tab] = await browser.tabs.query({ active: true, currentWindow: true })
		if (tab?.id === undefined) {
			show('No page to save in this window.', true)
			return
		}
		const response = (await browser.runtime.sendMessage({ type: 'save', format, tabId: tab.id })) as { readonly ok?: unknown; readonly message?: unknown }
		if (response.ok !== true) {
			show(typeof response.message === 'string' ? response.message : 'Save failed.', true)
		}
	} catch (error) {
		show(error instanceof Error ? error.message : String(error), true)
	} finally {
		setBusy(false)
	}
}

for (const [format, button] of buttons) {
	button.addEventListener('click', () => {
		// FIRST, and before any `await`: this click is the user gesture the
		// permission request has to be spent on, and it does not survive one.
		const permission = browser.permissions.request(CAPTURE_HOST_PERMISSIONS)
		void requestSave(format, permission)
	})
}
