/**
 * Firefox **document** identity, measured in a real Firefox against a real
 * page that navigates its own frames.
 *
 * **This file is a gate, not a feature test**, and it is deliberately a
 * *different* gate from `frame-identity.test.ts`. That file established
 * which browsing context a captured document belongs to:
 *
 * ```text
 *   InjectionResult.frameId
 *     ↔ runtime.getFrameId(container)
 *     ↔ the container's ordinal in the same serialization traversal
 * ```
 *
 * Every link in that join is about a **frame**. None of them is about a
 * **document**, and a frame outlives the documents loaded into it. So the
 * join can be entirely correct and the archive still silently wrong:
 *
 * ```text
 *   t0  capture child document A out of frame 42
 *   t1  the page navigates frame 42 to document B
 *   t2  serialize the parent; getFrameId(container) === 42, as it should be
 *   t3  attach A to a container that now holds B          ← wrong archive,
 *                                                           no wrong number
 * ```
 *
 * Nothing in the frame-identity measurement can detect that, because
 * nothing in it changed. This file measures whether Firefox offers a
 * primitive that can, and what happens when it is absent.
 *
 * **The candidate is `documentId`.** Mozilla documents it as naming a
 * particular loaded Document, changing when a frame navigates while its
 * `frameId` stays the same, and it reaches the WebExtension APIs in
 * Firefox 153 (`runtime.getDocumentId()`,
 * `scripting.InjectionResult.documentId`, `scripting` targeting by
 * `documentIds`). That documentation is treated here as a hypothesis and
 * nothing more: every claim below is a real measurement against a real
 * navigation, and the suite runs unchanged on a Firefox that predates the
 * API so that its *absence* is measured too rather than assumed.
 *
 * Tests are lettered to keep them distinguishable from the frame-identity
 * suite's A–V in logs and notes:
 *
 * - **AA–AC** — availability, namespace, and the version boundary.
 * - **AD–AE** — the parent/document relationship, including whether a child
 *   can name its parent *document* across an origin boundary.
 * - **AF–AG** — the navigation itself: same container, same frame id,
 *   different document. AG is the verdict test.
 * - **AH** — the race reproduced directly: targeting a **stale frame id**
 *   after the navigation, which is the concrete reason `frameId` alone
 *   cannot carry document continuity.
 * - **AI** — targeting a **stale document id**, where the security
 *   condition is not the shape of the failure but that the script must not
 *   run in the replacement document.
 * - **AJ** — the same-document controls: a fragment navigation and a
 *   `pushState()` must *not* change the id, and a reload at the same URL
 *   must. Together they show the id tracks Document lifetime rather than
 *   URL.
 * - **AK** — the parent-side question a serializer actually has:
 *   can `getDocumentId(container)` be read in the same traversal that reads
 *   `getFrameId(container)` and the container's ordinal?
 * - **AL** — what a Firefox *without* the API can do instead, which is the
 *   finding that decides the supported-version floor.
 * - **AM** — that none of it is reachable by the page being captured.
 *
 * **Nothing here licenses Phase 2**, and no production code is touched: the
 * probe reaches `runtime.getDocumentId` through a locally typed view of
 * `globalThis.browser`, because `src/firefox/firefox-api.d.ts` is the
 * reviewable list of APIs the *shipped* adapter calls and this is not one
 * of them. See `docs/research/firefox-phase2-document-identity.md` for what
 * these runs do and do not establish.
 */

import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import { DOCUMENT_IDENTITY_DOCS, DOCUMENT_IDENTITY_MARKERS, DOCUMENT_IDENTITY_PATH, DOCUMENT_IDENTITY_READY_TITLE, startTestServer, type TestServer } from '../test-page.ts'
import { openProbeSession, type ProbeSession, type ProbeRun as SharedProbeRun } from './probe-session.ts'

/** One frame container as its *own* document sees it, asked both identity questions at the same moment — which is the arrangement a serializer would be in. */
interface ProbedContainer {
	readonly id: string | null
	readonly tagName: string
	/** Position among `<iframe>`/`<frame>` in tree order **including open shadow roots** — the order the capture's serializer emits. */
	readonly treeOrdinal: number
	readonly srcAttribute: string | null
	readonly hasSrcdoc: boolean
	readonly sandboxAttribute: string | null
	/** `runtime.getFrameId(element)`: the frame-identity half, re-measured here so a contradiction with the other suite would surface in this one too. */
	readonly elementFrameId: number | string
	/** `runtime.getDocumentId(element)`: the document-identity half, and the question this file exists for. */
	readonly elementDocumentId: string
	/** The same question asked through the `WindowProxy`, which must not answer differently. */
	readonly contentWindowFrameId: number | string
	readonly contentWindowDocumentId: string
	/** Whether the parent can reach into the child at all — `null`/`threw` for cross-origin and sandboxed containers, which is why identity may not depend on it. */
	readonly contentDocumentTitle: string
}

/** What one document reports about itself, its parent, and its own containers. A document answers only about itself; correlating the answers is the extension's job. */
interface ProbedDocument {
	/** The `data-ab-frame` the fixture document names itself with. A navigation is confirmed by the *replacement naming itself*, never by a URL. */
	readonly marker: string | null
	readonly href: string
	readonly title: string
	readonly selfOrigin: string
	readonly isTop: boolean
	/**
	 * A `data-*` attribute the **test harness** writes into a document
	 * immediately before reloading its frame, purely so the suite can wait
	 * until the replacement Document is the one answering. It is a wait
	 * signal and never an identity: a page can forge it, which is exactly
	 * why no assertion in this file joins on it.
	 */
	readonly reloadMark: string | null
	/** `typeof browser.runtime.getFrameId` in this world. */
	readonly getFrameIdType: string
	/** `typeof browser.runtime.getDocumentId` in this world — the availability question, measured in every document kind rather than assumed from a version number. */
	readonly getDocumentIdType: string
	readonly selfFrameId: number | string
	readonly parentFrameId: number | string
	/** `runtime.getDocumentId(window)`: what this document calls itself, to be compared against the `InjectionResult.documentId` the extension was handed for it. */
	readonly selfDocumentId: string
	/** `runtime.getDocumentId(window.parent)`: whether a child can name its parent *document*, not merely its parent frame. */
	readonly parentDocumentId: string
	readonly topDocumentId: string
	readonly containers: readonly ProbedContainer[]
	/** What the API says about inputs that are not frames, which decides whether a wrong answer can be told from a right one. */
	readonly nonFrameElementDocumentId: string
	readonly detachedIframeDocumentId: string
	readonly plainObjectDocumentId: string
}

type ProbeRun = SharedProbeRun<ProbedDocument>

/**
 * The probe, injected into every frame.
 *
 * Deliberately **not** production code, and deliberately not shared with
 * the frame-identity probe: what is being measured is the browser, and a
 * probe that shared code with the capture — or with the other gate — would
 * make a Firefox change and an ArchiveBridge change indistinguishable in
 * the failure. It is stringified into the page, so it may close over
 * nothing.
 */
