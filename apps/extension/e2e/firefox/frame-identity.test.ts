/**
 * Firefox frame identity, measured in a real Firefox against a real
 * multi-frame page.
 *
 * **This file is a gate, not a feature test.** Firefox frame capture must
 * join two different things: which browsing context a captured child belongs
 * to — its frame/container identity — and where its container sits in the
 * serialized HTML that archived markup gets rewritten against. The second
 * is still answered by *position*: a container's ordinal in that
 * serialized snapshot, because a rewrite of archived markup has nothing
 * else to see. The first was assumed to need position too, since two
 * frames can share a `src`, a `srcdoc` frame has none, and a frame may
 * have navigated since load. That old positional join for identity spans
 * four numbers that no single vantage point can see at once:
 *
 * ```text
 *   InjectionResult.frameId          seen only by the extension
 *     ↕
 *   index in window.parent.frames    seen only by the child
 *     ↕
 *   index of container.contentWindow seen only by the parent
 *     in window.frames
 *     ↕
 *   the container's ordinal in the   seen only by whatever rewrites the
 *   serialized HTML                  archived markup
 * ```
 *
 * Every assertion here is about **Firefox**, never about ArchiveBridge's
 * frame capture — which does not exist yet and must not be designed until
 * these hold. So the test injects a throwaway probe of its own rather than
 * production code, and asserts the browser behaviours a future
 * implementation is *allowed to depend on*. If a future Firefox changes one
 * of them, this file is where that has to surface, loudly, before it
 * surfaces as a silently mis-linked archive.
 *
 * Two of those assertions exist specifically because the numbers above are
 * **not** interchangeable, and the fixture is built to prove it (see
 * `test-page.ts`'s `FRAME_IDENTITY_PATH` doc):
 *
 * - an `<object>`/`<embed>` pair placed before every `<iframe>` in the
 *   document nevertheless takes the *last* browsing-context indices
 *   without being a frame container — and which of the two takes which is
 *   not even stable across page loads — so container ordinal and
 *   browsing-context index are provably different numbers;
 * - an `<iframe>` inside an open shadow root is invisible to
 *   `document.querySelectorAll` but present in the serialized snapshot, so
 *   a light-DOM ordinal and the ordinal the library's positional rewrite
 *   counts in provably diverge.
 *
 * The one thing measured through production code is that last link: the
 * serialized HTML comes from the real `capturePageState`, and the ordinals
 * are resolved with the real `rewriteFrameContainerSrcAttributes`, because
 * an ordinal agreed on by a probe and a different parser would prove
 * nothing about the code that will actually do the rewriting.
 *
 * **Tests A–L are that measurement, and G is its verdict: the positional
 * join does not hold.** Tests M–V measure a different primitive entirely,
 * `browser.runtime.getFrameId(target)`, which Firefox documents as taking
 * a `WindowProxy`, an `<iframe>`, a `<frame>`, an `<object>` or an
 * `<embed>` and returning that frame's id. If the id it returns is the
 * same id `scripting.executeScript` reports, the four-number chain above
 * collapses into two links that no one has to infer:
 *
 * ```text
 *   InjectionResult.frameId          seen by the extension
 *     ↕ the same number, measured in both places
 *   runtime.getFrameId(container)    seen by the container's own document,
 *                                    which also knows that container's
 *                                    ordinal in what it just serialized
 * ```
 *
 * The browsing-context indices vanish from the join, and with them every
 * case the fixture proves they get wrong. What replaces them is not
 * "usually matching ids" — test P is the actual condition: each reached
 * document is claimed by **exactly one** container, in the document that
 * document itself calls its parent. Test U is the other half, and the one
 * that constrains the design rather than the browser: the ordinals move
 * under a page that reorders its own frames while the ids do not, so the
 * two have to be read in the same pass to mean anything together.
 *
 * None of this is a licence to build Phase 2 on `getFrameId` — see
 * `docs/research/` for what these runs do and do not establish. It is
 * here so that a Firefox which changes any of it fails this file first.
 */

import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, before, describe, test } from 'node:test'
import { rewriteFrameContainerSrcAttributes } from '@xarsh/archivebridge'
import { PAGE_CAPTURE_LIMITS } from '../../src/firefox/capture-limits.ts'
import { capturePageState } from '../../src/firefox/page-capture.ts'
import {
	FRAME_IDENTITY_FAILED_URL,
	FRAME_IDENTITY_FRAMESET_PATH,
	FRAME_IDENTITY_FRAMESET_READY_TITLE,
	FRAME_IDENTITY_MARKERS,
	FRAME_IDENTITY_PATH,
	FRAME_IDENTITY_READY_TITLE,
	startTestServer,
	type TestServer,
} from '../test-page.ts'
import { openProbeSession, type ProbeSession, type ProbedInjection as SharedProbedInjection, type ProbeRun as SharedProbeRun } from './probe-session.ts'

/**
 * What one frame reports about itself and its own direct containers.
 *
 * The shape is the measurement: a frame answers only about **itself** —
 * its own index in its parent, its own containers' indices — and never
 * about another frame. Correlating the answers is the extension's job, and
 * keeping that split visible here is what keeps the eventual production
 * split honest, since a page must never be trusted with, or told about,
 * another frame's identity.
 */
interface ProbedFrame {
	/** The `data-ab-frame` the fixture document names itself with, so a frame is identified by what it is rather than by where it was expected. */
	readonly marker: string | null
	readonly href: string
	readonly locationOrigin: string
	readonly selfOrigin: string
	readonly documentURI: string
	readonly baseURI: string
	readonly referrer: string
	/** Whether `document.cookie` can be read at all, and how much of it there is — never what it says. */
	readonly cookieAccess: string
	readonly isTop: boolean
	/** This frame's index among its parent's child browsing contexts, from `parent.frames[i] === window`; `-1` when nothing matched. */
	readonly selfIndex: number
	readonly selfIndexNote: string
	readonly parentFramesLength: string
	readonly ownFramesLength: number
	/** `window.frameElement`: the container element when the parent is same-origin, `null` when it is not. */
	readonly frameElement: string
	/** Whether this document can synchronously reach a known property of its parent's document. */
	readonly parentDocumentAccess: string
	readonly parentLocationHref: string
	readonly containers: readonly ProbedContainer[]
	readonly embeddedObjects: readonly ProbedContainer[]
	readonly title: string
	/** `typeof browser.runtime.getFrameId` as this content script sees it — measured, not assumed, since an API missing in an isolated world would sink the whole hypothesis. */
	readonly getFrameIdType: string
	/** `runtime.getFrameId(window)`: what this document calls itself, to be compared against the `InjectionResult.frameId` the extension was handed for it. */
	readonly selfFrameId: number | string
	/** `runtime.getFrameId(window.parent)`: the parentage no `InjectionResult` carries, if a child can name it. */
	readonly parentFrameId: number | string
	readonly topFrameId: number | string
	/** `runtime.getFrameId` of each of this document's own child browsing contexts, by `window.frames` index — the WindowProxy input path, which is all a cross-origin child is reachable through. */
	readonly childWindowFrameIds: readonly (number | string)[]
	/** What the API says about an element that hosts no browsing context, which decides whether a wrong answer can be told from a right one. */
	readonly nonFrameElementFrameId: number | string
	/** An `<iframe>` created and never inserted: it has no browsing context, and must not be given some other frame's id. */
	readonly detachedIframeFrameId: number | string
	/** A plain object, i.e. the degenerate input a hostile page could never produce but a bug could. */
	readonly plainObjectFrameId: number | string
}

