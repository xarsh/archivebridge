/**
 * The single narrowing point for untrusted plist-parser output.
 *
 * Every place ArchiveBridge turns a value that came out of the `plist`
 * package into something it reads named fields off goes through
 * {@link narrowPlistDict} — `webarchive/parse.ts` for `.webarchive` files and
 * `mhtml/sidecar.ts` for the metadata sidecar. One definition, because both
 * have to agree on exactly the same invariant (the same reason
 * `model/webarchive.ts` owns the reserved-key sets).
 *
 * **The invariant this establishes:** for a dictionary returned by
 * `narrowPlistDict`, ordinary property access (`dict.WebResourceURL`) can only
 * ever resolve to an *own* key of the source plist dictionary. It can never
 * resolve through a prototype.
 *
 * **Why that needs enforcing.** `plist`'s binary backend builds dictionaries
 * with plain property assignment (`dict[key] = value`), so a plist dictionary
 * carrying a key literally named `__proto__` does not get an own `__proto__`
 * property — JavaScript's legacy `__proto__` setter on `Object.prototype`
 * intercepts the assignment and *replaces that dictionary object's prototype*
 * instead. Reading fields with ordinary property access would then inherit
 * them from an attacker-supplied object, so a crafted `.webarchive` could
 * make a resource dictionary that owns no `WebResourceURL` at all report an
 * attacker-chosen URL, with no diagnostic. (Confirmed against the installed
 * `plist`: the binary backend has no guard; its XML backend rejects a
 * `__proto__` key outright, so only binary plists can reach this.) This is
 * not `Object.prototype` pollution — nothing outside the one dictionary is
 * affected — but archive files are untrusted input and a parser that reports
 * fabricated fields as valid is an integrity bug regardless. See
 * docs/architecture.md#security-assumptions.
 *
 * **Two-part policy, because normalizing alone would hide the evidence.** An
 * own-key copy on its own would stop the spoofing, but it would also make a
 * dictionary whose prototype was tampered with look indistinguishable from an
 * ordinary one — silently discarding the only trace that the input carried a
 * `__proto__` key. So a specialized prototype is *reported* as a problem and
 * the dictionary is treated as malformed by the caller's existing
 * diagnostic/recovery policy; only dictionaries with the ordinary prototype
 * are accepted, and those are copied onto a null-prototype object so
 * downstream field access has nothing to inherit through.
 *
 * Accepting exactly `Object.prototype` is an observed property of the
 * installed `plist`, not an assumption: dictionaries parsed from binary *and*
 * XML plists both have `Object.prototype`, at every nesting depth, and no
 * supported path returns a null-prototype dictionary (even feeding
 * `buildBinary` a null-prototype object round-trips back to
 * `Object.prototype`). If that ever changes, this is the one place to widen.
 *
 * **What cannot be preserved, stated honestly.** A literal `__proto__` plist
 * key is consumed by JavaScript prototype semantics inside the dependency,
 * before ArchiveBridge sees the object, so by then it is not an own key of
 * anything and there is nothing left to round-trip. ArchiveBridge therefore
 * does *not* claim to preserve it as unknown `extra` — such a dictionary is
 * malformed input instead. Ordinary unknown keys are unaffected and are
 * preserved exactly as before. (A `__proto__` whose plist value is neither an
 * object nor null — a string, say — makes the assignment a silent no-op in
 * the dependency, leaving the prototype ordinary and the key simply gone;
 * that case is indistinguishable from the key never having been there, by
 * anything downstream of the parser.) Should a future `plist` keep
 * `__proto__` as a real own key, the copy below carries it straight through
 * into `extra` with no further change here — assigning it onto a
 * null-prototype target is an ordinary property write, since the interfering
 * setter lives on `Object.prototype`.
 */

/** A plist dictionary narrowed for field access: own keys only, no prototype to inherit through. */
export type PlistDict = Record<string, unknown>

/** Why a value cannot be used as a plist dictionary. */
export type PlistDictProblem = 'not-a-dictionary' | 'unexpected-prototype'

export type PlistDictResult = { readonly kind: 'ok'; readonly dict: PlistDict } | { readonly kind: 'error'; readonly problem: PlistDictProblem }

/**
 * Narrows an untrusted plist value to a {@link PlistDict}, or reports why it
 * isn't one. See the module doc comment for the invariant and the reasoning.
 */
export function narrowPlistDict(value: unknown): PlistDictResult {
	// `Uint8Array`/`Date` are plist value types of their own (`Data`, `Date`), not
	// dictionaries, and arrays are the `Array` type — none may stand in for a dict.
	if (typeof value !== 'object' || value === null || Array.isArray(value) || value instanceof Uint8Array || value instanceof Date) {
		return { kind: 'error', problem: 'not-a-dictionary' }
	}
	if (Object.getPrototypeOf(value) !== Object.prototype) {
		return { kind: 'error', problem: 'unexpected-prototype' }
	}

	const dict: PlistDict = Object.create(null)
	for (const [key, entry] of Object.entries(value)) {
		dict[key] = entry
	}
	return { kind: 'ok', dict }
}

/** Human-readable form of a {@link PlistDictProblem}, for diagnostic messages. */
export function describePlistDictProblem(problem: PlistDictProblem): string {
	switch (problem) {
		case 'not-a-dictionary':
			return 'is not a dictionary'
		case 'unexpected-prototype':
			return 'is a dictionary whose prototype was replaced, which a "__proto__" plist key does'
	}
}

/** {@link narrowPlistDict} for callers that only need "usable or not" — i.e. that report one message however the narrowing failed. */
export function asPlistDict(value: unknown): PlistDict | undefined {
	const result = narrowPlistDict(value)
	return result.kind === 'ok' ? result.dict : undefined
}
