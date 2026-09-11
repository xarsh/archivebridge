import assert from 'node:assert/strict'
import test from 'node:test'
import { escapeCssStringValue, rewriteCssReferences } from './css-rewrite.ts'

/** Rewrites every reference to `R:<value>`, so a test can see exactly which values the scanner offered. */
function rewriteAll(css: string): string {
	return rewriteCssReferences(css, (value, kind) => `${kind === 'import' ? 'I' : 'R'}:${value}`)
}

function collect(css: string): readonly string[] {
	const seen: string[] = []
	rewriteCssReferences(css, (value, kind) => {
		seen.push(`${kind}:${value}`)
		return undefined
	})
	return seen
}

test('rewrites a quoted, single-quoted and unquoted url() alike', () => {
	assert.equal(rewriteAll('a{background:url("x.png")}'), 'a{background:url("R:x.png")}')
	assert.equal(rewriteAll("a{background:url('x.png')}"), 'a{background:url("R:x.png")}')
	assert.equal(rewriteAll('a{background:url(x.png)}'), 'a{background:url("R:x.png")}')
})

test('tolerates whitespace inside a url token, as CSS does', () => {
	assert.deepEqual(collect('a{background:url(  "x.png"  )}'), ['url:x.png'])
	assert.deepEqual(collect('a{background:url(\n\tx.png\n)}'), ['url:x.png'])
})

test('is case-insensitive on the url function name', () => {
	assert.deepEqual(collect('a{background:URL(x.png)}'), ['url:x.png'])
	assert.deepEqual(collect('a{background:Url(x.png)}'), ['url:x.png'])
})

test('does not match url as the tail of a longer identifier', () => {
	assert.deepEqual(collect('a{background:myurl(x.png)}'), [])
	assert.deepEqual(collect('a{--my-url:1}'), [])
	assert.deepEqual(collect('a{background:-webkit-url(x.png)}'), [])
})

test('never matches inside a comment, including an unterminated one', () => {
	assert.deepEqual(collect('/* url(hidden.png) */a{color:red}'), [])
	assert.deepEqual(collect('a{color:red}/* url(hidden.png)'), [])
	assert.equal(rewriteAll('/* url(a) */b{background:url(b.png)}'), '/* url(a) */b{background:url("R:b.png")}')
})

test('never matches inside a string', () => {
	assert.deepEqual(collect('a::after{content:"url(hidden.png)"}'), [])
	assert.deepEqual(collect("a::after{content:'url(hidden.png)'}"), [])
	assert.deepEqual(collect('a::after{content:"\\"url(hidden.png)"}'), [])
})

test('decodes CSS escapes in an unquoted url token so a ) can be part of the URL', () => {
	assert.deepEqual(collect('a{background:url(a\\)b.png)}'), ['url:a)b.png'])
	assert.deepEqual(collect('a{background:url(a\\28 b.png)}'), ['url:a(b.png'])
	assert.deepEqual(collect('a{background:url("a\\"b.png")}'), ['url:a"b.png'])
})

test('leaves an unterminated url token or string completely alone', () => {
	assert.equal(rewriteAll('a{background:url("x.png}'), 'a{background:url("x.png}')
	assert.equal(rewriteAll('a{background:url(x.png'), 'a{background:url(x.png')
	assert.equal(rewriteAll('a{background:url(x y.png)}'), 'a{background:url(x y.png)}')
})

test('finds @import targets in both string and url() form, and leaves trailing conditions alone', () => {
	assert.deepEqual(collect('@import "a.css";'), ['import:a.css'])
	assert.deepEqual(collect('@import url(a.css);'), ['import:a.css'])
	assert.deepEqual(collect('@import url("a.css") screen and (min-width:1px);'), ['import:a.css'])
	assert.equal(rewriteAll('@import "a.css" screen;'), '@import url("I:a.css") screen;')
})

test('a plain string that is not an @import target is not a reference', () => {
	assert.deepEqual(collect('@media screen{a::after{content:"a.css"}}'), [])
	// The @import ends at the semicolon; a later string is an ordinary value.
	assert.deepEqual(collect('@import "a.css";b::after{content:"c.css"}'), ['import:a.css'])
})

test('@import is not matched as the prefix of a longer at-rule', () => {
	assert.deepEqual(collect('@importantly "a.css";'), [])
})

test('rewrites every occurrence in a realistic sheet and preserves everything else byte for byte', () => {
	const css = [
		'@import url(base.css);',
		'@font-face{font-family:F;src:url(f.woff2) format("woff2"),url(f.woff) format("woff")}',
		'.a{background:url(a.png) no-repeat,url("b.png")}',
		'.b{background-image:image-set(url(c.png) 1x,url(d.png) 2x)}',
	].join('\n')
	assert.equal(
		rewriteCssReferences(css, (value) => `/${value}`),
		[
			'@import url("/base.css");',
			'@font-face{font-family:F;src:url("/f.woff2") format("woff2"),url("/f.woff") format("woff")}',
			'.a{background:url("/a.png") no-repeat,url("/b.png")}',
			'.b{background-image:image-set(url("/c.png") 1x,url("/d.png") 2x)}',
		].join('\n'),
	)
})

