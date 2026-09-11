/**
 * Rewrites the resource references inside a CSS stylesheet — `url(...)`
 * tokens, `@import` targets, and URL-bearing string arguments in
 * `image-set()`-style functions — leaving every other byte of the sheet
 * untouched.
 *
 * **Why a hand-written scanner and not a CSS parser.** The viewer needs
 * exactly two things from a stylesheet: where each URL-bearing token or
 * string starts and ends, and what kind of reference it is. It never needs
 * the cascade, selectors, specificity, at-rule nesting, or a
 * re-serializable tree — the browser's own CSS engine does all of that
 * with the rewritten text. A full CSS parser (`postcss`, `css-tree`,
 * `lightningcss`) would be a new runtime dependency an order of magnitude
 * larger than the problem, and CONTRIBUTING.md's dependency policy asks
 * for a concrete reason before any of them. There isn't one here:
 * URL-reference boundaries are a *tokenizer*-level question, and CSS
 * tokenization is small and fully specified — CSS Syntax Level 3 §4.3.
 *
 * That is the same reasoning that pointed the *other* way for HTML in
 * `mhtml/html-rewrite.ts`, and the difference is not arbitrary. HTML
 * tokenization has tree-construction feedback (RAWTEXT, foster parenting,
 * `<template>` content, namespace adjustment) where "which text is markup"
 * genuinely depends on the parse; getting it wrong silently rewrites the
 * wrong span. CSS has none of that: a `url(` inside a comment or a string
 * is unreachable from the scanner's flat states, and this module stays a
 * bounded tokenizer-level scanner rather than growing into a parser — it
 * does not implement selectors, cascade, specificity or general value
 * evaluation, and it deliberately does not resolve cascade-carried
 * custom-property values (see below).
 *
 * What it therefore handles for real, rather than by pattern-matching:
 *
 * - `/* ... *\/` comments, including an unterminated one (the rest of the
 *   sheet is a comment, per spec — no rewrites inside it).
 * - `"..."`/`'...'` strings, with backslash escapes and the escaped-newline
 *   continuation, so a `url(` inside a string value is never matched.
 * - `url(` as a *function* token: an ident sequence whose **decoded** value
 *   is an ASCII case-insensitive match for `url`, immediately followed by
 *   `(`. Decoding is not a refinement — CSS identifiers may be written with
 *   escapes, so `u\72l(…)`, `\75rl(…)` and `\75\72\6c(…)` are url tokens
 *   that Chromium loads (measured, Chromium 153) and that a scanner
 *   comparing raw bytes misses entirely. Reading the whole identifier is
 *   also what rules out a tail match: `myurl(` and `my\75rl(` are one
 *   identifier each, and neither is `url`.
 * - `@import` likewise by the **decoded** value of the at-keyword's ident
 *   sequence, so `@\69mport "x.css"` is an import (measured to load), then
 *   followed by either a string or a `url()`, with the trailing media
 *   query/`layer()`/`supports()` conditions left alone.
 * - Quoted and unquoted url token values, with CSS escapes decoded before
 *   the value is handed to the caller (`url(a\)b.png)` is one URL
 *   containing a literal `)`), and an unterminated token degrading to no
 *   rewrite rather than to a corrupt one.
 * - A bare `<string>` argument of `image-set()`/`-webkit-image-set()`,
 *   which is a URL per CSS Images 4 and loads without any `url()` around it
 *   (measured) — including one written inside a `var()`/`env()`/`if()`
 *   *within* such a call, which substitution puts in the same place
 *   (`image-set(var(--x, "u.png") 1x)` loads `u.png`, measured). Strings
 *   anywhere else — `content: "url(x)"`, a font family name,
 *   `image-set(url(x.png) type("image/png"))` — are left alone, because the
 *   scanner treats a string as a reference only when the innermost frame
 *   that is not a substitution function is one of those two calls.
 *
 * What it deliberately does **not** attempt is the other direction of the
 * same feature: a string that becomes a URL only after the *cascade*
 * substitutes it, as in `:root{--x:"u.png"}` plus
 * `image-set(var(--x) 1x)`. Chromium loads that (measured, Chromium 153),
 * and no scanner can know it without evaluating custom properties across
 * every sheet, inline style and `@property` initial value that could define
 * `--x` — while rewriting every string that *might* be one would corrupt
 * font names, `content` strings and `syntax` descriptors. That case is
 * named in the viewer's security contract, where the CSP's `img-src` is the
 * mechanism that stops it (docs/architecture.md, "The security contract, as
 * rules").
 *
 * What it deliberately does **not** rewrite, because Chromium does not load
 * it either (measured): `url (x)` and `url/**\/(x)`. A function token is an
 * identifier *immediately* followed by `(`; whitespace or a comment in
 * between makes it an ident plus a parenthesis block, which fetches
 * nothing.
 *
 * Replacement values are always written back as a **double-quoted** url
 * token, escaped by {@link escapeCssStringValue}, regardless of how the
 * original was written: the input value can come from untrusted archive
 * data, so it must not be able to close the token, the enclosing
 * declaration, or (via `</style>`) the enclosing HTML element.
 */

