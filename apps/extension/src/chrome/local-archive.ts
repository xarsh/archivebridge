/**
 * Reading the bytes of a local archive, on Chrome/Edge.
 *
 * `fetch()` on a `file://` URL works from an extension page — measured,
 * and it returns the exact bytes even for the `.webarchive` Chrome itself
 * refuses to render — but only with two things in place: the
 * `file:///*` host permission (declared in the manifest) *and* the
 * per-extension **"Allow access to file URLs"** toggle, which the user
 * must turn on in `chrome://extensions` and which defaults to off.
 *
 * Those are two different failures and the viewer has to tell them apart:
 * a missing file is the user's mistake, a missing toggle is a setting only
 * they can change. `chrome.extension.isAllowedFileSchemeAccess()` is what
 * distinguishes them, and it is asked *after* a read fails rather than
 * before every read — the permission is the unusual case, not the
 * expected one.
 */

import type { ViewerFailure } from '../core/viewer-source.ts'

export type LocalArchiveRead = { readonly ok: true; readonly bytes: Uint8Array } | { readonly ok: false; readonly failure: ViewerFailure }

/** Reads `fileUrl`, classifying a failure as "not allowed to read local files" or "could not read this one". */
export async function readLocalArchive(fileUrl: string): Promise<LocalArchiveRead> {
	try {
		const response = await fetch(fileUrl)
		if (!response.ok) {
			return { ok: false, failure: { kind: 'unreadable', detail: `The file could not be read (HTTP ${response.status}).` } }
		}
		return { ok: true, bytes: new Uint8Array(await response.arrayBuffer()) }
	} catch (error) {
		if (!(await isFileAccessAllowed())) {
			return { ok: false, failure: { kind: 'file-access-denied' } }
		}
		return { ok: false, failure: { kind: 'unreadable', detail: `The file could not be read: ${error instanceof Error ? error.message : String(error)}.` } }
	}
}

/** Whether Chrome is currently letting this extension read `file://` URLs at all. */
export async function isFileAccessAllowed(): Promise<boolean> {
	try {
		return await chrome.extension.isAllowedFileSchemeAccess()
	} catch {
		return false
	}
}

/**
 * How a reader turns the file-access toggle on. Chrome-specific by nature,
 * which is why it lives here and not in `core/viewer-source.ts`'s
 * browser-neutral failure messages.
 */
export const FILE_ACCESS_HINT = 'Open chrome://extensions, find ArchiveBridge, choose Details, and turn on “Allow access to file URLs”.'