test('returning undefined leaves an occurrence exactly as written', () => {
	const css = ".a{background:url(  'keep.png'  )}"
	assert.equal(
		rewriteCssReferences(css, () => undefined),
		css,
	)
})

test('escapes a replacement so it cannot close the url token, the string, or a <style> element', () => {
	const hostile = 'x")}body{background:url("y'
	const rewritten = rewriteCssReferences('a{background:url(a.png)}', () => hostile)
	assert.equal(rewritten, 'a{background:url("x\\")}body{background:url(\\"y")}')
	assert.equal(
		rewriteCssReferences('a{background:url(a.png)}', () => '</style><script>x()</script>'),
		'a{background:url("\\3c /style\\3e \\3c script\\3e x()\\3c /script\\3e ")}',
	)
})

test('escapeCssStringValue escapes exactly the characters that can break out', () => {
	assert.equal(escapeCssStringValue('a\\b"c<d>e\nf'), 'a\\\\b\\"c\\3c d\\3e e\\A f')
	assert.equal(escapeCssStringValue('plain/url?a=1&b=2'), 'plain/url?a=1&b=2')
})

// CSS identifiers and at-keywords may be spelled with escapes, and the
// token's *decoded* value is what the spec — and Chromium — compares
// against `url` and `import`. Every spelling below was measured to load in
// Chromium 153, and every one of them was missed by the keyword-matching
// scanner this replaced.

test('recognizes url() however its identifier is escaped', () => {
	assert.deepEqual(collect('a{background:u\\72l(x.png)}'), ['url:x.png'])
	assert.deepEqual(collect('a{background:\\75rl(x.png)}'), ['url:x.png'])
	assert.deepEqual(collect('a{background:\\75\\72\\6c(x.png)}'), ['url:x.png'])
	assert.deepEqual(collect('a{background:\\55RL(x.png)}'), ['url:x.png'])
	// A hex escape may be terminated by one whitespace character, which is
	// consumed as part of the escape rather than separating the identifier.
	assert.deepEqual(collect('a{background:\\75 rl(x.png)}'), ['url:x.png'])
	assert.deepEqual(collect('a{background:\\000075rl(x.png)}'), ['url:x.png'])
})

test('an escaped url() is rewritten into an ordinary one', () => {
	assert.equal(rewriteAll('a{background:u\\72l(x.png)}'), 'a{background:url("R:x.png")}')
})

test('recognizes @import however its at-keyword is escaped', () => {
	assert.deepEqual(collect('@\\69mport "a.css";'), ['import:a.css'])
	assert.deepEqual(collect('@im\\70ort url(a.css);'), ['import:a.css'])
	assert.deepEqual(collect('@\\49\\4d\\50\\4f\\52\\54 "a.css";'), ['import:a.css'])
})

test('an escape cannot disguise a longer identifier as url', () => {
	// `my\75rl` decodes to `myurl`, which is not `url` — reading the whole
	// identifier is what makes a tail match impossible.
	assert.deepEqual(collect('a{background:my\\75rl(x.png)}'), [])
	assert.deepEqual(collect('a{background:--\\75rl(x.png)}'), [])
	assert.deepEqual(collect('@\\69mportantly "a.css";'), [])
})

test('an escaped spelling inside a comment or a string is still not a reference', () => {
	assert.deepEqual(collect('/* u\\72l(x.png) */a{color:red}'), [])
	assert.deepEqual(collect('a{content:"u\\72l(x.png)"}'), [])
	assert.deepEqual(collect("a{content:'\\75rl(x.png)'}"), [])
	assert.deepEqual(collect('/* @\\69mport "a.css"; */'), [])
	assert.deepEqual(collect('a{content:"@\\69mport \\"a.css\\";"}'), [])
	// An unterminated comment swallows the rest of the sheet, per spec.
	assert.deepEqual(collect('/* u\\72l(x.png)'), [])
})

test('a function token needs its ( immediately, as Chromium requires', () => {
	// Measured (Chromium 153): neither of these fetches anything, because an
	// identifier followed by whitespace or a comment is not a function token.
	assert.equal(rewriteAll('a{background:url (x.png)}'), 'a{background:url (x.png)}')
	assert.equal(rewriteAll('a{background:url/**/(x.png)}'), 'a{background:url/**/(x.png)}')
	assert.equal(rewriteAll('@import url (a.css);'), '@import url (a.css);')
})

