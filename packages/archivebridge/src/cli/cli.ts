/**
 * archivebridge CLI.
 *
 * Argument parsing is hand-rolled (process.argv + a switch) rather than
 * pulling in a CLI framework: the surface area is two subcommands, and this
 * project keeps runtime dependencies at zero unless a standard API cannot
 * reasonably do the job.
 *
 * `inspect` and `convert` are implemented entirely on top of the library's
 * public API: format detection, `parseMhtml`/`parseWebArchive`, the direct
 * WebArchive <-> MHTML converters, and `serializeMhtml`/`serializeWebArchive`.
 * `inspect` always operates on canonical MHTML — a WebArchive input is
 * parsed and then converted to an `MhtmlDocument` first; there is no
 * WebArchive-shaped inspection code path. See docs/architecture.md, "No
 * format-neutral Archive/ArchiveView IR" and its "CLI" section.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { convertWebArchiveToMhtml } from '../convert/to-mhtml.ts'
import { convertMhtmlToWebArchive } from '../convert/to-web-archive.ts'
import { detectArchiveFormatFromBytes, detectArchiveFormatFromFilename } from '../format/detect.ts'
import { buildFrameTree, findFrameRootReferences, groupPartsByFrame, type MhtmlFrameNode } from '../mhtml/frames.ts'
import { parseMhtml } from '../mhtml/parse.ts'
import { serializeMhtml } from '../mhtml/serialize.ts'
import { findSidecarPart, findSidecarPartIndices } from '../mhtml/sidecar.ts'
import type { ArchiveFormat, Diagnostic } from '../model/archive.ts'
import type { MhtmlDocument, MhtmlPart } from '../model/mhtml.ts'
import type { WebArchiveDocument } from '../model/webarchive.ts'
import { parseWebArchive } from '../webarchive/parse.ts'
import { serializeWebArchive } from '../webarchive/serialize.ts'

const COMMANDS = ['inspect', 'convert'] as const
type Command = (typeof COMMANDS)[number]

const HELP_TEXT = `archivebridge - inspect and convert saved web page archives

Usage:
  archivebridge inspect <file>
  archivebridge convert <input> <output>

Commands:
  inspect   Show the structure and diagnostics of an archive, exiting
            non-zero if it could not be parsed or has any diagnostics
  convert   Convert between MHTML and WebArchive

Options:
  -h, --help     Show this help message
  --version      Show the CLI version
`

/** Minimal output seam so main() can be unit tested without touching the real console. */
export interface CliIO {
	readonly stdout: (line: string) => void
	readonly stderr: (line: string) => void
}

const defaultIO: CliIO = {
	stdout: (line) => console.log(line),
	stderr: (line) => console.error(line),
}

function isCommand(value: string): value is Command {
	return (COMMANDS as readonly string[]).includes(value)
}

export function main(argv: readonly string[], io: CliIO = defaultIO): number {
	const [first, ...rest] = argv

	// Stream choice follows the exit code, not the kind of text: help that was
	// *asked for* is the command's output and goes to stdout with exit 0, while
	// help printed because the invocation was wrong is part of an error report
	// and goes to stderr with exit 1 — the same rule the per-command `Usage:`
	// lines in `runInspect`/`runConvert` already follow. This is what keeps
	// `archivebridge ... > out` from writing usage text into a file the caller
	// expects to hold real output, and keeps a failed run's diagnosis visible
	// when stdout is piped somewhere else.
	if (first === undefined) {
		io.stderr(HELP_TEXT)
		return 1
	}

	if (first === '-h' || first === '--help') {
		io.stdout(HELP_TEXT)
		return 0
	}

	if (first === '--version') {
		io.stdout(getVersion())
		return 0
	}

	if (!isCommand(first)) {
		io.stderr(`archivebridge: unknown command '${first}'`)
		io.stderr(HELP_TEXT)
		return 1
	}

	return runCommand(first, rest, io)
}

function runCommand(command: Command, args: readonly string[], io: CliIO): number {
	switch (command) {
		case 'inspect':
			return runInspect(args, io)
		case 'convert':
			return runConvert(args, io)
	}
}

/** Parses MHTML bytes, reporting its diagnostics and any failure to `io`. Returns undefined on failure. */
function parseMhtmlReporting(bytes: Uint8Array, path: string, io: CliIO): MhtmlDocument | undefined {
	const { document, diagnostics } = parseMhtml(bytes)
	for (const diagnostic of diagnostics) {
		io.stderr(`archivebridge: ${formatDiagnostic(diagnostic)}`)
	}
	if (document === undefined) {
		io.stderr(`archivebridge: could not parse '${path}' as mhtml`)
	}
	return document
}

/** Parses WebArchive bytes, reporting its diagnostics and any failure to `io`. Returns undefined on failure. */
function parseWebArchiveReporting(bytes: Uint8Array, path: string, io: CliIO): WebArchiveDocument | undefined {
	const { document, diagnostics } = parseWebArchive(bytes)
	for (const diagnostic of diagnostics) {
		io.stderr(`archivebridge: ${formatDiagnostic(diagnostic)}`)
	}
	if (document === undefined) {
		io.stderr(`archivebridge: could not parse '${path}' as webarchive`)
	}
	return document
}