/** One frame container as its *own* document sees it: where it sits, and which browsing context it holds. */
interface ProbedContainer {
	readonly id: string | null
	readonly tagName: string
	/** Position among `<iframe>`/`<frame>` in tree order **including open shadow roots**, a shadow root's content before its host's light children — the order the capture's serializer emits. */
	readonly treeOrdinal: number
	/** Position among `document.querySelectorAll('iframe, frame')`, which does not descend into shadow roots; `-1` for a container that only the tree order sees. */
	readonly lightOrdinal: number
	readonly srcAttribute: string | null
	readonly hasSrcdoc: boolean
	readonly sandboxAttribute: string | null
	readonly hasContentWindowProperty: boolean
	/** Index in this document's own `window.frames` where `container.contentWindow` was found; `-1` when it holds no browsing context. */
	readonly browsingContextIndex: number
	readonly contentDocumentTitle: string
	/** `runtime.getFrameId(element)`: the container element handed straight to the API, which is the join being tested. */
	readonly elementFrameId: number | string
	/** `runtime.getFrameId(element.contentWindow)`: the same question asked through the WindowProxy, which must not answer differently. */
	readonly contentWindowFrameId: number | string
}

/**
 * One `scripting.executeScript` result about a {@link ProbedFrame}. The
 * shape — and the fact that it reports *which* fields Firefox supplied —
 * lives in `probe-session.ts`, because `document-identity.test.ts` measures
 * the same thing about a different probe.
 */
type ProbedInjection = SharedProbedInjection<ProbedFrame>

type ProbeRun = SharedProbeRun<ProbedFrame>

/**
 * The probe, injected into every frame.
 *
 * Deliberately **not** production code: what is being measured is the
 * browser, and a probe that shared code with the capture would make a
 * Firefox change and an ArchiveBridge change indistinguishable in the
 * failure. It is stringified into the page the way `capture.ts` passes
 * `capturePageState`, so it may close over nothing.
 */
function frameIdentityProbe(): unknown {
	const FRAME_TAGS = ['IFRAME', 'FRAME']
	const EMBED_TAGS = ['OBJECT', 'EMBED']

	/** Reports what an access *did*, naming whatever it threw by `name` rather than by message: a name is the browser's stable answer, a message is prose that changes between versions. */
	const attempt = (read: () => unknown): string => {
		try {
			const value = read()
			return value === undefined ? 'undefined' : value === null ? 'null' : String(value)
		} catch (error) {
			return `threw: ${(error as { name?: string } | null)?.name ?? 'unknown'}`
		}
	}

	/**
	 * `browser.runtime` as an isolated-world content script sees it, typed
	 * here rather than in `src/firefox/firefox-api.d.ts`: that file is the
	 * reviewable list of platform APIs the **shipped** adapter calls, and
	 * `getFrameId` is not one of them. Whether it ever becomes one is what
	 * this probe exists to decide, so widening the production declarations
	 * now would record a conclusion that has not been reached.
	 */
	const contentScriptRuntime = (globalThis as unknown as { browser?: { runtime?: { getFrameId?: (target: unknown) => unknown } } }).browser?.runtime

	/**
	 * What `runtime.getFrameId` says about `target`: a number when it gave
	 * one, and otherwise a string naming what happened. The split matters —
	 * an API that is not there, an API that threw, and an API that answered
	 * `-1` are three different findings, and a join must never be built on
	 * top of two of them being indistinguishable.
	 */
	const frameIdOf = (target: unknown): number | string => {
		if (typeof contentScriptRuntime?.getFrameId !== 'function') {
			return 'unavailable: browser.runtime.getFrameId is not a function in this world'
		}
		try {
			const value = contentScriptRuntime.getFrameId(target)
			return typeof value === 'number' ? value : `non-numeric: ${value === undefined ? 'undefined' : String(value)}`
		} catch (error) {
			return `threw: ${(error as { name?: string } | null)?.name ?? 'unknown'}`
		}
	}

	/** Finds `target` among `win`'s child browsing contexts. `WindowProxy` identity comparison is permitted cross-origin, which is the whole reason this join is possible at all. */
	const browsingContextIndexIn = (win: Window, target: unknown): number => {
		try {
			for (let index = 0; index < win.frames.length; index += 1) {
				if (win.frames[index] === target) {
					return index
				}
			}
			return -1
		} catch {
			return -2
		}
	}

	// Tree order **including open shadow roots**, with a root's content
	// before its host's light children — the order the capture's serializer
	// emits, since it writes each root as the host's first child
	// `<template shadowrootmode>`. Closed roots are absent from both, which
	// is the same scope the capture has.
	const treeOrderedContainers: Element[] = []
	const treeOrderedEmbeds: Element[] = []
	const walk = (element: Element): void => {
		if (FRAME_TAGS.includes(element.tagName)) {
			treeOrderedContainers.push(element)
		} else if (EMBED_TAGS.includes(element.tagName)) {
			treeOrderedEmbeds.push(element)
		}
		const root = element.shadowRoot
		if (root !== null) {
			for (const child of root.children) {
				walk(child)
			}
		}
		for (const child of element.children) {
			walk(child)
		}
	}
	walk(document.documentElement)

	const lightOrder = Array.from(document.querySelectorAll('iframe, frame'))

	const describeContainer = (element: Element, treeOrdinal: number): unknown => ({
		id: element.id === '' ? null : element.id,
		tagName: element.tagName.toLowerCase(),
		treeOrdinal,
		lightOrdinal: lightOrder.indexOf(element),
		srcAttribute: element.getAttribute('src'),
		hasSrcdoc: element.hasAttribute('srcdoc'),
		sandboxAttribute: element.getAttribute('sandbox'),
		hasContentWindowProperty: 'contentWindow' in element,
		browsingContextIndex: browsingContextIndexIn(window, (element as HTMLIFrameElement).contentWindow),
		contentDocumentTitle: attempt(() => (element as HTMLIFrameElement).contentDocument?.title),
		elementFrameId: frameIdOf(element),
		// `<embed>` has no `contentWindow` at all, which is a different
		// answer from having one the API declines to identify.
		contentWindowFrameId: 'contentWindow' in element ? frameIdOf((element as HTMLIFrameElement).contentWindow) : 'no contentWindow property',
	})

	const isTop = window === window.top
	let selfIndex = -1
	let selfIndexNote = 'top document: no parent to be indexed in'
	if (!isTop) {
		selfIndex = browsingContextIndexIn(window.parent, window)
		selfIndexNote =
			selfIndex >= 0
				? 'matched by WindowProxy identity'
				: selfIndex === -2
					? "the parent's frames list could not be read at all"
					: 'no child browsing context of the parent was this window'
	}

	return {
		marker: document.documentElement.dataset.abFrame ?? null,
		href: attempt(() => location.href),
		locationOrigin: attempt(() => location.origin),
		selfOrigin: attempt(() => self.origin),
		documentURI: attempt(() => document.documentURI),
		baseURI: attempt(() => document.baseURI),
		referrer: attempt(() => (document.referrer === '' ? '(empty)' : document.referrer)),
		// Whether the cookie jar is reachable and how big it is, never what
		// is in it: the question is which credential scope this document
		// has, and a value would be a secret in a log.
		cookieAccess: attempt(() => `readable, ${document.cookie.length} characters`),
		isTop,
		selfIndex,
		selfIndexNote,
		parentFramesLength: attempt(() => window.parent.frames.length),
		ownFramesLength: window.frames.length,
		frameElement: attempt(() => {
			const element = window.frameElement
			return element === null ? null : `${element.tagName.toLowerCase()}#${element.id}`
		}),
		parentDocumentAccess: attempt(() => `readable: ${window.parent.document.title}`),
		parentLocationHref: attempt(() => window.parent.location.href),
		containers: treeOrderedContainers.map((element, treeOrdinal) => describeContainer(element, treeOrdinal)),
		embeddedObjects: treeOrderedEmbeds.map((element) => describeContainer(element, -1)),
		title: document.title,
		getFrameIdType: typeof contentScriptRuntime?.getFrameId,
		selfFrameId: frameIdOf(window),
		parentFrameId: isTop ? 'top document: no parent' : frameIdOf(window.parent),
		topFrameId: frameIdOf(window.top),
		childWindowFrameIds: Array.from({ length: window.frames.length }, (_unused, index) => frameIdOf(window.frames[index])),
		nonFrameElementFrameId: frameIdOf(document.documentElement),
		// Created, never inserted: it hosts no browsing context, so an id
		// here would mean the API answers about something other than a live
		// frame — and a join is only as sound as its worst wrong answer.
		detachedIframeFrameId: frameIdOf(document.createElement('iframe')),
		plainObjectFrameId: frameIdOf({}),
	}
}

