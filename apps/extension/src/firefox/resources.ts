/**
 * Acquiring the bytes behind the URLs a captured page referenced — the one
 * part of a Firefox capture that touches the network.
 *
 * **It runs in the background, and that is a measured requirement rather
 * than a preference.** A content-script `fetch` carries the page's origin
 * and is CORS-gated, so a cross-origin subresource simply fails; the
 * background's privileged `fetch` reaches any origin the extension has
 * permission for. The exact inverse holds for `blob:` URLs, which only the
 * page principal can read — those are read during the injected capture
 * instead and never reach this module.
 *
 * **This is not a general-purpose privileged fetcher, and the code says so
 * rather than the comment.** {@link classifyResourceUrl} is the gate: only
 * `http:`/`https:` pass, so `file:`, `moz-extension:`, `javascript:`,
 * `chrome:`, `about:` and anything else a page might put in an attribute
 * are refused by policy before a request exists — and the capture only ever
 * asks about URLs the page itself referenced. "The capture path makes no
 * network request other than acquiring the resources the page itself
 * referenced" is an invariant (docs/architecture.md, "Capture-side security
 * assumptions"), and these two properties together are what hold it.
 *
 * **Credentials are scoped, not global, and a redirect does not widen the
 * scope.** `credentials: 'include'` sends the user's cookies, which is what
 * makes a logged-in page archivable at all; sending them to a *different*
 * site because `<all_urls>` happened to be granted would turn a save into a
 * cross-site credentialed request the page never made. Same-origin gets
 * credentials, everything else does not — deliberately stricter than the
 * same-site rule the architecture states, because it needs no public-suffix
 * list and erring this way can only ever under-send.
 *
 * That rule is about the *URL the policy was evaluated for*, and
 * `redirect: 'follow'` does not respect it. Measured, in a real Firefox,
 * from an extension page holding `<all_urls>`: a same-origin URL answering
 * `302` to another origin made Firefox send **the redirect target's own
 * cookies** to the target — a same-origin reference is all a page needs to
 * have the user's cookies for an unrelated site delivered to it. So a
 * credentialed request is made with `redirect: 'manual'` instead, which
 * stops the chain at the origin the cookies belonged to, and is then re-run
 * with no credentials at all if it turns out to have redirected. See
 * {@link fetchResourceWithoutCredentialLeak}.
 *
 * **Every response body is read against a bound.** `Content-Length` is
 * absent on a chunked response and is a claim rather than a fact when it is
 * present (both measured), so the bound is enforced by a reader that stops,
 * not by trusting a header — see `capture-limits.ts` for why one save gets a
 * byte budget at all. A body this module will *not* read is cancelled for
 * the same reason: an unread `fetch` body still arrives in full in Firefox
 * (measured), and a non-ok response never reaches the bounded reader.
 *
 * **The total budget is waited for, never divided up.** Six workers reading
 * at once against one total means a worker has to claim its ceiling before
 * it knows how much it will actually use. Claiming *whatever is left* is
 * what the first draft did, and with the real constants — six workers, a
 * 32 MiB per-resource ceiling, a 128 MiB total — four of them could hold the
 * whole budget in claims while retaining almost nothing, and a fifth
 * resource of eleven bytes would then be read against a budget of zero and
 * dropped. Fidelity would depend on which responses happened to arrive
 * first. So a worker that cannot claim a *full* ceiling waits for one to be
 * released instead of settling for a smaller one (see
 * {@link createByteBudget}), which makes the rule exact: a resource is
 * refused for the total only when the bytes already retained plus its own
 * would really exceed it.
 *
 * The module uses no `browser.*` API — only the platform `fetch` — which is
 * incidental to its job and useful for its tests: the same code runs under
 * Node against the E2E lane's own deterministic server.
 */

import type { Diagnostic } from '@xarsh/archivebridge'
import { readContentType } from './content-type.ts'
import type { AcquiredResource } from './mhtml-document.ts'
import type { NetworkResourceReference } from './page-capture.ts'

/** How many resources are fetched at once. High enough not to serialize a page's images, low enough not to hammer one origin harder than the page itself did. */
const FETCH_CONCURRENCY = 6

/** Media types for a response that arrived without a usable `Content-Type`, chosen from where the reference was found rather than by sniffing the bytes. */
const FALLBACK_MIME_TYPES: Readonly<Record<NetworkResourceReference['kind'], string>> = {
	image: 'application/octet-stream',
	stylesheet: 'text/css',
}

