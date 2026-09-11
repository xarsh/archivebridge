/**
 * Turns one browser MHTML capture into the bytes to write for a requested
 * {@link SaveFormat}. This is the whole of the extension's archive logic,
 * and it is deliberately browser-neutral: no `chrome.*`, no DOM, no
 * `navigator`. Every format-specific operation is delegated to
 * `@xarsh/archivebridge`'s public API, per CONTRIBUTING.md's boundary rule
 * that the extension must not reimplement archive parsing or conversion.
 *
 * Two properties are worth stating because they are easy to break:
 *
 * - **MHTML is passed through byte-for-byte.** The browser's own capture
 *   is already canonical MHTML (see docs/architecture.md, "MHTML is the
 *   canonical format"), so re-serializing it through ArchiveBridge would
 *   only risk changing bytes the browser produced for no gain. Parsing
 *   still happens, but purely to read the page title/URL for the file
 *   name and to surface diagnostics.
 * - **A parse problem never blocks an MHTML save.** The bytes came from
 *   the browser; refusing to write them because ArchiveBridge disliked
 *   something in them would be strictly worse for the user than writing
 *   them under a fallback file name. WebArchive is different — conversion
 *   genuinely cannot proceed without a parsed document — and says so.
 *
 * Being free of browser APIs is what lets the whole byte-generation path
 * be asserted directly, on real captured bytes, without a browser and
 * without any test-only branch in production code.
 */

import { convertMhtmlToWebArchive, type Diagnostic, extractMhtmlRootTitle, parseMhtml, serializeWebArchive } from '@xarsh/archivebridge'
import { archiveFileName, type SaveFormat } from './file-name.ts'

/** The MIME types Chrome itself associates with these two formats (measured: it derives `.mht` from `application/x-mimearchive` when it declines to render one). Used only as the saved `Blob`'s type; the file name carries the authoritative extension. */
const MIME_TYPES: Readonly<Record<SaveFormat, string>> = {
	mhtml: 'application/x-mimearchive',
	webarchive: 'application/x-webarchive',
}

/** Bytes ready to hand to a save adapter, plus everything the caller needs to describe what happened. */
export interface ArchiveBytes {
	readonly format: SaveFormat
	readonly bytes: Uint8Array
	readonly fileName: string
	readonly mimeType: string
	/** The archive's main-resource URL, when it could be read. Reported so a caller can log/display what was actually saved. */
	readonly pageUrl: string | undefined
	/** Diagnostics from parsing (and, for WebArchive, converting). Non-empty does not mean failure — see docs/architecture.md, "Diagnostics and partial failure". */
	readonly diagnostics: readonly Diagnostic[]
}

/** Thrown when a requested format genuinely cannot be produced from the captured bytes. Carries the diagnostics that explain why, so the caller can surface something more useful than "conversion failed". */
export class ArchiveConversionError extends Error {
	readonly diagnostics: readonly Diagnostic[]

	constructor(message: string, diagnostics: readonly Diagnostic[]) {
		super(message)
		this.name = 'ArchiveConversionError'
		this.diagnostics = diagnostics
	}
}

/**
 * Produces the bytes to save for `format` from `capturedMhtml` — the raw
 * output of a browser MHTML capture.
 *
 * Throws {@link ArchiveConversionError} only when `format` cannot be
 * produced at all.
 */
export function archiveBytesFrom(capturedMhtml: Uint8Array, format: SaveFormat): ArchiveBytes {
	const parsed = parseMhtml(capturedMhtml)
	const pageUrl = parsed.document === undefined ? undefined : parsed.document.parts[parsed.document.rootPartIndex]?.location
	const pageTitle = parsed.document === undefined ? undefined : extractMhtmlRootTitle(parsed.document)

	switch (format) {
		case 'mhtml':
			return {
				format,
				bytes: capturedMhtml,
				fileName: archiveFileName(pageUrl, format, pageTitle),
				mimeType: MIME_TYPES[format],
				pageUrl,
				diagnostics: parsed.diagnostics,
			}
		case 'webarchive': {
			if (parsed.document === undefined) {
				throw new ArchiveConversionError('the captured MHTML could not be parsed, so it cannot be converted to WebArchive', parsed.diagnostics)
			}
			const converted = convertMhtmlToWebArchive(parsed.document)
			return {
				format,
				bytes: serializeWebArchive(converted.document),
				fileName: archiveFileName(pageUrl, format, pageTitle),
				mimeType: MIME_TYPES[format],
				pageUrl,
				diagnostics: [...parsed.diagnostics, ...converted.diagnostics],
			}
		}
	}
}