/** Whether a `url(`/`@import` occurrence found by the scanner is an `@import` target. Callers resolve the two identically today, but an `@import` pulls in a whole stylesheet rather than a resource, so the distinction is reported rather than flattened. */
export type CssReferenceKind = 'url' | 'import'

/**
 * Escapes `value` for use inside a double-quoted CSS string.
 *
 * `\` and `"` are escaped because they would otherwise end or corrupt the
 * token. Newlines are escaped because an unescaped one is a parse error in
 * a CSS string. `<` and `>` are escaped because rewritten CSS is spliced
 * back into a `<style>` element as well as served as a standalone
 * stylesheet, and a value containing `</style>` would otherwise close that
 * element and turn the remainder of the sheet into markup — an injection
 * from archive-controlled data into the reconstructed document. CSS
 * numeric escapes are equivalent to the character for every consumer of
 * the value, so escaping them costs nothing.
 */
export function escapeCssStringValue(value: string): string {
	let out = ''
	for (const character of value) {
		switch (character) {
			case '\\':
				out += '\\\\'
				break
			case '"':
				out += '\\"'
				break
			case '\n':
				out += '\\A '
				break
			case '\r':
				out += '\\D '
				break
			case '\f':
				out += '\\C '
				break
			case '<':
				out += '\\3c '
				break
			case '>':
				out += '\\3e '
				break
			default:
				out += character
		}
	}
	return out
}

const WHITESPACE = new Set([' ', '\t', '\n', '\r', '\f'])

function isWhitespace(character: string | undefined): boolean {
	return character !== undefined && WHITESPACE.has(character)
}

function isHexDigit(character: string | undefined): boolean {
	return character !== undefined && /^[0-9a-fA-F]$/.test(character)
}

/** True for a character that can appear in a CSS identifier — used to tell the function token `url(` from the tail of a longer identifier such as `myurl(`. Non-ASCII is an ident character per CSS Syntax Level 3 §4.2. */
function isIdentCharacter(character: string | undefined): boolean {
	if (character === undefined) {
		return false
	}
	return /^[A-Za-z0-9_-]$/.test(character) || character.charCodeAt(0) > 0x7f
}

/** True for a character an identifier may *start* with, per CSS Syntax Level 3 §4.3.9. A digit is deliberately absent: `5url(` is a dimension token followed by a parenthesis, not a url token. A backslash is included because an escape can begin an identifier. */
function isIdentStartCharacter(character: string | undefined): boolean {
	if (character === undefined) {
		return false
	}
	return /^[A-Za-z_\\-]$/.test(character) || character.charCodeAt(0) > 0x7f
}

interface EscapeRead {
	readonly text: string
	readonly next: number
}

/**
 * Reads one CSS escape sequence starting at `css[index]` (which must be a
 * backslash), per CSS Syntax Level 3 §4.3.7: up to six hex digits followed
 * by at most one whitespace character form a code point; a backslash
 * before a newline is a line continuation (contributing nothing); anything
 * else is that character literally.
 */
