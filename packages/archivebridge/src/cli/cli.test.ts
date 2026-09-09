import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
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

/** Like {@link collectIO}, but keeps the two streams apart so a test can assert *which* one text went to. */
function collectStreams() {
	const out: string[] = []
	const err: string[] = []
	return {
		out,
		err,
		io: {
			stdout: (line: string) => out.push(line),
			stderr: (line: string) => err.push(line),
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

// Stream choice follows the exit code (cli.ts's `main`): requested help is
// output, help printed because the invocation was wrong is an error report. A
// caller redirecting stdout to a file must not find usage text in it.
test('help requested with --help goes to stdout, leaving stderr empty', () => {
	const { out, err, io } = collectStreams()
	const code = main(['--help'], io)
	assert.equal(code, 0)
	assert.deepEqual(err, [])
	assert.ok(out.some((line) => line.includes('Usage')))
})

test('help printed because no command was given goes to stderr, leaving stdout empty', () => {
	const { out, err, io } = collectStreams()
	const code = main([], io)
	assert.equal(code, 1)
	assert.deepEqual(out, [])
	assert.ok(err.some((line) => line.includes('Usage')))
})

test('an unknown command reports the error and the help text on stderr, leaving stdout empty', () => {
	const { out, err, io } = collectStreams()
	const code = main(['frobnicate'], io)
	assert.equal(code, 1)
	assert.deepEqual(out, [])
	assert.ok(
		err.some((line) => line.includes("unknown command 'frobnicate'")),
		'expected the unknown command to be named on stderr',
	)
	assert.ok(
		err.some((line) => line.includes('Usage')),
		'expected the help text on stderr too, not stdout',
	)
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

test('convert reports a clean error, not an unhandled exception, when the parsed archive cannot be serialized conformingly', () => {
	// The parser is tolerant of duplicate Content-IDs (it diagnoses them and keeps
	// both parts); the serializer refuses to write that back out. So a real foreign
	// archive can be parseable and unserializable at once, and the CLI has to report
	// that as an ordinary failure.
	const duplicateContentIds = [
		'MIME-Version: 1.0',
		'Content-Type: multipart/related; boundary="B"',
		'',
		'--B',
		'Content-Type: text/html',
		'Content-ID: <shared@example.invalid>',
		'Content-Location: https://example.invalid/',
		'',
		'main document',
		'--B',
		'Content-Type: text/css',
		'Content-ID: <shared@example.invalid>',
		'Content-Location: https://example.invalid/style.css',
		'',
		'body { color: red; }',
		'--B--',
		'',
	].join('\r\n')

	const input = join(mkdtempSync(join(tmpdir(), 'archivebridge-cli-')), 'duplicate-content-ids.mhtml')
	writeFileSync(input, duplicateContentIds)

	const { lines, io } = collectIO()
	const code = main(['convert', input, join(tmpdir(), 'out.mhtml')], io)
	assert.equal(code, 1)
	assert.ok(
		lines.some((line) => line.includes('could not convert') && line.includes('same Content-ID')),
		`expected a clean conversion error, got: ${lines.join(' | ')}`,
	)
})
