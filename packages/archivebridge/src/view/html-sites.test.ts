import assert from 'node:assert/strict'
import test from 'node:test'
import { classifyHtmlSite, type HtmlSite, htmlAttributeMarkup, rewriteHtmlSites } from './html-sites.ts'

/** Every site the walk offers, as `namespace/tag@attribute=value` (or `namespace/tag#text=...` for a `<style>` body). */
function sites(html: string): readonly string[] {
	const seen: string[] = []
	rewriteHtmlSites(html, (site) => {
		seen.push(
			site.kind === 'attribute'
				? `${site.element.namespace}/${site.element.tagName}@${site.attribute.name}=${site.attribute.value}`
				: `${site.element.namespace}/${site.element.tagName}#text=${site.text}`,
		)
		return undefined
	})
	return seen
}

/** Rewrites just the sites `match` selects, using `edit` to produce the replacement markup. */
function rewrite(html: string, match: (site: HtmlSite) => boolean, edit: (site: HtmlSite) => string): string {
	return rewriteHtmlSites(html, (site) => (match(site) ? { markup: edit(site) } : undefined))
}

test('visits every attribute of every element, with its namespace', () => {
	assert.deepEqual(sites('<img src="a.png" alt="a">'), ['html/img@src=a.png', 'html/img@alt=a'])
	assert.deepEqual(sites('<svg><image xlink:href="a.png" href="b.png"/></svg>'), ['svg/image@xlink:href=a.png', 'svg/image@href=b.png'])
})

test('reports a namespaced SVG attribute under the qualified name its source location uses', () => {
	assert.equal(
		rewrite(
			'<svg><use xlink:href="#a"/></svg>',
			(site) => site.kind === 'attribute' && site.attribute.name === 'xlink:href',
			() => htmlAttributeMarkup('xlink:href', '#b'),
		),
		'<svg><use xlink:href="#b"/></svg>',
	)
})

test('lowercases attribute and tag names but keeps values verbatim', () => {
	assert.deepEqual(sites('<IMG SRC="A.PNG">'), ['html/img@src=A.PNG'])
})

test('decodes entity references in the value it offers, and re-escapes what it writes', () => {
	assert.deepEqual(sites('<a href="?a=1&amp;b=2">x</a>'), ['html/a@href=?a=1&b=2'])
	assert.equal(
		rewrite(
			'<a href="x">y</a>',
			() => true,
			() => htmlAttributeMarkup('href', '?a=1&b=2'),
		),
		'<a href="?a=1&amp;b=2">y</a>',
	)
})

test('an escaped replacement cannot break out of the attribute', () => {
	assert.equal(htmlAttributeMarkup('src', '"><script>x()</script>'), 'src="&quot;&gt;&lt;script&gt;x()&lt;/script&gt;"')
})

test('offers the text content of a <style> element, in either namespace', () => {
	assert.deepEqual(sites('<style>a{color:red}</style>'), ['html/style#text=a{color:red}'])
	assert.deepEqual(sites('<svg><style>a{color:red}</style></svg>'), ['svg/style#text=a{color:red}'])
})

test('rewrites <style> text in place, leaving the element untouched', () => {
	assert.equal(
		rewrite(
			'<style media="print">a{background:url(x)}</style>',
			(site) => site.kind === 'style-text',
			() => 'a{background:url(y)}',
		),
		'<style media="print">a{background:url(y)}</style>',
	)
})

test('does not treat markup inside a comment or a <script> body as elements', () => {
	assert.deepEqual(sites('<!-- <img src="hidden.png"> --><p>ok</p>'), [])
	assert.deepEqual(sites('<script>var a = "<img src=\'hidden.png\'>"</script>'), [])
})

test('honors only the first of a duplicate attribute, as a browser does', () => {
	assert.deepEqual(sites('<img src="real.png" src="evil.png">'), ['html/img@src=real.png'])
	assert.equal(
		rewrite(
			'<img src="real.png" src="evil.png">',
			() => true,
			() => htmlAttributeMarkup('src', 'new.png'),
		),
		'<img src="new.png" src="evil.png">',
	)
})

