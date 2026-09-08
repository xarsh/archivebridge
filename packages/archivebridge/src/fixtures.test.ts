import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { detectArchiveFormatFromBytes } from './format/detect.ts'

const fixturesUrl = new URL('../../../fixtures/', import.meta.url)

test('fixtures/mhtml/minimal.mhtml is detected as mhtml', () => {
	const path = fileURLToPath(new URL('mhtml/minimal.mhtml', fixturesUrl))
	const bytes = readFileSync(path)
	assert.ok(bytes.length > 0)
	assert.equal(detectArchiveFormatFromBytes(bytes), 'mhtml')
})

test('fixtures/webarchive/minimal.webarchive is detected as webarchive', () => {
	const path = fileURLToPath(new URL('webarchive/minimal.webarchive', fixturesUrl))
	const bytes = readFileSync(path)
	assert.ok(bytes.length > 0)
	assert.equal(detectArchiveFormatFromBytes(bytes), 'webarchive')
})
