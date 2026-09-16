/**
 * The shared bootstrap the Firefox identity probes run in: a real Firefox
 * with the real built extension installed, the optional `<all_urls>` host
 * permission acquired from a genuine synthesized click, and a way to run an
 * arbitrary probe function across a tab's frames through
 * `browser.scripting.executeScript`.
 *
 * **This is test-only scaffolding, not production code, and it is shared
 * for a specific reason.** Two suites now measure Firefox identity
 * primitives against real pages — `frame-identity.test.ts` (which browsing
 * context a captured document belongs to) and
 * `document-identity.test.ts` (whether that browsing context still holds
 * the document that was captured out of it). Both need exactly the same
 * setup, and none of that setup is obvious: the host permission has to come
 * from a real input event rather than a granted pref, the extension has to
 * be driven through its own popup because BiDi cannot reach a background
 * realm at all (see `bidi-session.ts`), and the tab id has to be found by
 * URL with a guard against a second tab at the same address answering
 * plausibly. A second copy of that would mean a future Firefox change
 * surfacing in one suite and not the other, which is precisely the failure
 * mode both suites exist to prevent.
 *
 * What is deliberately **not** here is anything either suite measures.
 * The probe functions themselves, the assertions, and every interpretation
 * of a result live in the suites. This module knows how to get a probe into
 * a frame and how to hand back what Firefox said about it, including which
 * fields Firefox put on an `InjectionResult` at all — which is itself one of
 * the measurements, and so is reported rather than normalized away.
 */

import assert from 'node:assert/strict'
import { startFirefoxSession } from './bidi-session.ts'

/**
 * One `scripting.executeScript` result, kept as Firefox handed it over —
 * including which fields were there at all, which is one of the things
 * being measured. `documentId` is the clearest case: it is absent on
 * Firefox 152.0.1 and present from 153.0.1 (measured), so it is read
 * defensively and reported as `null` when missing rather than being
 * assumed into existence.
 */
export interface ProbedInjection<TResult> {
	readonly frameId: number | null
	readonly documentId: string | null
	readonly parentFrameId: number | null
	readonly error: string | null
	readonly result: TResult | null
}

export interface ProbeRun<TResult> {
	/** Every own-enumerable key Firefox put on an `InjectionResult`, deduplicated across the result set. */
	readonly injectionResultKeys: readonly string[]
	readonly injections: readonly ProbedInjection<TResult>[]
}

/** A Firefox with the built extension installed, the optional host permission acquired from a real click, and a way to run a probe across a tab's frames. */
export interface ProbeSession {
	/** Opens `url`, waits for it to rename itself to `readyTitle`, and returns both the tab id the extension addresses it by and the browsing context a test drives the page itself through. */
	openTab(url: string, readyTitle: string): Promise<OpenedTab>
	/** Runs `probe` in every frame of `tabId`, the way a Phase 2 identity pass would. */
	probeAllFrames<TResult>(tabId: number, probe: () => unknown): Promise<ProbeRun<TResult>>
	/** Runs it in exactly the frames named, which is the bounded second pass a heavy capture would need. */
	probeFrames<TResult>(tabId: number, frameIds: readonly number[], probe: () => unknown): Promise<ProbeRun<TResult>>
	/** Evaluates an expression in the extension's own page and parses the JSON it returns. */
	inPopup<T>(expression: string): Promise<T>
	/** Evaluates an expression in a **page's** own main world — how a test mutates or navigates a fixture the way a hostile page would, from outside the extension entirely. */
	inPage(context: string, expression: string): Promise<unknown>
	close(): Promise<void>
}

/** A fixture tab, addressable from both sides: `tabId` is what `scripting.executeScript` targets, `context` is what drives the page itself. */
export interface OpenedTab {
	readonly tabId: number
	readonly context: string
}

