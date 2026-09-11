/**
 * Deterministic download file names for saved archives.
 *
 * The name is derived from the archive's own captured content rather than
 * from the browser's tab metadata. That is a deliberate architectural
 * choice, not a convenience: reading `tab.title`/`tab.url` would require
 * the `tabs` or `activeTab` permission, while the captured MHTML already
 * carries the page's `<title>` in its root part and the page URL as that
 * part's `Content-Location`. Deriving the name from the archive bytes
 * therefore keeps the extension's permission set minimal *and* keeps this
 * logic browser-neutral — a future Firefox or Safari capture adapter
 * produces the same names from the same bytes, with no per-browser tab API
 * involved.
 *
 * Naming priority is page title first, URL second, `archive` last — the
 * title (once `@xarsh/archivebridge` has extracted and decoded it) is
 * preferred because it is what a user recognizes, matching the browser's
 * own native Save As. Title sanitation preserves ordinary Unicode, unlike
 * URL sanitation below, which intentionally reduces to ASCII: a URL's
 * non-Latin path segment is redundant with the page's own title, but a
 * title *is* the name, so discarding its script would defeat the point.
 * Both sanitation passes are conservative rather than clever: the output
 * has to be a legal file name on Windows, macOS and Linux alike, and it
 * has to be stable enough for tests to assert on exactly.
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

/**
 * Upper bound on a title-derived stem, in UTF-8 *bytes* rather than
 * characters: a title stem keeps ordinary Unicode (see the module doc
 * comment), and a JS string's `.length` counts UTF-16 code units, not
 * bytes — a CJK or emoji-heavy title can need up to 4 bytes per character.
 * 150 bytes leaves comfortable room for `.webarchive` plus a `(1)`-style
 * de-duplication suffix within the 255-byte-or-code-unit limit every one
 * of APFS/ext4/NTFS enforces, on any input.
 */
const MAX_TITLE_STEM_BYTES = 150

/**
 * A hostile page can declare an arbitrarily long `<title>`. This bounds
 * how much of it sanitation ever processes, so a pathological title can't
 * make {@link truncateUtf8}'s per-character encoding loop expensive — no
 * real title needs anywhere near this many characters to fill
 * {@link MAX_TITLE_STEM_BYTES}.
 */
const TITLE_INPUT_CAP = 2048

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

function isReservedStem(stem: string): boolean {
	return WINDOWS_RESERVED_STEMS.has((stem.split('.')[0] ?? '').toLowerCase())
}

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
 * Builds a `[...]+` character-class `RegExp` from Unicode code points,
 * without ever writing a literal control/formatting character (or its
 * source-level escape sequence) into this file: `codePoints` are ordinary
 * numeric literals, and the characters they name only ever exist as
 * runtime values. That keeps this file itself free of the very characters
 * — raw bidi overrides, C0/C1 controls — the sanitizer exists to strip.
 */
const BACKSLASH_CODE_POINT = 0x5c

/** A literal backslash needs doubling to survive as a `RegExp` *source string* (not a regex literal): a single backslash would instead escape whichever character follows it in the class. */
function charClassMember(codePoint: number): string {
	const char = String.fromCodePoint(codePoint)
	return codePoint === BACKSLASH_CODE_POINT ? char + char : char
}

function controlCharClass(...codePoints: readonly number[]): RegExp {
	const chars = codePoints.map((codePoint) => charClassMember(codePoint)).join('')
	return new RegExp(`[${chars}]+`, 'gu')
}

function codeRange(startCodePoint: number, endCodePointInclusive: number): number[] {
	const codePoints: number[] = []
	for (let codePoint = startCodePoint; codePoint <= endCodePointInclusive; codePoint += 1) {
		codePoints.push(codePoint)
	}
	return codePoints
}

/**
 * Unicode bidi formatting/isolate control characters: ALM (U+061C), LRM/RLM
 * (U+200E, U+200F), the embedding/override block (U+202A-U+202E), and the
 * isolate block (U+2066-U+2069). An attacker-controlled page title can carry
 * these to visually reorder the rendered file name — e.g. making a
 * `.exe`-suffixed name display as if it ended in something else. They carry
 * no meaning in a file name, so they are stripped entirely rather than
 * replaced with a visible placeholder.
 */
const BIDI_CONTROL_CHARS = controlCharClass(0x061c, 0x200e, 0x200f, ...codeRange(0x202a, 0x202e), ...codeRange(0x2066, 0x2069))