test('descends into a declarative shadow root, in both the standard and the legacy Blink spelling', () => {
	assert.ok(sites('<div><template shadowrootmode="open"><img src="a.png"></template></div>').includes('html/img@src=a.png'))
	assert.ok(sites('<div><template shadowmode="open"><img src="a.png"></template></div>').includes('html/img@src=a.png'))
	assert.ok(sites('<div><template shadowmode="closed"><img src="a.png"></template></div>').includes('html/img@src=a.png'))
})

test('does not descend into an ordinary inert <template>, nor into one whose mode is not a real mode', () => {
	assert.deepEqual(sites('<template><img src="a.png"></template>'), [])
	assert.deepEqual(sites('<div><template shadowmode="sideways"><img src="a.png"></template></div>'), ['html/template@shadowmode=sideways'])
})

test('parses <noscript> content as markup, because the rendered document will have scripting disabled', () => {
	assert.deepEqual(sites('<noscript><link rel="preconnect" href="http://elsewhere/"></noscript>'), ['html/link@rel=preconnect', 'html/link@href=http://elsewhere/'])
	assert.equal(
		rewrite(
			'<noscript><img src="a.png"></noscript>',
			(site) => site.kind === 'attribute' && site.attribute.name === 'src',
			() => htmlAttributeMarkup('src', 'about:invalid'),
		),
		'<noscript><img src="about:invalid"></noscript>',
	)
})

test('rewrites several sites in one pass without disturbing anything between them', () => {
	const html = "<!doctype html>\n<html><head><style>a{background:url(s)}</style></head><body>\n<img src=a.png width=10>\n<a href='b'>l</a>\n</body></html>"
	const rewritten = rewriteHtmlSites(html, (site) => {
		if (site.kind === 'style-text') {
			return { markup: 'a{background:url(S)}' }
		}
		if (site.attribute.name === 'src' || site.attribute.name === 'href') {
			return { markup: htmlAttributeMarkup(site.attribute.name, `/${site.attribute.value}`) }
		}
		return undefined
	})
	assert.equal(rewritten, '<!doctype html>\n<html><head><style>a{background:url(S)}</style></head><body>\n<img src="/a.png" width=10>\n<a href="/b">l</a>\n</body></html>')
})

test('one attribute can become two, which is how a value is preserved next to a neutralized one', () => {
	assert.equal(
		rewrite(
			'<a href="http://x/">l</a>',
			(site) => site.kind === 'attribute' && site.attribute.name === 'href',
			(site) => `${htmlAttributeMarkup('href', '#')} ${htmlAttributeMarkup('data-original', site.kind === 'attribute' ? site.attribute.value : '')}`,
		),
		'<a href="#" data-original="http://x/">l</a>',
	)
})

test('returns the input unchanged when nothing is edited', () => {
	const html = '<html><body><img src="a.png"></body></html>'
	assert.equal(
		rewriteHtmlSites(html, () => undefined),
		html,
	)
})

test('malformed markup degrades to whatever the HTML parser makes of it, never to a corrupt splice', () => {
	assert.equal(
		rewrite(
			'<img src="unterminated',
			() => true,
			() => htmlAttributeMarkup('src', 'x'),
		),
		'<img src="unterminated',
	)
	assert.equal(
		rewrite(
			'<img src=a.png <img src=b.png>',
			(site) => site.kind === 'attribute' && site.attribute.name === 'src',
			() => htmlAttributeMarkup('src', 'X'),
		),
		'<img src="X" <img src=b.png>',
	)
})

/**
 * The classification, exercised directly rather than through either caller.
 *
 * It is the one description of the reference surface — the viewer applies
 * security policy to it, the MHTML->WebArchive converter applies format
 * translation to it — so it is pinned here, where neither caller's policy can
 * hide a change to it.
 */
function classify(html: string): readonly string[] {
	const seen: string[] = []
	rewriteHtmlSites(html, (site) => {
		const classification = classifyHtmlSite(site)
		const where = site.kind === 'attribute' ? site.attribute.name : '#text'
		seen.push(`${where}=${classification.kind}${'role' in classification ? `/${classification.role}` : ''}`)
		return undefined
	})
	return seen
}