export async function openProbeSession(): Promise<ProbeSession> {
	const session = await startFirefoxSession()
	try {
		const popupContext = await session.openPage(session.extensionUrl('popup.html'))
		const inPopup = async <T>(expression: string): Promise<T> => JSON.parse(String(await session.evaluate(popupContext, expression))) as T

		// The host permission this probe needs for cross-origin frames is
		// acquired exactly as a user acquires it: a genuine synthesized
		// pointer event on the production button, whose command then fails
		// fast because the active tab is the popup itself. The failure is
		// incidental; the grant is the point.
		await session.click(popupContext, '#save-mhtml')
		for (let attempt = 0; attempt < 200; attempt += 1) {
			const busy = await inPopup<boolean>("JSON.stringify(document.getElementById('save-mhtml').disabled)")
			if (!busy) {
				break
			}
			await new Promise((resolve) => setTimeout(resolve, 50))
		}
		const granted = await inPopup<{ origins: string[] }>('(async () => JSON.stringify(await browser.permissions.getAll()))()')
		assert.ok(granted.origins.includes('<all_urls>'), `the probe needs the host permission Phase 2 would run with; got ${JSON.stringify(granted.origins)}`)

		// The probe arrives as source text and is rebuilt inside the popup,
		// the way `capture.ts` passes `capturePageState` — so a probe may
		// close over nothing, which is what keeps it honest about running
		// in a world it did not come from.
		const runProbe = async <TResult>(target: string, probe: () => unknown): Promise<ProbeRun<TResult>> =>
			await inPopup<ProbeRun<TResult>>(`(async () => {
				const probe = ${probe.toString()}
				const injections = await browser.scripting.executeScript({
					target: ${target},
					world: 'ISOLATED',
					func: probe,
				})
				// Every own key Firefox put on an InjectionResult, which is
				// itself one of the measurements: whether the result set
				// carries any parentage at all decides where the frame tree
				// has to come from.
				const keys = new Set()
				for (const injection of injections) { for (const key of Object.keys(injection)) { keys.add(key) } }
				return JSON.stringify({
					injectionResultKeys: [...keys].sort(),
					injections: injections.map((injection) => ({
						frameId: injection.frameId === undefined ? null : injection.frameId,
						documentId: injection.documentId === undefined ? null : injection.documentId,
						parentFrameId: injection.parentFrameId === undefined ? null : injection.parentFrameId,
						error: injection.error === undefined ? null : String(injection.error),
						result: injection.result === undefined ? null : injection.result,
					})),
				})
			})()`)

		return {
			inPopup,
			inPage: async (context, expression) => await session.evaluate(context, expression),
			openTab: async (url, readyTitle) => {
				const context = await session.openPage(url)
				for (let attempt = 0; attempt < 400; attempt += 1) {
					if (String(await session.evaluate(context, 'document.title')) === readyTitle) {
						break
					}
					await new Promise((resolve) => setTimeout(resolve, 50))
				}
				assert.equal(
					await session.evaluate(context, 'document.title'),
					readyTitle,
					`${url} never settled: a fixture that has not finished building its frames would make every ordinal below meaningless`,
				)
				// `tabs.query({ url })` is not an option — its `url` is a match
				// pattern, and a match pattern cannot carry a port, which every
				// URL this server serves has.
				for (let attempt = 0; attempt < 100; attempt += 1) {
					const tabs = await inPopup<{ id: number; url?: string }[]>('(async () => JSON.stringify(await browser.tabs.query({})))()')
					const matches = tabs.filter((candidate) => candidate.url === url)
					if (matches.length > 1) {
						throw new Error(
							`${matches.length} tabs are open at ${url}: a tab id found by URL would be one of them, and a probe of the wrong tab still answers plausibly. Open each fixture tab at a distinct URL.`,
						)
					}
					const [tab] = matches
					if (tab !== undefined) {
						return { tabId: tab.id, context }
					}
					await new Promise((resolve) => setTimeout(resolve, 50))
				}
				throw new Error(`no tab found for ${url}`)
			},
			probeAllFrames: async (tabId, probe) => await runProbe(`{ tabId: ${tabId}, allFrames: true }`, probe),
			probeFrames: async (tabId, frameIds, probe) => await runProbe(`{ tabId: ${tabId}, frameIds: ${JSON.stringify(frameIds)} }`, probe),
			close: async () => await session.close(),
		}
	} catch (error) {
		await session.close()
		throw error
	}
}
