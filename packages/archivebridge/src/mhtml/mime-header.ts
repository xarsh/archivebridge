/**
 * The small slice of MIME header syntax (RFC 2045 §5.1's `Content-Type`
 * grammar and RFC 2045 §5.1/RFC 822's `quoted-string`) that ArchiveBridge
 * actually reads and writes. Reader and writer share this module on purpose:
 * `mhtml/parse.ts` unescapes the quoted-pairs that `mhtml/serialize.ts`
 * writes, and both agree on what a syntactically valid media type is, so the
 * two cannot drift apart into a serialize -> parse round trip that loses or
 * mangles a parameter value.
 *
 * Deliberately *not* implemented here: RFC 2231/RFC 5987 parameter
 * continuations and extended (charset-tagged, non-ASCII) parameter values,
 * and RFC 2047 encoded words. ArchiveBridge writes none of them, and the
 * headers it reads from real captures don't use them; a value that would
 * need one is rejected by the writer (see `mhtml/serialize.ts`) rather than
 * half-supported here.
 */

/** RFC 2045 §5.1 `tspecials`. A `token` is any ASCII character that is not one of these, not SPACE, and not a CTL. */
const TSPECIALS = '()<>@,;:\\"/[]?='

function isTokenChar(ch: string): boolean {
	const code = ch.charCodeAt(0)
	return code > 0x20 && code < 0x7f && !TSPECIALS.includes(ch)
}

function isToken(value: string): boolean {
	if (value.length === 0) {
		return false
	}
	for (const ch of value) {
		if (!isTokenChar(ch)) {
			return false
		}
	}
	return true
}

/**
 * Whether `value` is a syntactically valid RFC 2045 media type — exactly one
 * `token "/" token`. Note that a second `/` makes the subtype a non-token, so
 * `a/b/c` is correctly rejected.
 */
export function isValidMediaType(value: string): boolean {
	const slash = value.indexOf('/')
	if (slash === -1) {
		return false
	}
	return isToken(value.slice(0, slash)) && isToken(value.slice(slash + 1))
}

/**
 * Encodes `value` as an RFC 2045 `quoted-string` parameter value, escaping
 * `"` and `\` as quoted-pairs. Every parameter is quoted, even where a bare
 * `token` would also be legal: one form for every parameter is simpler than
 * two, and a `quoted-string` is valid anywhere a `token` is. Callers are
 * responsible for having already rejected values a header field cannot carry
 * at all (CR/LF, other control characters, non-ASCII) — a `quoted-string`
 * cannot represent those either.
 */
export function quoteMimeParameter(value: string): string {
	return `"${value.replace(/[\\"]/g, '\\$&')}"`
}

/** Why a string cannot be written into a MIME header field value. */
export type HeaderValueProblem = 'line-break' | 'control-character' | 'non-ascii'

/**
 * The reason `value` cannot appear in a header field value ArchiveBridge
 * writes, or `undefined` if it can. CR/LF is checked first and reported
 * separately because it is the header-injection case, not merely a
 * conformance one (see docs/architecture.md#security-assumptions). Non-ASCII
 * is rejected because RFC 5322/2045 header field values are US-ASCII and
 * carrying anything else conformingly needs RFC 2047/2231 machinery this
 * module intentionally does not implement.
 */
export function findHeaderValueProblem(value: string): HeaderValueProblem | undefined {
	if (/[\r\n]/.test(value)) {
		return 'line-break'
	}
	for (const ch of value) {
		const code = ch.codePointAt(0) ?? 0
		if (code < 0x20 || code === 0x7f) {
			return 'control-character'
		}
		if (code > 0x7f) {
			return 'non-ascii'
		}
	}
	return undefined
}

/** Human-readable form of a {@link HeaderValueProblem}, for writer error messages. */
export function describeHeaderValueProblem(problem: HeaderValueProblem): string {
	switch (problem) {
		case 'line-break':
			return 'line break'
		case 'control-character':
			return 'control character'
		case 'non-ascii':
			return 'non-ASCII character'
	}
}

/**
 * Splits a header value on top-level `;` separators, respecting
 * `"quoted-string"` segments *and* the quoted-pairs inside them: a `\"` does
 * not end the quoted-string, so a `;` after it is still inside quotes and
 * must not split the value. Escapes are left in place; {@link parseContentType}
 * unescapes them when it unquotes a parameter value.
 *
 * Tolerant of malformed foreign input by construction: an unterminated
 * quoted-string simply swallows the rest of the value into one segment rather
 * than failing.
 */
function splitHeaderParams(value: string): string[] {
	const parts: string[] = []
	let current = ''
	let inQuotes = false

	for (let i = 0; i < value.length; i++) {
		const ch = value[i]
		if (ch === undefined) {
			break
		}
		if (inQuotes && ch === '\\' && i + 1 < value.length) {
			current += ch + value[i + 1]
			i += 1
			continue
		}
		if (ch === '"') {
			inQuotes = !inQuotes
			current += ch
			continue
		}
		if (ch === ';' && !inQuotes) {
			parts.push(current)
			current = ''
			continue
		}
		current += ch
	}
	parts.push(current)
	return parts
}

/**
 * Strips a parameter value's outer quotes and undoes its quoted-pairs, the
 * inverse of {@link quoteMimeParameter}. A value that isn't quoted at all is
 * returned unchanged.
 */
function unquoteMimeParameter(value: string): string {
	if (value.length < 2 || !value.startsWith('"') || !value.endsWith('"')) {
		return value
	}
	const inner = value.slice(1, -1)
	let out = ''
	for (let i = 0; i < inner.length; i++) {
		const ch = inner[i]
		if (ch === undefined) {
			break
		}
		if (ch === '\\' && i + 1 < inner.length) {
			out += inner[i + 1]
			i += 1
			continue
		}
		out += ch
	}
	return out
}

export interface ContentType {
	readonly type: string
	readonly params: ReadonlyMap<string, string>
}

/** Parses a `Content-Type` header value into its lowercased media type and its parameters (keys lowercased, values unquoted/unescaped). */
export function parseContentType(value: string): ContentType {
	const [typeSegment, ...paramSegments] = splitHeaderParams(value)
	const type = (typeSegment ?? '').trim().toLowerCase()
	const params = new Map<string, string>()

	for (const segment of paramSegments) {
		const eq = segment.indexOf('=')
		if (eq === -1) {
			continue
		}
		const key = segment.slice(0, eq).trim().toLowerCase()
		params.set(key, unquoteMimeParameter(segment.slice(eq + 1).trim()))
	}

	return { type, params }
}
