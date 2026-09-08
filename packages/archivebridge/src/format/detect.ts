import type { ArchiveFormat } from '../model/archive.ts'

/**
 * Only the first bytes of a file are ever needed to tell MHTML from
 * WebArchive apart. Bounding the sniff window keeps detection safe to run
 * on attacker-controlled input without reading (or requiring) the whole file.
 */
const MAX_SNIFF_BYTES = 4096

const BINARY_PLIST_MAGIC = new TextEncoder().encode('bplist')

/**
 * Detects the archive format by inspecting file content.
 *
 * There is no registered magic number for MHTML: it is plain RFC 2045/2046
 * MIME text, so detection falls back to looking for the mail-style headers
 * every MHTML file starts with. WebArchive is an Apple property list,
 * either binary (starts with the `bplist` magic) or XML (starts with an
 * `<?xml` declaration and a `plist` DOCTYPE).
 *
 * Returns `undefined` when neither shape is recognized, rather than
 * guessing: callers can combine this with {@link detectArchiveFormatFromFilename}
 * or surface an `unsupported-feature` diagnostic.
 */
export function detectArchiveFormatFromBytes(bytes: Uint8Array): ArchiveFormat | undefined {
	const head = bytes.subarray(0, MAX_SNIFF_BYTES)

	if (startsWithBytes(head, BINARY_PLIST_MAGIC)) {
		return 'webarchive'
	}

	const text = new TextDecoder('utf-8', { fatal: false }).decode(head)
	const trimmed = text.trimStart()

	if (trimmed.startsWith('<?xml') && text.includes('<!DOCTYPE plist')) {
		return 'webarchive'
	}

	if (/^(mime-version:|content-type:\s*multipart\/related|from:)/i.test(trimmed)) {
		return 'mhtml'
	}

	return undefined
}

/** Detects the archive format from a file name's extension, if recognized. */
export function detectArchiveFormatFromFilename(filename: string): ArchiveFormat | undefined {
	const lower = filename.toLowerCase()

	if (lower.endsWith('.mhtml') || lower.endsWith('.mht')) {
		return 'mhtml'
	}

	if (lower.endsWith('.webarchive')) {
		return 'webarchive'
	}

	return undefined
}

function startsWithBytes(haystack: Uint8Array, needle: Uint8Array): boolean {
	if (haystack.length < needle.length) {
		return false
	}

	for (let i = 0; i < needle.length; i++) {
		if (haystack[i] !== needle[i]) {
			return false
		}
	}

	return true
}