function readEscape(css: string, index: number): EscapeRead {
	const first = css[index + 1]
	if (first === undefined) {
		// A trailing backslash is a parse error; the spec substitutes U+FFFD.
		return { text: '�', next: index + 1 }
	}
	if (first === '\n' || first === '\r' || first === '\f') {
		const isCrLf = first === '\r' && css[index + 2] === '\n'
		return { text: '', next: index + (isCrLf ? 3 : 2) }
	}
	if (!isHexDigit(first)) {
		return { text: first, next: index + 2 }
	}
	let hex = ''
	let cursor = index + 1
	while (hex.length < 6 && isHexDigit(css[cursor])) {
		hex += css[cursor]
		cursor += 1
	}
	if (isWhitespace(css[cursor])) {
		cursor += css[cursor] === '\r' && css[cursor + 1] === '\n' ? 2 : 1
	}
	const codePoint = Number.parseInt(hex, 16)
	const text = codePoint === 0 || codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff) ? '�' : String.fromCodePoint(codePoint)
	return { text, next: cursor }
}

interface TokenRead {
	/** The decoded value, or undefined when the token is unterminated (in which case nothing is rewritten). */
	readonly value: string | undefined
	/** Offset just past the token, for the scanner to continue from. */
	readonly next: number
	/** Offset of the first byte of the rewritable span, and just past its last. */
	readonly startOffset: number
	readonly endOffset: number
}

/** Reads a quoted string starting at the opening quote, decoding escapes. An unterminated string yields no value. */
function readQuotedString(css: string, index: number): TokenRead {
	const quote = css[index]
	let cursor = index + 1
	let value = ''
	for (;;) {
		const character = css[cursor]
		if (character === undefined) {
			break
		}
		if (character === quote) {
			return { value, next: cursor + 1, startOffset: index, endOffset: cursor + 1 }
		}
		if (character === '\\') {
			const sequence = readEscape(css, cursor)
			value += sequence.text
			cursor = sequence.next
			continue
		}
		if (character === '\n') {
			// A bad-string token: the string ends at the newline and is dropped.
			return { value: undefined, next: cursor, startOffset: index, endOffset: cursor }
		}
		value += character
		cursor += 1
	}
	return { value: undefined, next: cursor, startOffset: index, endOffset: cursor }
}

/**
 * Reads the value of a `url(` token whose `(` is at `index`, returning the
 * span that a replacement should overwrite — the whole `url(...)`
 * including both parentheses, so the replacement can normalize the quoting
 * style.
 */
function readUrlToken(css: string, urlStart: number, index: number): TokenRead {
	let cursor = index + 1
	while (isWhitespace(css[cursor])) {
		cursor += 1
	}
	const quote = css[cursor]
	if (quote === '"' || quote === "'") {
		const string = readQuotedString(css, cursor)
		if (string.value === undefined) {
			return { value: undefined, next: string.next, startOffset: urlStart, endOffset: string.next }
		}
		let after = string.next
		while (isWhitespace(css[after])) {
			after += 1
		}
		if (css[after] !== ')') {
			return { value: undefined, next: after, startOffset: urlStart, endOffset: after }
		}
		return { value: string.value, next: after + 1, startOffset: urlStart, endOffset: after + 1 }
	}
	let value = ''
	for (;;) {
		const character = css[cursor]
		if (character === undefined) {
			break
		}
		if (character === ')') {
			return { value, next: cursor + 1, startOffset: urlStart, endOffset: cursor + 1 }
		}
		if (character === '\\') {
			const sequence = readEscape(css, cursor)
			value += sequence.text
			cursor = sequence.next
			continue
		}
		if (isWhitespace(character)) {
			let after = cursor
			while (isWhitespace(css[after])) {
				after += 1
			}
			if (css[after] !== ')') {
				// Whitespace inside an unquoted url token is a parse error; leave it alone.
				return { value: undefined, next: after, startOffset: urlStart, endOffset: after }
			}
			return { value, next: after + 1, startOffset: urlStart, endOffset: after + 1 }
		}
		if (character === '"' || character === "'" || character === '(') {
			return { value: undefined, next: cursor + 1, startOffset: urlStart, endOffset: cursor + 1 }
		}
		value += character
		cursor += 1
	}
	return { value: undefined, next: cursor, startOffset: urlStart, endOffset: cursor }
}

