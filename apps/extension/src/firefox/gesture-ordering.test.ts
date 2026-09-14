/**
 * One invariant, guarded where no other test can reach it.
 *
 * Firefox's transient activation does not survive an `await`:
 * `browser.permissions.request()` called after one rejects immediately with
 * `permissions.request may only be called from a user input handler`
 * (measured). So both gesture handlers — the popup button's click listener
 * and `menus.onClicked` — must call it as their *first* action, before
 * anything is looked up.
 *
 * The popup's half is exercised for real by the Firefox E2E lane, which
 * clicks the production button with a synthesized pointer event and asserts
 * the permission was actually granted. **The context menu's half is not
 * reachable from any automation this project has**: Firefox's context menu
 * is native chrome UI that WebDriver BiDi does not expose, and the research
 * that measured this behaviour needed macOS `osascript` to drive it — which
 * is not something to make a CI gate.
 *
 * So it is guarded here, against the source rather than the behaviour. A
 * source-shape assertion is a weak test and is chosen deliberately over the
 * two alternatives: a fake `browser` object (which CONTRIBUTING.md rules
 * out, and which would only prove this file's idea of Firefox), or nothing
 * at all — and "nothing at all" is how a refactor that hoists one innocuous
 * `await` above the request ships a context-menu command that can never
 * acquire its permission.
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

/** The body of the callback passed to `addListener` at `start`, by brace matching — enough to isolate one handler without parsing TypeScript. */
function listenerBody(source: string, start: number): string {
	const open = source.indexOf('{', start)
	assert.notEqual(open, -1, 'no handler body found')
	let depth = 0
	for (let index = open; index < source.length; index += 1) {
		if (source[index] === '{') {
			depth += 1
		} else if (source[index] === '}') {
			depth -= 1
			if (depth === 0) {
				return source.slice(open, index + 1)
			}
		}
	}
	throw new Error('unbalanced handler body')
}

function assertRequestsPermissionBeforeAwaiting(body: string, what: string): void {
	const request = body.indexOf('permissions.request(')
	assert.notEqual(request, -1, `${what} never calls permissions.request`)
	const firstAwait = body.indexOf('await ')
	if (firstAwait !== -1) {
		assert.ok(request < firstAwait, `${what} awaits something before requesting the host permission, which spends the gesture the request needs`)
	}
}

test('the context-menu handler requests the host permission before it awaits anything', async () => {
	const source = await readFile(join(here, 'background.ts'), 'utf8')
	const listener = source.indexOf('browser.menus.onClicked.addListener(')
	assert.notEqual(listener, -1, 'background.ts no longer registers a menus.onClicked listener')
	assertRequestsPermissionBeforeAwaiting(listenerBody(source, listener), 'the menus.onClicked handler')
})

test('the popup’s click handler does the same', async () => {
	const source = await readFile(join(here, 'popup.ts'), 'utf8')
	const listener = source.indexOf("button.addEventListener('click'")
	assert.notEqual(listener, -1, 'popup.ts no longer registers a click listener')
	assertRequestsPermissionBeforeAwaiting(listenerBody(source, listener), 'the popup click handler')
})
