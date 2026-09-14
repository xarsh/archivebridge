/**
 * Launches a real Firefox with the real built Firefox extension installed,
 * over **WebDriver BiDi**, and exposes the pieces a test needs to drive it.
 *
 * **Why not Playwright.** Playwright loads extensions only in Chromium,
 * and only with a persistent context — there is no Firefox equivalent. So
 * the Chrome lane keeps Playwright (`e2e/extension-session.ts`) and this
 * lane needs its own runner. It gets one without a new dependency:
 * Firefox's own remote agent speaks WebDriver BiDi over a WebSocket,
 * `webExtension.install` takes an unpacked, unsigned directory, and Node
 * has had a global `WebSocket` since 22. The protocol surface used here is
 * six commands (`session.new`, `webExtension.install`/`uninstall`,
 * `browsingContext.create`/`navigate`, `script.evaluate`), which is far
 * less code than the Chromium target-discovery and worker-attach machinery
 * Playwright is worth paying for on the other lane.
 *
 * **Three things about this protocol are not guessable and cost real time
 * to rediscover:**
 *
 * - The WebSocket endpoint is `ws://127.0.0.1:<port>/session`, **not** the
 *   bare `ws://127.0.0.1:<port>` Firefox prints in its own startup line.
 *   Connecting to the bare URL fails the upgrade silently.
 * - **BiDi does not expose an extension's background realm.**
 *   `script.getRealms` reports only page realms, so there is no Firefox
 *   equivalent of Playwright's `serviceWorker.evaluate()`. The extension
 *   is driven through its own pages instead — which is what the Chrome
 *   lane does anyway, and is the more honest test besides.
 * - Reaching those pages needs the extension's **per-profile UUID**, which
 *   Firefox generates on install. It is pinned in advance with an
 *   `extensions.webextensions.uuids` pref in the throwaway profile, so
 *   `moz-extension://<uuid>/popup.html` is a knowable address. That pref
 *   lives in the test profile, never in `src/` — CONTRIBUTING.md's "never
 *   add a branch to `src/` for a test's benefit" holds here.
 * - **`permissions.request()` needs a real input event**, and BiDi's own
 *   `userActivation: true` flag on `script.evaluate` is not one: the call
 *   still rejects with `permissions.request may only be called from a user
 *   input handler` (measured). {@link FirefoxSession.click} synthesizes an
 *   actual pointer event through `input.performActions` instead, which
 *   resolves it — so the production popup's gesture ordering is exercised
 *   as the user would exercise it, not simulated around.
 *
 * **Firefox is taken from the machine, not downloaded.** `FIREFOX_BIN`
 * overrides the binary; otherwise `firefox` from `PATH`. The repository
 * pins no browser for either lane (the Chrome lane uses whatever
 * `npx playwright install chromium` fetched), so pinning one here would be
 * a new policy — and a new download/install step in CI. The floor that
 * *is* enforced is the manifest's `strict_min_version: "128.0"`: an older
 * Firefox refuses the install and the test fails loudly rather than
 * silently testing something else.
 */

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The built Firefox `dist-firefox/` directory that gets installed. Exported so a test can read its built `manifest.json` and assert on what actually ships. */
export const builtFirefoxExtensionDir = join(dirname(dirname(dirname(fileURLToPath(import.meta.url)))), 'dist-firefox')

const FIREFOX_BINARY = process.env.FIREFOX_BIN ?? 'firefox'

/** Long enough to cover a cold Firefox start on a loaded CI machine, short enough to fail rather than hang. */
const COMMAND_TIMEOUT_MS = 30_000
const STARTUP_TIMEOUT_MS = 60_000

interface BidiResponse {
	readonly id?: number
	readonly type?: string
	readonly result?: Record<string, unknown>
	readonly error?: string
	readonly message?: string
}

/** A BiDi `RemoteValue`, as much of it as `script.evaluate` results need. */
interface RemoteValue {
	readonly type: string
	readonly value?: unknown
}

/** Converts a BiDi `RemoteValue` back into an ordinary JS value. Only the types an assertion here needs are handled; anything else comes back as its raw `value`. */
function deserialize(value: RemoteValue | undefined): unknown {
	if (value === undefined) {
		return undefined
	}
	switch (value.type) {
		case 'undefined':
			return undefined
		case 'null':
			return null
		case 'string':
		case 'number':
		case 'boolean':
			return value.value
		case 'array':
			return (value.value as RemoteValue[]).map(deserialize)
		case 'object': {
			const entries = value.value as [string, RemoteValue][]
			return Object.fromEntries(entries.map(([key, entry]) => [key, deserialize(entry)]))
		}
		default:
			return value.value
	}
}