interface IdentRead {
	/** The identifier's *value* — escapes decoded — which is what the spec compares against `url`, `import` and every other keyword. */
	readonly value: string
	/** Offset just past the identifier as written, escapes included. */
	readonly next: number
}

/**
 * Consumes an ident sequence starting at `css[index]`, per CSS Syntax
 * Level 3 §4.3.11, decoding escapes with {@link readEscape}.
 *
 * **This is the whole reason the scanner is not a keyword matcher.** CSS
 * identifiers and at-keywords may be spelled with escapes, and the token's
 * *value* — the decoded text — is what every keyword comparison in the
 * spec is made against (§4.3.4 "consume an ident-like token" checks the
 * consumed ident sequence's value against `url`; an at-rule's name is the
 * at-keyword token's value). So `u\72l(…)`, `\75rl(…)` and `\75\72\6c(…)`
 * are all url tokens, and `@\69mport` is `@import` — all four measured to
 * load in Chromium 153. A scanner comparing raw source bytes sees none of
 * them, which is a reference reaching the browser unrewritten.
 *
 * Reading the *whole* sequence also replaces the old "is the previous
 * character an ident character" lookbehind: `myurl(` and `my\75rl(` both
 * read as the single identifier `myurl`, which is not `url`, so neither is
 * mistaken for a url token.
 */
function readIdentSequence(css: string, index: number): IdentRead {
	let value = ''
	let cursor = index
	for (;;) {
		const character = css[cursor]
		if (character === undefined) {
			break
		}
		if (character === '\\') {
			// A backslash before a newline is not a valid escape inside an
			// identifier, so it ends the sequence rather than continuing it.
			const following = css[cursor + 1]
			if (following === '\n' || following === '\r' || following === '\f') {
				break
			}
			const sequence = readEscape(css, cursor)
			value += sequence.text
			cursor = sequence.next
			continue
		}
		if (!isIdentCharacter(character)) {
			break
		}
		value += character
		cursor += 1
	}
	return { value, next: cursor }
}

/** CSS functions whose `<string>` arguments are URLs rather than ordinary strings (CSS Images 4 `image-set()`, plus the prefixed spelling Chromium still supports — both measured to load a bare-string URL in Chromium 153). */
const STRING_URL_FUNCTIONS = new Set(['image-set', '-webkit-image-set'])

/**
 * Functions that *substitute* their argument into the value around them,
 * rather than consuming it themselves — so a string written inside one of
 * them ends up wherever the function sits.
 *
 * They are transparent for the purpose of deciding whether a string is a
 * URL: measured in Chromium 153, `image-set(var(--x, "u.png") 1x)`,
 * `image-set(env(--x, "u.png") 1x)` and
 * `image-set(if(style(--c: 1): "u.png") 1x)` all load `u.png`, because the
 * substituted string lands in an image-set argument, where a bare string is
 * a URL. Nothing else about substitution is modelled: this is a question
 * about the text the scanner can already see, not about the cascade.
 *
 * The conditions of an `if()` are not affected, because each of them is
 * itself a function (`style()`, `media()`, `supports()`) and so pushes its
 * own opaque frame.
 */
const SUBSTITUTION_FUNCTIONS = new Set(['var', 'env', 'if'])

/** What an open parenthesis means for the string tokens inside it. */
type FunctionFrame =
	/** A {@link STRING_URL_FUNCTIONS} call: a bare string argument is a URL. */
	| 'string-url'
	/** A {@link SUBSTITUTION_FUNCTIONS} call: its arguments belong to the frame around it. */
	| 'substitution'
	/** Anything else, including a plain parenthesis: its strings are ordinary strings. */
	| 'opaque'

/**
 * Rewrites the CSS reference forms this viewer statically recognizes:
 * `url()` tokens, `@import` targets, and URL-bearing string arguments in
 * `image-set()`-style functions. `rewrite` is called with each reference's
 * decoded value and returns a replacement URL (or `undefined` to leave
 * that occurrence exactly as written). Every other byte of `css` is
 * preserved.
 */