/** What one capture may allocate for fetched bytes. Passed in by `capture.ts` rather than read from `capture-limits.ts` here, so the policy layer owns the numbers and a test can prove the mechanism with small ones. */
export interface ResourceFetchLimits {
	/** Ceiling on a single response's body. A response that exceeds it contributes no bytes at all, never a truncated prefix. */
	readonly maxResourceBytes: number
	/** Ceiling on every response body of one capture, added up. */
	readonly maxTotalBytes: number
}

export interface ResourceAcquisitionResult {
	readonly resources: readonly AcquiredResource[]
	readonly diagnostics: readonly Diagnostic[]
}

/** What may be requested for a harvested URL, and how. `undefined` means the URL is refused outright. */
export interface ResourceRequestPolicy {
	readonly url: string
	readonly credentials: 'include' | 'omit'
}

/** The response a resource's bytes will be read from, and whether getting it cost the credentials the policy had allowed. */
export interface ResourceFetchAttempt {
	readonly response: Response
	/** True when the credentialed attempt was abandoned because the URL redirected: the response is the uncredentialed one, so the bytes may be a logged-out variant of the resource. */
	readonly credentialsWithheld: boolean
}

/**
 * Decides whether a URL harvested from a page may be fetched at all, and
 * with whose credentials.
 *
 * Separated from the fetching so the policy is directly testable — it is
 * the security-relevant half, and the half that must not quietly drift.
 */
export function classifyResourceUrl(rawUrl: string, pageUrl: string): ResourceRequestPolicy | undefined {
	let url: URL
	let page: URL
	try {
		url = new URL(rawUrl)
		page = new URL(pageUrl)
	} catch {
		return undefined
	}
	if (url.protocol !== 'http:' && url.protocol !== 'https:') {
		return undefined
	}
	return { url: url.href, credentials: url.origin === page.origin ? 'include' : 'omit' }
}

/**
 * Fetches one classified URL under the rule that **credentials reach only
 * the URL the policy was evaluated for**.
 *
 * An uncredentialed request follows redirects normally: there is nothing to
 * leak, and the platform bounds the chain itself (measured: Firefox makes 21
 * requests and then fails with a `NetworkError`; Node/undici does the same).
 *
 * A credentialed request is made with `redirect: 'manual'`, which is what
 * makes the bound on *this* side exact — at most two requests per resource,
 * with at most the first carrying cookies:
 *
 * - Firefox answers a redirect with an opaque-redirect filtered response —
 *   status `0`, no headers, no body, **no `Location`** (measured), so
 *   following the chain hop by hop with the policy re-evaluated at each hop
 *   is not something a background `fetch` can do at all. Node/undici instead
 *   hands back the `3xx` itself, hence the two-part test below. `body` being
 *   `null` is also why the abandoned attempt needs no cancelling here, unlike
 *   the non-ok responses {@link acquireResources} drops: there is no stream
 *   to cancel, the transfer having happened inside the platform's own
 *   redirect handling.
 * - Either way the chain has stopped with the cookies still on the one
 *   origin they belonged to, and the request is re-run from the original URL
 *   with `credentials: 'omit'`, where following redirects is safe.
 *
 * The cost is stated rather than hidden: a same-origin resource behind a
 * same-origin redirect is archived as whatever a logged-out client gets, and
 * {@link ResourceFetchAttempt.credentialsWithheld} is what says so.
 *
 * Exported because it is the security-relevant half of the fetch and is
 * verified where the behaviour actually lives — injected into a real Firefox
 * with a real cookie jar by `e2e/firefox/phase-1.test.ts`, which is why it
 * references nothing outside itself.
 */
export async function fetchResourceWithoutCredentialLeak(url: string, credentials: 'include' | 'omit'): Promise<ResourceFetchAttempt> {
	if (credentials === 'omit') {
		return { response: await fetch(url, { credentials: 'omit', redirect: 'follow' }), credentialsWithheld: false }
	}
	const attempt = await fetch(url, { credentials: 'include', redirect: 'manual' })
	if (attempt.type !== 'opaqueredirect' && (attempt.status < 300 || attempt.status > 399)) {
		return { response: attempt, credentialsWithheld: false }
	}
	return { response: await fetch(url, { credentials: 'omit', redirect: 'follow' }), credentialsWithheld: true }
}

