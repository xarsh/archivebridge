/**
 * Deterministic download file names for saved archives.
 *
 * The name is derived from the archive's own main-resource URL rather than
 * from the browser's tab metadata. That is a deliberate architectural
 * choice, not a convenience: reading `tab.title`/`tab.url` would require
 * the `tabs` or `activeTab` permission, while the captured MHTML already
 * carries the page URL as its root part's `Content-Location`. Deriving the
 * name from the archive bytes therefore keeps the extension's permission
 * set minimal *and* keeps this logic browser-neutral — a future Firefox or
 * Safari capture adapter produces the same names from the same bytes, with
 * no per-browser tab API involved.
 *
 * Sanitation is intentionally small and conservative rather than clever:
 * the output has to be a legal file name on Windows, macOS and Linux
 * alike, and it has to be stable enough for tests to assert on exactly.
 */

/** Formats the extension can save. The same two formats `ArchiveFormat` names in `@xarsh/archivebridge`. */
export type SaveFormat = 'mhtml' | 'webarchive'

const FILE_EXTENSIONS: Readonly<Record<SaveFormat, string>> = {
	mhtml: 'mhtml',
	webarchive: 'webarchive',
}

/**
 * Upper bound on the stem length. 96 leaves room for a `.webarchive`
 * suffix and a `(1)`-style de-duplication suffix from the browser inside
 * the 255-byte per-path-component limit that APFS, ext4 and NTFS share.
 */
const MAX_STEM_LENGTH = 96

/** Windows reserved device names — illegal as a file stem even with an extension. */
const WINDOWS_RESERVED_STEMS = new Set([
	'con',
	'prn',
	'aux',
	'nul',
	'com1',
	'com2',
	'com3',
	'com4',
	'com5',
	'com6',
	'com7',
	'com8',
	'com9',
	'lpt1',
	'lpt2',
	'lpt3',
	'lpt4',
	'lpt5',
	'lpt6',
	'lpt7',
	'lpt8',
	'lpt9',
])

const FALLBACK_STEM = 'archive'

/**
 * Reduces `text` to ASCII letters, digits, `.`, `_` and `-`, collapsing
 * every run of anything else into a single `-`.
 *
 * Non-ASCII characters are dropped rather than percent-decoded or
 * transliterated. That loses information for a non-Latin URL, and it is
 * still the right trade for a *file name*: the alternative is emitting
 * bytes whose legality and normalization differ per filesystem (APFS
 * normalizes Unicode, ext4 does not, NTFS rejects a different set), which
 * would make the name neither deterministic nor portable. The archive's
 * real URL is preserved losslessly inside the archive itself.
 */
function sanitizeSegment(text: string): string {
	return text.replace(/[^A-Za-z0-9._-]+/g, '-')
}

/** Trims leading/trailing `-` and `.` runs that sanitation can leave behind (a leading `.` also makes the file hidden on Unix; a trailing `.` is illegal on Windows). */
function trimSeparators(text: string): string {
	return text.replace(/^[.-]+/, '').replace(/[.-]+$/, '')
}

/**
 * The part of `pageUrl` worth putting in a file name: `host` + path for a
 * hierarchical URL, the scheme-specific part otherwise. Query and fragment
 * are dropped — rarely meaningful in a file name, always noisy.
 *
 * The path is percent-*decoded* first, so a non-Latin URL contributes a
 * separator (via {@link sanitizeSegment}) rather than a run of hex: `URL`
 * normalizes `/日本語/page` to `/%E6%97%A5%E6%9C%AC%E8%AA%9E/page`, and
 * `example.com-E6-97-A5-E6-9C-AC-E8-AA-9E-page` is a worse name than
 * `example.com--page` by any measure. Malformed escapes are left as-is:
 * `decodeURIComponent` throws on them, and the raw form is a perfectly
 * good input to sanitation.
 */
function readableUrlPart(pageUrl: string): string {
	let url: URL
	try {
		url = new URL(pageUrl)
	} catch {
		return pageUrl
	}
	const path = decodePath(url.pathname)
	if (url.host.length === 0) {
		return path
	}
	return path === '/' ? url.host : `${url.host}${path}`
}

function decodePath(pathname: string): string {
	try {
		return decodeURIComponent(pathname)
	} catch {
		return pathname
	}
}

/**
 * Builds the file-name stem for an archive whose main resource is
 * `pageUrl`. `undefined` (or a URL that sanitizes away to nothing) yields
 * `archive` — this is a naming decision, never a failure: refusing to save
 * real captured bytes because their URL was odd would be the wrong
 * outcome.
 */
export function archiveFileStem(pageUrl: string | undefined): string {
	if (pageUrl === undefined) {
		return FALLBACK_STEM
	}
	const truncated = trimSeparators(sanitizeSegment(readableUrlPart(pageUrl))).slice(0, MAX_STEM_LENGTH)
	const stem = trimSeparators(truncated)
	if (stem.length === 0 || WINDOWS_RESERVED_STEMS.has((stem.split('.')[0] ?? '').toLowerCase())) {
		return FALLBACK_STEM
	}
	return stem
}

/** The full download file name (stem plus format extension) for an archive whose main resource is `pageUrl`. */
export function archiveFileName(pageUrl: string | undefined, format: SaveFormat): string {
	return `${archiveFileStem(pageUrl)}.${FILE_EXTENSIONS[format]}`
}
