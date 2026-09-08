/**
 * archivebridge CLI.
 *
 * Argument parsing is hand-rolled (process.argv + a switch) rather than
 * pulling in a CLI framework: the surface area is three subcommands, and
 * this project keeps runtime dependencies at zero unless a standard API
 * cannot reasonably do the job.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { detectArchiveFormatFromBytes, detectArchiveFormatFromFilename } from '../format/detect.ts'
import { parseMhtml } from '../mhtml/parse.ts'
import { serializeMhtml } from '../mhtml/serialize.ts'
import type { Archive, ArchiveFormat, Diagnostic, ParseResult, Resource } from '../model/archive.ts'
import { parseWebArchive } from '../webarchive/parse.ts'
import { serializeWebArchive } from '../webarchive/serialize.ts'

const COMMANDS = ['inspect', 'convert', 'extract'] as const
type Command = (typeof COMMANDS)[number]

const HELP_TEXT = `archivebridge - inspect and convert saved web page archives

Usage:
  archivebridge inspect <file>
  archivebridge convert <input> <output>
  archivebridge extract <file> <output-dir>

Commands:
  inspect   Show the structure and diagnostics of an archive
  convert   Convert between MHTML and WebArchive
  extract   Extract archive resources to a directory

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

	if (first === undefined) {
		io.stdout(HELP_TEXT)
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
		io.stdout(HELP_TEXT)
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
		case 'extract':
			return runExtract(args, io)
	}
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

	const { archive, diagnostics } = parseByFormat(format, bytes)

	io.stdout(`Format: ${format}`)
	if (archive !== undefined) {
		io.stdout('')
		for (const line of formatArchive(archive, 0)) {
			io.stdout(line)
		}
	}
	io.stdout('')
	io.stdout(`Diagnostics (${diagnostics.length}):`)
	for (const diagnostic of diagnostics) {
		io.stdout(`  - ${formatDiagnostic(diagnostic)}`)
	}

	return archive === undefined ? 1 : 0
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

	const { archive, diagnostics } = parseByFormat(inputFormat, bytes)
	for (const diagnostic of diagnostics) {
		io.stderr(`archivebridge: ${formatDiagnostic(diagnostic)}`)
	}

	if (archive === undefined) {
		io.stderr(`archivebridge: could not parse '${input}' as ${inputFormat}`)
		return 1
	}

	let converted: Uint8Array
	try {
		converted = serializeByFormat(outputFormat, archive)
	} catch (error) {
		io.stderr(`archivebridge: could not convert to ${outputFormat}: ${error instanceof Error ? error.message : String(error)}`)
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

function runExtract(_args: readonly string[], io: CliIO): number {
	io.stderr('archivebridge extract: not implemented yet')
	return 1
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

function parseByFormat(format: ArchiveFormat, bytes: Uint8Array): ParseResult {
	switch (format) {
		case 'mhtml':
			return parseMhtml(bytes)
		case 'webarchive':
			return parseWebArchive(bytes)
	}
}

function serializeByFormat(format: ArchiveFormat, archive: Archive): Uint8Array {
	switch (format) {
		case 'mhtml':
			return serializeMhtml(archive)
		case 'webarchive':
			return serializeWebArchive(archive)
	}
}

function formatArchive(archive: Archive, depth: number): string[] {
	const indent = '  '.repeat(depth)
	const lines: string[] = [`${indent}Main URL: ${archive.mainUrl}`, `${indent}Main resource:`, ...formatResource(archive.mainResource, depth + 1)]

	lines.push(`${indent}Resources (${archive.resources.size}):`)
	for (const resource of archive.resources.values()) {
		lines.push(...formatResource(resource, depth + 1))
	}

	lines.push(`${indent}Frames (${archive.frames.length}):`)
	archive.frames.forEach((frame, index) => {
		lines.push(`${indent}  [${index}]`)
		lines.push(...formatArchive(frame, depth + 2))
	})

	return lines
}

function formatResource(resource: Resource, depth: number): string[] {
	const indent = '  '.repeat(depth)
	const lines = [`${indent}- ${resource.url}`, `${indent}    MIME type: ${resource.mimeType}`, `${indent}    Size: ${resource.data.length} bytes`]
	if (resource.textEncoding !== undefined) {
		lines.push(`${indent}    Text encoding: ${resource.textEncoding}`)
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
		case 'duplicate-resource-url':
			return `duplicate-resource-url: ${diagnostic.url}`
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
