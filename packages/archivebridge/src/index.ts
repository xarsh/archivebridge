/**
 * Public API of @xarsh/archivebridge.
 *
 * This module intentionally only exports what is actually implemented.
 * Remaining entry points (parseArchive, ...) will be added here once they
 * exist; see docs/architecture.md for the planned shape.
 */

export { detectArchiveFormatFromBytes, detectArchiveFormatFromFilename } from './format/detect.ts'
export { parseMhtml } from './mhtml/parse.ts'
export { serializeMhtml } from './mhtml/serialize.ts'
export type { Archive, ArchiveFormat, Diagnostic, ParseResult, Resource } from './model/archive.ts'
export { parseWebArchive } from './webarchive/parse.ts'
export { serializeWebArchive } from './webarchive/serialize.ts'
