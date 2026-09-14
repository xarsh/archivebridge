/**
 * The function ArchiveBridge injects into the page being saved on Firefox,
 * and the only ArchiveBridge code that runs inside a web page.
 *
 * It runs in the **isolated content-script world** (`world: 'ISOLATED'`),
 * against the **top document only** — Phase 1 does not capture frames, and
 * `capture.ts` says so with `frameIds: [0]` rather than leaving it implicit.
 *
 * ## Two constraints shape every line of this file
 *
 * **1. It may not reference anything outside itself.**
 * `browser.scripting.executeScript({ func })` serializes the function and
 * evaluates the source in the page; a call to an imported helper — or to a
 * module-level constant — becomes a `ReferenceError` there. That is why
 * this is one large function with inner helpers instead of a module of
 * small ones, and why the `cid:` spelling is repeated here rather than
 * imported from `@xarsh/archivebridge` (see {@link CapturedCanvas.cidUrl},
 * and `capture.ts`, which verifies it through the library).
 *
 * **2. It must not leave the live page mutated.**
 * A page may have MutationObservers and arbitrary script running while a
 * save happens, so nothing here writes to the live DOM — no temporary
 * markers, no attribute writes, no node replacement, not even ones undone
 * in a `finally`. Instead it builds a **separate, inert snapshot document**
 * (`document.implementation.createHTMLDocument`, which has no browsing
 * context, so nothing in it loads or executes) by recursively cloning the
 * live tree, and applies every capture decision — live form state, the
 * canvas replacement, shadow-root templates, dropping `<script>` — to that
 * clone. The live document is only ever *read*.
 *
 * A recursive clone rather than `cloneNode(true)` plus a fix-up pass,
 * because the two are the same amount of work and the recursive form is
 * the one that can interleave what has to be interleaved: a shadow root
 * becomes a `<template>` child the live tree does not have, and a
 * `<canvas>` becomes a different element entirely. Re-parsing the
 * serialized HTML and editing *that* was the other candidate; it was
 * rejected because HTML serialize→parse is not exactly idempotent (a
 * leading newline in `<pre>`/`<textarea>`, foster-parented table content),
 * so the element correspondence it depends on can silently shift, and the
 * failure mode is writing one control's value onto another. The one cost
 * of recursion is that a pathologically deep tree exhausts the stack
 * instead of being cloned; that throws, the command reports it, and the
 * page is untouched — the ordinary failure path, not a hang or a
 * half-written archive.
 *
 * ## What it returns
 *
 * Data, never archive structure. The MIME parts, the `Content-ID`s and the
 * `MhtmlDocument` are all assembled later, out of the page, by
 * `mhtml-document.ts`. The value crosses the world boundary by **structured
 * clone**, not JSON, so `Uint8Array`s cross as themselves — measured, and
 * the reason nothing here base64s its own binary.
 */

/** Options `capture.ts` passes in. Kept to plain data: everything here has to survive structured clone. */
export interface PageCaptureOptions {
	/**
	 * The `Content-ID` stem for canvas pixel parts. The background mints it
	 * (`capture.ts`) so identity is minted in exactly one place; this
	 * function only appends `-<index>`, and the background re-checks that it
	 * did.
	 */
	readonly canvasContentIdPrefix: string
	/**
	 * What this capture may collect and allocate, from `capture-limits.ts`.
	 * Passed in rather than imported for the reason everything else here is
	 * inlined: this function is serialized into the page and can reference
	 * nothing outside itself. Every one of these bounds a dimension the page
	 * controls — see that module for why each exists.
	 */
	readonly maxNetworkResources: number
	readonly maxBlobResources: number
	readonly maxResourceBytes: number
	readonly maxCapturedBytes: number
	readonly maxCanvases: number
	readonly maxCanvasPixels: number
}

/**
 * A `<canvas>`'s rendered pixels, which have no URL of their own and are
 * therefore addressed by `Content-ID`.
 *
 * **No media type.** These bytes are always a PNG — `toDataURL('image/png')`
 * produced them and a data URL that does not say `image/png` is refused —
 * so the archive part's `Content-Type` comes from `mhtml-document.ts`'s own
 * constant. Returning one from the page would be an unnecessary claim, and
 * an unnecessary claim one step from a MIME header is worth not having: see
 * `capture.ts`, where the world boundary is narrowed.
 */