export interface FirefoxSession {
	/** The extension's `browser_specific_settings.gecko.id`, as declared in the built manifest. */
	readonly extensionId: string
	/** The per-profile UUID pinned into this session's profile, and therefore the host of every `moz-extension:` URL below. */
	readonly extensionUuid: string
	/** The id `webExtension.install` returned, for `webExtension.uninstall`. */
	readonly installedExtension: string
	/** A `moz-extension://<uuid>/<path>` URL for a page of the installed extension. */
	extensionUrl(path: string): string
	/** Opens `url` in a new tab and returns its browsing-context id. */
	openPage(url: string): Promise<string>
	/** Evaluates `expression` in `context`'s default realm, awaiting a promise result. */
	evaluate(context: string, expression: string): Promise<unknown>
	/**
	 * Clicks the element `selector` names, with a synthesized pointer event
	 * rather than a DOM `click()` — the difference being that this one counts
	 * as a user gesture, which is the whole reason it exists.
	 */
	click(context: string, selector: string): Promise<void>
	/** Uninstalls the extension, then closes Firefox and removes the throwaway profile. */
	close(): Promise<void>
}

/** One request/response pair in flight. */
interface PendingCommand {
	readonly resolve: (result: Record<string, unknown>) => void
	readonly reject: (error: Error) => void
	readonly timer: ReturnType<typeof setTimeout>
}

class BidiConnection {
	readonly #socket: WebSocket
	readonly #pending = new Map<number, PendingCommand>()
	#nextId = 1

	constructor(socket: WebSocket) {
		this.#socket = socket
		socket.addEventListener('message', (event: MessageEvent) => {
			const message = JSON.parse(String(event.data)) as BidiResponse
			if (message.id === undefined) {
				return
			}
			const pending = this.#pending.get(message.id)
			if (pending === undefined) {
				return
			}
			this.#pending.delete(message.id)
			clearTimeout(pending.timer)
			if (message.type === 'error') {
				pending.reject(new Error(`BiDi error: ${message.error ?? 'unknown'}: ${message.message ?? ''}`))
				return
			}
			pending.resolve(message.result ?? {})
		})
	}

	send(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
		const id = this.#nextId++
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.#pending.delete(id)
				reject(new Error(`BiDi timed out waiting for ${method}`))
			}, COMMAND_TIMEOUT_MS)
			this.#pending.set(id, { resolve, reject, timer })
			this.#socket.send(JSON.stringify({ id, method, params }))
		})
	}

	close(): void {
		for (const pending of this.#pending.values()) {
			clearTimeout(pending.timer)
		}
		this.#pending.clear()
		this.#socket.close()
	}
}

/**
 * The throwaway profile. Beyond pinning the extension UUID, every pref here
 * exists to stop first-run Firefox from doing something that would make the
 * test nondeterministic — an onboarding tab that steals the context, a
 * default-browser prompt, a background update check.
 */
async function writeProfile(profileDir: string, extensionId: string, extensionUuid: string): Promise<void> {
	const uuidMap = JSON.stringify({ [extensionId]: extensionUuid })
	const prefs = [
		`user_pref("extensions.webextensions.uuids", ${JSON.stringify(uuidMap)});`,
		// The extension asks for `<all_urls>` as an *optional* host permission,
		// from the user's own click. The click is real (see `click` below); the
		// doorhanger that normally answers it is native UI no automation here
		// can reach, so this pref makes Firefox grant the request instead of
		// prompting. It changes who answers the prompt, not whether production
		// asks — the gesture, the call site and its ordering are all the real
		// ones. Lives in the throwaway profile, never in `src/`.
		'user_pref("extensions.webextOptionalPermissionPrompts", false);',
		'user_pref("browser.aboutwelcome.enabled", false);',
		'user_pref("browser.startup.homepage_override.mstone", "ignore");',
		'user_pref("startup.homepage_welcome_url", "about:blank");',
		'user_pref("startup.homepage_welcome_url.additional", "");',
		'user_pref("browser.shell.checkDefaultBrowser", false);',
		'user_pref("app.update.auto", false);',
		'user_pref("datareporting.policy.dataSubmissionEnabled", false);',
	].join('\n')
	await writeFile(join(profileDir, 'user.js'), `${prefs}\n`)
}

/** Reads the BiDi WebSocket URL out of Firefox's own startup output. */
function waitForBidiUrl(process: ReturnType<typeof spawn>): Promise<string> {
	return new Promise((resolve, reject) => {
		let output = ''
		const timer = setTimeout(() => {
			finish()
			reject(new Error(`Firefox did not report a WebDriver BiDi listener within ${STARTUP_TIMEOUT_MS}ms. Output so far:\n${output}`))
		}, STARTUP_TIMEOUT_MS)
		const onData = (chunk: Buffer) => {
			output += chunk.toString()
			const match = output.match(/WebDriver BiDi listening on (ws:\/\/\S+)/)
			if (match?.[1] !== undefined) {
				finish()
				resolve(match[1])
			}
		}
		const onError = (error: Error) => {
			finish()
			reject(new Error(`could not start Firefox (${FIREFOX_BINARY}): ${error.message}`))
		}
		const onExit = (code: number | null) => {
			finish()
			reject(new Error(`Firefox exited with code ${code} before reporting a BiDi listener. Output:\n${output}`))
		}
		function finish(): void {
			clearTimeout(timer)
			process.stdout?.off('data', onData)
			process.stderr?.off('data', onData)
			process.off('error', onError)
			process.off('exit', onExit)
		}
		process.stdout?.on('data', onData)
		process.stderr?.on('data', onData)
		process.on('error', onError)
		process.on('exit', onExit)
	})
}