test('classifies every kind of site a browser loads from', () => {
	assert.deepEqual(classify('<img src="a" srcset="a 1x" alt="a" id="a">'), ['src=url/resource', 'srcset=srcset/image', 'alt=none', 'id=none'])
	assert.deepEqual(classify('<link rel="stylesheet" href="a">'), ['rel=none', 'href=url/stylesheet'])
	assert.deepEqual(classify('<link rel="icon" href="a">'), ['rel=none', 'href=url/resource'])
	assert.deepEqual(classify('<link rel="preload" href="a" imagesrcset="a 1x">'), ['rel=none', 'href=url/network-hint', 'imagesrcset=srcset/preload'])
	assert.deepEqual(classify('<link href="a">'), ['href=url/network-hint'], 'an unknown or absent rel is not a resource')
	assert.deepEqual(classify('<iframe src="a" srcdoc="b" name="c">'), ['src=url/frame', 'srcdoc=html', 'name=none'])
	assert.deepEqual(classify('<script src="a">'), ['src=url/script'])
	assert.deepEqual(classify('<object data="a">'), ['data=url/plugin'])
	assert.deepEqual(classify('<embed src="a">'), ['src=url/plugin'])
	assert.deepEqual(classify('<a href="a" ping="b">'), ['href=url/hyperlink', 'ping=url/navigation'])
	assert.deepEqual(classify('<form action="a">'), ['action=url/navigation'])
	assert.deepEqual(classify('<base href="a">'), ['href=url/base'])
	assert.deepEqual(classify('<body background="a">'), ['background=url/resource'])
	assert.deepEqual(classify('<video src="a" poster="b">'), ['src=url/resource', 'poster=url/resource'])
	assert.deepEqual(classify('<div style="a">'), ['style=css'])
	assert.deepEqual(classify('<style>a</style>'), ['#text=css'])
	assert.deepEqual(classify('<svg><image href="a" xlink:href="b"/></svg>'), ['href=url/resource', 'xlink:href=url/resource'])
	assert.deepEqual(classify('<svg><use href="a"/></svg>'), ['href=url/svg-use'])
	assert.deepEqual(classify('<svg><rect fill="a" stroke="b" x="c"/></svg>'), ['fill=css', 'stroke=css', 'x=none'])
})

test('classifies page data as no reference at all, whatever its value looks like', () => {
	// The converter depends on this: a value that merely *spells* a URL is not
	// a reference, and rewriting one would edit the archived page's content.
	assert.deepEqual(classify('<div id="cid:x" class="cid:x" data-key="cid:x" title="url(cid:x)" aria-label="cid:x">'), [
		'id=none',
		'class=none',
		'data-key=none',
		'title=none',
		'aria-label=none',
	])
	assert.deepEqual(classify('<input value="cid:x" type="text">'), ['value=none', 'type=none'])
	assert.deepEqual(classify('<div onclick="cid:x">'), ['onclick=none'], 'an event handler holds script, not a URL')
	assert.deepEqual(classify('<meta http-equiv="refresh" content="0;url=cid:x">'), ['http-equiv=none', 'content=none'], 'a directive with a URL inside a larger grammar')
	assert.deepEqual(classify('<svg><set attributeName="href" to="cid:x"/></svg>'), ['attributename=none', 'to=none'], 'whether `to` holds a URL depends on `attributeName`')
})

test('classification follows the namespace, not the spelling', () => {
	// `fill` is a CSS-valued presentation attribute only in SVG; on a `<div>`
	// it is inert page data and nothing may rewrite it.
	assert.deepEqual(classify('<div fill="url(cid:x)">'), ['fill=none'])
	// And the reverse: SVG's `<image>` loads from `href`, not from `src`, so
	// `src` there is page data — it is HTML's `<img>` that uses `src`.
	assert.deepEqual(classify('<svg><image src="a" href="b"/></svg>'), ['src=none', 'href=url/resource'])
	// `<img>` is one of HTML's foreign-content breakout elements, so this one
	// really is an HTML `<img>` despite being written inside `<svg>` — the
	// classification reports what the parser built, which is what loads.
	assert.deepEqual(classify('<svg><img src="a"/></svg>'), ['src=url/resource'])
})
