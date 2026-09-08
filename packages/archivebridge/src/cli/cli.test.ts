import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { main } from './cli.ts'

const fixturePath = fileURLToPath(new URL('../../../../fixtures/mhtml/minimal.mhtml', import.meta.url))

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

test('no command prints help and exits with an error code', () => {
	const { lines, io } = collectIO()
	const code = main([], io)
	assert.equal(code, 1)
	assert.ok(lines.some((line) => line.includes('Usage')))
})

test('--help prints help and exits 0', () => {
	const { lines, io } = collectIO()
	const code = main(['--help'], io)
	assert.equal(code, 0)
	assert.ok(lines.some((line) => line.includes('Usage')))
})

test('--version prints a version string and exits 0', () => {
	const { lines, io } = collectIO()
	const code = main(['--version'], io)
	assert.equal(code, 0)
	assert.equal(lines.length, 1)
	assert.match(lines[0] ?? '', /^\d+\.\d+\.\d+/)
})

test('unknown command exits with an error code', () => {
	const { io } = collectIO()
	const code = main(['frobnicate'], io)
	assert.equal(code, 1)
})

test('extract is recognized but not yet implemented', () => {
	const { lines, io } = collectIO()
	const code = main(['extract', 'a', 'b'], io)
	assert.equal(code, 1)
	assert.ok(lines.some((line) => line.includes('not implemented yet')))
})

test('inspect with no file prints usage and exits with an error code', () => {
	const { lines, io } = collectIO()
	const code = main(['inspect'], io)
	assert.equal(code, 1)
	assert.ok(lines.some((line) => line.includes('Usage')))
})

test('inspect on a nonexistent file exits with an error code', () => {
	const { lines, io } = collectIO()
	const code = main(['inspect', '/nonexistent/does-not-exist.mhtml'], io)
	assert.equal(code, 1)
	assert.ok(lines.some((line) => line.includes('could not read')))
})

test('convert with missing arguments prints usage and exits with an error code', () => {
	const { lines, io } = collectIO()
	const code = main(['convert', 'a'], io)
	assert.equal(code, 1)
	assert.ok(lines.some((line) => line.includes('Usage')))
})

test('convert to an unrecognized output extension exits with an error code', () => {
	const { lines, io } = collectIO()
	const code = main(['convert', fixturePath, join(tmpdir(), 'out.unknown')], io)
	assert.equal(code, 1)
	assert.ok(lines.some((line) => line.includes('could not determine output format')))
})