/**
 * Characters illegal (or merely inadvisable) in a file name on at least
 * one of Windows/macOS/Linux: the ASCII/C0 control range (U+0000-U+001F,
 * which includes NUL), DEL and the C1 control range (U+007F-U+009F), and
 * the nine punctuation characters Windows reserves (`/ \ : * ? " < > |`).
 * Runs of them collapse to a single `-`, matching {@link sanitizeSegment}'s
 * "readable replacement, not deleted arbitrary portions" approach.
 */
const ILLEGAL_FILENAME_CHARS = controlCharClass(
	...codeRange(0x00, 0x1f),
	...codeRange(0x7f, 0x9f),
	0x2f /* / */,
	0x5c /* \ */,
	0x3a /* : */,
	0x2a /* * */,
	0x3f /* ? */,
	0x22 /* " */,
	0x3c /* < */,
	0x3e /* > */,
	0x7c /* | */,
)

/** Trims leading/trailing whitespace, `-` and `.` runs — the whitespace half matters only for title stems, whose sanitation (unlike the URL path's) never turns a space into `-`. */
function trimStemEdges(text: string): string {
	return text.replace(/^[\s.-]+/, '').replace(/[\s.-]+$/, '')
}

/**
 * Truncates `text` to at most `maxBytes` UTF-8 bytes without splitting a
 * Unicode code point (`for...of` iterates by code point, so a surrogate
 * pair — e.g. an emoji — is never separated).
 */
function truncateUtf8(text: string, maxBytes: number): string {
	const encoder = new TextEncoder()
	if (encoder.encode(text).byteLength <= maxBytes) {
		return text
	}
	let result = ''
	let byteLength = 0
	for (const character of text) {
		const characterBytes = encoder.encode(character).byteLength
		if (byteLength + characterBytes > maxBytes) {
			break
		}
		result += character
		byteLength += characterBytes
	}
	return result
}

/**
 * Sanitizes an already-extracted, already-whitespace-normalized page
 * title (see `@xarsh/archivebridge`'s `extractMhtmlRootTitle`) into a safe
 * file-name stem. Unlike {@link readableUrlPart}'s URL handling, ordinary
 * Unicode is preserved rather than reduced to ASCII — see the module doc
 * comment. Returns `undefined` when the title sanitizes away to nothing or
 * to a Windows reserved device name, so the caller can fall back to
 * URL-derived naming.
 */
function titleFileStem(title: string): string | undefined {
	const capped = title.length > TITLE_INPUT_CAP ? title.slice(0, TITLE_INPUT_CAP) : title
	const withoutBidi = capped.normalize('NFC').replace(BIDI_CONTROL_CHARS, '')
	const withoutIllegal = withoutBidi.replace(ILLEGAL_FILENAME_CHARS, '-')
	const truncated = trimStemEdges(truncateUtf8(trimStemEdges(withoutIllegal), MAX_TITLE_STEM_BYTES))
	if (truncated.length === 0 || isReservedStem(truncated)) {
		return undefined
	}
	return truncated
}

/**
 * Builds the file-name stem for an archive whose captured page title is
 * `pageTitle` and whose main resource is `pageUrl`. Priority is `pageTitle`
 * first, `pageUrl` second, `archive` last — never a failure: refusing to
 * save real captured bytes because a nice name couldn't be found would be
 * the wrong outcome.
 */
export function archiveFileStem(pageUrl: string | undefined, pageTitle?: string): string {
	if (pageTitle !== undefined) {
		const fromTitle = titleFileStem(pageTitle)
		if (fromTitle !== undefined) {
			return fromTitle
		}
	}
	if (pageUrl === undefined) {
		return FALLBACK_STEM
	}
	const truncated = trimSeparators(sanitizeSegment(readableUrlPart(pageUrl))).slice(0, MAX_STEM_LENGTH)
	const stem = trimSeparators(truncated)
	if (stem.length === 0 || isReservedStem(stem)) {
		return FALLBACK_STEM
	}
	return stem
}

/** The full download file name (stem plus format extension) for an archive whose captured page title is `pageTitle` and whose main resource is `pageUrl`. */
export function archiveFileName(pageUrl: string | undefined, format: SaveFormat, pageTitle?: string): string {
	return `${archiveFileStem(pageUrl, pageTitle)}.${FILE_EXTENSIONS[format]}`
}