export interface CapturedCanvas {
	/** `options.canvasContentIdPrefix` + `-<index>`, and nothing else — the background verifies exactly that. */
	readonly contentId: string
	/** The `cid:` URI written into the snapshot's `<img src>`. Spelled here because this function cannot import the library; re-derived and checked against `encodeCidUri` in `capture.ts`. */
	readonly cidUrl: string
	readonly bytes: Uint8Array
}

/** Bytes behind a `blob:` URL the captured markup references. Only the page principal can read one, which is why this is read here and not by the background's privileged fetch (measured: the same URL fetched from the background throws `NetworkError`). */
export interface CapturedBlob {
	readonly url: string
	/**
	 * The blob response's `Content-Type` **verbatim**, which is the blob's own
	 * type and is therefore whatever the page passed to `new Blob()`: often a
	 * bare media type, but just as legitimately `text/plain;charset=utf-8`,
	 * and empty for a blob created without a type (all measured). It is
	 * carried uninterpreted and split into `mimeType`/`textEncoding` by
	 * `mhtml-document.ts` through `content-type.ts`, because this function
	 * returns data rather than archive structure and cannot import the parser
	 * that knows the difference. Handing the whole header through as a
	 * `mimeType` is what used to make one ordinary typed blob throw out of
	 * `serializeMhtml` and take the entire save with it.
	 */
	readonly contentType: string
	readonly bytes: Uint8Array
}

/** A resource the page referenced that the background has to fetch. `kind` is only used to pick a fallback media type when a response carries no `Content-Type`. */
export interface NetworkResourceReference {
	readonly url: string
	readonly kind: 'image' | 'stylesheet'
}

/**
 * Every kind of note {@link capturePageState} can produce.
 *
 * A list rather than only a union because the narrowing at the world
 * boundary has to be able to *check* it: what comes back is a page's
 * output, and `mhtml-document.ts` names a diagnostic per kind, so a kind
 * nobody named must be dropped rather than mapped to nothing. Declared out
 * here, beside the injected function rather than inside it — nothing inside
 * may reference it (see the module header).
 */
export const PAGE_CAPTURE_NOTE_KINDS = [
	'canvas-unreadable',
	'canvas-limit-reached',
	'blob-unreadable',
	'blob-too-large',
	'blob-limit-reached',
	'resource-limit-reached',
	'capture-byte-limit-reached',
] as const

/** Something the capture could not do. Turned into a {@link Diagnostic} by `mhtml-document.ts`; deliberately not a `Diagnostic` here, because this value comes back across a world boundary and is narrowed before it is read. */
export interface PageCaptureNote {
	readonly kind: (typeof PAGE_CAPTURE_NOTE_KINDS)[number]
	readonly detail: string
}

/** Everything one top-document capture produces. */
export interface PageCaptureResult {
	readonly url: string
	readonly mimeType: string
	readonly title: string
	/** The serialized snapshot: post-script DOM, live form state, shadow roots as `<template shadowrootmode>`, canvases replaced, `<script>` removed. */
	readonly html: string
	readonly networkResources: readonly NetworkResourceReference[]
	readonly canvases: readonly CapturedCanvas[]
	readonly blobs: readonly CapturedBlob[]
	readonly notes: readonly PageCaptureNote[]
}

/**
 * Captures the top document of the page this runs in.
 *
 * Injected by `capture.ts`; never called in-process. Every helper it uses
 * is declared inside it — see the module header.
 */