async function readExtensionId(): Promise<string> {
	const manifestPath = join(builtFirefoxExtensionDir, 'manifest.json')
	const { readFile } = await import('node:fs/promises')
	const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { browser_specific_settings?: { gecko?: { id?: unknown } } }
	const id = manifest.browser_specific_settings?.gecko?.id
	if (typeof id !== 'string') {
		throw new Error(`${manifestPath} declares no browser_specific_settings.gecko.id, so its moz-extension: UUID cannot be pinned. Did you run \`npm run build\`?`)
	}
	return id
}

/** Launches headless Firefox, installs `dist-firefox/`, and returns a session addressed by a UUID pinned before launch. */
export async function startFirefoxSession(): Promise<FirefoxSession> {
	const extensionId = await readExtensionId()
	const extensionUuid = randomUUID()
	const profileDir = await mkdtemp(join(tmpdir(), 'archivebridge-firefox-e2e-'))
	await writeProfile(profileDir, extensionId, extensionUuid)

	// Port 0 would be ideal, but Firefox's remote agent requires a real port;
	// it prints the one it bound, so a collision surfaces as a startup failure
	// rather than as a connection to someone else's browser.
	const port = 10_000 + Math.floor(Math.random() * 40_000)
	const firefox = spawn(FIREFOX_BINARY, ['--profile', profileDir, '--remote-debugging-port', String(port), '--headless', '--no-remote'], { stdio: ['ignore', 'pipe', 'pipe'] })

	const cleanup = async (connection?: BidiConnection) => {
		connection?.close()
		firefox.kill()
		await rm(profileDir, { recursive: true, force: true })
	}

	let connection: BidiConnection | undefined
	try {
		const bidiUrl = await waitForBidiUrl(firefox)
		// The `/session` path is required; the bare URL Firefox printed above
		// fails the WebSocket upgrade with no error worth reading.
		const socket = new WebSocket(`${bidiUrl}/session`)
		await new Promise<void>((resolve, reject) => {
			socket.addEventListener('open', () => resolve(), { once: true })
			socket.addEventListener('error', () => reject(new Error(`could not open a BiDi WebSocket to ${bidiUrl}/session`)), { once: true })
		})
		connection = new BidiConnection(socket)
		await connection.send('session.new', { capabilities: {} })

		const installed = await connection.send('webExtension.install', {
			extensionData: { type: 'path', path: builtFirefoxExtensionDir },
		})
		const installedExtension = installed.extension
		if (typeof installedExtension !== 'string') {
			throw new Error(`webExtension.install returned no extension id: ${JSON.stringify(installed)}`)
		}

		const openConnection = connection
		return {
			extensionId,
			extensionUuid,
			installedExtension,
			extensionUrl: (path) => `moz-extension://${extensionUuid}/${path.replace(/^\//, '')}`,
			openPage: async (url) => {
				const created = await openConnection.send('browsingContext.create', { type: 'tab' })
				const context = created.context
				if (typeof context !== 'string') {
					throw new Error(`browsingContext.create returned no context: ${JSON.stringify(created)}`)
				}
				// `wait: "interactive"` rather than `"complete"`: a page containing a
				// frame that cannot connect makes `"complete"` reject with
				// `Address rejected` even though the navigation itself succeeded.
				await openConnection.send('browsingContext.navigate', { context, url, wait: 'interactive' })
				return context
			},
			evaluate: async (context, expression) => {
				const result = await openConnection.send('script.evaluate', {
					expression,
					target: { context },
					awaitPromise: true,
					resultOwnership: 'none',
				})
				if (result.type === 'exception') {
					const details = result.exceptionDetails as { text?: string } | undefined
					throw new Error(`script.evaluate threw: ${details?.text ?? JSON.stringify(result)}`)
				}
				return deserialize(result.result as RemoteValue | undefined)
			},
			click: async (context, selector) => {
				const box = await openConnection.send('script.evaluate', {
					expression: `(() => { const rect = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return JSON.stringify({ x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) }) })()`,
					target: { context },
					awaitPromise: true,
					resultOwnership: 'none',
				})
				const { x, y } = JSON.parse(String(deserialize(box.result as RemoteValue | undefined))) as { x: number; y: number }
				await openConnection.send('input.performActions', {
					context,
					actions: [
						{
							type: 'pointer',
							id: 'mouse',
							parameters: { pointerType: 'mouse' },
							actions: [
								{ type: 'pointerMove', x, y },
								{ type: 'pointerDown', button: 0 },
								{ type: 'pointerUp', button: 0 },
							],
						},
					],
				})
			},
			close: async () => {
				try {
					await openConnection.send('webExtension.uninstall', { extension: installedExtension })
				} finally {
					await cleanup(openConnection)
				}
			},
		}
	} catch (error) {
		await cleanup(connection)
		throw error
	}
}