function runInspect(args: readonly string[], io: CliIO): number {
	const [file] = args
	if (file === undefined || args.length !== 1) {
		io.stderr('Usage: archivebridge inspect <file>')
		return 1
	}

	const bytes = readArchiveBytes(file, io)
	if (bytes === undefined) {
		return 1
	}

	const format = detectFormat(file, bytes, io)
	if (format === undefined) {
		return 1
	}

	const diagnostics: Diagnostic[] = []
	const document = loadCanonicalMhtmlCollecting(format, bytes, diagnostics)

	io.stdout(`Format: ${format}`)
	if (document !== undefined) {
		io.stdout('')
		for (const line of formatMhtmlDocument(document, diagnostics)) {
			io.stdout(line)
		}
	}
	io.stdout('')
	io.stdout(`Diagnostics (${diagnostics.length}):`)
	for (const diagnostic of diagnostics) {
		io.stdout(`  - ${formatDiagnostic(diagnostic)}`)
	}

	return document === undefined || diagnostics.length > 0 ? 1 : 0
}

/** Loads bytes as canonical MHTML for `inspect`: a WebArchive input is parsed and converted first (docs/architecture.md, "No format-neutral Archive/ArchiveView IR"). Diagnostics are collected into a caller-supplied array, since `inspect` prints them after the structural output rather than streaming them straight to `io.stderr`. */
function loadCanonicalMhtmlCollecting(format: ArchiveFormat, bytes: Uint8Array, diagnostics: Diagnostic[]): MhtmlDocument | undefined {
	if (format === 'mhtml') {
		const result = parseMhtml(bytes)
		diagnostics.push(...result.diagnostics)
		return result.document
	}
	const webResult = parseWebArchive(bytes)
	diagnostics.push(...webResult.diagnostics)
	if (webResult.document === undefined) {
		return undefined
	}
	const converted = convertWebArchiveToMhtml(webResult.document)
	diagnostics.push(...converted.diagnostics)
	return converted.document
}

function runConvert(args: readonly string[], io: CliIO): number {
	const [input, output] = args
	if (input === undefined || output === undefined || args.length !== 2) {
		io.stderr('Usage: archivebridge convert <input> <output>')
		return 1
	}

	const bytes = readArchiveBytes(input, io)
	if (bytes === undefined) {
		return 1
	}

	const inputFormat = detectFormat(input, bytes, io)
	if (inputFormat === undefined) {
		return 1
	}

	const outputFormat = detectArchiveFormatFromFilename(output)
	if (outputFormat === undefined) {
		io.stderr(`archivebridge: could not determine output format from '${output}' (expected a .mhtml, .mht, or .webarchive extension)`)
		return 1
	}

	// The serializers deliberately *throw* for an in-memory model that cannot be
	// written conformingly — a document with duplicate Content-IDs, a header value
	// no MIME header field can carry, a WebArchive `extra` claiming a reserved key
	// (see mhtml/serialize.ts and webarchive/serialize.ts). The tolerant parsers
	// can produce such a model from real foreign input, so this is a reachable
	// outcome of `convert`, not just an internal invariant violation: it has to
	// surface as a normal CLI error, not an unhandled stack trace.
	let converted: Uint8Array | undefined
	try {
		converted = convertForOutput(inputFormat, outputFormat, bytes, input, io)
	} catch (error) {
		io.stderr(`archivebridge: could not convert '${input}' to ${outputFormat}: ${error instanceof Error ? error.message : String(error)}`)
		return 1
	}
	if (converted === undefined) {
		return 1
	}

	try {
		writeFileSync(output, converted)
	} catch (error) {
		io.stderr(`archivebridge: could not write '${output}': ${error instanceof Error ? error.message : String(error)}`)
		return 1
	}

	io.stdout(`archivebridge: wrote ${output} (${inputFormat} -> ${outputFormat})`)
	return 0
}

/** Parses `bytes` as `inputFormat` and serializes as `outputFormat`, converting between formats directly when they differ (the one CLI operation that legitimately deals with both format-native shapes) — or just re-serializing when they're the same. */
function convertForOutput(inputFormat: ArchiveFormat, outputFormat: ArchiveFormat, bytes: Uint8Array, input: string, io: CliIO): Uint8Array | undefined {
	if (inputFormat === 'mhtml') {
		const document = parseMhtmlReporting(bytes, input, io)
		if (document === undefined) {
			return undefined
		}
		if (outputFormat === 'mhtml') {
			return serializeMhtml(document)
		}
		const { document: webDoc, diagnostics } = convertMhtmlToWebArchive(document)
		for (const diagnostic of diagnostics) {
			io.stderr(`archivebridge: ${formatDiagnostic(diagnostic)}`)
		}
		return serializeWebArchive(webDoc)
	}

	const document = parseWebArchiveReporting(bytes, input, io)
	if (document === undefined) {
		return undefined
	}
	if (outputFormat === 'webarchive') {
		return serializeWebArchive(document)
	}
	const { document: mhtmlDoc, diagnostics } = convertWebArchiveToMhtml(document)
	for (const diagnostic of diagnostics) {
		io.stderr(`archivebridge: ${formatDiagnostic(diagnostic)}`)
	}
	return serializeMhtml(mhtmlDoc)
}

