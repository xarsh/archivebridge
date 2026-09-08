/**
 * CLI integration tests: exercise `main()` end-to-end against real fixture
 * files on disk, the same way a user invoking the `archivebridge` binary
 * would. Complements the unit-style tests in cli.test.ts, which use
 * synthetic args and don't touch the filesystem.
 */

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { parseMhtml } from '../mhtml/parse.ts'
import { parseWebArchive } from '../webarchive/parse.ts'
import { main } from './cli.ts'

const fixturesUrl = new URL('../../../../fixtures/', import.meta.url)
const minimalMhtmlPath = fileURLToPath(new URL('mhtml/minimal.mhtml', fixturesUrl))
const minimalWebArchivePath = fileURLToPath(new URL('webarchive/minimal.webarchive', fixturesUrl))
const exampleComMhtmlPath = fileURLToPath(new URL('mhtml/example-com.chrome.mhtml', fixturesUrl))

function collectIO() {
	const lines: string[] = []
	return {
		lines,
		io: {
			stdout: (line: string) => lines.push(line),
			stderr: (line: string) => lines.push(line),
		},
	}
}

function withTempDir(run: (dir: string) => void): void {
	const dir = mkdtempSync(join(tmpdir(), 'archivebridge-cli-'))
	try {
		run(dir)
	} finally {
		rmSync(dir, { recursive: true, force: true })
	}
}

test('inspect prints the archive structure and diagnostics for an MHTML fixture', () => {
	const { lines, io } = collectIO()
	const code = main(['inspect', minimalMhtmlPath], io)
	const output = lines.join('\n')

	assert.equal(code, 0)
	assert.match(output, /Format: mhtml/)
	assert.match(output, /Main URL: https:\/\/example\.invalid\//)
	assert.match(output, /Resources \(0\):/)
	assert.match(output, /Frames \(0\):/)
	assert.match(output, /Diagnostics \(0\):/)
})

test('inspect prints subresources for a multi-resource MHTML fixture', () => {
	const { lines, io } = collectIO()
	const code = main(['inspect', exampleComMhtmlPath], io)
	const output = lines.join('\n')

	assert.equal(code, 0)
	assert.match(output, /Main URL: https:\/\/example\.com\//)
	assert.match(output, /cid:css-26e12f97-5991-48e5-8947-8f89db6bc3fa@mhtml\.blink/)
})

test('inspect prints the archive structure and diagnostics for a WebArchive fixture', () => {
	const { lines, io } = collectIO()
	const code = main(['inspect', minimalWebArchivePath], io)
	const output = lines.join('\n')

	assert.equal(code, 0)
	assert.match(output, /Format: webarchive/)
	assert.match(output, /Diagnostics \(0\):/)
})

test('inspect on an unrecognized file exits with an error code', () => {
	withTempDir((dir) => {
		const path = join(dir, 'not-an-archive.txt')
		writeFileSync(path, 'just some text')

		const { lines, io } = collectIO()
		const code = main(['inspect', path], io)

		assert.equal(code, 1)
		assert.ok(lines.some((line) => line.includes('could not detect the archive format')))
	})
})

test('convert turns an MHTML fixture into a WebArchive that parses back to the same archive', () => {
	withTempDir((dir) => {
		const outputPath = join(dir, 'out.webarchive')
		const { lines, io } = collectIO()
		const code = main(['convert', minimalMhtmlPath, outputPath], io)

		assert.equal(code, 0)
		assert.ok(lines.some((line) => line.includes('wrote') && line.includes('mhtml -> webarchive')))

		const original = parseMhtml(readFileSync(minimalMhtmlPath))
		const converted = parseWebArchive(readFileSync(outputPath))

		assert.deepEqual(converted.diagnostics, [])
		assert.ok(original.archive)
		assert.ok(converted.archive)
		assert.deepEqual(converted.archive, original.archive)
	})
})

test('convert turns a WebArchive fixture into an MHTML that parses back to the same archive', () => {
	withTempDir((dir) => {
		const outputPath = join(dir, 'out.mhtml')
		const { lines, io } = collectIO()
		const code = main(['convert', minimalWebArchivePath, outputPath], io)

		assert.equal(code, 0)
		assert.ok(lines.some((line) => line.includes('wrote') && line.includes('webarchive -> mhtml')))

		const original = parseWebArchive(readFileSync(minimalWebArchivePath))
		const converted = parseMhtml(readFileSync(outputPath))

		assert.deepEqual(converted.diagnostics, [])
		assert.ok(original.archive)
		assert.ok(converted.archive)
		assert.deepEqual(converted.archive, original.archive)
	})
})

test('convert round-trips MHTML -> WebArchive -> MHTML back to the same archive', () => {
	withTempDir((dir) => {
		const webArchivePath = join(dir, 'roundtrip.webarchive')
		const mhtmlPath = join(dir, 'roundtrip.mhtml')

		assert.equal(main(['convert', minimalMhtmlPath, webArchivePath], collectIO().io), 0)
		assert.equal(main(['convert', webArchivePath, mhtmlPath], collectIO().io), 0)

		const original = parseMhtml(readFileSync(minimalMhtmlPath))
		const roundTripped = parseMhtml(readFileSync(mhtmlPath))

		assert.deepEqual(roundTripped.diagnostics, [])
		assert.deepEqual(roundTripped.archive, original.archive)
	})
})

test('convert on a nonexistent input file exits with an error code', () => {
	withTempDir((dir) => {
		const { lines, io } = collectIO()
		const code = main(['convert', join(dir, 'missing.mhtml'), join(dir, 'out.webarchive')], io)

		assert.equal(code, 1)
		assert.ok(lines.some((line) => line.includes('could not read')))
	})
})
