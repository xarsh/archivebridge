/**
 * Regression for two BiDi restrictions this harness works around or is
 * blocked by (see `bidi-session.ts`'s module doc): the Firefox 153+
 * system-access gate on navigating to a `moz-extension:` page
 * (`explainNavigateFailure`), and the Firefox 155+ refusal of
 * `input.performActions` on one at all (`explainClickFailure`). Without
 * these, every test that opens or clicks an extension page would fail with
 * the same unexplained BiDi error. This needs no Firefox: it is a unit test
 * of the message rewrites alone.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { explainClickFailure, explainNavigateFailure } from './bidi-session.ts'

test('explainNavigateFailure names the required launch flag for a moz-extension: navigation Firefox rejected', () => {
	const rejected = new Error('BiDi error: unsupported operation: Navigation to "moz-extension://abc/popup.html" is not allowed in this context')
	const explained = explainNavigateFailure('moz-extension://abc/popup.html', rejected)
	assert.match(explained.message, /--remote-allow-system-access/)
	assert.match(explained.message, /unsupported operation/, 'the original BiDi error must still be present, not replaced')
})

test('explainNavigateFailure leaves a non-system-access error on a moz-extension: URL untouched', () => {
	const timeout = new Error('BiDi timed out waiting for browsingContext.navigate')
	assert.equal(explainNavigateFailure('moz-extension://abc/popup.html', timeout), timeout)
})

test('explainNavigateFailure leaves the same rejection message untouched for an ordinary web page', () => {
	// The rejection this harness works around is specific to moz-extension:
	// destinations; an ordinary page hitting a differently-caused "not
	// allowed in this context" must not be misattributed to the same fix.
	const rejected = new Error('BiDi error: unsupported operation: Navigation to "https://example.com/" is not allowed in this context')
	assert.equal(explainNavigateFailure('https://example.com/', rejected), rejected)
})

test('explainClickFailure names the Firefox 155+ restriction for input.performActions on a privileged context', () => {
	const rejected = new Error('BiDi error: unsupported operation: The command does not support browsing contexts in privileged scope')
	const explained = explainClickFailure('abc-context', rejected)
	assert.match(explained.message, /input\.performActions/)
	assert.match(explained.message, /privileged scope/, 'the original BiDi error must still be present, not replaced')
})

test('explainClickFailure leaves an unrelated error untouched', () => {
	const timeout = new Error('BiDi timed out waiting for input.performActions')
	assert.equal(explainClickFailure('abc-context', timeout), timeout)
})
