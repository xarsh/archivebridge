import assert from 'node:assert/strict'
import test from 'node:test'
import { describeViewerFailure, readViewerSource } from './viewer-source.ts'

const VIEWER = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/viewer.html'

test('reads a local .webarchive out of the viewer URL fragment', () => {
	assert.deepEqual(readViewerSource(`${VIEWER}#file:///home/u/page.webarchive`), { kind: 'archive', url: 'file:///home/u/page.webarchive', displayName: 'page.webarchive' })
})

test('keeps the fragment exactly as written, and decodes only the display name', () => {
	// Chromium percent-encodes `#`, `?`, `%` and space in a file URL; decoding
	// before reading would name a different file, or no file at all.
	const source = readViewerSource(`${VIEWER}#file:///tmp/weird%20%23%3F&%25=+%20name.webarchive`)
	assert.equal(source.kind, 'archive')
	assert.equal(source.kind === 'archive' ? source.url : '', 'file:///tmp/weird%20%23%3F&%25=+%20name.webarchive')
	assert.equal(source.kind === 'archive' ? source.displayName : '', 'weird #?&%=+ name.webarchive')
})

test('a name containing query-like characters is not split on them', () => {
	const source = readViewerSource(`${VIEWER}#file:///tmp/a&b=c+d.webarchive`)
	assert.equal(source.kind === 'archive' ? source.url : '', 'file:///tmp/a&b=c+d.webarchive')
})

test('matches the extension case-insensitively', () => {
	assert.equal(readViewerSource(`${VIEWER}#file:///tmp/A.WEBARCHIVE`).kind, 'archive')
	assert.equal(readViewerSource(`${VIEWER}#file:///tmp/A.WebArchive`).kind, 'archive')
})

test('an undecodable display name degrades to the raw segment rather than failing', () => {
	const source = readViewerSource(`${VIEWER}#file:///tmp/%E0%A4%A.webarchive`)
	assert.equal(source.kind === 'archive' ? source.displayName : '', '%E0%A4%A.webarchive')
})

test('no fragment at all means no archive was named', () => {
	assert.deepEqual(readViewerSource(VIEWER), { kind: 'absent' })
	assert.deepEqual(readViewerSource(`${VIEWER}#`), { kind: 'absent' })
	assert.deepEqual(readViewerSource('not a url'), { kind: 'absent' })
})

test('rejects every source that is not a local .webarchive', () => {
	const rejected = [
		'https://evil.example/x.webarchive',
		'file:///tmp/notes.txt',
		'file:///tmp/page.mhtml',
		'file:///tmp/page.webarchive.txt',
		'file://remote-host/share/page.webarchive',
		'chrome-extension://abcdefghijklmnopabcdefghijklmnop/viewer.html',
		'javascript:alert(1)',
		'data:text/html,<script>x()</script>',
		'/tmp/page.webarchive',
		'file:///tmp/',
	]
	for (const value of rejected) {
		// Only the verdict is asserted here: the URL parser percent-encodes some
		// of these on the way into the fragment, and how a refused value is spelt
		// back is the next test's business.
		assert.equal(readViewerSource(`${VIEWER}#${value}`).kind, 'rejected', `expected ${value} to be rejected`)
	}
})

test('a rejected value is reported verbatim, so the message can show what was asked for', () => {
	const message = describeViewerFailure({ kind: 'rejected-source', value: 'https://evil.example/x.webarchive' })
	assert.match(message.detail, /https:\/\/evil\.example\/x\.webarchive/)
})

test('every failure has a title and a detail, and none of them names a browser', () => {
	const failures = [
		{ kind: 'absent-source' },
		{ kind: 'rejected-source', value: 'x' },
		{ kind: 'file-access-denied' },
		{ kind: 'unreadable', detail: 'no such file' },
		{ kind: 'unrecognized-format' },
		{ kind: 'unparseable', detail: 'malformed-archive' },
		{ kind: 'no-document', detail: 'not HTML' },
	] as const
	for (const failure of failures) {
		const message = describeViewerFailure(failure)
		assert.ok(message.title.length > 0 && message.detail.length > 0, `empty message for ${failure.kind}`)
		// The Chrome-specific instruction belongs to the Chrome layer, not here.
		assert.doesNotMatch(`${message.title} ${message.detail}`, /chrome|firefox|safari/i)
	}
})