test('a bare string argument of image-set() is a URL, because the browser loads it', () => {
	assert.deepEqual(collect('a{background-image:image-set("x.png" 1x)}'), ['url:x.png'])
	assert.deepEqual(collect('a{background-image:image-set("x.png" 1x, "y.png" 2x)}'), ['url:x.png', 'url:y.png'])
	assert.deepEqual(collect('a{background-image:-webkit-image-set("x.png" 1x)}'), ['url:x.png'])
	assert.deepEqual(collect('a{background-image:IMAGE-SET("x.png" 1x)}'), ['url:x.png'])
	assert.deepEqual(collect('a{background-image:image-\\73 et("x.png" 1x)}'), ['url:x.png'])
	assert.deepEqual(collect('a{background-image:image-\\000073et("x.png" 1x)}'), ['url:x.png'])
	assert.equal(rewriteAll('a{background-image:image-set("x.png" 1x)}'), 'a{background-image:image-set(url("R:x.png") 1x)}')
})

test('a string outside image-set() is left alone, including one just after it', () => {
	assert.deepEqual(collect('a{content:"x.png"}'), [])
	assert.deepEqual(collect('a{font-family:"Some Font"}'), [])
	assert.deepEqual(collect('a{background-image:image-set("x.png" 1x);content:"y.png"}'), ['url:x.png'])
	// A nested ordinary function inside image-set() does not make its own
	// strings URLs, and does not stop the image-set arguments from being URLs.
	assert.deepEqual(collect('a{background-image:image-set(calc(1px) "x.png" 1x)}'), ['url:x.png'])
	assert.deepEqual(collect('a{background-image:foo(image-set("x.png" 1x))}'), ['url:x.png'])
	assert.deepEqual(collect('a{background-image:image-set(foo("x.png") 1x)}'), [])
})

test('a string inside a substitution function inside image-set() is a URL, because substitution puts it there', () => {
	// Measured, Chromium 153: each of these loads the URL, because var()/env()
	// substitute their fallback into the image-set argument, where a bare
	// string is a URL. The scanner sees the string as written, so it can
	// neutralize all of them without evaluating anything.
	assert.deepEqual(collect('a{background-image:image-set(var(--x,"x.png") 1x)}'), ['url:x.png'])
	assert.deepEqual(collect('a{background-image:image-set(env(--x,"x.png") 1x)}'), ['url:x.png'])
	assert.deepEqual(collect('a{background-image:image-set(var(--a,var(--b,"x.png")) 1x)}'), ['url:x.png'])
	assert.deepEqual(collect('a{background-image:-webkit-image-set(var(--x,"x.png") 1x)}'), ['url:x.png'])
	assert.deepEqual(collect('a{background-image:image-set(if(style(--c: 1): "x.png"; else: "y.png") 1x)}'), ['url:x.png', 'url:y.png'])
	assert.equal(rewriteAll('a{background-image:image-set(var(--x,"x.png") 1x)}'), 'a{background-image:image-set(var(--x,url("R:x.png")) 1x)}')
})

test('a substitution function is transparent only inside image-set(), and only for its own arguments', () => {
	// The same fallback outside image-set() is an ordinary string.
	assert.deepEqual(collect('a{content:var(--x,"x.png")}'), [])
	assert.deepEqual(collect('a{font-family:var(--f,"Some Font")}'), [])
	// A nested ordinary function still shields its strings: `type()` names a
	// MIME type, not a URL, and rewriting it would corrupt the declaration.
	assert.deepEqual(collect('a{background-image:image-set(var(--x,type("image/png")) 1x)}'), [])
	assert.deepEqual(collect('a{background-image:image-set(url(x.png) 1x type("image/png"))}'), ['url:x.png'])
	// An `if()` condition tests a custom property's value; those strings are
	// inside style()/media()/supports() and are not URLs either.
	assert.deepEqual(collect('a{background-image:image-set(if(style(--c: "x.png"): url(y.png)) 1x)}'), ['url:y.png'])
})

test('a string in a custom property is not a reference, because whether it becomes one depends on the cascade', () => {
	// The honest limit of a static scanner: `--x` is a URL only once some
	// other declaration substitutes it into an image-set, which is a question
	// about the cascade rather than about this stylesheet's text. Measured to
	// load in Chromium 153, and stopped by the viewer's `img-src` CSP instead
	// — see docs/architecture.md, "The security contract, as rules".
	assert.deepEqual(collect(':root{--x:"x.png"}a{background-image:image-set(var(--x) 1x)}'), [])
	// A url() token in a custom property is still a url token, and is rewritten.
	assert.deepEqual(collect(':root{--x:url(x.png)}a{background-image:var(--x)}'), ['url:x.png'])
	assert.deepEqual(collect(':root{--x:image-set("x.png" 1x)}a{background-image:var(--x)}'), ['url:x.png'])
})
