/**
 * End-to-end tests for the local WebArchive viewer, against a real
 * Chromium with the real built extension loaded.
 *
 * Nothing here is simulated. The browser really navigates to a
 * `file:///….webarchive`, the extension's own `declarativeNetRequest` rule
 * really redirects it, the viewer page really reads the bytes off disk,
 * and every assertion is made against the archived DOM the browser
 * actually laid out. There is no fake `chrome` object and no branch in
 * `src/` that exists for these tests.
 *
 * **The beacon server is what makes the network claim checkable.** Every
 * external URL in the hostile fixture addresses the local test server,
 * which records both HTTP requests and raw TCP connections — the second
 * because `preconnect`/`dns-prefetch` connect without ever sending a
 * request, and no CSP directive stops them. Zero from both counters is the
 * only honest form of "the viewer made no network requests".
 *
 * **Reaching into the archive frame is Playwright's isolated world**, not
 * the archived page's own scripting: a sandboxed frame with no
 * `allow-scripts` still has an execution context the automation protocol
 * can use, which is why these tests can read the rendered DOM while the
 * archive's own script never runs. Assertions stay semantic (rendered
 * text, computed styles, natural image sizes, CSS rules, recorded
 * traffic); no screenshot is used, because a pixel diff cannot tell a
 * rendering change from a fidelity regression.
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import type { Frame, Page } from 'playwright'
import { builtExtensionDir, type ExtensionSession, openTestPage, startExtensionSession } from './extension-session.ts'
import { startTestServer, type TestServer } from './test-page.ts'
import {
	buildCspBackstopWebArchive,
	buildHostileWebArchive,
	buildMalformedWebArchive,
	buildResourceWebArchive,
	buildSecondWebArchive,
	buildUnrewritableWebArchive,
	captureMhtmlBytes,
	createFixtureDirectory,
	toWebArchiveBytes,
	writeFixture,
} from './viewer-fixtures.ts'

describe('Chrome extension local WebArchive viewer', () => {
	let server: TestServer
	let session: ExtensionSession
	let fixtures: string
	/** The live capture, as the `.webarchive` the viewer opens and as the MHTML it came from. */
	let capturedWebArchiveUrl: string
	let capturedMhtmlUrl: string
	let hostileUrl: string
	let cspBackstopUrl: string
	let resourceUrl: string
	let secondUrl: string
	let malformedUrl: string
	let plainTextUrl: string
	let decoyUrl: string
	let unrewritableUrl: string

	before(async () => {
		server = await startTestServer()
		session = await startExtensionSession()
		fixtures = await createFixtureDirectory()

		// The flow that matters most, exactly as a user would produce it: a live
		// page, Chrome's own capture, ArchiveBridge's own conversion, a file on
		// disk. Everything the fidelity tests assert comes out of this.
		const page = await openTestPage(session.context, `${server.origin}/viewer/`)
		const tabId = await session.serviceWorker.evaluate(async () => {
			const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
			if (tab?.id === undefined) {
				throw new Error('no active tab')
			}
			return tab.id
		})
		const mhtml = await captureMhtmlBytes(session.serviceWorker, tabId)
		await page.close()

		// The interception rule is installed from `runtime.onInstalled`, which
		// races a test that navigates immediately. Waiting on what Chrome
		// actually holds is the honest signal — nothing in `src/` announces it.
		await waitForInterceptionRule()

		capturedWebArchiveUrl = await writeFixture(fixtures, 'captured.webarchive', toWebArchiveBytes(mhtml))
		capturedMhtmlUrl = await writeFixture(fixtures, 'captured.mhtml', mhtml)
		hostileUrl = await writeFixture(fixtures, 'hostile.webarchive', buildHostileWebArchive(server.origin))
		cspBackstopUrl = await writeFixture(fixtures, 'cascade.webarchive', buildCspBackstopWebArchive(server.origin))
		resourceUrl = await writeFixture(fixtures, 'resources.webarchive', buildResourceWebArchive(server.origin))
		secondUrl = await writeFixture(fixtures, 'second.webarchive', buildSecondWebArchive())
		malformedUrl = await writeFixture(fixtures, 'malformed.webarchive', buildMalformedWebArchive())
		unrewritableUrl = await writeFixture(fixtures, 'unrewritable.webarchive', buildUnrewritableWebArchive(server.origin))
		plainTextUrl = await writeFixture(fixtures, 'notes.txt', new TextEncoder().encode('just a note'))
		decoyUrl = await writeFixture(fixtures, 'decoy.webarchive.txt', new TextEncoder().encode('not an archive'))
	})

	after(async () => {
		await session?.close()
		await server?.close()
	})

	async function waitForInterceptionRule(): Promise<void> {
		const deadline = Date.now() + 15_000
		for (;;) {
			const rules = await session.serviceWorker.evaluate(async () => await chrome.declarativeNetRequest.getDynamicRules())
			if (rules.length > 0) {
				return
			}
			if (Date.now() > deadline) {
				throw new Error('the extension never installed its .webarchive interception rule')
			}
			await new Promise((resolve) => setTimeout(resolve, 100))
		}
	}

	/** Opens `fileUrl` the way a double-click does — a top-level navigation — and waits for the viewer to settle on either an archive or a failure. */
	async function openArchive(fileUrl: string): Promise<Page> {
		const page = await session.context.newPage()
		await page.goto(fileUrl, { waitUntil: 'load' })
		await page.waitForFunction(() => document.getElementById('archive')?.hasAttribute('src') === true || document.getElementById('failure')?.hidden === false, undefined, {
			timeout: 30_000,
		})
		// Subresources of the reconstructed document load after it commits.
		await page.waitForTimeout(500)
		return page
	}

	/** The frame the archive rendered into. */
	function archiveFrame(page: Page): Frame {
		const frame = page.frames().find((candidate) => candidate.parentFrame() === page.mainFrame())
		if (frame === undefined) {
			throw new Error('the archive frame did not load')
		}
		return frame
	}

	test('A. opening a local .webarchive is intercepted and lands in the viewer', async () => {
		const page = await openArchive(capturedWebArchiveUrl)
		assert.equal(new URL(page.url()).protocol, 'chrome-extension:')
		assert.equal(new URL(page.url()).pathname, '/viewer.html')
		assert.equal(new URL(page.url()).hash, `#${capturedWebArchiveUrl}`)
		assert.equal(await page.title(), 'captured.webarchive — ArchiveBridge')
		assert.equal(await page.locator('#failure').isVisible(), false)
		assert.equal(await page.locator('#archive').isVisible(), true)
		await page.close()
	})

	test('A. the viewer names the archive and stays out of the way otherwise', async () => {
		const page = await openArchive(capturedWebArchiveUrl)
		assert.match((await page.locator('#source').textContent()) ?? '', /^captured\.webarchive — \d+ documents?, \d+ resources?$/)
		// No archive library, no history, no conversion buttons, no settings: the
		// notes toggle is the only control the viewer's own chrome has at all,
		// and a clean archive does not even show that.
		assert.deepEqual(await page.locator('button, input, select, textarea, a').evaluateAll((elements) => elements.map((element) => element.id)), ['notes-toggle'])
		assert.equal(await page.locator('#notes-toggle').isVisible(), false)
		assert.equal(await page.locator('#notes').isVisible(), false)
		await page.close()
	})

	test('B. an unrelated file:// navigation is left completely alone', async () => {
		const page = await session.context.newPage()
		await page.goto(plainTextUrl, { waitUntil: 'load' })
		assert.equal(page.url(), plainTextUrl)
		assert.equal(await page.evaluate(() => document.body.textContent), 'just a note')
		await page.close()
	})

	test('B. a file that merely contains .webarchive in its name is not intercepted', async () => {
		const page = await session.context.newPage()
		await page.goto(decoyUrl, { waitUntil: 'load' })
		assert.equal(page.url(), decoyUrl)
		await page.close()
	})

	test('C. .mhtml is left to Chrome, which still renders it natively', async () => {
		const page = await session.context.newPage()
		await page.goto(capturedMhtmlUrl, { waitUntil: 'load' })
		assert.equal(page.url(), capturedMhtmlUrl, 'the viewer must not pre-empt Chrome native MHTML rendering')
		// Chrome's native MHTML rendering presents the archive as an ordinary
		// document: `text/html`, not the `multipart/related` the file is.
		assert.equal(await page.evaluate(() => document.contentType), 'text/html')
		assert.equal(await page.evaluate(() => document.getElementById('heading')?.textContent), 'viewer fixture')
		await page.close()
	})

	test('D+E+F. the archived page, its image and its stylesheet all render from archived bytes', async () => {
		const page = await openArchive(capturedWebArchiveUrl)
		const rendered = await archiveFrame(page).evaluate(() => ({
			heading: document.getElementById('heading')?.textContent ?? null,
			headingColor: getComputedStyle(document.getElementById('heading') as Element).color,
			imageWidth: (document.getElementById('image') as HTMLImageElement | null)?.naturalWidth ?? null,
			imageScheme: ((document.getElementById('image') as HTMLImageElement | null)?.currentSrc ?? '').split(':')[0] ?? null,
			paintedWidth: getComputedStyle(document.getElementById('painted') as Element).width,
			paintedBackground: getComputedStyle(document.getElementById('painted') as Element).backgroundImage.slice(0, 9),
		}))
		assert.equal(rendered.heading, 'viewer fixture')
		// rgb(1, 2, 3) is in the archived stylesheet and nowhere else.
		assert.equal(rendered.headingColor, 'rgb(1, 2, 3)')
		assert.equal(rendered.imageWidth, 1024, 'the archived PNG did not decode')
		assert.equal(rendered.imageScheme, 'blob')
		// The width and the background both come from a url() inside that stylesheet.
		assert.equal(rendered.paintedWidth, '11px')
		assert.equal(rendered.paintedBackground, 'url("blob')
		await page.close()
	})

	test('H. an archived nested frame renders its own archived document', async () => {
		const page = await openArchive(capturedWebArchiveUrl)
		assert.equal(await page.frameLocator('#archive').frameLocator('#frame').locator('#framed').textContent(), 'framed content')
		assert.match((await archiveFrame(page).locator('#frame').getAttribute('src')) ?? '', /^blob:chrome-extension:\/\//)
		await page.close()
	})

	test('Q. Blink shadowmode markup becomes a working declarative shadow root, resources and all', async () => {
		const page = await openArchive(capturedWebArchiveUrl)
		const shadow = await archiveFrame(page).evaluate(() => {
			const root = document.getElementById('shadow-host')?.shadowRoot ?? null
			return {
				text: root?.getElementById('in-shadow')?.textContent ?? null,
				imageWidth: (root?.getElementById('shadow-image') as HTMLImageElement | null)?.naturalWidth ?? null,
				// A template still sitting in the light DOM means nothing hydrated.
				templateLeft: document.querySelector('#shadow-host template') !== null,
				legacyAttributeLeft: document.querySelector('[shadowmode]') !== null,
			}
		})
		assert.equal(shadow.text, 'shadow content', 'the captured shadow root did not hydrate')
		assert.equal(shadow.imageWidth, 1024, 'a resource inside the shadow root was not resolved')
		assert.equal(shadow.templateLeft, false)
		assert.equal(shadow.legacyAttributeLeft, false)
		await page.close()
	})

	test('G. a font, an @import chain, a data: URL and a srcset all resolve to archived bytes', async () => {
		const page = await openArchive(resourceUrl)
		const resolved = await archiveFrame(page).evaluate(() => {
			const rules = [...document.styleSheets].flatMap((sheet) => [...sheet.cssRules].map((rule) => rule.cssText))
			return {
				fontSource: rules.find((rule) => rule.includes('@font-face'))?.match(/url\("?([^")]+)"?\)/)?.[1] ?? null,
				importedColor: getComputedStyle(document.getElementById('imported') as Element).color,
				typefaceColor: getComputedStyle(document.getElementById('typeface') as Element).color,
				inlineStyledWidth: getComputedStyle(document.getElementById('inline-styled') as Element).width,
				dataImageWidth: (document.getElementById('inline-data') as HTMLImageElement | null)?.naturalWidth ?? null,
				responsiveWidth: (document.getElementById('responsive') as HTMLImageElement | null)?.naturalWidth ?? null,
			}
		})
		// The @font-face src points at the archive's own font bytes rather than
		// at about:invalid, which is what "the font resolved" means here.
		assert.match(resolved.fontSource ?? '', /^blob:chrome-extension:\/\//)
		assert.equal(resolved.importedColor, 'rgb(7, 8, 9)', 'the @import chain did not apply')
		assert.equal(resolved.typefaceColor, 'rgb(4, 5, 6)')
		assert.equal(resolved.inlineStyledWidth, '13px')
		assert.equal(resolved.dataImageWidth, 1, 'an archived data: URL should still work')
		assert.equal(resolved.responsiveWidth, 1)
		await page.close()
	})

	test('I. a resource the archive does not contain stays missing, and is reported rather than fetched', async () => {
		server.resetTraffic()
		const page = await openArchive(resourceUrl)
		const absent = await archiveFrame(page).evaluate(() => ({
			width: (document.getElementById('absent') as HTMLImageElement | null)?.naturalWidth ?? null,
			src: document.getElementById('absent')?.getAttribute('src') ?? null,
		}))
		assert.equal(absent.width, 0)
		assert.equal(absent.src, 'about:invalid', 'a missing resource must not keep a URL that could be fetched')
		assert.deepEqual(server.requests, [])
		assert.equal(server.connectionCount(), 0)

		// And the viewer says so, rather than failing silently.
		await page.locator('#notes-toggle').click()
		assert.match((await page.locator('#notes').textContent()) ?? '', /Not in this archive: .*absent\.gif/)
		await page.close()
	})

	test('J+N. a hostile archive reaches the network zero times, by request and by connection', async () => {
		server.resetTraffic()
		const page = await openArchive(hostileUrl)
		await page.waitForTimeout(1500)
		assert.deepEqual(server.requests, [], 'the viewer made HTTP requests for archived content')
		assert.equal(server.connectionCount(), 0, 'the viewer opened a TCP connection for archived content')
		await page.close()
	})

	test('K+L+M. no archived script runs: not inline, not archived-and-resolvable, not an event handler, not a javascript: URL', async () => {
		server.resetTraffic()
		const page = await openArchive(hostileUrl)
		await page.waitForTimeout(800)
		const evidence = await archiveFrame(page).evaluate(() => ({
			title: document.title,
			inlineScriptRan: document.documentElement.getAttribute('data-inline-script'),
			handlerRan: document.documentElement.getAttribute('data-handler'),
			javascriptUrlRan: document.documentElement.getAttribute('data-js-url'),
			scriptSources: [...document.querySelectorAll('script[src]')].map((element) => element.getAttribute('src')),
			handlerAttribute: document.getElementById('handler-image')?.getAttribute('onerror') ?? null,
			preservedHandler: document.getElementById('handler-image')?.getAttribute('data-archivebridge-onerror') ?? null,
			javascriptLink: document.getElementById('javascript-link')?.getAttribute('href') ?? null,
		}))
		assert.equal(evidence.title, 'ORIGINAL_TITLE', 'an archived script changed the document')
		assert.equal(evidence.inlineScriptRan, null)
		assert.equal(evidence.handlerRan, null)
		assert.equal(evidence.javascriptUrlRan, null)
		// One of these two is a script the archive genuinely contains the bytes
		// for. Having the bytes is not a reason to load it.
		assert.deepEqual(evidence.scriptSources, ['about:invalid', 'about:invalid'])
		assert.equal(evidence.handlerAttribute, null, 'an inline handler attribute survived into the rendered document')
		assert.match(evidence.preservedHandler ?? '', /fetch/)
		assert.equal(evidence.javascriptLink, '#')
		assert.deepEqual(server.requests, [])
		assert.equal(server.connectionCount(), 0)
		await page.close()
	})

	test('J. every external reference in the hostile archive is inert in the rendered document', async () => {
		const page = await openArchive(hostileUrl)
		const references = await archiveFrame(page).evaluate(() => {
			const attribute = (selector: string, name: string) => document.querySelector(selector)?.getAttribute(name) ?? null
			return {
				neutralized: {
					stylesheet: attribute('link[rel=stylesheet]', 'href'),
					preconnect: attribute('link[rel=preconnect]', 'href'),
					dnsPrefetch: attribute('link[rel=dns-prefetch]', 'href'),
					preload: attribute('link[rel=preload]', 'href'),
					icon: attribute('link[rel=icon]', 'href'),
					missingImage: attribute('#missing-image', 'src'),
					externalFrame: attribute('#external-frame', 'src'),
					object: attribute('#object-content', 'data'),
					embed: attribute('#embed-content', 'src'),
					formAction: attribute('#escape-form', 'action'),
					svgImage: attribute('#svg-image', 'href'),
					poster: attribute('#media', 'poster'),
					mediaSource: attribute('#media source', 'src'),
				},
				srcset: attribute('#responsive-missing', 'srcset'),
				topLink: attribute('#top-link', 'href'),
				topLinkOriginal: attribute('#top-link', 'data-archivebridge-href'),
				srcdocFrame: attribute('#srcdoc-frame', 'srcdoc'),
				metaRefresh: attribute('meta[http-equiv=refresh]', 'content'),
				archivedCsp: attribute('meta[http-equiv="Content-Security-Policy"]', 'content'),
				baseHref: attribute('base', 'href'),
				preservedBase: attribute('base', 'data-archivebridge-base-href'),
				styleText: document.querySelector('style')?.textContent ?? null,
			}
		})
		for (const [name, value] of Object.entries(references.neutralized)) {
			assert.equal(value, 'about:invalid', `${name} was left pointing outward: ${value}`)
		}
		// Both candidates were missing, so both became the same inert URL and the
		// duplicate collapsed — see `formatSrcset` in the library's renderer.
		assert.equal(references.srcset, 'about:invalid 1x')
		assert.equal(references.topLink, '#')
		assert.match(references.topLinkOriginal ?? '', /top-navigation$/)
		assert.equal(references.metaRefresh, '', 'an archived meta refresh must not survive')
		assert.equal(references.archivedCsp, '', "an archived page's own CSP must not survive")
		assert.equal(references.baseHref, null, 'an archived <base href> must not survive into the rendered document')
		assert.match(references.preservedBase ?? '', /\/base\/$/)
		assert.doesNotMatch(references.styleText ?? '', /127\.0\.0\.1/, 'a url() or @import in an archived <style> was left pointing outward')
		assert.doesNotMatch(references.srcdocFrame ?? '', /127\.0\.0\.1/, 'an archived iframe srcdoc was shipped unrewritten')
		await page.close()
	})

	test('O. a form inside the archive cannot submit, even when a real click submits it', async () => {
		server.resetTraffic()
		const page = await openArchive(hostileUrl)
		const before = page.url()
		const pagesBefore = session.context.pages().length
		await page.frameLocator('#archive').locator('#submit-button').click()
		await page.waitForTimeout(800)
		assert.equal(page.url(), before, 'submitting the archived form navigated the viewer')
		assert.equal(session.context.pages().length, pagesBefore)
		assert.deepEqual(server.requests, [])
		assert.equal(server.connectionCount(), 0)
		// The archive is still on screen: nothing was torn down by the attempt.
		assert.equal(await page.frameLocator('#archive').locator('#marker').textContent(), 'hostile archive')
		await page.close()
	})

	test('P. clicking an archived link escapes neither the frame, the tab, nor the machine', async () => {
		server.resetTraffic()
		const page = await openArchive(hostileUrl)
		const before = page.url()
		const pagesBefore = session.context.pages().length
		for (const id of ['#top-link', '#blank-link', '#javascript-link']) {
			await page.frameLocator('#archive').locator(id).click()
			await page.waitForTimeout(400)
		}
		assert.equal(page.url(), before, 'an archived link navigated the viewer tab')
		assert.equal(session.context.pages().length, pagesBefore, 'an archived link opened a window')
		assert.deepEqual(server.requests, [])
		assert.equal(server.connectionCount(), 0)
		assert.equal(await page.frameLocator('#archive').locator('#marker').textContent(), 'hostile archive')
		await page.close()
	})

	test('the archive frame is sandboxed exactly as the policy says, and runs nothing at all', async () => {
		const page = await openArchive(hostileUrl)
		assert.equal(await page.locator('#archive').getAttribute('sandbox'), 'allow-same-origin')
		// `allow-same-origin` is what lets the frame load the viewer's blob URLs,
		// and it does put the frame on the extension's origin — where a
		// `chrome.runtime` object exists. Without `allow-scripts` there is no code
		// that could ever reach it, and that is the property asserted here: the
		// archive's own script elements are present and none of them ran.
		const inert = await archiveFrame(page).evaluate(() => ({
			title: document.title,
			scriptElements: document.querySelectorAll('script').length,
			ranAnything:
				document.documentElement.hasAttribute('data-inline-script') ||
				document.documentElement.hasAttribute('data-handler') ||
				document.documentElement.hasAttribute('data-js-url'),
			inlineScriptText: document.getElementById('inline-script')?.textContent?.includes('fetch(') ?? false,
		}))
		assert.equal(inert.title, 'ORIGINAL_TITLE')
		assert.ok(inert.scriptElements > 0, 'the fixture should still contain script elements; they simply never run')
		assert.equal(inert.inlineScriptText, true, 'the inline script body is still there, and still inert')
		assert.equal(inert.ranAnything, false)
		await page.close()
	})

	test('R. a malformed archive produces a plain message, not a blank page and not an escape', async () => {
		server.resetTraffic()
		const page = await openArchive(malformedUrl)
		assert.equal(await page.locator('#failure').isVisible(), true)
		assert.equal(await page.locator('#archive').isVisible(), false)
		assert.equal(await page.locator('#failure-title').textContent(), 'Could not read the archive')
		assert.match((await page.locator('#failure-detail').textContent()) ?? '', /could not be parsed/)
		assert.equal(page.url().startsWith('chrome-extension://'), true)
		assert.deepEqual(server.requests, [])
		await page.close()
	})

	test('R. a source the viewer was never meant to open is refused by name', async () => {
		const page = await session.context.newPage()
		await page.goto(`chrome-extension://${session.extensionId}/viewer.html#https://example.invalid/x.webarchive`, { waitUntil: 'load' })
		await page.waitForTimeout(400)
		assert.equal(await page.locator('#failure-title').textContent(), 'Not a local archive')
		assert.equal(await page.locator('#archive').isVisible(), false)
		await page.close()
	})

	test('R. a .webarchive that is not on disk fails with a readable message', async () => {
		const page = await openArchive(capturedWebArchiveUrl.replace('captured.webarchive', 'no-such-file.webarchive'))
		assert.equal(await page.locator('#failure-title').textContent(), 'Could not read the archive')
		await page.close()
	})

	test('S. Chrome grants this session file access, and the viewer really consults that API', async () => {
		// The `--load-extension` harness grants "Allow access to file URLs"
		// unconditionally, and re-grants it on every launch (measured: patching
		// the profile preference off does not survive a relaunch), so the
		// *denied* branch is not reachable from an automated session. Its message
		// is covered in `src/core/viewer-source.test.ts` and its Chrome-specific
		// remedy in `chrome/local-archive.ts`. What is testable here is that the
		// API the viewer branches on exists and answers.
		const allowed = await session.serviceWorker.evaluate(async () => await chrome.extension.isAllowedFileSchemeAccess())
		assert.equal(allowed, true)
		// With access granted, the popup says nothing about it.
		const popup = await session.context.newPage()
		await popup.goto(`chrome-extension://${session.extensionId}/popup.html`)
		await popup.waitForTimeout(300)
		assert.equal(await popup.locator('#file-access').isVisible(), false)
		await popup.close()
	})

	test('T. moving to another archive releases the previous archive resource URLs', async () => {
		const page = await openArchive(capturedWebArchiveUrl)
		const firstImageUrl = (await archiveFrame(page).locator('#image').getAttribute('src')) ?? ''
		assert.match(firstImageUrl, /^blob:chrome-extension:\/\//)

		/** A live object URL decodes as an image; a revoked one cannot. `img-src blob:` is in the policy, so this distinguishes revocation from a CSP refusal. */
		const loads = async (url: string): Promise<boolean> =>
			await page.evaluate(
				async (candidate) =>
					await new Promise<boolean>((resolve) => {
						const probe = new Image()
						probe.addEventListener('load', () => resolve(true), { once: true })
						probe.addEventListener('error', () => resolve(false), { once: true })
						probe.src = candidate
					}),
				url,
			)
		assert.equal(await loads(firstImageUrl), true, 'the probe cannot tell a live URL from a revoked one')

		// Opening another archive in an open viewer tab changes only the
		// fragment, so nothing tears the document down and this code is what has
		// to release the previous load's URLs.
		await page.goto(`${page.url().split('#')[0] ?? ''}#${secondUrl}`)
		await page.waitForFunction(() => document.title.startsWith('second.webarchive'), undefined, { timeout: 10_000 })
		await page.waitForTimeout(500)

		assert.equal(await page.frameLocator('#archive').locator('#second-marker').textContent(), 'second archive')
		assert.equal(await loads(firstImageUrl), false, 'the previous archive resource URLs were not released')
		await page.close()
	})

	// The vectors below need no script at all, so "no allow-scripts" does not
	// cover them. Each was measured to load in Chromium 153 and to defeat the
	// rewrite before it handled them — at which point only the CSP stopped
	// them, which is the wrong layer to be relying on (docs/architecture.md:
	// "the rewrite is the primary mechanism and the CSP is the backstop").

	test('U. escaped CSS spellings and image-set strings are rewritten, not left for the CSP', async () => {
		server.resetTraffic()
		const page = await openArchive(hostileUrl)
		await page.waitForTimeout(800)
		const sheets = await archiveFrame(page).evaluate(() => [...document.querySelectorAll('style')].map((element) => element.textContent ?? ''))
		const all = sheets.join('\n')
		// Every one of these is a live URL only if the scanner missed it.
		assert.doesNotMatch(all, /127\.0\.0\.1/, 'an escaped url()/@import or an image-set string kept its original URL')
		// Eight escaped/bare-string/substituted references, the two plainly
		// spelled ones in the same sheet, and the `data:text/css` import, all
		// inert. Counting them is what distinguishes "rewritten" from "the whole
		// stylesheet failed to arrive".
		assert.equal(all.match(/about:invalid/g)?.length, 11, 'not every reference in the archived stylesheets was rewritten')
		assert.deepEqual(server.requests, [])
		assert.equal(server.connectionCount(), 0)
		await page.close()
	})

	test('V. SVG declarative animation cannot put a neutralized reference back', async () => {
		server.resetTraffic()
		const page = await openArchive(hostileUrl)
		// SMIL begins at 0s; a real click is what the event-timed one waits for.
		await page
			.frameLocator('#archive')
			.locator('#smil-event')
			.click({ force: true })
			.catch(() => {})
		await page.waitForTimeout(1500)
		const smil = await archiveFrame(page).evaluate(() => {
			const attribute = (selector: string, name: string) => document.querySelector(selector)?.getAttribute(name) ?? null
			return {
				setHref: attribute('#smil-set', 'href'),
				animateHref: attribute('#smil-animate', 'href'),
				targetHref: attribute('#smil-target', 'href'),
				// The operative attributes must be gone from the animation elements.
				liveAttributeNames: [...document.querySelectorAll('set, animate, animateTransform, animateMotion')].flatMap((element) =>
					[...element.attributes].map((attr) => attr.name).filter((name) => ['attributename', 'to', 'from', 'by', 'values'].includes(name.toLowerCase())),
				),
				preserved: attribute('#smil-external', 'data-archivebridge-attributename'),
			}
		})
		assert.equal(smil.setHref, 'about:invalid')
		assert.equal(smil.animateHref, 'about:invalid')
		assert.equal(smil.targetHref, 'about:invalid')
		assert.deepEqual(smil.liveAttributeNames, [], 'an SVG animation element kept an attribute that lets it assign a URL')
		// Renamed rather than deleted, so the reconstructed document still shows what was captured.
		assert.equal(smil.preserved, 'href')
		assert.deepEqual(server.requests, [], 'SMIL reached the network')
		assert.equal(server.connectionCount(), 0)
		await page.close()
	})

	test('W. the obsolete background attribute is rewritten wherever Chromium honors it', async () => {
		server.resetTraffic()
		const page = await openArchive(hostileUrl)
		await page.waitForTimeout(500)
		const backgrounds = await archiveFrame(page).evaluate(() =>
			['body', '#table-background', '#tbody-background', '#tr-background', '#td-background'].map(
				(selector) => document.querySelector(selector)?.getAttribute('background') ?? null,
			),
		)
		assert.deepEqual(backgrounds, ['about:invalid', 'about:invalid', 'about:invalid', 'about:invalid', 'about:invalid'])
		assert.deepEqual(server.requests, [])
		assert.equal(server.connectionCount(), 0)
		await page.close()
	})

	test('X. the hostile archive sends no external reference to the CSP backstop, because the rewrite got there first', async () => {
		// The strongest form of "the rewrite is the primary mechanism": every
		// statically identifiable external reference in the hostile fixture is
		// rewritten before it reaches the CSP, so none of them shows up as a
		// violation naming the beacon server. That is zero external-reference
		// CSP violations, not a claim that the page logs zero CSP violations of
		// any kind.
		server.resetTraffic()
		const page = await session.context.newPage()
		const violations: string[] = []
		page.on('console', (message) => {
			if (/violates the following Content Security Policy/.test(message.text())) {
				violations.push(message.text())
			}
		})
		await page.goto(hostileUrl, { waitUntil: 'load' })
		await page.waitForTimeout(2500)
		const external = violations.filter((text) => text.includes('127.0.0.1'))
		assert.deepEqual(external, [], 'a reference reached the CSP backstop instead of being rewritten away')
		assert.deepEqual(server.requests, [])
		assert.equal(server.connectionCount(), 0)
		await page.close()
	})

	test('Y. a reference that cannot be rewritten refuses the document instead of shipping it live', async () => {
		server.resetTraffic()
		const page = await openArchive(unrewritableUrl)
		await page.waitForTimeout(800)
		// No archive frame at all: the document was never handed to the browser.
		assert.equal(await page.locator('#archive').isVisible(), false)
		assert.equal(await page.locator('#failure').isVisible(), true)
		assert.equal(await page.locator('#archive').getAttribute('src'), null, 'the refused document was still pointed at')
		// And the viewer says why, rather than failing blankly.
		const notes = (await page.locator('#notes').textContent()) ?? ''
		assert.match(notes, /could not be rewritten/)
		assert.deepEqual(server.requests, [], 'the unrewritable reference was fetched')
		assert.equal(server.connectionCount(), 0)
		await page.close()
	})

	test('Z. an archived external SVG <use> is refused, while a same-document one still renders', async () => {
		// A <use> naming another document is the one SVG reference Chromium
		// instantiates *in this document*: measured in Chromium 153, the
		// referenced <symbol>'s own <image href="http://…"> and
		// fill="url(http://…)" load from the referenced file's bytes, which this
		// viewer mints as an opaque resource and never rewrites. Inside the
		// viewer, only the CSP stopped it before this refusal existed.
		server.resetTraffic()
		const page = await openArchive(hostileUrl)
		await page.waitForTimeout(800)
		const uses = await archiveFrame(page).evaluate(() => ({
			external: document.getElementById('use-external')?.getAttribute('href') ?? null,
			xlink: document.getElementById('use-xlink')?.getAttribute('xlink:href') ?? null,
			local: document.getElementById('use-local')?.getAttribute('href') ?? null,
			// The symbol a same-document <use> clones is part of this document, so
			// its reference was rewritten to archived bytes and still renders.
			localImage: document.getElementById('use-local-image')?.getAttribute('href') ?? null,
		}))
		assert.equal(uses.external, 'about:invalid', 'an archived SVG document was still instantiated by <use>')
		assert.equal(uses.xlink, 'about:invalid')
		assert.equal(uses.local, '#local-symbol', 'a same-document <use> must keep working')
		assert.match(uses.localImage ?? '', /^blob:chrome-extension:\/\//)
		assert.deepEqual(server.requests, [], 'a reference inside an archived SVG reached the network')
		assert.equal(server.connectionCount(), 0)
		// The refusal is reported, not silent.
		await page.locator('#notes-toggle').click()
		assert.match((await page.locator('#notes').textContent()) ?? '', /Not loaded \(nested-content\)/)
		await page.close()
	})

	test('Z. a url() in an SVG presentation attribute is rewritten, not left for the CSP', async () => {
		server.resetTraffic()
		const page = await openArchive(hostileUrl)
		await page.waitForTimeout(800)
		const presentation = await archiveFrame(page).evaluate(() => {
			const attribute = (id: string, name: string) => document.getElementById(id)?.getAttribute(name) ?? null
			return [
				attribute('pres-fill', 'fill'),
				attribute('pres-stroke', 'stroke'),
				attribute('pres-effects', 'filter'),
				attribute('pres-effects', 'mask'),
				attribute('pres-effects', 'clip-path'),
				attribute('pres-markers', 'marker-start'),
				attribute('pres-markers', 'marker-mid'),
				attribute('pres-markers', 'marker-end'),
			]
		})
		assert.deepEqual(
			presentation,
			Array.from({ length: 8 }, () => 'url("about:invalid")'),
		)
		assert.deepEqual(server.requests, [])
		assert.equal(server.connectionCount(), 0)
		await page.close()
	})

	test('Z. a data: stylesheet and a data: frame are refused, because their nested content is live', async () => {
		// Both are "self-contained" only in the sense that the bytes travel with
		// the URL. Measured in Chromium 153 outside the viewer: a data:text/css
		// sheet loads its own @import and url() to any origin (and nests a
		// further data: sheet inside itself), and a data:text/html frame loads
		// its images and runs its script. A data: *image* cannot reach anything
		// — which is why those are still kept verbatim, asserted by test G.
		server.resetTraffic()
		const page = await openArchive(hostileUrl)
		await page.waitForTimeout(800)
		const nested = await archiveFrame(page).evaluate(() => ({
			stylesheet: document.getElementById('data-stylesheet')?.getAttribute('href') ?? null,
			frame: document.getElementById('data-frame')?.getAttribute('src') ?? null,
			imports: [...document.querySelectorAll('style')].map((element) => element.textContent ?? '').join('\n'),
		}))
		assert.equal(nested.stylesheet, 'about:invalid')
		assert.equal(nested.frame, 'about:invalid')
		assert.doesNotMatch(nested.imports, /data:text\/css/, 'a data: stylesheet survived into an @import')
		assert.deepEqual(server.requests, [])
		assert.equal(server.connectionCount(), 0)
		await page.close()
	})

	test('Z. the one construct the rewrite cannot see is stopped by the CSP, and that is visible in both directions', async () => {
		// The honest counterpart to test X. A bare string in image-set() is a
		// URL, and the cascade can carry that string from another rule, another
		// sheet, an inline style or an @property initial value — so whether it
		// is a reference at all is a question about custom-property
		// substitution rather than about this stylesheet's text. All five
		// shapes in the fixture were measured to load in Chromium 153.
		//
		// The assertions prove *both* halves, which is the point: the URL is
		// still in the rendered stylesheet (nothing pretends to have rewritten
		// it), Chromium really computed it into an image URL (so this is a live
		// load, not an unparsed value), the CSP refused every one of them by
		// name, and the server saw neither a request nor a connection.
		server.resetTraffic()
		const page = await session.context.newPage()
		const violations: string[] = []
		page.on('console', (message) => {
			if (/violates the following Content Security Policy/.test(message.text())) {
				violations.push(message.text())
			}
		})
		await page.goto(cspBackstopUrl, { waitUntil: 'load' })
		await page.waitForFunction(() => document.getElementById('archive')?.hasAttribute('src') === true, undefined, { timeout: 30_000 })
		await page.waitForTimeout(2000)

		const computed = await archiveFrame(page).evaluate(() => ({
			styleText: document.querySelector('style')?.textContent ?? '',
			backgrounds: ['cascade-var', 'cascade-webkit', 'cascade-property', 'cascade-inline'].map((id) => {
				const element = document.getElementById(id)
				return element === null ? 'MISSING' : getComputedStyle(element).backgroundImage
			}),
			mask: getComputedStyle(document.getElementById('cascade-mask') as Element).maskImage,
		}))

		// Not rewritten: the reconstruction layer never claimed to have removed it.
		assert.match(computed.styleText, /--cascade:"http:\/\/127\.0\.0\.1/)
		// And really live: Chromium substituted the string into an image URL.
		for (const background of computed.backgrounds) {
			assert.match(background, /^image-set\(url\("http:\/\/127\.0\.0\.1/, `the cascade case did not compute to a live image URL: ${background}`)
		}
		assert.match(computed.mask, /^image-set\(url\("http:\/\/127\.0\.0\.1/)
		// Stopped by the backstop, by name, for every one of them.
		const blockedImages = violations.filter((text) => text.includes('img-src blob: data:') && text.includes('127.0.0.1'))
		assert.equal(blockedImages.length, 5, `expected every cascade-hidden image to be refused by img-src, saw ${violations.length} violations`)
		// Which is what the counters have to agree with.
		assert.deepEqual(server.requests, [], 'the CSP let a cascade-hidden image reach the network')
		assert.equal(server.connectionCount(), 0, 'the CSP let a cascade-hidden image open a connection')
		await page.close()
	})

	test('the manifest asks for exactly the permissions the viewer needs, and no web origins', async () => {
		const manifest = JSON.parse(await readFile(join(builtExtensionDir, 'manifest.json'), 'utf8')) as {
			permissions?: readonly string[]
			host_permissions?: readonly string[]
			optional_host_permissions?: unknown
			web_accessible_resources?: unknown
		}
		assert.deepEqual(manifest.permissions, ['pageCapture', 'downloads', 'offscreen', 'contextMenus', 'declarativeNetRequest'])
		// `file:///*` is needed twice over: a declarativeNetRequest redirect
		// requires host permission for the request URL, and the viewer has to
		// read the bytes. It stays gated behind the user's own "Allow access to
		// file URLs" toggle either way, and it admits no web origin.
		assert.deepEqual(manifest.host_permissions, ['file:///*'])
		assert.equal(manifest.optional_host_permissions, undefined)
		// A browser-initiated redirect needs no web-accessible resource —
		// Chromium's navigation throttle proceeds when a navigation has no
		// initiator origin, which a double-click or an omnibox entry does not.
		// See chrome/file-interception.ts for what that does and does not cover
		// (a click from another local file is the measured limit).
		assert.equal(manifest.web_accessible_resources, undefined)

		const granted = await session.serviceWorker.evaluate(async () => await chrome.permissions.getAll())
		assert.deepEqual(granted.origins, ['file:///*'])
		assert.deepEqual([...(granted.permissions ?? [])].sort(), ['contextMenus', 'declarativeNetRequest', 'downloads', 'offscreen', 'pageCapture'])
	})

	test('the interception rule Chrome holds is the one the extension asked for', async () => {
		const rules = await session.serviceWorker.evaluate(async () => await chrome.declarativeNetRequest.getDynamicRules())
		assert.equal(rules.length, 1)
		const [rule] = rules
		assert.equal(rule?.condition.regexFilter, String.raw`^file:///.*\.webarchive$`)
		assert.deepEqual(rule?.condition.resourceTypes, ['main_frame'], 'only a top-level navigation may become a viewer')
		assert.equal(rule?.condition.isUrlFilterCaseSensitive, false)
		assert.equal(rule?.action.redirect.regexSubstitution, `chrome-extension://${session.extensionId}/viewer.html#\\0`)
	})

	test('a file name full of URL punctuation survives the redirect intact', async () => {
		// Chromium percent-encodes `#`, `?`, `%` and space in a file URL and
		// leaves `&`, `=` and `+` literal — which is exactly why the source
		// travels in the fragment rather than in a query parameter.
		const awkward = await writeFixture(fixtures, 'a &b=c+d %25 #x?y.webarchive', buildSecondWebArchive())
		const page = await openArchive(awkward)
		assert.equal(new URL(page.url()).hash, `#${awkward}`)
		assert.equal(await page.frameLocator('#archive').locator('#second-marker').textContent(), 'second archive')
		assert.match((await page.locator('#source').textContent()) ?? '', /^a &b=c\+d %25 #x\?y\.webarchive/)
		await page.close()
	})

	test('an uppercase extension is intercepted too', async () => {
		const upper = await writeFixture(fixtures, 'SHOUTING.WEBARCHIVE', buildSecondWebArchive())
		const page = await openArchive(upper)
		assert.equal(new URL(page.url()).protocol, 'chrome-extension:')
		assert.equal(await page.frameLocator('#archive').locator('#second-marker').textContent(), 'second archive')
		await page.close()
	})
})