function readArchiveBytes(path: string, io: CliIO): Uint8Array | undefined {
	try {
		return readFileSync(path)
	} catch (error) {
		io.stderr(`archivebridge: could not read '${path}': ${error instanceof Error ? error.message : String(error)}`)
		return undefined
	}
}

/** Sniffs by content first (works for extensionless input), falling back to the filename. */
function detectFormat(path: string, bytes: Uint8Array, io: CliIO): ArchiveFormat | undefined {
	const format = detectArchiveFormatFromBytes(bytes) ?? detectArchiveFormatFromFilename(path)
	if (format === undefined) {
		io.stderr(`archivebridge: could not detect the archive format of '${path}'`)
	}
	return format
}

function formatMhtmlDocument(document: MhtmlDocument, diagnostics: Diagnostic[]): string[] {
	const adjacency = findFrameRootReferences(document, diagnostics)
	const frameTree = buildFrameTree(document.rootPartIndex, adjacency, diagnostics)
	const sidecarResult = findSidecarPart(document, diagnostics)
	const resourceIndicesByOwner = groupPartsByFrame(document, frameTree, new Set(findSidecarPartIndices(document)))

	const lines = formatFrameNode(document, frameTree, resourceIndicesByOwner, 0)
	if (sidecarResult !== undefined) {
		lines.push('Metadata sidecar: present')
	}
	return lines
}

function formatFrameNode(document: MhtmlDocument, node: MhtmlFrameNode, resourceIndicesByOwner: ReadonlyMap<number, readonly number[]>, depth: number): string[] {
	const indent = '  '.repeat(depth)
	const part = document.parts[node.partIndex]
	if (part === undefined) {
		return []
	}

	const lines = [`${indent}Main URL: ${part.location ?? '(no Content-Location)'}`, `${indent}Main resource:`, ...formatPart(part, depth + 1)]

	const ownedIndices = resourceIndicesByOwner.get(node.partIndex) ?? []
	lines.push(`${indent}Resources (${ownedIndices.length}):`)
	for (const index of ownedIndices) {
		const resourcePart = document.parts[index]
		if (resourcePart !== undefined) {
			lines.push(...formatPart(resourcePart, depth + 1))
		}
	}

	lines.push(`${indent}Frames (${node.children.length}):`)
	node.children.forEach((child, index) => {
		lines.push(`${indent}  [${index}]`)
		lines.push(...formatFrameNode(document, child, resourceIndicesByOwner, depth + 2))
	})

	return lines
}

function formatPart(part: MhtmlPart, depth: number): string[] {
	const indent = '  '.repeat(depth)
	const lines = [
		`${indent}- ${part.location ?? part.contentId ?? '(no Content-Location or Content-ID)'}`,
		`${indent}    MIME type: ${part.mimeType}`,
		`${indent}    Size: ${part.data.length} bytes`,
	]
	if (part.textEncoding !== undefined) {
		lines.push(`${indent}    Text encoding: ${part.textEncoding}`)
	}
	return lines
}

function formatDiagnostic(diagnostic: Diagnostic): string {
	switch (diagnostic.type) {
		case 'malformed-archive':
			return `malformed-archive: ${diagnostic.message}`
		case 'malformed-resource':
			return diagnostic.url === undefined ? `malformed-resource: ${diagnostic.message}` : `malformed-resource (${diagnostic.url}): ${diagnostic.message}`
		case 'unsupported-encoding':
			return `unsupported-encoding: ${diagnostic.encoding}`
		case 'unresolved-resource':
			return `unresolved-resource: ${diagnostic.url}`
		case 'duplicate-content-location':
			return `duplicate-content-location: ${diagnostic.url}`
		case 'duplicate-content-id':
			return `duplicate-content-id: ${diagnostic.contentId}`
		case 'duplicate-metadata-sidecar':
			return `duplicate-metadata-sidecar: ${diagnostic.count} parts matched the sidecar media type`
		case 'malformed-metadata-sidecar':
			return `malformed-metadata-sidecar: ${diagnostic.message}`
		case 'frame-depth-exceeded':
			return `frame-depth-exceeded: depth ${diagnostic.depth}`
		case 'cyclic-frame-reference':
			return `cyclic-frame-reference: part index ${diagnostic.partIndex}`
		case 'unconsumed-child-frame':
			return `unconsumed-child-frame: ${diagnostic.url}`
		case 'unsupported-feature':
			return `unsupported-feature: ${diagnostic.feature}`
		case 'recovered-non-conforming-input':
			return `recovered-non-conforming-input: ${diagnostic.message}`
	}
}

function getVersion(): string {
	// Resolved at runtime rather than hardcoded so the built CLI always
	// reports the version it was actually packaged at.
	const packageJsonPath = fileURLToPath(new URL('../../package.json', import.meta.url))
	const { version } = JSON.parse(readFileSync(packageJsonPath, 'utf-8')) as { version: string }
	return version
}