/**
 * The marker the frame *this test* inserts carries, in the mutation
 * experiment below. It is defined here rather than in `test-page.ts`
 * because no fixture serves it: it is created by a page mutating itself
 * after the capture would already have looked at it, which is the whole
 * point of it.
 */
const MUTATION_INSERTED_MARKER = 'mutation-inserted'

describe('Firefox frame identity: the browser facts frame capture would join on', () => {
	let server: TestServer
	let probe: ProbeSession
	let run: ProbeRun
	/** Every frame that answered, by the marker its own document carries. */
	let byMarker: Map<string, ProbedInjection>
	/** The top document's serialized snapshot, from the production capture — the string a positional rewrite would be handed. */
	let topDocumentHtml: string

	/** The same probe run against the legacy `<frameset>` fixture, which is a whole document shape rather than one more element. */
	let framesetRun: ProbeRun
	/** A second pass targeting an explicitly chosen handful of frames — the bounded step a heavy capture would need. */
	let boundedRun: ProbeRun

	/** The same fixture in its own tab, probed once before it mutates itself and once after — the two observations a two-pass capture would be joining across. */
	let mutationBefore: ProbeRun
	let mutationAfter: ProbeRun

	/** What a page's *own* scripts can see of the extension APIs the identity join is made of, evaluated in the page's main world. */
	let pageWorldApis: readonly string[]
	/** The frame ids that second pass was asked for. */
	let boundedFrameIds: readonly number[]

	before(async () => {
		server = await startTestServer()
		probe = await openProbeSession()
		const { tabId } = await probe.openTab(`${server.origin}${FRAME_IDENTITY_PATH}`, FRAME_IDENTITY_READY_TITLE)
		run = await probe.probeAllFrames<ProbedFrame>(tabId, frameIdentityProbe)
		byMarker = new Map()
		for (const injection of run.injections) {
			if (injection.result?.marker != null) {
				byMarker.set(injection.result.marker, injection)
			}
		}

		// A capture that ran the heavy per-frame collection everywhere first
		// and bounded itself afterwards would already have paid the cost an
		// attacker-controlled frame count multiplies. So the sequence a
		// bounded design needs is this one: probe cheaply, choose, then run
		// against explicit frame ids only.
		boundedFrameIds = [FRAME_IDENTITY_MARKERS.sameOrigin, FRAME_IDENTITY_MARKERS.crossOrigin, FRAME_IDENTITY_MARKERS.sandboxed].map((marker) => byMarker.get(marker)?.frameId ?? -1)
		boundedRun = await probe.probeFrames<ProbedFrame>(tabId, boundedFrameIds, frameIdentityProbe)

		const captured = await probe.inPopup<{ html: string }>(`(async () => {
			const capturePageState = ${capturePageState.toString()}
			const [injection] = await browser.scripting.executeScript({
				target: { tabId: ${tabId}, frameIds: [0] },
				world: 'ISOLATED',
				func: capturePageState,
				args: [${JSON.stringify({ canvasContentIdPrefix: `canvas-${randomUUID()}@archivebridge`, ...PAGE_CAPTURE_LIMITS })}],
			})
			return JSON.stringify({ html: injection.result.html })
		})()`)
		topDocumentHtml = captured.html

		const frameset = await probe.openTab(`${server.origin}${FRAME_IDENTITY_FRAMESET_PATH}`, FRAME_IDENTITY_FRAMESET_READY_TITLE)
		framesetRun = await probe.probeAllFrames<ProbedFrame>(frameset.tabId, frameIdentityProbe)

		// The fixture again, in a tab of its own, probed either side of a
		// mutation it makes to itself — because a capture that observes
		// identity in one pass and serializes the DOM in another is
		// observing two different documents, and the page decides how
		// different. The two mutations are the cheapest hostile ones:
		// prepending a frame shifts every ordinal after it by one, and
		// swapping the two containers that share a `src` exchanges two
		// ordinals without changing the markup at all.
		const mutating = await probe.openTab(`${server.origin}${FRAME_IDENTITY_PATH}?pass=mutation`, FRAME_IDENTITY_READY_TITLE)
		mutationBefore = await probe.probeAllFrames<ProbedFrame>(mutating.tabId, frameIdentityProbe)

		// What the page itself can reach, asked in the page's own main
		// world: the security half of the identity question, since a
		// primitive a page can read is one a page can lie with.
		pageWorldApis = JSON.parse(
			String(
				await probe.inPage(
					mutating.context,
					'JSON.stringify([typeof browser, typeof chrome, typeof (globalThis.browser && globalThis.browser.runtime && globalThis.browser.runtime.getFrameId)])',
				),
			),
		) as readonly string[]
		await probe.inPage(
			mutating.context,
			`(() => {
				const inserted = document.createElement('iframe')
				inserted.id = 'mutation-inserted'
				inserted.srcdoc = '<!doctype html><html lang="en" data-ab-frame="${MUTATION_INSERTED_MARKER}"><head><meta charset="utf-8"><title>inserted frame</title></head><body><p id="framed">INSERTED_CONTENT</p></body></html>'
				document.body.insertBefore(inserted, document.body.firstChild)
				const first = document.getElementById('duplicate-a')
				first.parentNode.insertBefore(document.getElementById('duplicate-b'), first)
				return 'mutated'
			})()`,
		)
		mutationAfter = mutationBefore
		for (let attempt = 0; attempt < 200; attempt += 1) {
			mutationAfter = await probe.probeAllFrames<ProbedFrame>(mutating.tabId, frameIdentityProbe)
			if (mutationAfter.injections.some((injection) => injection.result?.marker === MUTATION_INSERTED_MARKER)) {
				break
			}
			await new Promise((resolve) => setTimeout(resolve, 50))
		}

		// The whole measurement, printed: this suite's value is as much the
		// recorded table as its assertions, and a CI log that only says
		// "passed" cannot be read against a future Firefox.
		console.log('frame-identity measurement:', JSON.stringify({ run, framesetRun, boundedRun, mutationBefore, mutationAfter, pageWorldApis, topDocumentHtml }, null, '\t'))
	})

	after(async () => {
		await probe?.close()
		await server?.close()
	})

	/** The frame that named itself `marker`, failing with the whole roster rather than `undefined` when it is not there. */
	function frame(marker: string): ProbedFrame {
		const injection = byMarker.get(marker)
		assert.notEqual(injection, undefined, `no frame reported itself as "${marker}"; the frames that answered were ${JSON.stringify([...byMarker.keys()])}`)
		assert.notEqual(injection?.result, null, `the frame "${marker}" produced no result: ${injection?.error}`)
		return injection?.result as ProbedFrame
	}

	/** The top document's container with this element id, in the tree order a serializer would emit. */
	function container(id: string): ProbedContainer {
		const found = frame(FRAME_IDENTITY_MARKERS.top).containers.find((candidate) => candidate.id === id)
		assert.notEqual(found, undefined, `the top document reported no frame container #${id}`)
		return found as ProbedContainer
	}

	/** The `src` the rewritten markup gave the container with this element id, or `undefined` when it has none. */
	function rewrittenSrc(html: string, id: string): string | undefined {
		const element = new RegExp(`<iframe[^>]*\\sid="${id}"[^>]*>`).exec(html)?.[0]
		assert.notEqual(element, undefined, `the serialized snapshot has no <iframe id="${id}">`)
		return /\ssrc="([^"]*)"/.exec(element ?? '')?.[1]
	}

	test('A. every frame with a document is reached, and the one without a document is not', () => {
		// The roster by name, not by count: a count that happens to match
		// while two frames swapped places would say nothing.
		assert.deepEqual(
			[...byMarker.keys()].sort(),
			[
				FRAME_IDENTITY_MARKERS.aboutBlank,
				FRAME_IDENTITY_MARKERS.crossOrigin,
				FRAME_IDENTITY_MARKERS.duplicate,
				FRAME_IDENTITY_MARKERS.embedSvg,
				FRAME_IDENTITY_MARKERS.inDeclarativeShadow,
				FRAME_IDENTITY_MARKERS.inShadow,
				FRAME_IDENTITY_MARKERS.inShadowCross,
				FRAME_IDENTITY_MARKERS.nestedCross,
				FRAME_IDENTITY_MARKERS.nestedDeep,
				FRAME_IDENTITY_MARKERS.nestedParent,
				FRAME_IDENTITY_MARKERS.nestedSame,
				FRAME_IDENTITY_MARKERS.objectSvg,
				FRAME_IDENTITY_MARKERS.sandboxed,
				FRAME_IDENTITY_MARKERS.sameOrigin,
				FRAME_IDENTITY_MARKERS.srcdoc,
				FRAME_IDENTITY_MARKERS.top,
			].sort(),
		)
		// The two frames that share a `src` are two separate results, not one.
		assert.equal(run.injections.filter((injection) => injection.result?.marker === FRAME_IDENTITY_MARKERS.duplicate).length, 2)
		// Cross-origin, sandboxed, `srcdoc`, `about:blank` and shadow-hosted
		// frames are all injectable; the frame whose load failed has no
		// document to inject into, so it is absent — which is why it has to
		// be discovered somewhere other than the result set.
		assert.equal(
			run.injections.some((injection) => injection.result?.href === FRAME_IDENTITY_FAILED_URL),
			false,
			'a frame whose load failed must not appear as a reached frame',
		)
		assert.equal(run.injections.length, 17, 'one result per document: sixteen distinct documents plus the second of the two same-src siblings')
	})

	test('B. an InjectionResult carries a frame id and no parentage at all', () => {
		// The gate this file exists for: **no field on an InjectionResult
		// says who a frame's parent is**, so a frame tree cannot be
		// recovered from the result set however it is squinted at. That is
		// what sends Phase 2 looking for a tree somewhere else.
		//
		// Asserted as a *bound* on the key set rather than as an exact list,
		// because one of those keys is version-dependent and the other is
		// not: `frameId` is there on every Firefox this extension supports,
		// while `documentId` appeared between 152.0.1 (absent) and 154.0.1
		// (present) — both measured. Pinning the exact list would make an
		// older supported Firefox fail for a fact that is true, while
		// leaving the key that actually matters unguarded. What must never
		// change silently is that no parentage is here.
		for (const key of run.injectionResultKeys) {
			assert.ok(
				['documentId', 'error', 'frameId', 'result'].includes(key),
				`Firefox put an unrecognized field "${key}" on an InjectionResult — if it carries parentage, the whole webNavigation question in docs/research/firefox-phase2-frame-identity.md reopens`,
			)
		}
		assert.equal(run.injectionResultKeys.includes('frameId'), true)
		assert.equal(run.injectionResultKeys.includes('parentFrameId'), false, 'if Firefox ever adds parentage here, Phase 2 no longer needs a second source for the frame tree')
		assert.equal(
			run.injections.every((injection) => typeof injection.frameId === 'number'),
			true,
		)
		// Frame ids are unique per frame and are what a bounded second pass
		// is addressed by; the top document is always 0.
		assert.equal(byMarker.get(FRAME_IDENTITY_MARKERS.top)?.frameId, 0)
		assert.equal(new Set(run.injections.map((injection) => injection.frameId)).size, run.injections.length)
	})

	test('C. the production extension cannot see a frame tree at all, because it does not ask for webNavigation', async () => {
		// The counterpart to B: with no parentage in the result set and no
		// `webNavigation`, the tree is simply not available to this build.
		// Asserted here rather than assumed, because "Phase 2 needs a new
		// permission" is a claim about the shipped manifest.
		assert.equal(await probe.inPopup<string>('JSON.stringify(typeof browser.webNavigation)'), 'undefined')
	})

	test('D. a child finds its own index in its parent by WindowProxy identity, in every frame kind that has one', () => {
		// The cross-origin comparison is the one that cannot be replaced:
		// `frameElement` is null there, so identity against the parent's
		// frames list is all a cross-origin child has.
		for (const marker of [
			FRAME_IDENTITY_MARKERS.sameOrigin,
			FRAME_IDENTITY_MARKERS.crossOrigin,
			FRAME_IDENTITY_MARKERS.srcdoc,
			FRAME_IDENTITY_MARKERS.aboutBlank,
			FRAME_IDENTITY_MARKERS.sandboxed,
			FRAME_IDENTITY_MARKERS.nestedCross,
			FRAME_IDENTITY_MARKERS.nestedDeep,
		]) {
			assert.equal(frame(marker).selfIndexNote, 'matched by WindowProxy identity', `${marker} could not find itself among its parent's frames`)
			assert.ok(frame(marker).selfIndex >= 0)
		}
		// Duplicate `src` is the case URL matching cannot answer, and
		// indices answer it: two frames, one URL, two distinct positions.
		const duplicates = run.injections.filter((injection) => injection.result?.marker === FRAME_IDENTITY_MARKERS.duplicate).map((injection) => injection.result?.selfIndex)
		assert.deepEqual([...duplicates].sort(), [2, 3])
		// Nesting does not change the rule: a child's index is relative to
		// its own parent, whatever depth that parent is at.
		assert.equal(frame(FRAME_IDENTITY_MARKERS.nestedSame).selfIndex, 0)
		assert.equal(frame(FRAME_IDENTITY_MARKERS.nestedCross).selfIndex, 1)
		assert.equal(frame(FRAME_IDENTITY_MARKERS.nestedDeep).selfIndex, 0)
	})

	test('E. a frame inside a shadow root has no index in its parent at all', () => {
		// It is reachable, it is injectable, and it is *not* a
		// document-tree child navigable — so `parent.frames` never contains
		// it, and the index join has nothing to say about it. Same-origin it
		// still has an identity, through `frameElement`; cross-origin it has
		// neither.
		assert.equal(frame(FRAME_IDENTITY_MARKERS.inShadow).selfIndexNote, 'no child browsing context of the parent was this window')
		assert.equal(frame(FRAME_IDENTITY_MARKERS.inShadow).selfIndex, -1)
		assert.equal(frame(FRAME_IDENTITY_MARKERS.inDeclarativeShadow).selfIndex, -1)
		assert.equal(frame(FRAME_IDENTITY_MARKERS.inShadow).frameElement, 'iframe#in-shadow')
		assert.equal(frame(FRAME_IDENTITY_MARKERS.inShadowCross).frameElement, 'null')
		// And the parent agrees from its side: the container holds a
		// browsing context, but not one its own frames list indexes.
		assert.equal(container('in-shadow').browsingContextIndex, -1)
		assert.equal(container('in-declarative-shadow').browsingContextIndex, -1)
		assert.equal(container('in-shadow-cross').browsingContextIndex, -1)
	})

	test('F. a parent identifies each of its own containers by contentWindow identity', () => {
		// The parent's half of the join, and the half that is internally
		// consistent: each container that holds a document-tree browsing
		// context maps to exactly one index, including the two that share a
		// URL and the ones with no URL of their own.
		assert.deepEqual(
			frame(FRAME_IDENTITY_MARKERS.top)
				.containers.filter((entry) => entry.browsingContextIndex >= 0)
				.map((entry) => [entry.id, entry.browsingContextIndex]),
			[
				['same-origin', 0],
				['cross-origin', 1],
				['duplicate-a', 2],
				['duplicate-b', 3],
				['nested-parent', 4],
				['srcdoc', 5],
				['about-blank', 6],
				['sandboxed', 7],
				['failed', 8],
			],
		)
		// A frame that failed to load still holds a position. Nothing can be
		// captured for it, and that is exactly why the position has to be
		// known: the container must be left alone rather than renumbered
		// over.
		assert.equal(container('failed').srcAttribute, FRAME_IDENTITY_FAILED_URL)
	})

	test('G. the two halves of the index join disagree, and a cross-origin child is where it shows', () => {
		// **This is the finding that decides Phase 2's architecture.** A
		// same-origin child and its parent enumerate the same list: only
		// document-tree child browsing contexts. A *cross-origin* child
		// enumerating the very same parent gets a longer list, one that
		// includes the frames inside shadow roots — so the two sides are not
		// counting the same things, and every index after the first
		// shadow-hosted frame differs.
		//
		// The fixture puts a shadow root before the cross-origin frame for
		// exactly this reason. If a future Firefox makes the two views
		// agree, this assertion fails and `(parent index, child index)`
		// becomes usable — which would be very good news, and must not
		// happen silently.
		assert.equal(frame(FRAME_IDENTITY_MARKERS.sameOrigin).parentFramesLength, '11', 'the same-origin view: document-tree children only')
		assert.equal(frame(FRAME_IDENTITY_MARKERS.crossOrigin).parentFramesLength, '14', 'the cross-origin view of the same parent: three shadow-hosted frames more')
		assert.equal(container('cross-origin').browsingContextIndex, 1, 'what the parent calls this container')
		assert.equal(frame(FRAME_IDENTITY_MARKERS.crossOrigin).selfIndex, 2, 'what the child calls itself')
		assert.notEqual(
			container('cross-origin').browsingContextIndex,
			frame(FRAME_IDENTITY_MARKERS.crossOrigin).selfIndex,
			'a join on these two numbers would link the wrong document to the wrong element',
		)
	})

	test('H. window.frames order is not document order', () => {
		// The `<object>` and `<embed>` come first in the document and last
		// in the frames list: Firefox orders that list by when a browsing
		// context was created, not by where its element sits. So an ordinal
		// taken from the markup is never a browsing-context index.
		const objectIndex = frame(FRAME_IDENTITY_MARKERS.objectSvg).selfIndex
		const embedIndex = frame(FRAME_IDENTITY_MARKERS.embedSvg).selfIndex
		assert.ok(objectIndex > container('failed').browsingContextIndex, `the <object> is first in the document and took index ${objectIndex}, after every <iframe>`)
		assert.ok(embedIndex > container('failed').browsingContextIndex, `the <embed> is second in the document and took index ${embedIndex}, after every <iframe>`)
		// Which of the two comes first is *not* asserted: both orders were
		// measured on Firefox 154.0.1 across runs of this very suite, because
		// the two contexts are created as their resources finish loading and
		// nothing orders that. That is the same finding as the assertions
		// above, only sharper — a browsing-context index is not even a stable
		// fact about one page across two loads, let alone a document position.
		// And the parent can locate the `<object>` but not the `<embed>`:
		// `HTMLEmbedElement` exposes no `contentWindow`, so an `<embed>`'s
		// browsing context cannot be identified from its parent at all.
		const [objectContainer, embedContainer] = frame(FRAME_IDENTITY_MARKERS.top).embeddedObjects
		assert.equal(objectContainer?.hasContentWindowProperty, true)
		assert.equal(objectContainer?.browsingContextIndex, objectIndex)
		assert.equal(embedContainer?.hasContentWindowProperty, false)
		assert.equal(embedContainer?.browsingContextIndex, -1)
	})

	test('I. the serialized snapshot is numbered differently again, and the library counts in that numbering', () => {
		// The third numbering, and the only one a rewrite of archived markup
		// can see. It counts frames inside shadow roots — the capture emits
		// them as `<template shadowrootmode>` — so it is neither the
		// light-DOM ordinal nor the browsing-context index.
		assert.deepEqual(
			frame(FRAME_IDENTITY_MARKERS.top).containers.map((entry) => [entry.id, entry.treeOrdinal, entry.lightOrdinal, entry.browsingContextIndex]),
			[
				['in-declarative-shadow', 0, -1, -1],
				['same-origin', 1, 0, 0],
				['in-shadow', 2, -1, -1],
				['in-shadow-cross', 3, -1, -1],
				['cross-origin', 4, 1, 1],
				['duplicate-a', 5, 2, 2],
				['duplicate-b', 6, 3, 3],
				['nested-parent', 7, 4, 4],
				['srcdoc', 8, 5, 5],
				['about-blank', 9, 6, 6],
				['sandboxed', 10, 7, 7],
				['failed', 11, 8, 8],
			],
		)

		// And that ordinal is the one the library's positional rewrite
		// counts in. Measured against the real serialized snapshot and the
		// real API rather than against a second implementation of the same
		// walk, because two parsers agreeing with each other would prove
		// nothing about the one that will do the work.
		const rewrite = rewriteFrameContainerSrcAttributes(
			topDocumentHtml,
			new Map(frame(FRAME_IDENTITY_MARKERS.top).containers.map((entry) => [entry.treeOrdinal, `cid:ordinal-${entry.treeOrdinal}@probe`])),
		)
		for (const entry of frame(FRAME_IDENTITY_MARKERS.top).containers) {
			if (entry.srcAttribute === null) {
				continue
			}
			assert.equal(
				rewrittenSrc(rewrite.html, entry.id ?? ''),
				`cid:ordinal-${entry.treeOrdinal}@probe`,
				`the library rewrote a different element than #${entry.id} at ordinal ${entry.treeOrdinal}`,
			)
		}

		// The two containers with no `src` cannot be linked positionally at
		// all: the rewrite fails closed on them rather than inventing an
		// attribute. That is a Phase 2 scope decision waiting to be made,
		// not a defect — and it is pinned here so the decision is made
		// deliberately.
		assert.deepEqual(
			rewrite.diagnostics.map((diagnostic) => ('url' in diagnostic ? diagnostic.url : diagnostic.type)).sort(),
			['cid:ordinal-8@probe', 'cid:ordinal-9@probe'],
			'the srcdoc and about:blank containers have no src attribute to rewrite',
		)
	})

	test('J. a document with no URL of its own still reports an origin, and a sandboxed one reports none', () => {
		// What a frame can be trusted to say about its own credential scope,
		// which is what decides whether its subresources may be fetched with
		// cookies. `location.origin` is **not** that value: for an inherited
		// origin it says "null" while the document really has its parent's
		// origin. `self.origin` is the one that matches the document's
		// actual principal.
		const srcdoc = frame(FRAME_IDENTITY_MARKERS.srcdoc)
		assert.equal(srcdoc.href, 'about:srcdoc')
		assert.equal(srcdoc.locationOrigin, 'null')
		assert.equal(srcdoc.selfOrigin, new URL(server.origin).origin)
		assert.equal(srcdoc.parentDocumentAccess.startsWith('readable:'), true)

		const aboutBlank = frame(FRAME_IDENTITY_MARKERS.aboutBlank)
		assert.equal(aboutBlank.href, 'about:blank')
		assert.equal(aboutBlank.locationOrigin, 'null')
		assert.equal(aboutBlank.selfOrigin, new URL(server.origin).origin)

		// A sandboxed frame has an opaque origin, and says so twice: no
		// origin, and no cookie jar to be scoped to one.
		const sandboxed = frame(FRAME_IDENTITY_MARKERS.sandboxed)
		assert.equal(sandboxed.selfOrigin, 'null')
		assert.equal(sandboxed.cookieAccess, 'threw: SecurityError')
		assert.equal(sandboxed.frameElement, 'null')
		assert.equal(sandboxed.parentDocumentAccess, 'threw: SecurityError')
		// Its own URL, by contrast, looks perfectly ordinary — which is the
		// trap: a scope derived by re-parsing the document URL would hand a
		// sandboxed document the credentials of the origin it was loaded
		// from.
		assert.equal(sandboxed.locationOrigin, new URL(server.origin).origin)

		// An ordinary cross-origin frame is the control: its own origin, and
		// nothing readable about its parent.
		const cross = frame(FRAME_IDENTITY_MARKERS.crossOrigin)
		assert.equal(cross.selfOrigin, new URL(server.crossOrigin).origin)
		assert.equal(cross.parentDocumentAccess, 'threw: SecurityError')
		assert.equal(cross.frameElement, 'null')
	})

	test('K. a legacy frameset is an ordinary frame tree', () => {
		const framesetByMarker = new Map(
			framesetRun.injections.filter((injection) => injection.result?.marker != null).map((injection) => [injection.result?.marker, injection.result as ProbedFrame]),
		)
		assert.deepEqual([...framesetByMarker.keys()].sort(), [FRAME_IDENTITY_MARKERS.framesetA, FRAME_IDENTITY_MARKERS.framesetB, FRAME_IDENTITY_MARKERS.framesetTop].sort())
		assert.equal(framesetByMarker.get(FRAME_IDENTITY_MARKERS.framesetA)?.selfIndex, 0)
		assert.equal(framesetByMarker.get(FRAME_IDENTITY_MARKERS.framesetB)?.selfIndex, 1)
		// `<frame>` behaves as `<iframe>` does on both sides of the join, so
		// nothing about it needs separate handling.
		assert.deepEqual(
			framesetByMarker.get(FRAME_IDENTITY_MARKERS.framesetTop)?.containers.map((entry) => [entry.id, entry.tagName, entry.treeOrdinal, entry.browsingContextIndex]),
			[
				['frameset-a', 'frame', 0, 0],
				['frameset-b', 'frame', 1, 1],
			],
		)
	})

	test('L. a cheap identity pass can be followed by one bounded to chosen frames', () => {
		// What makes a globally bounded capture possible at all: the heavy
		// per-frame work does not have to run everywhere first.
		// `allFrames: true` is the cheap pass, and the expensive one is
		// addressed by explicit frame ids — so the number of frames a page
		// can make a capture pay for is the extension's decision, not the
		// page's.
		assert.equal(boundedFrameIds.includes(-1), false, 'every frame the bounded pass asked for was named by the cheap pass')
		assert.deepEqual(boundedRun.injections.map((injection) => injection.frameId).sort(), [...boundedFrameIds].sort())
		assert.deepEqual(
			boundedRun.injections.map((injection) => injection.result?.marker).sort(),
			[FRAME_IDENTITY_MARKERS.crossOrigin, FRAME_IDENTITY_MARKERS.sameOrigin, FRAME_IDENTITY_MARKERS.sandboxed].sort(),
		)
		assert.ok(boundedRun.injections.length < run.injections.length, 'the bounded pass must actually be a subset')
	})

	test('M. runtime.getFrameId exists in an isolated world, and refuses to answer about anything that is not a frame', () => {
		// The precondition for everything below it: the join being tested
		// needs this API inside injected code — in *every* document kind,
		// including the ones a page can conjure without a URL — and content
		// scripts get only a subset of `browser.*`. Measured, not assumed.
		assert.deepEqual([...new Set(run.injections.map((injection) => injection.result?.getFrameIdType))], ['function'])

		// And it fails closed on the three inputs that are not frames. That
		// is what makes a wrong answer impossible rather than merely
		// unlikely: an element that hosts nothing throws, and an element
		// that *could* host one but does not yet answers `-1` — neither is
		// ever some other frame's id.
		for (const injection of run.injections) {
			assert.equal(injection.result?.nonFrameElementFrameId, 'threw: Error', `${injection.result?.marker} got an id for <html>, which hosts no frame`)
			assert.equal(injection.result?.plainObjectFrameId, 'threw: Error', `${injection.result?.marker} got an id for a plain object`)
		}
		// `-1` for a created-but-never-inserted `<iframe>`, in every document
		// that can make one. The two SVG documents cannot: in an SVG
		// document `createElement('iframe')` builds an SVG-namespace element
		// rather than an `HTMLIFrameElement`, so the API throws there for the
		// same reason it throws for `<html>` — the input is not a frame
		// element at all.
		for (const injection of run.injections) {
			const svgDocument = injection.result?.marker === FRAME_IDENTITY_MARKERS.objectSvg || injection.result?.marker === FRAME_IDENTITY_MARKERS.embedSvg
			assert.equal(injection.result?.detachedIframeFrameId, svgDocument ? 'threw: Error' : -1, `${injection.result?.marker} answered about a detached <iframe>`)
		}
	})

	test('N. a document’s own id is exactly the id the extension was handed for it', () => {
		// One half of the namespace question: `scripting`’s `frameId` and
		// `runtime.getFrameId` are the same number for the same document,
		// measured for every frame kind in the fixture at once — cross
		// origin, sandboxed, `srcdoc`, `about:blank`, shadow-hosted,
		// `<object>` and `<embed>` included.
		for (const injection of run.injections) {
			assert.equal(injection.result?.selfFrameId, injection.frameId, `${injection.result?.marker} disagreed with the InjectionResult it arrived in`)
		}
		// And every document agrees about the top of its own tree, however
		// far from it and across however many origin changes.
		assert.deepEqual([...new Set(run.injections.map((injection) => injection.result?.topFrameId))], [0])
	})

	test('O. a child can name its parent, which is the parentage no InjectionResult carries', () => {
		// Test B measures that the result set contains no parentage at all.
		// This is where it can come from instead, without `webNavigation`:
		// the child asks the API about `window.parent`, and gets a frame id
		// in the same namespace — *including* across an origin boundary, which
		// is the case `nested-deep` exists for, a same-origin grandchild
		// whose parent is cross-origin to it.
		const markerOf = new Map(run.injections.map((injection) => [injection.frameId, injection.result?.marker]))
		assert.deepEqual(
			run.injections
				.map((injection) => [
					injection.result?.marker,
					typeof injection.result?.parentFrameId === 'number' ? markerOf.get(injection.result.parentFrameId) : injection.result?.parentFrameId,
				])
				.sort(),
			[
				[FRAME_IDENTITY_MARKERS.aboutBlank, FRAME_IDENTITY_MARKERS.top],
				[FRAME_IDENTITY_MARKERS.crossOrigin, FRAME_IDENTITY_MARKERS.top],
				[FRAME_IDENTITY_MARKERS.duplicate, FRAME_IDENTITY_MARKERS.top],
				[FRAME_IDENTITY_MARKERS.duplicate, FRAME_IDENTITY_MARKERS.top],
				[FRAME_IDENTITY_MARKERS.embedSvg, FRAME_IDENTITY_MARKERS.top],
				[FRAME_IDENTITY_MARKERS.inDeclarativeShadow, FRAME_IDENTITY_MARKERS.top],
				[FRAME_IDENTITY_MARKERS.inShadow, FRAME_IDENTITY_MARKERS.top],
				[FRAME_IDENTITY_MARKERS.inShadowCross, FRAME_IDENTITY_MARKERS.top],
				[FRAME_IDENTITY_MARKERS.nestedCross, FRAME_IDENTITY_MARKERS.nestedParent],
				[FRAME_IDENTITY_MARKERS.nestedDeep, FRAME_IDENTITY_MARKERS.nestedCross],
				[FRAME_IDENTITY_MARKERS.nestedParent, FRAME_IDENTITY_MARKERS.top],
				[FRAME_IDENTITY_MARKERS.nestedSame, FRAME_IDENTITY_MARKERS.nestedParent],
				[FRAME_IDENTITY_MARKERS.objectSvg, FRAME_IDENTITY_MARKERS.top],
				[FRAME_IDENTITY_MARKERS.sameOrigin, FRAME_IDENTITY_MARKERS.top],
				[FRAME_IDENTITY_MARKERS.sandboxed, FRAME_IDENTITY_MARKERS.top],
				[FRAME_IDENTITY_MARKERS.srcdoc, FRAME_IDENTITY_MARKERS.top],
				[FRAME_IDENTITY_MARKERS.top, 'top document: no parent'],
			].sort(),
		)
	})

	test('P. every reached document is claimed by exactly one container, in the document it calls its parent', () => {
		// **The soundness condition.** Not "the ids usually match": for each
		// captured child, exactly one frame container in exactly one parent
		// document reports that child’s frame id, and it is a container of
		// the document the child itself names as its parent. Duplicate URLs,
		// missing URLs, origin boundaries and shadow roots are all in the
		// fixture, and none of them is consulted.
		const claimedBy = new Map<number, string[]>()
		for (const injection of run.injections) {
			const document = injection.result as ProbedFrame
			for (const entry of [...document.containers, ...document.embeddedObjects]) {
				if (typeof entry.elementFrameId !== 'number') {
					continue
				}
				claimedBy.set(entry.elementFrameId, [...(claimedBy.get(entry.elementFrameId) ?? []), `${document.marker}#${entry.id}`])
			}
		}

		// No id is claimed twice — anywhere, by any document, including the
		// containers of documents that cannot see each other at all.
		assert.deepEqual(
			[...claimedBy.values()].filter((claims) => claims.length > 1),
			[],
			'two containers claimed the same frame id: one captured document would be attached to both',
		)

		// And the whole join, written out: every reached document, and the
		// single container that owns it.
		assert.deepEqual(
			run.injections
				.filter((injection) => injection.frameId !== 0)
				.map((injection) => [injection.result?.marker, (claimedBy.get(injection.frameId as number) ?? ['claimed by nothing']).join(' and ')])
				.sort(),
			[
				[FRAME_IDENTITY_MARKERS.aboutBlank, `${FRAME_IDENTITY_MARKERS.top}#about-blank`],
				[FRAME_IDENTITY_MARKERS.crossOrigin, `${FRAME_IDENTITY_MARKERS.top}#cross-origin`],
				[FRAME_IDENTITY_MARKERS.duplicate, `${FRAME_IDENTITY_MARKERS.top}#duplicate-a`],
				[FRAME_IDENTITY_MARKERS.duplicate, `${FRAME_IDENTITY_MARKERS.top}#duplicate-b`],
				[FRAME_IDENTITY_MARKERS.embedSvg, `${FRAME_IDENTITY_MARKERS.top}#embed-svg`],
				[FRAME_IDENTITY_MARKERS.inDeclarativeShadow, `${FRAME_IDENTITY_MARKERS.top}#in-declarative-shadow`],
				[FRAME_IDENTITY_MARKERS.inShadow, `${FRAME_IDENTITY_MARKERS.top}#in-shadow`],
				[FRAME_IDENTITY_MARKERS.inShadowCross, `${FRAME_IDENTITY_MARKERS.top}#in-shadow-cross`],
				[FRAME_IDENTITY_MARKERS.nestedCross, `${FRAME_IDENTITY_MARKERS.nestedParent}#nested-cross`],
				[FRAME_IDENTITY_MARKERS.nestedDeep, `${FRAME_IDENTITY_MARKERS.nestedCross}#nested-deep`],
				[FRAME_IDENTITY_MARKERS.nestedParent, `${FRAME_IDENTITY_MARKERS.top}#nested-parent`],
				[FRAME_IDENTITY_MARKERS.nestedSame, `${FRAME_IDENTITY_MARKERS.nestedParent}#nested-same`],
				[FRAME_IDENTITY_MARKERS.objectSvg, `${FRAME_IDENTITY_MARKERS.top}#object-svg`],
				[FRAME_IDENTITY_MARKERS.sameOrigin, `${FRAME_IDENTITY_MARKERS.top}#same-origin`],
				[FRAME_IDENTITY_MARKERS.sandboxed, `${FRAME_IDENTITY_MARKERS.top}#sandboxed`],
				[FRAME_IDENTITY_MARKERS.srcdoc, `${FRAME_IDENTITY_MARKERS.top}#srcdoc`],
			].sort(),
		)

		// The claim and the child’s own account of its parentage agree, so
		// neither side has to be taken on trust: the document holding the
		// claiming container *is* the document the child named in O.
		const markerOf = new Map(run.injections.map((injection) => [injection.frameId, injection.result?.marker]))
		for (const injection of run.injections) {
			if (injection.frameId === 0) {
				continue
			}
			const claim = (claimedBy.get(injection.frameId as number) ?? []).join('')
			assert.equal(
				claim.startsWith(`${markerOf.get(injection.result?.parentFrameId as number)}#`),
				true,
				`${injection.result?.marker} is claimed by ${claim}, which is not in the document it calls its parent`,
			)
		}

		// Each container in the fixture’s one nested tree is claimed within
		// its own document and nowhere else, which is what keeps a
		// grandchild from being attached to a grandparent’s container.
		assert.equal(
			frame(FRAME_IDENTITY_MARKERS.top).containers.some((entry) => entry.elementFrameId === byMarker.get(FRAME_IDENTITY_MARKERS.nestedDeep)?.frameId),
			false,
		)
	})

	test('Q. a container and its contentWindow are the same frame, and an <embed> can only be asked one of the two ways', () => {
		// Both documented input types agree wherever both exist, so the
		// element path and the WindowProxy path are interchangeable rather
		// than two joins to keep in step. This matters because the element
		// is what a serializer has in hand, while a `WindowProxy` is what a
		// cross-origin frame can be reached through.
		for (const injection of run.injections) {
			for (const entry of [...(injection.result?.containers ?? []), ...(injection.result?.embeddedObjects ?? [])]) {
				if (entry.contentWindowFrameId === 'no contentWindow property') {
					continue
				}
				assert.equal(entry.elementFrameId, entry.contentWindowFrameId, `#${entry.id} answered differently through its element and its contentWindow`)
			}
		}
		// The `<embed>`, which has no `contentWindow` at all (test H), is
		// still identified from its element — the one identity it has from
		// its parent’s side.
		const [, embedContainer] = frame(FRAME_IDENTITY_MARKERS.top).embeddedObjects
		assert.equal(embedContainer?.contentWindowFrameId, 'no contentWindow property')
		assert.equal(embedContainer?.elementFrameId, byMarker.get(FRAME_IDENTITY_MARKERS.embedSvg)?.frameId)
		// Neither `<object>` nor `<embed>` is in Phase 2’s scope; they are
		// here because they take browsing-context indices without being
		// frame containers, and an identity that happened to alias one of
		// them would be a way to attach a captured document to the wrong
		// element.
	})

	test('R. the frame that failed to load has an id of its own that nothing captured can be attached to', () => {
		// The fail-closed case. Firefox does give the failed container a
		// frame id — it has a browsing context, just not a document anything
		// could be injected into — and that id appears in **no** injection
		// result. So a join that only ever attaches a captured document to
		// the container claiming *its* id has nothing to attach here, which
		// is the correct outcome: the container is left alone.
		const failedFrameId = container('failed').elementFrameId
		assert.equal(typeof failedFrameId, 'number')
		assert.notEqual(failedFrameId, -1, 'a failed frame still holds a browsing context')
		assert.equal(
			run.injections.some((injection) => injection.frameId === failedFrameId),
			false,
			'the failed frame must not be reachable',
		)
		// And its id is its own: no live frame’s container reports it.
		assert.deepEqual(
			frame(FRAME_IDENTITY_MARKERS.top)
				.containers.filter((entry) => entry.elementFrameId === failedFrameId)
				.map((entry) => entry.id),
			['failed'],
		)
	})

	test('S. the two cases the browsing-context join got wrong are exact here', () => {
		// Shadow-hosted frames, which have no index in their parent at all
		// (test E), are identified the same way every other container is.
		for (const [id, marker] of [
			['in-shadow', FRAME_IDENTITY_MARKERS.inShadow],
			['in-shadow-cross', FRAME_IDENTITY_MARKERS.inShadowCross],
			['in-declarative-shadow', FRAME_IDENTITY_MARKERS.inDeclarativeShadow],
			['cross-origin', FRAME_IDENTITY_MARKERS.crossOrigin],
			['srcdoc', FRAME_IDENTITY_MARKERS.srcdoc],
			['about-blank', FRAME_IDENTITY_MARKERS.aboutBlank],
			['sandboxed', FRAME_IDENTITY_MARKERS.sandboxed],
		]) {
			assert.equal(container(id ?? '').elementFrameId, byMarker.get(marker ?? '')?.frameId, `#${id} does not claim the frame that reported itself as ${marker}`)
		}

		// And the two siblings sharing a `src`: two containers, two ids, and
		// the pairing is decided by the ids alone — the URL is identical and
		// is never consulted. Each duplicate document is cross-checked
		// against the browsing-context index it reported for itself, which
		// is an independent measurement of the same pairing (test D).
		const duplicates = run.injections.filter((injection) => injection.result?.marker === FRAME_IDENTITY_MARKERS.duplicate)
		assert.equal(container('duplicate-a').srcAttribute, container('duplicate-b').srcAttribute)
		assert.equal(duplicates.find((injection) => injection.frameId === container('duplicate-a').elementFrameId)?.result?.selfIndex, 2)
		assert.equal(duplicates.find((injection) => injection.frameId === container('duplicate-b').elementFrameId)?.result?.selfIndex, 3)
	})

	test('T. a legacy <frame> is identified exactly as an <iframe> is', () => {
		const framesetTop = framesetRun.injections.find((injection) => injection.result?.marker === FRAME_IDENTITY_MARKERS.framesetTop)?.result as ProbedFrame
		const idOf = (marker: string): number | null => framesetRun.injections.find((injection) => injection.result?.marker === marker)?.frameId ?? null
		assert.deepEqual(
			framesetTop.containers.map((entry) => [entry.id, entry.elementFrameId, entry.contentWindowFrameId]),
			[
				['frameset-a', idOf(FRAME_IDENTITY_MARKERS.framesetA), idOf(FRAME_IDENTITY_MARKERS.framesetA)],
				['frameset-b', idOf(FRAME_IDENTITY_MARKERS.framesetB), idOf(FRAME_IDENTITY_MARKERS.framesetB)],
			],
		)
	})

	test('U. a container ordinal is a fact about a moment; a frame id is a fact about a frame', () => {
		// **The architectural consequence.** A capture that observed
		// identity in one pass and serialized the DOM in another would be
		// joining two different documents, and the page decides how
		// different. Here the page prepends one frame and reorders two
		// others between the two probes; the ids survive it and the
		// ordinals do not.
		const before = mutationBefore.injections.find((injection) => injection.frameId === 0)?.result as ProbedFrame
		const after = mutationAfter.injections.find((injection) => injection.frameId === 0)?.result as ProbedFrame
		const beforeById = new Map(before.containers.map((entry) => [entry.id, entry]))

		// Every container that was not touched keeps its frame id and gets a
		// new ordinal: the two numbers do not decay together, so a stale
		// ordinal carrying a correct id is exactly the silent
		// wrong-container attachment this file exists to prevent.
		for (const entry of after.containers) {
			const original = beforeById.get(entry.id)
			// The two that share a `src` were also swapped with each other,
			// so they moved by something other than the insertion alone; they
			// are measured on their own below.
			if (original === undefined || entry.id === 'duplicate-a' || entry.id === 'duplicate-b') {
				continue
			}
			assert.equal(entry.elementFrameId, original.elementFrameId, `#${entry.id} changed identity without being touched`)
			assert.equal(entry.treeOrdinal, original.treeOrdinal + 1, `#${entry.id} did not move by the one frame inserted before it`)
		}

		// The inserted frame is an ordinary participant: ordinal 0, its own
		// id, and that id is the one its document reports.
		const inserted = after.containers.find((entry) => entry.id === 'mutation-inserted')
		assert.equal(inserted?.treeOrdinal, 0)
		assert.equal(
			mutationAfter.injections.some((injection) => injection.frameId === inserted?.elementFrameId),
			true,
			'the inserted frame answered under the id its container reports',
		)

		// The moved container is the sharpest form of it. `#duplicate-b` was
		// re-inserted before its identical twin: the move destroyed its
		// browsing context, so it now holds a **different frame** — at the
		// **same ordinal it had before**, with the same `src`, in markup
		// that serializes identically. Nothing but the id can tell the two
		// apart.
		const movedBefore = beforeById.get('duplicate-b') as ProbedContainer
		const movedAfter = after.containers.find((entry) => entry.id === 'duplicate-b') as ProbedContainer
		assert.equal(movedAfter.treeOrdinal, movedBefore.treeOrdinal, 'the moved container ended up at the ordinal it started at')
		assert.notEqual(movedAfter.elementFrameId, movedBefore.elementFrameId, 'moving an iframe discards its browsing context, so its id must change')
		assert.equal(movedAfter.srcAttribute, movedBefore.srcAttribute)
		// Meanwhile its twin kept its id and moved two ordinals.
		assert.equal(after.containers.find((entry) => entry.id === 'duplicate-a')?.elementFrameId, beforeById.get('duplicate-a')?.elementFrameId)
		assert.equal(after.containers.find((entry) => entry.id === 'duplicate-a')?.treeOrdinal, (beforeById.get('duplicate-a') as ProbedContainer).treeOrdinal + 2)

		// Ids stay unique across all of it.
		const ids = after.containers.map((entry) => entry.elementFrameId)
		assert.equal(new Set(ids).size, ids.length)
	})

	test('V. none of this is visible to the page whose frames are being identified', () => {
		// The identity here is carried entirely between Firefox and the
		// extension: it is read in an isolated world, through an API the
		// page has no access to, and nothing is ever written into the page
		// to be read back. So there is no token for a hostile page to
		// observe, replay, or relay — the class of attack a postMessage
		// handshake would have had to defend against does not arise.
		assert.deepEqual(pageWorldApis, ['undefined', 'undefined', 'undefined'], "a page that can reach the extension's own APIs could forge the join")
	})
})