/**
 * Reads a response body, giving up the moment it exceeds `limit` rather
 * than after allocating whatever arrived.
 *
 * `response.arrayBuffer()` is what this replaces, and the reason it cannot
 * be used is that its allocation is the page's to choose. Nor is
 * `Content-Length` a substitute: it is absent on a chunked response and is a
 * claim rather than a fact when present (both measured against the E2E
 * lane's own server).
 *
 * `undefined` means "over the limit" — never a truncated prefix, because a
 * partial resource archived as if it were complete is worse than a missing
 * one.
 *
 * What it bounds is the bytes this capture *takes*, not the peak the runtime
 * holds while taking them: the chunks are concatenated at the end, so a body
 * that ends up at the limit passes through roughly twice it. Sizing one
 * buffer up front instead would mean trusting a length someone else chose.
 * See `capture-limits.ts` on what these bounds do and do not promise.
 */
async function readBoundedBody(response: Response, limit: number): Promise<Uint8Array | undefined> {
	if (response.body === null) {
		return new Uint8Array()
	}
	const reader = response.body.getReader()
	const chunks: Uint8Array[] = []
	let total = 0
	for (;;) {
		const { done, value } = await reader.read()
		if (done === true || value === undefined) {
			break
		}
		total += value.byteLength
		if (total > limit) {
			await reader.cancel()
			return undefined
		}
		chunks.push(value)
	}
	const bytes = new Uint8Array(total)
	let offset = 0
	for (const chunk of chunks) {
		bytes.set(chunk, offset)
		offset += chunk.byteLength
	}
	return bytes
}

/** A claim on the capture's shared byte budget, held for exactly as long as one body is being read. */
interface ByteBudget {
	/**
	 * Waits until a full ceiling can be claimed, and claims it. The number
	 * returned is what the next body may be read against; zero means the
	 * total is genuinely spent, not that somebody else is holding it.
	 */
	claim(): Promise<number>
	/** Returns a claim, keeping `retainedBytes` of it — the bytes that really were archived. */
	release(claimed: number, retainedBytes: number): void
}

/**
 * The capture's total byte budget, as something a worker waits its turn for.
 *
 * Two quantities, not one. **Retained** is bytes this capture is actually
 * keeping; **claimed** is bytes a worker has set aside because it is about
 * to read a body whose size nobody knows yet. The hard bound is that
 * `retained + claimed` never exceeds `maxTotalBytes`, which is what makes
 * concurrent reads as safe as sequential ones.
 *
 * What a worker asks for is the full ceiling it would be entitled to on its
 * own — `min(maxResourceBytes, maxTotalBytes - retained)` — and it either
 * gets that or waits. It never accepts a smaller one, because a smaller one
 * would refuse a resource on the strength of another worker's *claim*
 * rather than on retained bytes, and a claim is not an archived byte.
 *
 * This costs concurrency only where the numbers force it to: the fetches
 * themselves are still all in flight (a claim is taken after the response
 * arrives, so no worker waits on the budget while it waits on the network),
 * and the production constants leave four bodies reading at once. It cannot
 * deadlock: a worker only waits when its request exceeds what is free,
 * which can only be true while some other worker holds a claim, and every
 * claim is released in a `finally`.
 */
function createByteBudget(limits: ResourceFetchLimits): ByteBudget {
	let retained = 0
	let claimed = 0
	/** Workers waiting for a claim to come back. At most one per worker, so this is bounded by `FETCH_CONCURRENCY`. */
	const waiting: (() => void)[] = []

	/** The ceiling one more body is entitled to, given what is already retained. */
	const ceiling = (): number => Math.max(0, Math.min(limits.maxResourceBytes, limits.maxTotalBytes - retained))

	return {
		async claim(): Promise<number> {
			for (;;) {
				const wanted = ceiling()
				if (claimed + wanted <= limits.maxTotalBytes - retained) {
					claimed += wanted
					return wanted
				}
				// Not a poll: this settles only when a claim is released, and
				// `wanted` is re-derived then because another worker's retained
				// bytes may have lowered it.
				await new Promise<void>((resolve) => waiting.push(resolve))
			}
		},
		release(claimedBytes: number, retainedBytes: number): void {
			claimed -= claimedBytes
			retained += retainedBytes
			// Everyone re-checks rather than one being handed the freed bytes:
			// what each waiter needs differs, so the budget cannot know which of
			// them the release unblocks.
			for (const wake of waiting.splice(0)) {
				wake()
			}
		},
	}
}

