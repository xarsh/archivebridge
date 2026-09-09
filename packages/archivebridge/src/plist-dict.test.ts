/**
 * Unit tests for the plist-dictionary trust boundary. The end-to-end,
 * real-bytes coverage lives with the two consumers (`webarchive/parse.test.ts`
 * and `mhtml/sidecar.test.ts`), which is what actually exercises the
 * dependency's `__proto__` behavior; these tests pin the narrowing rule
 * itself. See `plist-dict.ts`'s module doc comment.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { buildBinary, build as buildXmlPlist, parseBinary, parse as parseXmlPlist } from 'plist'
import { asPlistDict, describePlistDictProblem, narrowPlistDict } from './plist-dict.ts'

/**
 * Round-trips a plist dictionary carrying a key literally named `__proto__`
 * through real serialized binary-plist bytes, returning whatever the
 * dependency's parser produced for it.
 *
 * Going through the bytes matters: the whole hazard is what `plist`'s binary
 * backend does with that key on the way back in, so a hand-built JavaScript
 * object would test the wrong thing. Building the input needs
 * `Object.defineProperty` because an object *literal* cannot express the key
 * at all — `{ __proto__: x }` is prototype-setting syntax, not a key — which
 * is precisely why the hazard exists in the first place.
 */
function parsePoisonedBinaryPlist(protoValue: unknown, ownKeys: Record<string, unknown> = {}): unknown {
	const object: Record<string, unknown> = {}
	Object.defineProperty(object, '__proto__', { value: protoValue, enumerable: true, writable: true, configurable: true })
	Object.assign(object, ownKeys)
	// biome-ignore lint/suspicious/noExplicitAny: buildBinary's parameter type cannot express an own `__proto__` key, which is exactly what these tests supply.
	return parseBinary(buildBinary(object as any))
}

test('narrowPlistDict accepts a dictionary parsed from a normal binary plist, at every nesting depth', () => {
	const parsed = parseBinary(buildBinary({ A: 'a', Nested: { B: 1 }, Arr: [{ C: true }] })) as Record<string, unknown>

	const root = narrowPlistDict(parsed)
	assert.equal(root.kind, 'ok')
	assert.equal(narrowPlistDict(root.kind === 'ok' ? root.dict.Nested : undefined).kind, 'ok')
	assert.equal(narrowPlistDict((parsed.Arr as unknown[])[0]).kind, 'ok')
})

test('narrowPlistDict accepts a dictionary parsed from a normal XML plist, at every nesting depth', () => {
	const parsed = parseXmlPlist(buildXmlPlist({ A: 'a', Nested: { B: 1 }, Arr: [{ C: true }] })) as Record<string, unknown>

	const root = narrowPlistDict(parsed)
	assert.equal(root.kind, 'ok')
	assert.equal(narrowPlistDict(root.kind === 'ok' ? root.dict.Nested : undefined).kind, 'ok')
	assert.equal(narrowPlistDict((parsed.Arr as unknown[])[0]).kind, 'ok')
})

test('narrowPlistDict preserves every own key and its value, in order', () => {
	const result = narrowPlistDict({ A: 'a', B: 2, C: new Uint8Array([1, 2]) })
	assert.equal(result.kind, 'ok')
	assert.ok(result.kind === 'ok')

	assert.deepEqual(Object.keys(result.dict), ['A', 'B', 'C'])
	assert.equal(result.dict.A, 'a')
	assert.equal(result.dict.B, 2)
	assert.deepEqual(result.dict.C, new Uint8Array([1, 2]))
})

test('narrowPlistDict returns a null-prototype dictionary, so field access cannot resolve through any prototype', () => {
	const result = narrowPlistDict({ A: 'a' })
	assert.ok(result.kind === 'ok')

	assert.equal(Object.getPrototypeOf(result.dict), null)
	// Nothing inherited from Object.prototype leaks in as a would-be plist field.
	assert.equal(result.dict.toString, undefined)
	assert.equal(result.dict.constructor, undefined)
})

test('narrowPlistDict copies rather than aliasing, so later mutation of the source cannot change a narrowed dictionary', () => {
	const source: Record<string, unknown> = { A: 'a' }
	const result = narrowPlistDict(source)
	assert.ok(result.kind === 'ok')

	source.A = 'mutated'
	source.B = 'added'
	assert.equal(result.dict.A, 'a')
	assert.equal(result.dict.B, undefined)
})

test('narrowPlistDict rejects a dictionary whose prototype was replaced by a __proto__ plist key', () => {
	// The dependency's binary backend turns the `__proto__` key into a prototype
	// replacement before ArchiveBridge sees the object; this is that end state.
	const poisoned = parsePoisonedBinaryPlist({ WebResourceURL: 'https://injected.invalid/' }, { Real: 'real' })

	assert.deepEqual(narrowPlistDict(poisoned), { kind: 'error', problem: 'unexpected-prototype' })
	assert.equal(asPlistDict(poisoned), undefined)
})

test('narrowPlistDict rejects a null-prototype dictionary, which a __proto__ plist key whose value is null produces', () => {
	const nullProto = parsePoisonedBinaryPlist(null, { Real: 'real' })

	assert.equal(Object.getPrototypeOf(nullProto), null, 'the dependency must really produce a null prototype for this to be testing anything')
	assert.deepEqual(narrowPlistDict(nullProto), { kind: 'error', problem: 'unexpected-prototype' })
})

test('narrowPlistDict rejects a dictionary whose prototype was replaced by an array, which inherits length and indices', () => {
	const arrayProto = parsePoisonedBinaryPlist([1, 2], { Real: 'real' })

	assert.deepEqual(narrowPlistDict(arrayProto), { kind: 'error', problem: 'unexpected-prototype' })
})

test('narrowPlistDict rejects every plist value that is not a dictionary', () => {
	for (const value of ['a string', 42, true, null, undefined, [1, 2], new Uint8Array([1]), new Date(0)]) {
		assert.deepEqual(narrowPlistDict(value), { kind: 'error', problem: 'not-a-dictionary' }, `${String(value)} must not narrow to a dictionary`)
	}
})

test('describePlistDictProblem names both problems distinguishably', () => {
	assert.equal(describePlistDictProblem('not-a-dictionary'), 'is not a dictionary')
	assert.match(describePlistDictProblem('unexpected-prototype'), /__proto__/)
})

test('a __proto__ plist key whose value is neither an object nor null leaves no trace the parser could report', () => {
	// Documented limitation, asserted so it stays a known property rather than a
	// surprise: the dependency's assignment is a silent no-op for such a value, so
	// the dictionary arrives with an ordinary prototype and the key simply gone.
	// Nothing downstream of the parser can tell this from the key never existing —
	// see `plist-dict.ts`'s "What cannot be preserved, stated honestly".
	const parsed = parsePoisonedBinaryPlist('not-an-object', { Real: 'real' })

	assert.equal(Object.getPrototypeOf(parsed), Object.prototype)
	const result = narrowPlistDict(parsed)
	assert.ok(result.kind === 'ok')
	assert.deepEqual(Object.keys(result.dict), ['Real'])
})
