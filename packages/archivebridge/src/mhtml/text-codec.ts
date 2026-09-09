/**
 * Text encode/decode for a resource's declared `textEncoding`, used
 * wherever HTML content has to be decoded to a string, edited (frame `src`
 * rewriting), and turned back into bytes without losing the original
 * charset semantics.
 *
 * The platform's own `TextEncoder` can only ever produce UTF-8 — it has no
 * encoding parameter at all, unlike `TextDecoder`, which (via the WHATWG
 * Encoding Standard Node implements) already decodes a wide range of
 * legacy encodings (`windows-1252`, `iso-8859-1`, `shift_jis`, ...). That
 * asymmetry is exactly the problem this module exists to solve: naively
 * decoding non-UTF-8 HTML, editing it, and re-encoding with `TextEncoder`
 * silently changes both the resource's bytes *and* its declared
 * `textEncoding` to UTF-8 on every rewrite — a real semantic change (not
 * merely a non-semantic re-encoding) for any resource whose original
 * encoding wasn't already UTF-8, and one docs/architecture.md's "Semantic
 * losslessness" goal does not allow.
 *
 * `iconv-lite` is the dependency this module adds to close that gap: it
 * both decodes *and* encodes a broad range of legacy encodings using the
 * same codec tables, so a decode-edit-encode round trip through one
 * `TextCodec` stays internally consistent (unlike decoding via
 * `TextDecoder` and then trying to encode via some unrelated encoder for
 * the "same" label, which risks subtle mismatches between two different
 * implementations' notion of what a label like `shift_jis` even means).
 * There is no standard Node/Web API that can encode into a legacy
 * single-/double-byte charset at all — `TextEncoder` is UTF-8-only by
 * spec, and Node has no built-in general-purpose charset encoder — so this
 * is a real gap a standard API cannot fill, matching CONTRIBUTING.md's
 * dependency-policy bar ("something Node.js standard APIs cannot
 * reasonably do"). `iconv-lite` is a pure-JS, widely-used implementation
 * (used by Node core's own historical `request`/`iconv` ecosystem
 * tooling) with no native bindings to build, matching the same
 * battle-tested-over-hand-rolled rationale already applied to `plist` and
 * `parse5` in this project's dependency policy.
 */

import * as iconv from 'iconv-lite'

export interface TextCodec {
	/** Decodes `bytes` as this codec's encoding. Always succeeds (leniently, matching `TextDecoder`'s `fatal: false` stance elsewhere in this project) — decoding is not the risky direction; see the module doc comment. */
	readonly decode: (bytes: Uint8Array) => string
	/**
	 * Encodes `text` back into bytes in this codec's encoding.
	 * Returns `undefined` — never throws — when the encoding cannot
	 * faithfully represent `text` (an unmappable character would be
	 * silently replaced) or isn't supported at all: callers must treat
	 * `undefined` as "do not perform a destructive, lossy conversion,"
	 * not as license to fall back to UTF-8 (which is exactly the
	 * silent-charset-change bug this module exists to avoid).
	 */
	readonly encode: (text: string) => Uint8Array | undefined
}

function isUtf8Label(label: string): boolean {
	const normalized = label.trim().toLowerCase()
	return normalized === 'utf-8' || normalized === 'utf8'
}

const UTF8_CODEC: TextCodec = {
	decode: (bytes) => new TextDecoder('utf-8', { fatal: false }).decode(bytes),
	encode: (text) => new TextEncoder().encode(text),
}

/** A decode-only fallback for a `textEncoding` label neither the platform `TextDecoder` nor `iconv-lite` recognizes: still decodes leniently (best-effort, never throws), but never claims to be able to encode — see {@link TextCodec.encode}'s doc comment. */
function bestEffortDecodeOnlyCodec(label: string): TextCodec {
	return {
		decode: (bytes) => {
			try {
				return new TextDecoder(label, { fatal: false }).decode(bytes)
			} catch {
				return new TextDecoder('utf-8', { fatal: false }).decode(bytes)
			}
		},
		encode: () => undefined,
	}
}

/**
 * Resolves `label` to its canonical name under the WHATWG Encoding
 * Standard — the same resolution a browser performs for `<meta charset>`,
 * `TextDecoder`, `fetch`, etc. — using the platform `TextDecoder`
 * constructor itself as the source of truth (`new
 * TextDecoder(label).encoding`) rather than re-deriving an alias table by
 * hand. This matters because a label is not always its own canonical
 * encoding: per the standard, `iso-8859-1` (and aliases like `latin1`,
 * `cp819`, `l1`, ...) canonicalize to **`windows-1252`**, which disagrees
 * with `iso-8859-1` for byte values 0x80-0x9F (control characters in true
 * ISO-8859-1, printable characters — e.g. `€` at 0x80 — in windows-1252).
 * Passing a label straight to `iconv-lite` without this step would decode/
 * encode those bytes using literal ISO-8859-1 semantics, silently
 * disagreeing with what a real browser (or this project's own `<meta
 * charset>`-driven expectations) would have done with the same label.
 * Returns `undefined` for a label the Encoding Standard doesn't recognize
 * at all — not itself an error, callers fall back to this module's
 * existing tolerant-unknown-label handling ({@link bestEffortDecodeOnlyCodec})
 * rather than guessing at a canonicalization for it.
 */
