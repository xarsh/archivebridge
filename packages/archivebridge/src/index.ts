/**
 * Public API of @xarsh/archivebridge.
 *
 * This module intentionally only exports what is actually implemented.
 * See docs/architecture.md for design rationale.
 */

export { convertWebArchiveToMhtml } from './convert/to-mhtml.ts'
export { convertMhtmlToWebArchive } from './convert/to-web-archive.ts'
export { detectArchiveFormatFromBytes, detectArchiveFormatFromFilename } from './format/detect.ts'
export { parseMhtml } from './mhtml/parse.ts'
export { serializeMhtml } from './mhtml/serialize.ts'
export type { ArchiveFormat, Diagnostic } from './model/archive.ts'
export type { MhtmlDocument, MhtmlParseResult, MhtmlPart } from './model/mhtml.ts'
export type { WebArchiveDocument, WebArchiveParseResult, WebArchiveResource } from './model/webarchive.ts'
export { parseWebArchive } from './webarchive/parse.ts'
export { serializeWebArchive } from './webarchive/serialize.ts'
