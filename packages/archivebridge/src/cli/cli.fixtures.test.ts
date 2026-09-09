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
const framesNestedMhtmlPath = fileURLToPath(new URL('mhtml/frames-nested.chrome.mhtml', fixturesUrl))
const framesNestedWebArchivePath = fileURLToPath(new URL('webarchive/frames-nested.safari.webarchive', fixturesUrl))

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

test('inspect shows real frame relationships for a multi-frame MHTML fixture instead of an always-empty Frames (0):', () => {
	const { lines, io } = collectIO()
	const code = main(['inspect', framesNestedMhtmlPath], io)
	const output = lines.join('\n')

	assert.equal(code, 0)
	assert.match(output, /Format: mhtml/)
	// root -> mid -> leaf: two non-empty "Frames (1):" sections, nested.
	assert.equal([...output.matchAll(/Frames \(1\):/g)].length, 2)
	assert.match(output, /Main URL: http:\/\/127\.0\.0\.1:8091\/iframe-nested\/mid\.html/)
	assert.match(output, /Main URL: http:\/\/127\.0\.0\.1:8091\/iframe-nested\/leaf\.html/)
	assert.match(output, /Diagnostics \(0\):/)
})

test('inspect shows real frame relationships for a multi-frame WebArchive fixture converted to canonical MHTML', () => {
	const { lines, io } = collectIO()
	const code = main(['inspect', framesNestedWebArchivePath], io)
	const output = lines.join('\n')

	assert.equal(code, 0)
	assert.match(output, /Format: webarchive/)
	assert.equal([...output.matchAll(/Frames \(1\):/g)].length, 2)
	assert.match(output, /Metadata sidecar: present/)
})

test('convert turns a multi-frame WebArchive fixture into MHTML with a real cid: link, round-tripping back to the same frame shape', () => {
	withTempDir((dir) => {
		const outputPath = join(dir, 'frames.mhtml')
		const code = main(['convert', framesNestedWebArchivePath, outputPath], collectIO().io)
		assert.equal(code, 0)

		const converted = parseMhtml(readFileSync(outputPath))
		// root and its level2 child each independently fetch the same-URL stylesheet (confirmed
		// real WebKit behavior, no cross-frame dedup — see fixtures/README.md's frame fixture
		// provenance notes); flattened into MHTML that's a genuine, expected duplicate-content-location.
		assert.deepEqual(converted.diagnostics, [{ type: 'duplicate-content-location', url: 'http://127.0.0.1:8091/style.css' }])
		assert.ok(converted.document)
		assert.equal(converted.document.parts.length, 6) // root + its stylesheet + level2 + level2's stylesheet + level3 + the metadata sidecar
		assert.ok(converted.document.parts.some((part) => part.mimeType === 'application/vnd.archivebridge.metadata'))
	})
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

test('convert turns an MHTML fixture into a WebArchive that parses back to the same document', () => {
	withTempDir((dir) => {
		const outputPath = join(dir, 'out.webarchive')
		const { lines, io } = collectIO()
		const code = main(['convert', minimalMhtmlPath, outputPath], io)

		assert.equal(code, 0)
		assert.ok(lines.some((line) => line.includes('wrote') && line.includes('mhtml -> webarchive')))

		const original = parseMhtml(readFileSync(minimalMhtmlPath))
		const converted = parseWebArchive(readFileSync(outputPath))

		assert.deepEqual(converted.diagnostics, [])
		assert.ok(original.document)
		assert.ok(converted.document)
		assert.equal(converted.document.mainResource.url, original.document.parts[original.document.rootPartIndex]?.location)
	})
})

test('convert turns a WebArchive fixture into an MHTML that parses back to the same document', () => {
	withTempDir((dir) => {
		const outputPath = join(dir, 'out.mhtml')
		const { lines, io } = collectIO()
		const code = main(['convert', minimalWebArchivePath, outputPath], io)

		assert.equal(code, 0)
		assert.ok(lines.some((line) => line.includes('wrote') && line.includes('webarchive -> mhtml')))

		const original = parseWebArchive(readFileSync(minimalWebArchivePath))
		const converted = parseMhtml(readFileSync(outputPath))

		assert.deepEqual(converted.diagnostics, [])
		assert.ok(original.document)
		assert.ok(converted.document)
		assert.equal(converted.document.parts[converted.document.rootPartIndex]?.location, original.document.mainResource.url)
	})
})

test('convert round-trips MHTML -> WebArchive -> MHTML back to the same document', () => {
	withTempDir((dir) => {
		const webArchivePath = join(dir, 'roundtrip.webarchive')
		const mhtmlPath = join(dir, 'roundtrip.mhtml')

		assert.equal(main(['convert', minimalMhtmlPath, webArchivePath], collectIO().io), 0)
		assert.equal(main(['convert', webArchivePath, mhtmlPath], collectIO().io), 0)

		const original = parseMhtml(readFileSync(minimalMhtmlPath))
		const roundTripped = parseMhtml(readFileSync(mhtmlPath))

		assert.deepEqual(roundTripped.diagnostics, [])
		assert.ok(original.document)
		assert.ok(roundTripped.document)
		assert.equal(roundTripped.document.parts[roundTripped.document.rootPartIndex]?.location, original.document.parts[original.document.rootPartIndex]?.location)
		assert.deepEqual(roundTripped.document.parts[roundTripped.document.rootPartIndex]?.data, original.document.parts[original.document.rootPartIndex]?.data)
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