/**
 * Fetches every reference in `references`, reporting the ones that could
 * not be had rather than failing the capture over them.
 *
 * A missing resource is an ordinary outcome: the archived markup keeps the
 * original reference, no MIME part is emitted, and an `unresolved-resource`
 * diagnostic records it — which is exactly the archive shape the viewer
 * already handles, and the same "degrade, do not fail outright" policy the
 * parser uses. Nothing is ever invented to stand in for a resource, and a
 * resource is stored under the URL the page referenced, never under the one
 * a redirect happened to land on: the archived markup names the former.
 */
export async function acquireResources(references: readonly NetworkResourceReference[], pageUrl: string, limits: ResourceFetchLimits): Promise<ResourceAcquisitionResult> {
	const resources: AcquiredResource[] = []
	const diagnostics: Diagnostic[] = []

	const budget = createByteBudget(limits)
	const queue = [...references]
	async function worker(): Promise<void> {
		for (;;) {
			const reference = queue.shift()
			if (reference === undefined) {
				return
			}
			const policy = classifyResourceUrl(reference.url, pageUrl)
			if (policy === undefined) {
				// A scheme the capture will not request. Not an error in the
				// archive's own terms — the reference stays in the markup — but the
				// reader should know the bytes are absent.
				diagnostics.push({ type: 'unresolved-resource', url: reference.url })
				continue
			}
			try {
				const attempt = await fetchResourceWithoutCredentialLeak(policy.url, policy.credentials)
				if (attempt.credentialsWithheld) {
					diagnostics.push({
						type: 'unsupported-feature',
						feature: `${reference.url} redirected, so it was re-fetched without credentials rather than sending them to wherever it redirected to`,
					})
				}
				if (!attempt.response.ok) {
					// **Cancelled, not just dropped**, and that is a measured
					// difference rather than tidiness. A non-ok response never reaches
					// `readBoundedBody`, so nothing above bounds it — and an unread
					// `fetch` body applies no backpressure in Firefox: measured against
					// a `500` whose body keeps coming, leaving the response unread
					// pulled the **whole** body off the wire anyway, 64 MB of it in
					// 37 ms, while `cancel()` cost a millisecond and destroyed the
					// connection after 2 MB. (Node/undici instead stalls the transfer
					// and holds the connection open until the response is collected,
					// which costs a socket per non-ok resource rather than bytes.) A
					// page choosing what its own server answers therefore chooses that
					// transfer, which is exactly the kind of thing a capture's bounds
					// exist to take out of its hands.
					await attempt.response.body?.cancel().catch(() => {
						// A body that is already errored has nothing left to release,
						// and the resource is reported unresolved either way.
					})
					diagnostics.push({ type: 'unresolved-resource', url: reference.url })
					continue
				}

				const claimed = await budget.claim()
				let bytes: Uint8Array | undefined
				try {
					bytes = await readBoundedBody(attempt.response, claimed)
				} finally {
					// In a `finally` because a read that throws must not take the
					// claim with it: the budget is shared, and a leaked claim would
					// be capacity no later resource could ever get back.
					budget.release(claimed, bytes?.byteLength ?? 0)
				}
				if (bytes === undefined) {
					diagnostics.push({
						type: 'unsupported-feature',
						feature: `${reference.url} is larger than this capture may allocate for it (${claimed} bytes), so none of it was archived`,
					})
					diagnostics.push({ type: 'unresolved-resource', url: reference.url })
					continue
				}

				const { mimeType, textEncoding } = readContentType(attempt.response.headers.get('content-type'), FALLBACK_MIME_TYPES[reference.kind])
				resources.push({ url: reference.url, mimeType, textEncoding, bytes })
			} catch {
				// A refused connection, a DNS failure and a missing host permission
				// are indistinguishable here (all `TypeError: NetworkError`), and
				// the outcome is the same for all three, so none of them is
				// guessed at.
				diagnostics.push({ type: 'unresolved-resource', url: reference.url })
			}
		}
	}

	await Promise.all(Array.from({ length: Math.min(FETCH_CONCURRENCY, references.length) }, worker))
	return { resources, diagnostics }
}
