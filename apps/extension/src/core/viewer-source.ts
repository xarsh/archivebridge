/**
 * What the viewer is being asked to open, and what to say when it cannot
 * open it.
 *
 * The viewer is reached by a redirect (see `chrome/file-interception.ts`),
 * so the archive's location arrives as part of the viewer page's own URL —
 * which makes it **attacker-influenced input**, not a trusted parameter.
 * A file name is chosen by whoever wrote the file; a page the user visits
 * can also simply link to the viewer with any fragment it likes. This
 * module is the boundary that turns that string into either a local
 * archive URL the viewer may read, or a refusal.
 *
 * Three properties are the reason it exists:
 *
 * - **The source travels in the fragment, not in a query parameter.** A
 *   `file:` URL keeps `&`, `=` and `+` literal (Chromium percent-encodes
 *   `#`, `?`, `%` and space — measured), so `?src=file:///a&b.webarchive`
 *   would silently truncate at the `&`. A fragment has no sub-delimiters:
 *   everything after the first `#` is the value.
 * - **The raw fragment is the URL; the decoded one is only for display.**
 *   Percent-decoding before reading would turn `%23` back into a `#` and
 *   read a different file (or nothing).
 * - **Validation is a whitelist, not a sanitizer.** The value must parse
 *   as a URL, be `file:` with no host, and name a `.webarchive` — the
 *   exact set the interception rule produces. Anything else is refused
 *   rather than repaired.
 *
 * Browser-neutral by construction: no `chrome.*`, no DOM, no `fetch`. The
 * Chrome viewer page supplies the location string and does the reading;
 * a Firefox or Safari viewer would supply its own and reuse all of this.
 */

/** The one archive extension the viewer opens. Chrome renders `.mht`/`.mhtml` natively and ArchiveBridge deliberately does not pre-empt it (docs/architecture.md, "Archive viewer"). */
const VIEWER_FILE_EXTENSION = '.webarchive'

export type ViewerSource =
	| {
			readonly kind: 'archive'
			/** The exact URL to read: the fragment as written, never percent-decoded. */
			readonly url: string
			/** The file's own name, percent-decoded, for the title bar and messages. */
			readonly displayName: string
	  }
	| {
			/** The viewer page was opened directly, with no archive named. */
			readonly kind: 'absent'
	  }
	| {
			/** Something was named, and it is not a local archive this viewer may open. */
			readonly kind: 'rejected'
			readonly value: string
	  }

/**
 * Reads the archive location out of a viewer page URL
 * (`chrome-extension://.../viewer.html#file:///...webarchive`).
 */
export function readViewerSource(viewerUrl: string): ViewerSource {
	let fragment: string
	try {
		fragment = new URL(viewerUrl).hash.slice(1)
	} catch {
		return { kind: 'absent' }
	}
	if (fragment.length === 0) {
		return { kind: 'absent' }
	}

	let url: URL
	try {
		url = new URL(fragment)
	} catch {
		return { kind: 'rejected', value: fragment }
	}
	// `file://host/share/...` is a remote path on Windows, and every other
	// scheme is somebody else's resource. The interception rule only ever
	// produces `file:///`, so anything else did not come from it.
	if (url.protocol !== 'file:' || url.host.length !== 0) {
		return { kind: 'rejected', value: fragment }
	}
	if (!url.pathname.toLowerCase().endsWith(VIEWER_FILE_EXTENSION)) {
		return { kind: 'rejected', value: fragment }
	}
	return { kind: 'archive', url: url.href, displayName: displayNameOf(url) }
}

/** The last path segment, percent-decoded where that is possible. Display only — never used to read anything. */
function displayNameOf(url: URL): string {
	const segment = url.pathname.split('/').pop() ?? url.pathname
	try {
		return decodeURIComponent(segment)
	} catch {
		return segment
	}
}

/** Why the viewer has nothing to show. Every case is reachable from ordinary use, not just from a hostile one. */
export type ViewerFailure =
	| { readonly kind: 'absent-source' }
	| { readonly kind: 'rejected-source'; readonly value: string }
	| { readonly kind: 'file-access-denied' }
	| { readonly kind: 'unreadable'; readonly detail: string }
	| { readonly kind: 'unrecognized-format' }
	| { readonly kind: 'unparseable'; readonly detail: string }
	| { readonly kind: 'no-document'; readonly detail: string }

export interface ViewerFailureMessage {
	readonly title: string
	readonly detail: string
}

/**
 * One line a reader can act on, plus one that explains it.
 *
 * Deliberately free of browser-specific instructions: `file-access-denied`
 * says *what* is wrong, and the per-browser layer adds *how to fix it*,
 * because the fix is a Chrome toggle that has no Firefox or Safari
 * equivalent.
 */
export function describeViewerFailure(failure: ViewerFailure): ViewerFailureMessage {
	switch (failure.kind) {
		case 'absent-source':
			return { title: 'No archive to show', detail: 'Open a .webarchive file to view it here.' }
		case 'rejected-source':
			return { title: 'Not a local archive', detail: `This viewer only opens local .webarchive files, and “${failure.value}” is not one.` }
		case 'file-access-denied':
			return { title: 'Cannot read local files', detail: 'ArchiveBridge is not allowed to read files on this computer, so it cannot open this archive.' }
		case 'unreadable':
			return { title: 'Could not read the archive', detail: failure.detail }
		case 'unrecognized-format':
			return { title: 'Not a recognized archive', detail: 'This file is neither a WebArchive nor an MHTML archive.' }
		case 'unparseable':
			return { title: 'Could not read the archive', detail: failure.detail }
		case 'no-document':
			return { title: 'Nothing to display', detail: failure.detail }
	}
}