function canonicalEncodingLabel(label: string): string | undefined {
	try {
		return new TextDecoder(label).encoding
	} catch {
		return undefined
	}
}

/**
 * Returns the {@link TextCodec} for `encodingLabel` (an MHTML/WebArchive
 * `textEncoding` value; `undefined` means UTF-8, this project's default).
 * Never throws.
 *
 * Canonicalization ({@link canonicalEncodingLabel}) is applied only when
 * `TextDecoder` actually recognizes `label` as a WHATWG Encoding Standard
 * name — i.e. only when there is a real canonical-vs-literal distinction to
 * resolve (`iso-8859-1` -> `windows-1252` being the motivating case). A
 * label `iconv-lite` recognizes but the Encoding Standard doesn't define at
 * all (e.g. `ucs2`, `CP932` — real values this module supported before
 * canonicalization was added) is looked up in `iconv-lite` **by its own
 * literal spelling**, not discarded just because `TextDecoder` doesn't know
 * it: gating iconv-lite lookup on `TextDecoder` recognizing the label first
 * would silently narrow this module's encoding coverage to the Encoding
 * Standard's label set, regressing every iconv-only alias.
 */
export function textCodecFor(encodingLabel: string | undefined): TextCodec {
	const label = encodingLabel ?? 'utf-8'
	if (isUtf8Label(label)) {
		return UTF8_CODEC
	}
	const canonical = canonicalEncodingLabel(label)
	if (canonical !== undefined && isUtf8Label(canonical)) {
		return UTF8_CODEC
	}
	const iconvLabel = canonical ?? label
	if (!iconv.encodingExists(iconvLabel)) {
		if (canonical === undefined) {
			// Neither the Encoding Standard nor iconv-lite recognizes this label at all.
			return bestEffortDecodeOnlyCodec(label)
		}
		// A real Web Encoding Standard label, but not one iconv-lite has an encode-capable
		// codec table for: decode using the canonical Web semantics, but never claim to encode.
		return {
			decode: (bytes) => new TextDecoder(canonical, { fatal: false }).decode(bytes),
			encode: () => undefined,
		}
	}
	return {
		decode: (bytes) => iconv.decode(bytes, iconvLabel),
		encode: (text) => {
			const encoded = iconv.encode(text, iconvLabel)
			// Verify the encode is lossless for this exact text: iconv-lite silently
			// substitutes a replacement character for anything the target charset
			// can't represent rather than throwing, so a mismatched round trip is the
			// only signal that this particular string can't be encoded faithfully.
			if (iconv.decode(encoded, iconvLabel) !== text) {
				return undefined
			}
			return new Uint8Array(encoded.buffer, encoded.byteOffset, encoded.byteLength)
		},
	}
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) {
		return false
	}
	for (let i = 0; i < a.length; i += 1) {
		if (a[i] !== b[i]) {
			return false
		}
	}
	return true
}

/**
 * True when `codec` can decode `originalBytes` and re-encode the resulting
 * string back to the exact same bytes — i.e. a decode-edit-encode round
 * trip through this codec is safe to perform on *this specific input*
 * without silently normalizing any byte an edit didn't actually touch.
 * `TextCodec.encode`'s own round-trip check (in {@link textCodecFor})
 * only proves the *edited* text can be encoded faithfully; it says nothing
 * about whether the *unedited original bytes* survive a decode→encode
 * round trip unchanged. They don't, for at least: a leading BOM (stripped
 * on decode, never re-added on encode), and any malformed/tolerantly-
 * decoded byte sequence (replaced by U+FFFD on decode, which re-encodes to
 * a *different* byte sequence than whatever malformed bytes were
 * originally there). Callers must treat `false` as "refuse this
 * destructive rewrite, keep the original bytes, diagnose instead" — never
 * as license to normalize the whole resource to whatever bytes decode→
 * encode happens to produce. See docs/architecture.md, "Semantic
 * losslessness".
 */
export function isSafelyReencodable(codec: TextCodec, originalBytes: Uint8Array): boolean {
	const decoded = codec.decode(originalBytes)
	const reencoded = codec.encode(decoded)
	return reencoded !== undefined && bytesEqual(reencoded, originalBytes)
}
