/**
 * Popup: two buttons, one status line.
 *
 * The popup is intentionally the smallest UI that can offer the two
 * commands. It holds no product logic — it resolves the active tab, hands
 * the request to the service worker's single command path (the same one
 * the page context menu uses), and renders whatever comes back. There is
 * no settings screen and no archive-conversion UI; conversion belongs to
 * the CLI, and the browser surface stays small on purpose. See
 * docs/architecture.md, "Browser extension".
 *
 * Resolving the active tab through `chrome.tabs.query` needs no `tabs`
 * permission, because only `Tab.id` is read — `url`/`title` are the
 * permission-gated fields, and the file name is derived from the archive
 * bytes instead precisely so they are never needed (see
 * `core/file-name.ts`).
 *
 * The one thing here that is not a save command is a single line about
 * local file access, shown only when Chrome's per-extension "Allow access
 * to file URLs" toggle is off. Opening a local `.webarchive` silently does
 * nothing useful in that state, and this is the only surface the user
 * reliably sees beforehand. It is a sentence, not a settings screen:
 * nothing here can change the toggle, because only the user can.
 */

import { FILE_ACCESS_HINT, isFileAccessAllowed } from '../chrome/local-archive.ts'
import type { SaveFormat } from '../core/file-name.ts'

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

async function requestSave(format: SaveFormat): Promise<void> {
	setBusy(true)
	clearStatus()
	try {
		const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
		if (tab?.id === undefined) {
			show('No page to save in this window.', true)
			return
		}
		const response = (await chrome.runtime.sendMessage({ type: 'save', format, tabId: tab.id })) as { readonly ok?: unknown; readonly message?: unknown }
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
		void requestSave(format)
	})
}

async function showFileAccessNote(): Promise<void> {
	if (await isFileAccessAllowed()) {
		return
	}
	const note = document.getElementById('file-access')
	if (note === null) {
		return
	}
	note.textContent = `To open local .webarchive files: ${FILE_ACCESS_HINT}`
	note.hidden = false
}

void showFileAccessNote()
