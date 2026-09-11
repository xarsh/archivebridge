import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { ARCHIVE_FRAME_SANDBOX, EXTENSION_PAGES_CSP } from './viewer-policy.ts'

const extensionRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))))

function manifest(): Record<string, unknown> {
	return JSON.parse(readFileSync(join(extensionRoot, 'manifest.json'), 'utf8')) as Record<string, unknown>
}

function viewerHtml(): string {
	return readFileSync(join(extensionRoot, 'viewer.html'), 'utf8')
}

function directives(): ReadonlyMap<string, readonly string[]> {
	return new Map(
		EXTENSION_PAGES_CSP.split(';')
			.map((directive) => directive.trim().split(/\s+/))
			.map((tokens) => [tokens[0] ?? '', tokens.slice(1)]),
	)
}

test('the manifest ships exactly the policy this module declares', () => {
	const csp = manifest().content_security_policy as { extension_pages?: string } | undefined
	assert.equal(csp?.extension_pages, EXTENSION_PAGES_CSP, 'manifest.json and viewer-policy.ts have drifted apart')
})

test('the archive frame in viewer.html carries exactly this sandbox, and no more', () => {
	assert.match(viewerHtml(), new RegExp(`sandbox="${ARCHIVE_FRAME_SANDBOX}"`))
	// The one combination that would undo the whole isolation model.
	assert.doesNotMatch(viewerHtml(), /allow-scripts/)
})

test('the sandbox grants nothing that lets archived content act', () => {
	const granted = ARCHIVE_FRAME_SANDBOX.split(/\s+/)
	assert.deepEqual(granted, ['allow-same-origin'])
	for (const forbidden of [
		'allow-scripts',
		'allow-forms',
		'allow-modals',
		'allow-popups',
		'allow-downloads',
		'allow-top-navigation',
		'allow-top-navigation-by-user-activation',
		'allow-pointer-lock',
		'allow-presentation',
		'allow-popups-to-escape-sandbox',
	]) {
		assert.equal(granted.includes(forbidden), false, `${forbidden} must not be granted`)
	}
})

test('the policy denies by default and admits no remote or inline script', () => {
	const csp = directives()
	assert.deepEqual(csp.get('default-src'), ["'none'"])
	assert.deepEqual(csp.get('script-src'), ["'self'"])
	assert.deepEqual(csp.get('object-src'), ["'none'"])
	assert.deepEqual(csp.get('form-action'), ["'none'"])
	assert.deepEqual(csp.get('base-uri'), ["'none'"])
})

test('no fetch directive admits a network scheme, so a rewrite that missed something still cannot reach out', () => {
	for (const [directive, sources] of directives()) {
		for (const source of sources) {
			assert.doesNotMatch(source, /^(https?:|wss?:|\*)/, `${directive} admits ${source}`)
		}
	}
})

test('resource directives admit only viewer-minted and self-contained URLs', () => {
	const csp = directives()
	assert.deepEqual(csp.get('img-src'), ['blob:', 'data:'])
	assert.deepEqual(csp.get('font-src'), ['blob:', 'data:'])
	assert.deepEqual(csp.get('media-src'), ['blob:', 'data:'])
	assert.deepEqual(csp.get('frame-src'), ['blob:'])
	// Reading the local archive is the viewer's own job and the only connection it makes.
	assert.deepEqual(csp.get('connect-src'), ['file:'])
	// Archived markup must not be able to name the extension's own resources.
	for (const directive of ['img-src', 'font-src', 'media-src', 'frame-src', 'style-src']) {
		assert.equal(csp.get(directive)?.includes("'self'"), false, `${directive} must not admit 'self'`)
	}
})