function documentIdentityProbe(): unknown {
	const FRAME_TAGS = ['IFRAME', 'FRAME']

	/**
	 * `browser.runtime` as an isolated-world content script sees it, typed
	 * here rather than in `src/firefox/firefox-api.d.ts`: that file is the
	 * reviewable list of platform APIs the **shipped** adapter calls, and
	 * neither `getFrameId` nor `getDocumentId` is one of them. Whether
	 * `getDocumentId` ever becomes one is what this probe exists to decide,
	 * so widening the production declarations now would record a conclusion
	 * that has not been reached.
	 */
	const contentScriptRuntime = (
		globalThis as unknown as {
			browser?: { runtime?: { getFrameId?: (target: unknown) => unknown; getDocumentId?: (target: unknown) => unknown } }
		}
	).browser?.runtime

	/**
	 * What `runtime.getFrameId` says about `target`: a number when it gave
	 * one, and otherwise a string naming what happened. An API that is not
	 * there, an API that threw, and an API that answered `-1` are three
	 * different findings.
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

	/**
	 * The same, for `getDocumentId`. The absence case is spelled out rather
	 * than collapsed to `undefined`, because on a Firefox that predates the
	 * API **every** answer is this string, and a suite that could not tell
	 * "absent" from "declined" would report a false continuity check.
	 */
	const documentIdOf = (target: unknown): string => {
		if (typeof contentScriptRuntime?.getDocumentId !== 'function') {
			return 'unavailable: browser.runtime.getDocumentId is not a function in this world'
		}
		try {
			const value = contentScriptRuntime.getDocumentId(target)
			return value === undefined ? 'undefined' : value === null ? 'null' : String(value)
		} catch (error) {
			return `threw: ${(error as { name?: string } | null)?.name ?? 'unknown'}`
		}
	}

	const attempt = (read: () => unknown): string => {
		try {
			const value = read()
			return value === undefined ? 'undefined' : value === null ? 'null' : String(value)
		} catch (error) {
			return `threw: ${(error as { name?: string } | null)?.name ?? 'unknown'}`
		}
	}

	// Tree order **including open shadow roots**, a root's content before its
	// host's light children — the order the capture's serializer emits, since
	// it writes each root as the host's first child `<template
	// shadowrootmode>`. Each container's whole `ProbedContainer` — ordinal,
	// both ids, and the rest of the diagnostic fields — is produced right
	// here, at the moment this walk encounters that container, so the triple
	// a serializer would record is read as a triple rather than assembled
	// from elements collected in an earlier pass.
	const treeOrderedContainers: ProbedContainer[] = []
	const walk = (element: Element): void => {
		if (FRAME_TAGS.includes(element.tagName)) {
			treeOrderedContainers.push({
				id: element.id === '' ? null : element.id,
				tagName: element.tagName.toLowerCase(),
				treeOrdinal: treeOrderedContainers.length,
				srcAttribute: element.getAttribute('src'),
				hasSrcdoc: element.hasAttribute('srcdoc'),
				sandboxAttribute: element.getAttribute('sandbox'),
				elementFrameId: frameIdOf(element),
				elementDocumentId: documentIdOf(element),
				contentWindowFrameId: frameIdOf((element as HTMLIFrameElement).contentWindow),
				contentWindowDocumentId: documentIdOf((element as HTMLIFrameElement).contentWindow),
				contentDocumentTitle: attempt(() => (element as HTMLIFrameElement).contentDocument?.title),
			})
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

	const isTop = window === window.top

	return {
		marker: document.documentElement.dataset.abFrame ?? null,
		href: attempt(() => location.href),
		title: document.title,
		selfOrigin: attempt(() => self.origin),
		isTop,
		reloadMark: document.documentElement.dataset.abReloadMark ?? null,
		getFrameIdType: typeof contentScriptRuntime?.getFrameId,
		getDocumentIdType: typeof contentScriptRuntime?.getDocumentId,
		selfFrameId: frameIdOf(window),
		parentFrameId: isTop ? 'top document: no parent' : frameIdOf(window.parent),
		selfDocumentId: documentIdOf(window),
		parentDocumentId: isTop ? 'top document: no parent' : documentIdOf(window.parent),
		topDocumentId: documentIdOf(window.top),
		containers: treeOrderedContainers,
		// Created, never inserted: it holds no document, so an id here would
		// mean the API answers about something other than a live document —
		// and a continuity check is only as sound as its worst wrong answer.
		nonFrameElementDocumentId: documentIdOf(document.documentElement),
		detachedIframeDocumentId: documentIdOf(document.createElement('iframe')),
		plainObjectDocumentId: documentIdOf({}),
	}
}

/**
 * The minimal probe used for the **targeting** experiments, where the
 * question is not what a document knows but simply *which document ran
 * this*. Kept small and separate so that a stale-target result is
 * unambiguous: if this answers at all, something executed, and its marker
 * says where.
 */
function whichDocumentProbe(): unknown {
	const contentScriptRuntime = (
		globalThis as unknown as {
			browser?: { runtime?: { getFrameId?: (target: unknown) => unknown; getDocumentId?: (target: unknown) => unknown } }
		}
	).browser?.runtime
	const idOf = (read: ((target: unknown) => unknown) | undefined): string => {
		if (typeof read !== 'function') {
			return 'unavailable'
		}
		try {
			return String(read.call(contentScriptRuntime, window))
		} catch (error) {
			return `threw: ${(error as { name?: string } | null)?.name ?? 'unknown'}`
		}
	}
	return {
		marker: document.documentElement.dataset.abFrame ?? null,
		href: location.href,
		title: document.title,
		selfFrameId: idOf(contentScriptRuntime?.getFrameId),
		selfDocumentId: idOf(contentScriptRuntime?.getDocumentId),
	}
}

/** What {@link whichDocumentProbe} reported from wherever it ran. */
interface WhichDocument {
	readonly marker: string | null
	readonly href: string
	readonly title: string
	readonly selfFrameId: string
	readonly selfDocumentId: string
}

/**
 * The exact outcome of one `scripting.executeScript` call, recorded without
 * deciding in advance which shape a failure takes.
 *
 * This shape is the measurement. Firefox could reject the promise, resolve
 * with an empty array, resolve with an `InjectionResult` carrying an
 * `error`, or execute somewhere — and the difference between "declined" and
 * "ran in the wrong document" is the entire security question, so all four
 * are recorded separately rather than normalized into a boolean.
 */
interface TargetOutcome {
	/** The rejection message, when the call rejected; `null` when it resolved. */
	readonly rejected: string | null
	readonly rejectedName: string | null
	/** How many `InjectionResult`s came back; `null` when the call rejected. */
	readonly resultCount: number | null
	readonly results: readonly {
		readonly frameId: number | null
		readonly documentId: string | null
		readonly error: string | null
		readonly result: WhichDocument | null
	}[]
}

/** How long a navigation is waited for before its non-arrival is recorded as the measurement. Bounded rather than open-ended, so a frame that never navigates fails loudly instead of hanging. */
const NAVIGATION_POLL_ATTEMPTS = 200
const NAVIGATION_POLL_INTERVAL_MS = 50

describe('Firefox document identity: whether a captured document is still the one its container holds', () => {
	let server: TestServer
	let probe: ProbeSession

	/** The Firefox actually under test, read from the browser rather than from an environment variable, so the recorded measurement names the build that produced it. */
	let browserVersion: string
	/** Whether `runtime.getDocumentId` exists in the injected world at all — measured, and the axis every assertion below branches on. */
	let documentIdSupported: boolean

	/** The fixture before anything navigates. */
	let baseline: ProbeRun
	/** The same fixture after six containers have been navigated to replacement documents. */
	let afterNavigation: ProbeRun

	/** Whether each held container element is still the very same DOM node afterwards, checked by node identity in the page's own world. */
	let containerNodeIdentity: readonly (readonly [string, string])[]

	/** `#nav-same`'s identities either side of its navigation — the frame the race is reproduced on. */
	let staleFrameId: number
	let staleDocumentId: string
	let freshDocumentId: string

	/** Targeting by the frame id captured from document A, after the frame holds document B. */
	let staleFrameIdOutcome: TargetOutcome
	/** Targeting by the document id captured from document A, after the frame holds document B. */
	let staleDocumentIdOutcome: TargetOutcome
	/** Targeting by document B's own current document id. */
	let freshDocumentIdOutcome: TargetOutcome
	/** Targeting by a well-formed document id that was never issued, as the control that separates "declined" from "declined *because* stale". */
	let unknownDocumentIdOutcome: TargetOutcome

	/** The same-document controls, each probed on `#same-doc` alone. */
	let sameDocBaseline: ProbedDocument
	let sameDocAfterFragment: ProbedDocument
	let sameDocAfterPushState: ProbedDocument
	let sameDocAfterReload: ProbedDocument

	/** What a page's *own* scripts can see of the APIs this identity is made of. */
	let pageWorldApis: readonly string[]

	before(async () => {
		server = await startTestServer()
		probe = await openProbeSession()

		const info = await probe.inPopup<{ version: string; name: string; buildID: string }>('(async () => JSON.stringify(await browser.runtime.getBrowserInfo()))()')
		browserVersion = `${info.name} ${info.version} (${info.buildID})`

		const { tabId, context } = await probe.openTab(`${server.origin}${DOCUMENT_IDENTITY_PATH}`, DOCUMENT_IDENTITY_READY_TITLE)

		/** One `executeScript` against an arbitrary target, with every failure shape preserved. */
		const target = async (targetExpression: string): Promise<TargetOutcome> =>
			await probe.inPopup<TargetOutcome>(`(async () => {
				const probe = ${whichDocumentProbe.toString()}
				try {
					const injections = await browser.scripting.executeScript({
						target: ${targetExpression},
						world: 'ISOLATED',
						func: probe,
					})
					return JSON.stringify({
						rejected: null,
						rejectedName: null,
						resultCount: injections.length,
						results: injections.map((injection) => ({
							frameId: injection.frameId === undefined ? null : injection.frameId,
							documentId: injection.documentId === undefined ? null : injection.documentId,
							error: injection.error === undefined ? null : String(injection.error),
							result: injection.result === undefined ? null : injection.result,
						})),
					})
				} catch (error) {
					// The rejection is recorded verbatim, including its
					// message: on a Firefox that does not know the
					// \`documentIds\` target at all the message is a schema
					// complaint, and on one that does it is a no-such-document
					// complaint. Those are different findings.
					return JSON.stringify({
						rejected: String(error && error.message ? error.message : error),
						rejectedName: error && error.name ? String(error.name) : null,
						resultCount: null,
						results: [],
					})
				}
			})()`)

		const probeAll = async (): Promise<ProbeRun> => await probe.probeAllFrames<ProbedDocument>(tabId, documentIdentityProbe)
		const markersOf = (run: ProbeRun): string[] => run.injections.flatMap((injection) => (injection.result?.marker == null ? [] : [injection.result.marker]))

		baseline = await probeAll()
		documentIdSupported = baseline.injections.every((injection) => injection.result?.getDocumentIdType === 'function')

		// The container elements are held by **node reference** in the page's
		// own world, so that "the same container" after the navigation is a
		// measured identity rather than an inference from an `id` attribute
		// that a page could have moved to a different element.
		await probe.inPage(
			context,
			`(() => {
				const lookup = (id) => document.getElementById(id) ?? document.getElementById('shadow-host').shadowRoot.getElementById(id)
				window.__abHeld = new Map(['nav-same', 'nav-cross', 'nav-sandbox', 'nav-srcdoc', 'nav-blank', 'nav-shadow', 'same-doc'].map((id) => [id, lookup(id)]))
				return 'held'
			})()`,
		)

		const same = baseline.injections.find((injection) => injection.result?.marker === DOCUMENT_IDENTITY_MARKERS.sameA)
		staleFrameId = same?.frameId as number
		staleDocumentId = same?.result?.selfDocumentId as string

		// **The navigations.** Driven from the page's own main world, i.e.
		// from outside the extension entirely — this is the page doing to
		// itself exactly what a hostile page would do between a capture and a
		// serialization.
		await probe.inPage(
			context,
			`(() => {
				const lookup = (id) => document.getElementById(id) ?? document.getElementById('shadow-host').shadowRoot.getElementById(id)
				lookup('nav-same').src = ${JSON.stringify(`${server.origin}${DOCUMENT_IDENTITY_DOCS.sameB}`)}
				// The origin transition: same-origin document replaced by a
				// cross-origin one in the same container.
				lookup('nav-cross').src = ${JSON.stringify(`${server.crossOrigin}${DOCUMENT_IDENTITY_DOCS.crossB}`)}
				lookup('nav-sandbox').src = ${JSON.stringify(`${server.origin}${DOCUMENT_IDENTITY_DOCS.sandboxB}`)}
				// \`srcdoc\` wins over \`src\` while it is present, so it has to
				// go before the container can be navigated to a real URL.
				const srcdoc = lookup('nav-srcdoc')
				srcdoc.removeAttribute('srcdoc')
				srcdoc.src = ${JSON.stringify(`${server.origin}${DOCUMENT_IDENTITY_DOCS.srcdocB}`)}
				lookup('nav-blank').src = ${JSON.stringify(`${server.origin}${DOCUMENT_IDENTITY_DOCS.blankB}`)}
				lookup('nav-shadow').src = ${JSON.stringify(`${server.origin}${DOCUMENT_IDENTITY_DOCS.shadowB}`)}
				return 'navigated'
			})()`,
		)

		// Waited for **deterministically**: the replacement documents name
		// themselves, and the suite does not proceed until all six have
		// answered under their own markers. No sleep, no timing luck — and a
		// bounded wait, so a frame that never navigates is recorded as such
		// by the assertions rather than hanging the run.
		const expectedAfter = [
			DOCUMENT_IDENTITY_MARKERS.sameB,
			DOCUMENT_IDENTITY_MARKERS.crossB,
			DOCUMENT_IDENTITY_MARKERS.sandboxB,
			DOCUMENT_IDENTITY_MARKERS.srcdocB,
			DOCUMENT_IDENTITY_MARKERS.blankB,
			DOCUMENT_IDENTITY_MARKERS.shadowB,
		]
		afterNavigation = baseline
		for (let attempt = 0; attempt < NAVIGATION_POLL_ATTEMPTS; attempt += 1) {
			afterNavigation = await probeAll()
			const present = new Set(markersOf(afterNavigation))
			if (expectedAfter.every((expected) => present.has(expected))) {
				break
			}
			await new Promise((resolve) => setTimeout(resolve, NAVIGATION_POLL_INTERVAL_MS))
		}

		containerNodeIdentity = JSON.parse(
			String(
				await probe.inPage(
					context,
					`(() => {
						const lookup = (id) => document.getElementById(id) ?? document.getElementById('shadow-host').shadowRoot.getElementById(id)
						return JSON.stringify([...window.__abHeld].map(([id, node]) => [
							id,
							node === lookup(id) ? (node.isConnected ? 'same node, still connected' : 'same node, detached') : 'a different node',
						]))
					})()`,
				),
			),
		) as readonly (readonly [string, string])[]

		const fresh = afterNavigation.injections.find((injection) => injection.result?.marker === DOCUMENT_IDENTITY_MARKERS.sameB)
		freshDocumentId = fresh?.result?.selfDocumentId as string

		// **The race, reproduced.** Document B is known to be loaded before
		// either of these runs, so what they measure is the browser's rule,
		// not a scheduling accident.
		staleFrameIdOutcome = await target(`{ tabId: ${tabId}, frameIds: [${staleFrameId}] }`)
		staleDocumentIdOutcome = await target(`{ tabId: ${tabId}, documentIds: [${JSON.stringify(staleDocumentId)}] }`)
		freshDocumentIdOutcome = await target(`{ tabId: ${tabId}, documentIds: [${JSON.stringify(freshDocumentId)}] }`)
		// A syntactically valid id that was never issued. Without this,
		// "the stale id was declined" could not be told apart from "this
		// Firefox declines every `documentIds` target".
		unknownDocumentIdOutcome = await target(`{ tabId: ${tabId}, documentIds: ["00000000-0000-4000-8000-000000000000"] }`)

		// **The same-document controls.** A fragment navigation and a
		// `pushState()` change this frame's URL without creating a Document;
		// the reload creates one *without* changing the URL. An identity that
		// tracked URLs would get both backwards.
		const sameDocFrameId = afterNavigation.injections.find((injection) => injection.result?.marker === DOCUMENT_IDENTITY_MARKERS.sameDoc)?.frameId as number
		const probeSameDoc = async (): Promise<ProbedDocument> =>
			(await probe.probeFrames<ProbedDocument>(tabId, [sameDocFrameId], documentIdentityProbe)).injections[0]?.result as ProbedDocument
		const waitForSameDoc = async (settled: (document: ProbedDocument) => boolean): Promise<ProbedDocument> => {
			let observed = await probeSameDoc()
			for (let attempt = 0; attempt < NAVIGATION_POLL_ATTEMPTS && !settled(observed); attempt += 1) {
				await new Promise((resolve) => setTimeout(resolve, NAVIGATION_POLL_INTERVAL_MS))
				observed = await probeSameDoc()
			}
			return observed
		}

		sameDocBaseline = await probeSameDoc()
		await probe.inPage(context, "(() => { document.getElementById('same-doc').contentWindow.location.hash = '#fragment-target'; return 'fragment' })()")
		sameDocAfterFragment = await waitForSameDoc((observed) => observed.href.includes('#fragment-target'))

		await probe.inPage(
			context,
			`(() => { document.getElementById('same-doc').contentWindow.history.pushState({}, '', ${JSON.stringify(`${DOCUMENT_IDENTITY_DOCS.sameDoc}?pushed`)}); return 'pushed' })()`,
		)
		sameDocAfterPushState = await waitForSameDoc((observed) => observed.href.includes('?pushed'))

		// The reload's wait signal is a marker the harness writes into the
		// *outgoing* document: the replacement will not carry it. It is only
		// a synchronization device — no assertion joins on it, precisely
		// because a page could write it too.
		await probe.inPage(
			context,
			`(() => {
				const frame = document.getElementById('same-doc')
				frame.contentDocument.documentElement.dataset.abReloadMark = 'outgoing'
				frame.contentWindow.location.reload()
				return 'reloaded'
			})()`,
		)
		sameDocAfterReload = await waitForSameDoc((observed) => observed.reloadMark === null)

		pageWorldApis = JSON.parse(
			String(
				await probe.inPage(
					context,
					'JSON.stringify([typeof browser, typeof chrome, typeof (globalThis.browser && globalThis.browser.runtime && globalThis.browser.runtime.getDocumentId), typeof (globalThis.browser && globalThis.browser.runtime && globalThis.browser.runtime.getFrameId)])',
				),
			),
		) as readonly string[]

		// The whole measurement, printed: this suite's value is as much the
		// recorded table as its assertions, and a CI log that only says
		// "passed" cannot be read against a future Firefox.
		console.log(
			'document-identity measurement:',
			JSON.stringify(
				{
					browserVersion,
					documentIdSupported,
					baseline,
					afterNavigation,
					containerNodeIdentity,
					staleFrameId,
					staleDocumentId,
					freshDocumentId,
					staleFrameIdOutcome,
					staleDocumentIdOutcome,
					freshDocumentIdOutcome,
					unknownDocumentIdOutcome,
					sameDocBaseline,
					sameDocAfterFragment,
					sameDocAfterPushState,
					sameDocAfterReload,
					pageWorldApis,
				},
				null,
				'\t',
			),
		)
	})

	after(async () => {
		await probe?.close()
		await server?.close()
	})

	/** The document that named itself `marker` in `run`, failing with the whole roster rather than `undefined` when it is not there. */
	function documentOf(run: ProbeRun, marker: string): ProbedDocument {
		const injection = run.injections.find((candidate) => candidate.result?.marker === marker)
		assert.notEqual(
			injection,
			undefined,
			`no document reported itself as "${marker}"; the documents that answered were ${JSON.stringify(run.injections.map((candidate) => candidate.result?.marker))}`,
		)
		return injection?.result as ProbedDocument
	}

	/** The top document's container with this element id, in `run`. */
	function containerOf(run: ProbeRun, id: string): ProbedContainer {
		const found = documentOf(run, DOCUMENT_IDENTITY_MARKERS.top).containers.find((candidate) => candidate.id === id)
		assert.notEqual(found, undefined, `the top document reported no frame container #${id}`)
		return found as ProbedContainer
	}

	/** The `InjectionResult` the document naming itself `marker` arrived in. */
	function injectionOf(run: ProbeRun, marker: string): { frameId: number | null; documentId: string | null } {
		const injection = run.injections.find((candidate) => candidate.result?.marker === marker)
		assert.notEqual(injection, undefined, `no injection result for "${marker}"`)
		return injection as { frameId: number | null; documentId: string | null }
	}

	test('AA. the fixture reached every document kind the continuity check has to cover', () => {
		// The roster by name: a count that happened to match while two
		// documents swapped places would say nothing. Both the navigable
		// containers' *starting* documents and the never-navigated controls
		// are here, because the question is asked of both.
		assert.deepEqual(
			[...new Set(baseline.injections.map((injection) => injection.result?.marker))].sort(),
			[
				DOCUMENT_IDENTITY_MARKERS.blankA,
				DOCUMENT_IDENTITY_MARKERS.crossA,
				DOCUMENT_IDENTITY_MARKERS.crossStatic,
				DOCUMENT_IDENTITY_MARKERS.nestedCross,
				DOCUMENT_IDENTITY_MARKERS.nestedDeep,
				DOCUMENT_IDENTITY_MARKERS.nestedParent,
				DOCUMENT_IDENTITY_MARKERS.sameA,
				DOCUMENT_IDENTITY_MARKERS.sameDoc,
				DOCUMENT_IDENTITY_MARKERS.sandboxA,
				DOCUMENT_IDENTITY_MARKERS.shadowA,
				DOCUMENT_IDENTITY_MARKERS.srcdocA,
				DOCUMENT_IDENTITY_MARKERS.top,
			].sort(),
		)
		// And every one of the six navigations actually happened, confirmed
		// by the replacement documents naming themselves — never by a URL
		// having changed, which is the identity this whole file refuses to
		// use.
		const after = new Set(afterNavigation.injections.map((injection) => injection.result?.marker))
		for (const marker of [
			DOCUMENT_IDENTITY_MARKERS.sameB,
			DOCUMENT_IDENTITY_MARKERS.crossB,
			DOCUMENT_IDENTITY_MARKERS.sandboxB,
			DOCUMENT_IDENTITY_MARKERS.srcdocB,
			DOCUMENT_IDENTITY_MARKERS.blankB,
			DOCUMENT_IDENTITY_MARKERS.shadowB,
		]) {
			assert.equal(after.has(marker), true, `the navigation to "${marker}" never completed, so nothing below measures what it claims to`)
		}
		// The replaced documents are gone, not merely shadowed by their
		// replacements.
		for (const marker of [
			DOCUMENT_IDENTITY_MARKERS.sameA,
			DOCUMENT_IDENTITY_MARKERS.crossA,
			DOCUMENT_IDENTITY_MARKERS.sandboxA,
			DOCUMENT_IDENTITY_MARKERS.srcdocA,
			DOCUMENT_IDENTITY_MARKERS.blankA,
			DOCUMENT_IDENTITY_MARKERS.shadowA,
		]) {
			assert.equal(after.has(marker), false, `"${marker}" still answered after its frame was navigated away`)
		}
	})

	test('AB. getDocumentId and InjectionResult.documentId appear together, or not at all', () => {
		// The availability question, asked of the *whole surface at once*:
		// either both halves of the join exist or neither does. A Firefox
		// that offered one without the other would be the dangerous case —
		// a continuity check that could be half-built — so it is asserted
		// against rather than assumed away.
		const injectionsCarryDocumentId = baseline.injectionResultKeys.includes('documentId')
		assert.equal(
			documentIdSupported,
			injectionsCarryDocumentId,
			`runtime.getDocumentId and InjectionResult.documentId disagree about whether document identity exists on ${browserVersion}`,
		)

		// Whichever way it went, the *frame* identity surface is unchanged —
		// this suite must never be the one that quietly contradicts the
		// frame-identity gate.
		assert.deepEqual([...new Set(baseline.injections.map((injection) => injection.result?.getFrameIdType))], ['function'])
		for (const key of baseline.injectionResultKeys) {
			assert.ok(['documentId', 'error', 'frameId', 'result'].includes(key), `Firefox put an unrecognized field "${key}" on an InjectionResult`)
		}
		assert.equal(baseline.injectionResultKeys.includes('parentFrameId'), false)

		// The version boundary, pinned to what was measured: absent on
		// 152.0.1, present from 153.0.1. If a future Firefox removes it, this
		// is where that surfaces — loudly — rather than in a silently
		// degraded capture.
		const major = Number.parseInt(browserVersion.replace(/^\D+/, ''), 10)
		assert.equal(documentIdSupported, major >= 153, `document identity support on ${browserVersion} is not what the measured 152/153 boundary predicts`)
	})

	test('AC. a document’s own id is exactly the id the extension was handed for it, in every document kind', (context) => {
		if (!documentIdSupported) {
			context.skip(`${browserVersion} has no runtime.getDocumentId; test AL is the measurement for this version`)
			return
		}
		// The namespace question, and the precondition for everything else:
		// what a document calls itself and what `scripting` calls it are one
		// value — across origin boundaries, opaque origins, `srcdoc`,
		// parent-written `about:blank` and shadow-hosted frames alike.
		for (const run of [baseline, afterNavigation]) {
			for (const injection of run.injections) {
				assert.equal(
					injection.result?.selfDocumentId,
					injection.documentId,
					`${injection.result?.marker} disagreed with the InjectionResult it arrived in about its own document id`,
				)
			}
		}
		// Every document in a run has a distinct id, and each is the opaque
		// UUID-shaped string Firefox issues — recorded as a format
		// observation, so a change of shape is visible rather than silently
		// tolerated.
		const ids = baseline.injections.map((injection) => injection.documentId)
		assert.equal(new Set(ids).size, ids.length, 'two live documents shared a document id')
		for (const id of ids) {
			assert.match(String(id), /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, 'document ids are expected to be UUIDs; a change of shape is a finding')
		}
		// And it fails closed on inputs that are not documents. An element
		// that holds nothing, and a plain object, must never be given some
		// other document's id.
		for (const injection of baseline.injections) {
			assert.equal(injection.result?.nonFrameElementDocumentId.startsWith('threw:'), true, `${injection.result?.marker} got a document id for <html>`)
			assert.equal(injection.result?.plainObjectDocumentId.startsWith('threw:'), true, `${injection.result?.marker} got a document id for a plain object`)
			assert.equal(ids.includes(injection.result?.detachedIframeDocumentId ?? ''), false, `${injection.result?.marker} was given a live document's id for a detached <iframe>`)
		}
	})

	test('AD. a child can name its parent document, across origin boundaries in both directions', (context) => {
		if (!documentIdSupported) {
			context.skip(`${browserVersion} has no runtime.getDocumentId`)
			return
		}
		// Test O of the frame-identity gate established that a child can name
		// its parent *frame*. This is the stronger statement the continuity
		// check needs: the id a child reports for `window.parent` is the id
		// of the parent **document**, so a captured child carries a
		// verifiable claim about which document it was inside.
		const documentIdOf = new Map(baseline.injections.map((injection) => [injection.documentId, injection.result?.marker]))
		assert.deepEqual(
			baseline.injections
				.map((injection) => [injection.result?.marker, injection.result?.isTop ? injection.result.parentDocumentId : documentIdOf.get(injection.result?.parentDocumentId ?? '')])
				.sort(),
			[
				[DOCUMENT_IDENTITY_MARKERS.blankA, DOCUMENT_IDENTITY_MARKERS.top],
				[DOCUMENT_IDENTITY_MARKERS.crossA, DOCUMENT_IDENTITY_MARKERS.top],
				[DOCUMENT_IDENTITY_MARKERS.crossStatic, DOCUMENT_IDENTITY_MARKERS.top],
				// The deep case: a same-origin-to-top grandchild inside a
				// cross-origin parent still names that parent's document.
				[DOCUMENT_IDENTITY_MARKERS.nestedCross, DOCUMENT_IDENTITY_MARKERS.nestedParent],
				[DOCUMENT_IDENTITY_MARKERS.nestedDeep, DOCUMENT_IDENTITY_MARKERS.nestedCross],
				[DOCUMENT_IDENTITY_MARKERS.nestedParent, DOCUMENT_IDENTITY_MARKERS.top],
				[DOCUMENT_IDENTITY_MARKERS.sameA, DOCUMENT_IDENTITY_MARKERS.top],
				[DOCUMENT_IDENTITY_MARKERS.sameDoc, DOCUMENT_IDENTITY_MARKERS.top],
				[DOCUMENT_IDENTITY_MARKERS.sandboxA, DOCUMENT_IDENTITY_MARKERS.top],
				[DOCUMENT_IDENTITY_MARKERS.shadowA, DOCUMENT_IDENTITY_MARKERS.top],
				[DOCUMENT_IDENTITY_MARKERS.srcdocA, DOCUMENT_IDENTITY_MARKERS.top],
				[DOCUMENT_IDENTITY_MARKERS.top, 'top document: no parent'],
			].sort(),
		)
		// Every document agrees about the top of its own tree, however many
		// origin changes away it is.
		const topDocumentId = documentOf(baseline, DOCUMENT_IDENTITY_MARKERS.top).selfDocumentId
		assert.deepEqual([...new Set(baseline.injections.map((injection) => injection.result?.topDocumentId))], [topDocumentId])
	})

	test('AE. a container’s document id is the id of the document it currently holds, including where the parent cannot read the child at all', (context) => {
		if (!documentIdSupported) {
			context.skip(`${browserVersion} has no runtime.getDocumentId`)
			return
		}
		// The parent's half. `getDocumentId(container)` must name the
		// document *in* that container, and it must do so for the containers
		// whose contents the parent cannot otherwise see — which is most of
		// the interesting ones.
		const byDocumentId = new Map(baseline.injections.map((injection) => [injection.documentId, injection.result?.marker]))
		assert.deepEqual(
			documentOf(baseline, DOCUMENT_IDENTITY_MARKERS.top).containers.map((container) => [container.id, byDocumentId.get(container.elementDocumentId)]),
			[
				['nav-same', DOCUMENT_IDENTITY_MARKERS.sameA],
				['nav-cross', DOCUMENT_IDENTITY_MARKERS.crossA],
				['nav-sandbox', DOCUMENT_IDENTITY_MARKERS.sandboxA],
				['nav-srcdoc', DOCUMENT_IDENTITY_MARKERS.srcdocA],
				['nav-blank', DOCUMENT_IDENTITY_MARKERS.blankA],
				['nav-shadow', DOCUMENT_IDENTITY_MARKERS.shadowA],
				['same-doc', DOCUMENT_IDENTITY_MARKERS.sameDoc],
				['cross-static', DOCUMENT_IDENTITY_MARKERS.crossStatic],
				['nested-parent', DOCUMENT_IDENTITY_MARKERS.nestedParent],
			],
		)
		// The element path and the `WindowProxy` path agree, so a serializer
		// holding an element and a probe holding a window are asking the same
		// question.
		for (const injection of baseline.injections) {
			for (const container of injection.result?.containers ?? []) {
				assert.equal(container.elementDocumentId, container.contentWindowDocumentId, `#${container.id} answered differently through its element and its contentWindow`)
			}
		}
		// And the identity does not depend on the parent being able to reach
		// into the child, which is the property that matters most: the
		// containers a parent *cannot* read through `contentDocument` are
		// identified exactly as the readable ones are.
		//
		// `#cross-static` is the cross-origin case at baseline — `#nav-cross`
		// is not, because it *starts* same-origin and only crosses when it
		// navigates, which is what makes it the origin-transition case in AG
		// rather than a cross-origin case here.
		//
		// Both are unreadable the same way from the parent's side:
		// `contentDocument` is `null` — for the cross-origin container
		// because of the origin, for the sandboxed one because its origin is
		// opaque — so reading a title through it yields `undefined` rather
		// than throwing. (The *child* reading back the other way does throw;
		// that is the frame-identity suite's test J.)
		assert.equal(containerOf(baseline, 'cross-static').contentDocumentTitle, 'undefined', 'a cross-origin container must not be readable through contentDocument')
		assert.equal(containerOf(baseline, 'nav-sandbox').contentDocumentTitle, 'undefined', 'a sandboxed container must not be readable through contentDocument')
		assert.equal(byDocumentId.get(containerOf(baseline, 'cross-static').elementDocumentId), DOCUMENT_IDENTITY_MARKERS.crossStatic)
		assert.equal(byDocumentId.get(containerOf(baseline, 'nav-sandbox').elementDocumentId), DOCUMENT_IDENTITY_MARKERS.sandboxA)

		// `#nav-cross` after its navigation is the same fact reached the
		// other way round: a container that *became* unreadable is still
		// identified, and identified as the document that actually replaced
		// the one the parent used to be able to see.
		const afterByDocumentId = new Map(afterNavigation.injections.map((injection) => [injection.documentId, injection.result?.marker]))
		assert.equal(containerOf(baseline, 'nav-cross').contentDocumentTitle, 'origin transition before')
		assert.equal(containerOf(afterNavigation, 'nav-cross').contentDocumentTitle, 'undefined')
		assert.equal(afterByDocumentId.get(containerOf(afterNavigation, 'nav-cross').elementDocumentId), DOCUMENT_IDENTITY_MARKERS.crossB)
	})

	test('AF. the same container, holding a different document, is still the same frame', () => {
		// **The setup for the whole problem, measured rather than argued.**
		// Six containers were navigated. Each is the same DOM node it was —
		// checked by node identity in the page's own world, not by `id` —
		// and each kept its frame id while its document was replaced.
		assert.deepEqual(
			[...containerNodeIdentity].sort(),
			[
				['nav-blank', 'same node, still connected'],
				['nav-cross', 'same node, still connected'],
				['nav-same', 'same node, still connected'],
				['nav-sandbox', 'same node, still connected'],
				['nav-shadow', 'same node, still connected'],
				['nav-srcdoc', 'same node, still connected'],
				['same-doc', 'same node, still connected'],
			].sort(),
		)

		for (const [id, before, after] of [
			['nav-same', DOCUMENT_IDENTITY_MARKERS.sameA, DOCUMENT_IDENTITY_MARKERS.sameB],
			['nav-cross', DOCUMENT_IDENTITY_MARKERS.crossA, DOCUMENT_IDENTITY_MARKERS.crossB],
			['nav-sandbox', DOCUMENT_IDENTITY_MARKERS.sandboxA, DOCUMENT_IDENTITY_MARKERS.sandboxB],
			['nav-srcdoc', DOCUMENT_IDENTITY_MARKERS.srcdocA, DOCUMENT_IDENTITY_MARKERS.srcdocB],
			['nav-blank', DOCUMENT_IDENTITY_MARKERS.blankA, DOCUMENT_IDENTITY_MARKERS.blankB],
			['nav-shadow', DOCUMENT_IDENTITY_MARKERS.shadowA, DOCUMENT_IDENTITY_MARKERS.shadowB],
		] as const) {
			// The frame id is unchanged — from the container's side and from
			// the document's side both. **This is the hazard**: every frame
			// identity number a Phase 2 join would compare still matches,
			// while the document behind it is a different one.
			assert.equal(
				containerOf(afterNavigation, id).elementFrameId,
				containerOf(baseline, id).elementFrameId,
				`#${id} changed frame id across a navigation, which would have made the race self-detecting`,
			)
			assert.equal(injectionOf(afterNavigation, after).frameId, injectionOf(baseline, before).frameId, `the document in #${id} arrived under a different frame id`)
			// And the ordinal is unchanged too, because nothing in the DOM
			// moved — so the container-placement race and the
			// document-replacement race really are independent.
			assert.equal(containerOf(afterNavigation, id).treeOrdinal, containerOf(baseline, id).treeOrdinal)
		}

		// The untouched containers are the control: they changed nothing.
		for (const id of ['same-doc', 'cross-static', 'nested-parent']) {
			assert.equal(containerOf(afterNavigation, id).elementFrameId, containerOf(baseline, id).elementFrameId)
		}
	})

	test('AG. …and it is a different document, which only documentId says', (context) => {
		if (!documentIdSupported) {
			context.skip(`${browserVersion} has no runtime.getDocumentId; test AL is the measurement for this version`)
			return
		}
		// **The verdict test.** The hypothesis in full:
		//
		//     same container   (AF, by node identity)
		//     same frameId     (AF, both sides)
		//     different documentId
		//     different document
		//
		// measured over every document kind in the fixture, and never
		// inferred from a URL — the `about:blank` container had no `src` at
		// all before its navigation, and the `srcdoc` one had no URL of its
		// own.
		for (const [id, before, after] of [
			['nav-same', DOCUMENT_IDENTITY_MARKERS.sameA, DOCUMENT_IDENTITY_MARKERS.sameB],
			['nav-cross', DOCUMENT_IDENTITY_MARKERS.crossA, DOCUMENT_IDENTITY_MARKERS.crossB],
			['nav-sandbox', DOCUMENT_IDENTITY_MARKERS.sandboxA, DOCUMENT_IDENTITY_MARKERS.sandboxB],
			['nav-srcdoc', DOCUMENT_IDENTITY_MARKERS.srcdocA, DOCUMENT_IDENTITY_MARKERS.srcdocB],
			['nav-blank', DOCUMENT_IDENTITY_MARKERS.blankA, DOCUMENT_IDENTITY_MARKERS.blankB],
			['nav-shadow', DOCUMENT_IDENTITY_MARKERS.shadowA, DOCUMENT_IDENTITY_MARKERS.shadowB],
		] as const) {
			const wasHolding = containerOf(baseline, id).elementDocumentId
			const nowHolding = containerOf(afterNavigation, id).elementDocumentId
			assert.notEqual(nowHolding, wasHolding, `#${id} reported the same document id before and after a real navigation, so the check cannot detect a replacement`)
			// The container's new id is the *replacement's* id, so a
			// serializer reading it gets the document that is actually there.
			assert.equal(nowHolding, injectionOf(afterNavigation, after).documentId, `#${id} names neither the old document nor the new one`)
			// And the old id is the one the capture would be carrying, so the
			// mismatch a fail-closed check needs is exactly this comparison.
			assert.equal(wasHolding, injectionOf(baseline, before).documentId)
		}

		// The untouched containers keep their document ids, which is what
		// makes the changed ones mean something: the id is not simply
		// re-issued on every read.
		for (const id of ['same-doc', 'cross-static', 'nested-parent']) {
			assert.equal(containerOf(afterNavigation, id).elementDocumentId, containerOf(baseline, id).elementDocumentId, `#${id} changed document id without being navigated`)
		}
		// Including the whole nested tree below an untouched container.
		assert.equal(injectionOf(afterNavigation, DOCUMENT_IDENTITY_MARKERS.nestedDeep).documentId, injectionOf(baseline, DOCUMENT_IDENTITY_MARKERS.nestedDeep).documentId)
	})

	test('AH. targeting the stale frame id runs in the replacement document — the concrete reason frameId cannot carry continuity', () => {
		// **The dangerous sequence, executed.** Document A's frame id was
		// captured before the navigation; document B is known to be loaded;
		// this call targets that same id. Whatever it does is the answer to
		// "is frameId enough?".
		assert.equal(staleFrameIdOutcome.rejected, null, 'targeting a live frame by id did not reject')
		assert.equal(staleFrameIdOutcome.resultCount, 1)
		const [only] = staleFrameIdOutcome.results
		assert.equal(only?.error, null)
		assert.equal(only?.frameId, staleFrameId, 'the stale frame id addressed the frame it always named — the frame is still there')
		// And it ran in **B**. The frame id is correct, the document is not,
		// and nothing in the call said otherwise. A Phase 2 that attached a
		// captured document on the strength of a matching frame id would
		// attach A to a container holding B, with every number agreeing.
		assert.equal(
			only?.result?.marker,
			DOCUMENT_IDENTITY_MARKERS.sameB,
			'the stale frame id did not reach the replacement document; if a future Firefox invalidates frame ids across navigation, the whole premise here changes',
		)
		assert.notEqual(only?.result?.marker, DOCUMENT_IDENTITY_MARKERS.sameA)
	})

	test('AI. targeting the stale document id does not run in the replacement document', (context) => {
		if (!documentIdSupported) {
			context.skip(`${browserVersion} has no scripting documentIds target; test AL is the measurement for this version`)
			return
		}
		// **The soundness condition, and it is deliberately not a claim about
		// the failure's shape.** What must hold is only this: the script did
		// not execute in document B. Firefox may reject, return nothing, or
		// return an `InjectionResult` carrying an error — all three are
		// recorded, none is assumed.
		const ranSomewhere = staleDocumentIdOutcome.results.filter((entry) => entry.result != null)
		assert.deepEqual(
			ranSomewhere.map((entry) => entry.result?.marker),
			[],
			`a stale document id executed somewhere: ${JSON.stringify(ranSomewhere)}`,
		)
		// Said the sharp way, since this is the security invariant:
		assert.equal(
			staleDocumentIdOutcome.results.some((entry) => entry.result?.marker === DOCUMENT_IDENTITY_MARKERS.sameB),
			false,
			'a stale document id executed in the replacement document, which would make documentId no better than frameId',
		)

		// The observed shape, pinned separately so a future Firefox changing
		// *how* it declines is visible without being confused for a
		// soundness regression.
		assert.equal(staleDocumentIdOutcome.rejected != null, true, `expected a rejection; got ${JSON.stringify(staleDocumentIdOutcome)}`)
		// A never-issued id is declined the same way, so the rejection is
		// about the document not existing rather than about this Firefox
		// refusing `documentIds` targets in general.
		assert.equal(unknownDocumentIdOutcome.rejected != null, true)
		assert.deepEqual(unknownDocumentIdOutcome.results, [])

		// And the other half: the *current* document is reachable by its
		// current id, so failing closed on a stale id is not the same as
		// failing always.
		assert.equal(freshDocumentIdOutcome.rejected, null, `targeting the live document by its current id failed: ${freshDocumentIdOutcome.rejected}`)
		assert.equal(freshDocumentIdOutcome.resultCount, 1)
		assert.equal(freshDocumentIdOutcome.results[0]?.result?.marker, DOCUMENT_IDENTITY_MARKERS.sameB)
		assert.equal(freshDocumentIdOutcome.results[0]?.documentId, freshDocumentId)
		assert.equal(freshDocumentIdOutcome.results[0]?.frameId, staleFrameId, 'the replacement document is in the frame that always held it')
	})

	test('AJ. the id tracks Document lifetime, not the URL', (context) => {
		if (!documentIdSupported) {
			context.skip(`${browserVersion} has no runtime.getDocumentId`)
			return
		}
		// **The control that makes AG mean what it says.** Two operations
		// change this frame's URL without creating a Document, and one
		// creates a Document without changing the URL. An identity derived
		// from URLs would be wrong about all three.
		assert.equal(sameDocAfterFragment.href.includes('#fragment-target'), true, 'the fragment navigation did not happen')
		assert.equal(sameDocAfterFragment.selfDocumentId, sameDocBaseline.selfDocumentId, 'a fragment navigation changed the document id, so the id tracks URLs rather than Documents')

		assert.equal(sameDocAfterPushState.href.includes('?pushed'), true, 'the pushState did not happen')
		assert.equal(sameDocAfterPushState.selfDocumentId, sameDocBaseline.selfDocumentId, 'history.pushState() changed the document id')

		// The reload is the mirror image: a new Document at a URL that did
		// not change.
		assert.equal(sameDocAfterReload.href, sameDocAfterPushState.href, 'the reload was expected to land on the same URL')
		assert.notEqual(sameDocAfterReload.selfDocumentId, sameDocBaseline.selfDocumentId, 'a reload did not change the document id, so a replaced Document would be undetectable')
		// Throughout all four observations it is the same frame, which is
		// the point: `frameId` cannot distinguish any of these from any
		// other.
		assert.equal(sameDocAfterFragment.selfFrameId, sameDocBaseline.selfFrameId)
		assert.equal(sameDocAfterPushState.selfFrameId, sameDocBaseline.selfFrameId)
		assert.equal(sameDocAfterReload.selfFrameId, sameDocBaseline.selfFrameId)
	})

	test('AK. a serializer can read frame id, document id and ordinal from the same container in one traversal', (context) => {
		if (!documentIdSupported) {
			context.skip(`${browserVersion} has no runtime.getDocumentId`)
			return
		}
		// The frame-identity gate's test U established that a container's
		// ordinal and its frame id must be observed in the **same**
		// traversal, because ordinals decay under DOM mutation while ids do
		// not. The question here is whether the document id can join that
		// same moment — because if it cannot, the continuity check would
		// have to be a second pass, and a second pass is what test U rules
		// out.
		//
		// It can: the probe's single shadow-aware walk produces all three per
		// container, and every one of them is a real answer for every
		// container kind in the fixture.
		for (const run of [baseline, afterNavigation]) {
			const containers = documentOf(run, DOCUMENT_IDENTITY_MARKERS.top).containers
			assert.equal(containers.length, 9)
			for (const container of containers) {
				assert.equal(typeof container.elementFrameId, 'number', `#${container.id} produced no frame id in the serializing traversal`)
				assert.match(container.elementDocumentId, /^[0-9a-f-]{36}$/, `#${container.id} produced no document id in the serializing traversal`)
			}
			// The ordinals are the contiguous tree order a rewrite counts in,
			// shadow-hosted container included — the same numbering the
			// frame-identity gate's test I measured against the real
			// serializer.
			assert.deepEqual(
				containers.map((container) => container.treeOrdinal),
				[0, 1, 2, 3, 4, 5, 6, 7, 8],
			)
			assert.equal(
				containers.some((container) => container.id === 'nav-shadow'),
				true,
				'the shadow-hosted container must be in the traversal a serializer walks',
			)
		}

		// So the triple a future Phase 2 would record is available, and the
		// two identities disagree in exactly the way a fail-closed check
		// needs: after the navigation, the frame id still matches what the
		// capture carried and the document id does not.
		const capturedFrameId = containerOf(baseline, 'nav-same').elementFrameId
		const capturedDocumentId = containerOf(baseline, 'nav-same').elementDocumentId
		assert.equal(containerOf(afterNavigation, 'nav-same').elementFrameId, capturedFrameId, 'the frame id agrees, which is why it cannot be the only check')
		assert.notEqual(
			containerOf(afterNavigation, 'nav-same').elementDocumentId,
			capturedDocumentId,
			'the document id is what disagrees, and therefore what fails the attachment closed',
		)
	})

	test('AL. on a Firefox without documentId, no primitive here distinguishes the replacement document', (context) => {
		if (documentIdSupported) {
			context.skip(`${browserVersion} has document identity; tests AC–AK are the measurement for this version`)
			return
		}
		// **The finding that decides the supported-version floor.** On a
		// Firefox that predates `documentId`, this is what is left — and it
		// is not enough. Recorded as assertions rather than as prose so that
		// a Firefox which quietly gains the API is not silently treated as
		// if it had not.
		assert.deepEqual([...new Set(baseline.injections.map((injection) => injection.result?.getDocumentIdType))], ['undefined'])
		assert.equal(baseline.injectionResultKeys.includes('documentId'), false)
		assert.deepEqual([...new Set(baseline.injections.map((injection) => injection.documentId))], [null])
		// `scripting` does not accept the target either, so there is no way
		// to address a document even if one could be named.
		assert.equal(staleDocumentIdOutcome.rejected != null, true, 'a documentIds target was accepted on a version with no document identity')

		// And the *frame* side is exactly as sound as it was — which is the
		// trap. Every number a Phase 2 join would compare still matches
		// across the navigation, so nothing fails; the archive is simply
		// wrong.
		assert.equal(containerOf(afterNavigation, 'nav-same').elementFrameId, containerOf(baseline, 'nav-same').elementFrameId)
		assert.equal(staleFrameIdOutcome.results[0]?.result?.marker, DOCUMENT_IDENTITY_MARKERS.sameB)
		// The container is unchanged in the serialized markup too: same
		// ordinal, and for the `about:blank` container not even a `src`
		// attribute to have noticed a difference in.
		assert.equal(containerOf(afterNavigation, 'nav-same').treeOrdinal, containerOf(baseline, 'nav-same').treeOrdinal)
		assert.equal(containerOf(baseline, 'nav-blank').srcAttribute, null)
		// Therefore: nothing observable to this extension, on this version,
		// separates "the captured document is still here" from "it was
		// replaced". The safe degradation is to not link the child at all.
	})

	test('AM. none of this is visible to the page whose documents are being identified', () => {
		// The identity is carried entirely between Firefox and the
		// extension: read in an isolated world, through an API the page
		// cannot reach, and never written into the page. So there is no
		// token for a hostile page to observe, replay, or relay — and in
		// particular a page cannot forge a document id to make a stale
		// capture look current.
		assert.deepEqual(pageWorldApis, ['undefined', 'undefined', 'undefined', 'undefined'], "a page that can reach the extension's own APIs could forge this join")
	})
})