export function rewriteCssReferences(css: string, rewrite: (value: string, kind: CssReferenceKind) => string | undefined): string {
	let out = ''
	let copiedTo = 0
	let index = 0
	/** Set when an `@import` has been seen and its target token has not been consumed yet, so a plain string counts as a reference rather than as an ordinary value. */
	let expectingImportTarget = false
	/**
	 * One entry per currently open `(`. A string token is a URL when the
	 * innermost enclosing frame — looking past any {@link
	 * SUBSTITUTION_FUNCTIONS} frames, whose arguments belong to the frame
	 * around them — is a {@link STRING_URL_FUNCTIONS} call. That is what makes
	 * `image-set("x.png" 1x)` and `image-set(var(--x, "x.png") 1x)` references
	 * while leaving `content: "("`, `font-family: var(--f, "Some Font")` and
	 * `image-set(url(x.png) type("image/png"))` alone. `url(` never pushes a
	 * frame: its token is consumed whole, closing parenthesis included.
	 */
	const functionStack: FunctionFrame[] = []

	/** Whether a string token found right here is a URL rather than an ordinary string. */
	function inStringUrlContext(): boolean {
		for (let position = functionStack.length - 1; position >= 0; position -= 1) {
			if (functionStack[position] !== 'substitution') {
				return functionStack[position] === 'string-url'
			}
		}
		return false
	}

	function emitReplacement(token: TokenRead, kind: CssReferenceKind): void {
		if (token.value === undefined) {
			return
		}
		const replacement = rewrite(token.value, kind)
		if (replacement === undefined) {
			return
		}
		out += css.slice(copiedTo, token.startOffset)
		out += `url("${escapeCssStringValue(replacement)}")`
		copiedTo = token.endOffset
	}

	for (;;) {
		const character = css[index]
		if (character === undefined) {
			break
		}

		if (character === '/' && css[index + 1] === '*') {
			const end = css.indexOf('*/', index + 2)
			index = end === -1 ? css.length : end + 2
			continue
		}

		if (character === '"' || character === "'") {
			const string = readQuotedString(css, index)
			if (expectingImportTarget) {
				expectingImportTarget = false
				emitReplacement(string, 'import')
			} else if (inStringUrlContext()) {
				emitReplacement(string, 'url')
			}
			index = string.next
			continue
		}

		if (character === '@' && isIdentStartCharacter(css[index + 1])) {
			// An at-keyword token: `@` followed by an ident sequence, whose
			// decoded value is the at-rule's name (`@\69mport` is `@import`).
			const name = readIdentSequence(css, index + 1)
			expectingImportTarget = name.value.toLowerCase() === 'import'
			index = name.next
			continue
		}

		if (isIdentStartCharacter(character) && !isIdentCharacter(css[index - 1])) {
			const ident = readIdentSequence(css, index)
			const name = ident.value.toLowerCase()
			// A function token is an ident sequence immediately followed by `(`.
			// No whitespace and no comment may come between the two: `url (x)`
			// and `url/**/(x)` are an ident plus a parenthesis block, and Chromium
			// loads neither (measured, Chromium 153).
			if (css[ident.next] === '(') {
				if (name === 'url') {
					const token = readUrlToken(css, index, ident.next)
					emitReplacement(token, expectingImportTarget ? 'import' : 'url')
					expectingImportTarget = false
					index = token.next
					continue
				}
				functionStack.push(STRING_URL_FUNCTIONS.has(name) ? 'string-url' : SUBSTITUTION_FUNCTIONS.has(name) ? 'substitution' : 'opaque')
				index = ident.next + 1
				continue
			}
			// Advancing past the whole identifier is what keeps the scanner from
			// restarting inside one and mistaking a tail for a keyword.
			index = ident.next
			continue
		}

		if (character === '(') {
			functionStack.push('opaque')
			index += 1
			continue
		}

		if (character === ')') {
			functionStack.pop()
			index += 1
			continue
		}

		if (character === ';' || character === '{' || character === '}') {
			expectingImportTarget = false
			if (character !== ';') {
				// A block boundary cannot appear inside a function's argument list;
				// reaching one means an unterminated `(` and the stack is stale.
				functionStack.length = 0
			}
		}

		index += 1
	}

	out += css.slice(copiedTo)
	return out
}