export async function capturePageState(options: PageCaptureOptions): Promise<PageCaptureResult> {
	const HTML_NAMESPACE = 'http://www.w3.org/1999/xhtml'

	/**
	 * `<input>` types whose `value` IDL attribute is in the spec's "value"
	 * mode — the ones where what the user sees can differ from the `value`
	 * content attribute, and therefore the only ones worth reflecting.
	 * `submit`/`reset`/`button`/`image` are in "default" mode (the attribute
	 * already *is* the value) and `checkbox`/`radio` are handled by
	 * `checked`, so neither needs to be here.
	 *
	 * `password`, `file` and `hidden` are absent by policy, not by omission:
	 * see {@link isStateExcluded}.
	 */
	const VALUE_MODE_INPUT_TYPES = new Set(['text', 'search', 'url', 'tel', 'email', 'number', 'range', 'color', 'date', 'month', 'week', 'time', 'datetime-local'])

	/** Live values never copied into an archive, whatever the page does with them. */
	const EXCLUDED_INPUT_TYPES = new Set(['password', 'file', 'hidden'])

	const notes: PageCaptureNote[] = []
	const canvases: CapturedCanvas[] = []
	/**
	 * How many canvases this capture has *tried* to snapshot, which is what
	 * {@link PageCaptureOptions.maxCanvases} bounds. Counting successes
	 * instead would bound nothing a page cares about: a tainted canvas, an
	 * oversized one and one that arrives after the byte budget is spent all
	 * leave `canvases` the same length, so a page could offer ten thousand of
	 * them and have every one of them cost real work.
	 */
	let canvasSnapshotAttempts = 0
	const blobUrls: string[] = []
	const networkResources = new Map<string, 'image' | 'stylesheet'>()
	const notedLimits = new Set<string>()
	let resourceLimitReached = false
	/** Bytes this capture has committed to returning across the world boundary: canvas pixels and blob contents, which are the two kinds it materializes itself. */
	let capturedBytes = 0

	const snapshot = document.implementation.createHTMLDocument('')

	function note(kind: PageCaptureNote['kind'], detail: string): void {
		notes.push({ kind, detail })
	}

	/**
	 * A note about a limit, recorded once however many times the limit is
	 * reached. A page with ten thousand canvases would otherwise answer a
	 * bound on canvases with an unbounded list of notes about it.
	 */
	function noteLimit(kind: PageCaptureNote['kind'], detail: string): void {
		if (notedLimits.has(kind)) {
			return
		}
		notedLimits.add(kind)
		note(kind, detail)
	}

	/** Whether `byteLength` more bytes still fit in this capture's budget, counting them against it if they do. */
	function reserveBytes(byteLength: number): boolean {
		if (capturedBytes + byteLength > options.maxCapturedBytes) {
			noteLimit('capture-byte-limit-reached', `the capture reached its ${options.maxCapturedBytes}-byte budget for canvas and blob content; the rest was not collected`)
			return false
		}
		capturedBytes += byteLength
		return true
	}

	function describe(error: unknown): string {
		return error instanceof Error ? error.message : String(error)
	}

	function base64ToBytes(base64: string): Uint8Array {
		const binary = atob(base64)
		const bytes = new Uint8Array(binary.length)
		for (let index = 0; index < binary.length; index += 1) {
			bytes[index] = binary.charCodeAt(index)
		}
		return bytes
	}

	/**
	 * Whether an element's live state must never be written into the
	 * archive. Deliberately checked on the *live* element, and deliberately
	 * a refusal rather than a redaction: an excluded control keeps whatever
	 * its original markup already said, so the archive records the page as
	 * served rather than the secret as typed.
	 */
	function isStateExcluded(element: Element): boolean {
		if (element instanceof HTMLInputElement && EXCLUDED_INPUT_TYPES.has(element.type)) {
			return true
		}
		// The attribute, not the IDL property: `autocomplete` is a
		// space-separated token list and the property normalizes it, while the
		// token is what the page actually declared.
		const autocomplete = element.getAttribute('autocomplete')
		if (autocomplete === null) {
			return false
		}
		return autocomplete.toLowerCase().split(/\s+/).includes('one-time-code')
	}

	function setOrRemove(element: Element, name: string, present: boolean): void {
		if (present) {
			element.setAttribute(name, '')
		} else {
			element.removeAttribute(name)
		}
	}

	/** Reflects one element's live state onto its clone, per the capture's form-state policy. */
	function applyLiveFormState(live: Element, clone: Element): void {
		// The type check comes first so that the great majority of a page's
		// elements — everything that is not a form control — costs one
		// `instanceof` rather than an attribute read.
		if (!(live instanceof HTMLInputElement || live instanceof HTMLOptionElement)) {
			return
		}
		if (isStateExcluded(live)) {
			return
		}
		if (live instanceof HTMLInputElement) {
			if (live.type === 'checkbox' || live.type === 'radio') {
				setOrRemove(clone, 'checked', live.checked)
			} else if (VALUE_MODE_INPUT_TYPES.has(live.type)) {
				clone.setAttribute('value', live.value)
			}
			return
		}
		if (live instanceof HTMLOptionElement) {
			// An `<option>`'s exclusion is its `<select>`'s: a one-time-code
			// control is the select, and its options are what carry the value.
			const owner = live.closest('select')
			if (owner === null || !isStateExcluded(owner)) {
				setOrRemove(clone, 'selected', live.selected)
			}
		}
	}

	/** Whether a `<textarea>`'s child text should become its live value rather than its served default. */
	function reflectsTextareaValue(live: Element): live is HTMLTextAreaElement {
		return live instanceof HTMLTextAreaElement && !isStateExcluded(live)
	}

	/**
	 * The `<img>` that stands in for a `<canvas>` in the archive.
	 *
	 * Static `<img src="cid:…">`, not a `<canvas>` carrying
	 * `background-image: url(cid:…)`: measured across three viewers, the
	 * `<img>` renders in ArchiveBridge's own viewer and in Chrome's native
	 * MHTML viewer while `background-image` renders in neither, because
	 * Chrome's MHTML parser resolves `cid:` for `<img src>` and not for a
	 * CSS `url()`. The cost is real and accepted: the archive no longer
	 * contains a `<canvas>` element.
	 *
	 * The explicit CSS size is not cosmetic. A `<canvas>` — or anything
	 * relying on the default canvas-sizing algorithm — collapses to 0×0 when
	 * a document is loaded as MHTML, reproduced identically in
	 * ArchiveBridge's viewer and in Chrome's own, so the replacement carries
	 * the box the live page was actually rendering, which is also what keeps
	 * a canvas whose CSS size differs from its bitmap size looking the same.
	 *
	 * Returns `undefined` when the pixels cannot be read, in which case the
	 * caller keeps the `<canvas>` element as ordinary markup.
	 *
	 * Every check here is ordered by what it costs to fail it, cheapest
	 * first, because the point of all of them is to not do expensive work on
	 * a page's say-so:
	 *
	 * 1. the **attempt count**, which costs nothing and bounds how many times
	 *    the three below can run at all;
	 * 2. the **pixel area**, read off two properties, which bounds the
	 *    allocation `toDataURL` is about to make;
	 * 3. **`toDataURL`** itself, the encode, which is where the allocation
	 *    happens and which can also simply produce no image (a canvas with a
	 *    zero-sized bitmap answers `data:,`);
	 * 4. the **captured-byte budget**, which can only be checked against the
	 *    decoded result and so is necessarily last.
	 *
	 * A canvas *tainted* by a cross-origin draw is not necessarily one of the
	 * failures, and exactly when it is was measured rather than assumed.
	 * Firefox lets this read succeed **while, and only while, the extension
	 * holds `<all_urls>`**: with per-origin host permission for the very
	 * origin that tainted the canvas — enough that the background fetches
	 * that origin's bytes directly — `toDataURL` still throws
	 * `SecurityError`, and revoking the broad grant after the pixels were
	 * drawn takes the read away again, so the check is made here rather than
	 * at draw time.
	 *
	 * So the privileged read is coextensive with the one broad, explicit,
	 * revocable grant ArchiveBridge asks the user for — the same grant that
	 * lets the background fetch any origin's bytes anyway — and the platform
	 * is what holds the line, not a judgement made here about which origins
	 * contributed to a canvas, which nothing exposes and which this therefore
	 * never guesses at. Under the grant the capture keeps the pixels rather
	 * than pretending to a restriction it is not under; without it the
	 * `SecurityError` lands in the `catch` below like any other failure and
	 * the `<canvas>` survives as ordinary markup. Both halves are pinned in
	 * `e2e/firefox/phase-1.test.ts`.
	 */
	function canvasReplacement(live: HTMLCanvasElement): Element | undefined {
		// Attempts rather than snapshots: a page whose canvases all fail — all
		// unreadable, all past the pixel bound, all arriving after the byte
		// budget is spent — must not get an unbounded number of tries at this,
		// and `canvases.length` would give it exactly that. This is also what
		// bounds the `canvas-unreadable` notes below to one per attempt.
		if (canvasSnapshotAttempts >= options.maxCanvases) {
			noteLimit('canvas-limit-reached', `more than ${options.maxCanvases} canvases were offered for snapshotting; the rest were left as ordinary <canvas> elements`)
			return undefined
		}
		canvasSnapshotAttempts += 1
		// Checked *before* `toDataURL`, because that call is where the
		// allocation happens — four bytes per pixel live, plus a PNG, plus its
		// base64 text — and a bound applied to its result would be applied a
		// gigabyte too late. A page can set a canvas to any size it likes.
		if (live.width * live.height > options.maxCanvasPixels) {
			noteLimit('canvas-limit-reached', `a ${live.width}x${live.height} canvas exceeds the ${options.maxCanvasPixels}-pixel snapshot limit; its pixels were not read`)
			return undefined
		}

		const prefix = 'data:image/png;base64,'
		let dataUrl: string
		try {
			dataUrl = live.toDataURL('image/png')
		} catch (error) {
			note('canvas-unreadable', describe(error))
			return undefined
		}
		if (!dataUrl.startsWith(prefix)) {
			note('canvas-unreadable', `toDataURL returned ${dataUrl.slice(0, 32)}…, which is not a base64 PNG`)
			return undefined
		}

		const bytes = base64ToBytes(dataUrl.slice(prefix.length))
		if (!reserveBytes(bytes.length)) {
			return undefined
		}
		const contentId = `${options.canvasContentIdPrefix}-${canvases.length}`
		const cidUrl = `cid:${encodeURIComponent(contentId)}`
		canvases.push({ contentId, cidUrl, bytes })

		const replacement = snapshot.createElementNS(HTML_NAMESPACE, 'img')
		for (const attribute of live.attributes) {
			const name = attribute.name.toLowerCase()
			// `width`/`height` on a `<canvas>` are its *bitmap* dimensions; on an
			// `<img>` they are layout hints in CSS pixels. Copying them across
			// would resize the page wherever the two differ, which is exactly the
			// case the explicit CSS size below exists to preserve.
			if (name === 'width' || name === 'height' || name === 'src' || name === 'style') {
				continue
			}
			try {
				replacement.setAttributeNS(attribute.namespaceURI, attribute.name, attribute.value)
			} catch {
				// An attribute name the snapshot document refuses is dropped rather
				// than failing the whole capture.
			}
		}

		const computed = getComputedStyle(live)
		const width = computed.width.endsWith('px') ? computed.width : `${live.width}px`
		const height = computed.height.endsWith('px') ? computed.height : `${live.height}px`
		// Appended after whatever inline style the element already had, so it
		// wins by ordinary cascade order. Deliberately appended rather than
		// merged: recognizing and replacing an existing `width`/`height`
		// declaration means tokenizing CSS, which is a job this project keeps in
		// the library and out of the extension entirely. A duplicated
		// declaration is valid CSS and the last one is what applies.
		const inline = live.getAttribute('style')
		const size = `width:${width};height:${height}`
		replacement.setAttribute('style', inline === null || inline.trim() === '' ? size : `${inline.replace(/;\s*$/, '')};${size}`)
		replacement.setAttribute('src', cidUrl)
		if (!replacement.hasAttribute('alt')) {
			replacement.setAttribute('alt', '')
		}
		return replacement
	}

	/** An open shadow root, as the standard declarative form. Firefox's own serializer writes `shadowrootmode` too, so nothing downstream has to normalize a legacy spelling. */
	function shadowRootTemplate(root: ShadowRoot): Element {
		const template = snapshot.createElementNS(HTML_NAMESPACE, 'template') as HTMLTemplateElement
		template.setAttribute('shadowrootmode', root.mode)
		if (root.delegatesFocus) {
			template.setAttribute('shadowrootdelegatesfocus', '')
		}
		if (root.clonable) {
			template.setAttribute('shadowrootclonable', '')
		}
		for (const child of root.childNodes) {
			const cloned = cloneNodeInto(child)
			if (cloned !== undefined) {
				template.content.appendChild(cloned)
			}
		}
		return template
	}

	function cloneNodeInto(live: Node): Node | undefined {
		if (live instanceof Element) {
			return cloneElementInto(live)
		}
		if (
			live.nodeType === Node.TEXT_NODE ||
			live.nodeType === Node.COMMENT_NODE ||
			live.nodeType === Node.CDATA_SECTION_NODE ||
			live.nodeType === Node.PROCESSING_INSTRUCTION_NODE
		) {
			return snapshot.importNode(live, false)
		}
		return undefined
	}

	/**
	 * One live element, as it should appear in the archive.
	 *
	 * `undefined` means "this element is not archived at all", which today
	 * is only `<script>`: stripping script elements matches the
	 * compatibility floor Blink's capture already sets, matches the viewer's
	 * rule that a script reference is never resolved even when the archive
	 * holds the bytes, and removes the one class of resource an archive has
	 * no legitimate use for. Inline handler attributes and `javascript:`
	 * URLs are deliberately *kept*: they are page content rather than
	 * references, and neutralizing them is the viewer's job, not the
	 * capture's.
	 */
	function cloneElementInto(live: Element): Element | undefined {
		if (live.localName === 'script') {
			return undefined
		}
		if (live instanceof HTMLCanvasElement) {
			const replacement = canvasReplacement(live)
			if (replacement !== undefined) {
				return replacement
			}
		}

		const qualifiedName = live.prefix === null ? live.localName : `${live.prefix}:${live.localName}`
		let clone: Element
		try {
			clone = snapshot.createElementNS(live.namespaceURI, qualifiedName)
		} catch {
			return undefined
		}
		for (const attribute of live.attributes) {
			try {
				clone.setAttributeNS(attribute.namespaceURI, attribute.name, attribute.value)
			} catch {
				// See `canvasReplacement`: an unrepresentable attribute is dropped.
			}
		}
		applyLiveFormState(live, clone)

		if (live instanceof HTMLTemplateElement && clone instanceof HTMLTemplateElement) {
			// A template's children live in its `content` fragment, not in
			// `childNodes`, and are serialized from there.
			for (const child of live.content.childNodes) {
				const cloned = cloneNodeInto(child)
				if (cloned !== undefined) {
					clone.content.appendChild(cloned)
				}
			}
			return clone
		}

		// The declarative shadow root goes first, which is where the HTML
		// parser expects to find it when it hydrates the archive.
		if (live.shadowRoot !== null) {
			clone.appendChild(shadowRootTemplate(live.shadowRoot))
		}

		if (reflectsTextareaValue(live)) {
			clone.appendChild(snapshot.createTextNode(live.value))
			return clone
		}
		for (const child of live.childNodes) {
			const cloned = cloneNodeInto(child)
			if (cloned !== undefined) {
				clone.appendChild(cloned)
			}
		}
		return clone
	}

	/** Every element of the snapshot, including the contents of declarative shadow roots and ordinary templates. */
	function walkSnapshot(element: Element, visit: (element: Element) => void): void {
		visit(element)
		const children = element instanceof HTMLTemplateElement ? element.content.children : element.children
		for (const child of children) {
			walkSnapshot(child, visit)
		}
	}

	function addNetworkResource(rawValue: string, kind: 'image' | 'stylesheet'): void {
		let resolved: URL
		try {
			resolved = new URL(rawValue, document.baseURI)
		} catch {
			return
		}
		if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') {
			return
		}
		resolved.hash = ''
		if (networkResources.has(resolved.href)) {
			return
		}
		if (networkResources.size >= options.maxNetworkResources) {
			resourceLimitReached = true
			return
		}
		networkResources.set(resolved.href, kind)
	}

	function addBlobUrl(url: string): void {
		if (blobUrls.includes(url)) {
			return
		}
		if (blobUrls.length >= options.maxBlobResources) {
			noteLimit('blob-limit-reached', `more than ${options.maxBlobResources} blob: resources; the rest were not read`)
			return
		}
		blobUrls.push(url)
	}

	/**
	 * The URL an element actually loads, if this element is one of the
	 * reference sites Phase 1 supports.
	 *
	 * Stated as a short explicit list rather than derived from a general
	 * "what can name a resource" walk. Completeness — CSS `url()`,
	 * `@import`, `srcset`, preload-only resources and the Resource Timing
	 * cross-check that catches the rest — is Phase 4's subject, and
	 * pretending to it here would be worse than not doing it.
	 *
	 * **A `blob:` URL is found the same way, and that is a correction.**
	 * Blob collection used to match any attribute whose value began with
	 * `blob:`, on the reasoning that a blob URL is readable nowhere but here.
	 * Measured against a real Firefox, that read and archived the bytes
	 * behind `data-private="blob:…"`, `value="blob:…"`, `title="blob:…"` and
	 * `href="blob:…"` — none of which a browser would ever load — turning
	 * page data that merely looks like a reference into archived content. It
	 * is the same mistake as resolving a `cid:`-shaped string in an arbitrary
	 * attribute: *looks like a resource reference* is not *is a resource
	 * reference*. A blob at a site Phase 1 does not support is left
	 * unarchived, which is the same gap every other unsupported site already
	 * has.
	 */
	function resourceReference(element: Element): { readonly url: string; readonly kind: 'image' | 'stylesheet' } | undefined {
		if (element.namespaceURI !== HTML_NAMESPACE) {
			return undefined
		}
		if (element.localName === 'img') {
			const source = element.getAttribute('src')
			return source === null ? undefined : { url: source.trim(), kind: 'image' }
		}
		if (element.localName === 'link') {
			const relationship = element.getAttribute('rel')?.toLowerCase().split(/\s+/) ?? []
			const href = element.getAttribute('href')
			if (href !== null && relationship.includes('stylesheet')) {
				return { url: href.trim(), kind: 'stylesheet' }
			}
		}
		return undefined
	}

	function collectReferences(element: Element): void {
		const reference = resourceReference(element)
		if (reference === undefined) {
			return
		}
		if (reference.url.toLowerCase().startsWith('blob:')) {
			addBlobUrl(reference.url)
			return
		}
		addNetworkResource(reference.url, reference.kind)
	}

	/**
	 * Makes the snapshot's own charset declaration agree with the bytes that
	 * will actually be written. The archive carries this HTML as UTF-8 (the
	 * only encoding the platform can produce), and the MIME part says so, so
	 * a `<meta charset>` inherited from a legacy-encoded page would be the
	 * one statement in the archive that is false. Only an existing
	 * declaration is corrected; none is invented, because the part's
	 * `Content-Type` already carries the authoritative answer.
	 */
	function normalizeCharsetDeclarations(root: Element): void {
		walkSnapshot(root, (element) => {
			if (element.namespaceURI !== HTML_NAMESPACE || element.localName !== 'meta') {
				return
			}
			if (element.hasAttribute('charset')) {
				element.setAttribute('charset', 'utf-8')
				return
			}
			if (element.getAttribute('http-equiv')?.toLowerCase() === 'content-type') {
				element.setAttribute('content', 'text/html; charset=utf-8')
			}
		})
	}

	const root = cloneElementInto(document.documentElement)
	if (root === undefined) {
		throw new Error('ArchiveBridge: the page has no document element to capture')
	}
	normalizeCharsetDeclarations(root)
	walkSnapshot(root, collectReferences)
	if (resourceLimitReached) {
		note('resource-limit-reached', `more than ${options.maxNetworkResources} referenced resources; the rest were not acquired`)
	}

	/**
	 * Reads a `blob:` URL's bytes, giving up the moment they exceed `limit`.
	 *
	 * Only the page principal can read a `blob:` URL — the same fetch from
	 * the background throws `NetworkError` (measured) — so this is the one
	 * kind of resource acquisition that has to happen in here.
	 *
	 * **`response.blob()` is what this replaces, and the reason is the
	 * contract rather than a measurement.** Consuming the body into a `Blob`
	 * and *then* comparing `blob.size` reads the bound off an object the page
	 * minted, after the platform has already been asked to produce the whole
	 * body; that the platform is unlikely to copy a blob it already holds is
	 * an implementation detail of one browser, not a bound this capture
	 * enforces. A reader that stops is a bound this capture enforces, and it
	 * says the same thing in code that `capture-limits.ts` says in prose. The
	 * cancel is what makes it real: the rest of the body is never produced.
	 *
	 * `undefined` bytes mean "over the limit" — never a truncated prefix,
	 * because a partial resource archived as if it were whole is worse than a
	 * missing one, and never counted against the capture's byte budget,
	 * because nothing was kept.
	 *
	 * This is `resources.ts`'s `readBoundedBody` a second time, deliberately:
	 * nothing in this function may reference anything outside it (see the
	 * module header), and the two sides of the capture read bodies on either
	 * side of a world boundary.
	 */
	async function readBoundedBlob(url: string, limit: number): Promise<{ readonly contentType: string; readonly bytes: Uint8Array | undefined }> {
		const response = await fetch(url)
		const contentType = response.headers.get('content-type') ?? ''
		if (response.body === null) {
			return { contentType, bytes: new Uint8Array() }
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
				return { contentType, bytes: undefined }
			}
			chunks.push(value)
		}
		const bytes = new Uint8Array(total)
		let offset = 0
		for (const chunk of chunks) {
			bytes.set(chunk, offset)
			offset += chunk.byteLength
		}
		return { contentType, bytes }
	}

	const blobs: CapturedBlob[] = []
	for (const url of blobUrls) {
		try {
			const { contentType, bytes } = await readBoundedBlob(url, options.maxResourceBytes)
			if (bytes === undefined) {
				note('blob-too-large', `${url} holds more than the ${options.maxResourceBytes} bytes one resource may contribute; it was not archived`)
				continue
			}
			if (!reserveBytes(bytes.length)) {
				continue
			}
			blobs.push({ url, contentType, bytes })
		} catch (error) {
			note('blob-unreadable', `${url}: ${describe(error)}`)
		}
	}

	/**
	 * The document's doctype, with its external identifiers.
	 *
	 * `<!DOCTYPE html>` covers every page written this century, but a legacy
	 * page's `PUBLIC`/`SYSTEM` identifiers are what put a browser in one
	 * rendering mode rather than another, so dropping them would archive a
	 * page that renders differently from the one captured. Both identifiers
	 * are plain properties of `DocumentType` (measured: Firefox reports them
	 * for a parsed HTML 4.01 doctype), so this needs no SGML serializer.
	 *
	 * What cannot be written is an identifier containing `"`, `<` or `>`,
	 * because a doctype has no escaping at all: a quote would end the
	 * identifier and an angle bracket would end the doctype, so the rest of
	 * it would re-parse as document content. The HTML parser never produces
	 * such an identifier — a `>` inside one truncates the doctype and forces
	 * quirks mode — but `createDocumentType` lets a page build one anyway,
	 * and this runs on pages. Those fall back to the name alone, which is
	 * exactly what the capture wrote before it preserved identifiers at all.
	 */
	function serializeDoctype(type: DocumentType): string {
		if (type.publicId === '' && type.systemId === '') {
			return `<!DOCTYPE ${type.name}>\n`
		}
		if (/["<>]/.test(type.publicId) || /["<>]/.test(type.systemId)) {
			return `<!DOCTYPE ${type.name}>\n`
		}
		if (type.publicId === '') {
			return `<!DOCTYPE ${type.name} SYSTEM "${type.systemId}">\n`
		}
		const system = type.systemId === '' ? '' : ` "${type.systemId}"`
		return `<!DOCTYPE ${type.name} PUBLIC "${type.publicId}"${system}>\n`
	}

	const doctype = document.doctype === null ? '' : serializeDoctype(document.doctype)

	return {
		url: document.URL,
		mimeType: document.contentType,
		title: document.title,
		html: doctype + root.outerHTML,
		networkResources: [...networkResources].map(([url, kind]) => ({ url, kind })),
		canvases,
		blobs,
		notes,
	}
}
