/**
 * The viewer page: read one local archive, reconstruct it, show it in an
 * isolated frame, and own the URLs that reconstruction created.
 *
 * ```text
 * viewer.html#file:///…/page.webarchive
 *   ├─ readViewerSource        core/viewer-source.ts   (browser-neutral)
 *   ├─ readLocalArchive        chrome/local-archive.ts (Chrome adapter)
 *   ├─ parse + convert         @xarsh/archivebridge
 *   ├─ renderMhtml             @xarsh/archivebridge    (browser-neutral)
 *   │     minting every resource URL through this module's registry
 *   └─ <iframe sandbox> src=<root document URL>
 * ```
 *
 * Only two of those steps are Chrome-specific: acquiring the bytes, and
 * the fact that a resource URL is `URL.createObjectURL`. Everything
 * expensive — parsing, conversion, resource resolution, HTML/CSS
 * rewriting, the security rewrite — happens in the library, which is what
 * makes the eventual Firefox and Safari viewers a different loader around
 * the same core rather than a second implementation.
 *
 * **This page never touches archived markup.** It receives a URL from
 * `renderMhtml` and assigns it to an iframe; the foreign document is never
 * parsed into, inserted into, or read out of this page's own DOM. That is
 * the trust boundary docs/architecture.md requires, and keeping it means
 * there is no place here where a mistake could put archive content in the
 * extension's origin with the extension's privileges.
 *
 * **Resource lifetime is owned, not hoped for.** Every URL minted for one
 * archive belongs to one {@link ResourceRegistry}; a registry is released
 * as a unit when its archive is replaced, when the page goes away, and
 * when the load that created it failed part way through. There is no
 * global map of archive bytes and nothing that outlives the tab.
 */

import {
	convertWebArchiveToMhtml,
	type Diagnostic,
	detectArchiveFormatFromBytes,
	type MhtmlDocument,
	type MhtmlRenderResult,
	parseMhtml,
	parseWebArchive,
	type RenderWarning,
	renderMhtml,
} from '@xarsh/archivebridge'
import { FILE_ACCESS_HINT, readLocalArchive } from '../chrome/local-archive.ts'
import { ARCHIVE_FRAME_SANDBOX } from '../core/viewer-policy.ts'
import { describeViewerFailure, readViewerSource, type ViewerFailure } from '../core/viewer-source.ts'

/** Every object URL minted for one archive load, released as one unit. */
interface ResourceRegistry {
	create(bytes: Uint8Array, mimeType: string): string
	release(): void
}

function createResourceRegistry(): ResourceRegistry {
	const urls: string[] = []
	return {
		create(bytes, mimeType) {
			const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mimeType }))
			urls.push(url)
			return url
		},
		release() {
			for (const url of urls.splice(0)) {
				URL.revokeObjectURL(url)
			}
		},
	}
}

function requireElement<T extends Element>(id: string, elementType: new () => T): T {
	const element = document.getElementById(id)
	if (!(element instanceof elementType)) {
		throw new Error(`viewer.html is missing element #${id}`)
	}
	return element
}

const bar = requireElement('bar', HTMLElement)
const sourceLabel = requireElement('source', HTMLElement)
const notesToggle = requireElement('notes-toggle', HTMLButtonElement)
const notes = requireElement('notes', HTMLUListElement)
const archiveFrame = requireElement('archive', HTMLIFrameElement)
const failure = requireElement('failure', HTMLElement)
const failureTitle = requireElement('failure-title', HTMLElement)
const failureDetail = requireElement('failure-detail', HTMLElement)
const failureHint = requireElement('failure-hint', HTMLElement)

/**
 * The registry for the archive currently on screen. Replaced — and its
 * predecessor released — only once a new archive has actually rendered, so
 * a failed load never takes down a document that is still being read.
 */
let currentResources: ResourceRegistry | undefined

/** Guards against two loads overlapping (a second `hashchange` while the first read is still in flight). */
let loadSequence = 0

function show(state: 'archive' | 'failure' | 'loading'): void {
	archiveFrame.hidden = state !== 'archive'
	failure.hidden = state !== 'failure'
	bar.hidden = false
}

function reportFailure(problem: ViewerFailure, displayName?: string): void {
	const message = describeViewerFailure(problem)
	failureTitle.textContent = message.title
	failureDetail.textContent = message.detail
	// The remedy for a missing file-access grant is a Chrome setting with no
	// equivalent elsewhere, so the browser-neutral message says what is wrong
	// and this line says what to do about it.
	failureHint.textContent = problem.kind === 'file-access-denied' ? FILE_ACCESS_HINT : ''
	failureHint.hidden = problem.kind !== 'file-access-denied'
	sourceLabel.textContent = displayName ?? ''
	document.title = displayName === undefined ? 'ArchiveBridge' : `${displayName} — ArchiveBridge`
	show('failure')
}

/** One line per warning, in the order the reconstruction produced them. */
function describeWarning(warning: RenderWarning): string {
	switch (warning.type) {
		case 'unresolved-reference':
			return `Not in this archive: ${warning.url} (${warning.element} ${warning.attribute})`
		case 'blocked-reference':
			return `Not loaded (${warning.reason}): ${warning.url === '' ? `${warning.element} ${warning.attribute}` : warning.url}`
		case 'frame-depth-exceeded':
			return `Frames nested deeper than the archive limit (${warning.depth}); the deepest are not shown.`
		case 'stylesheet-import-depth-exceeded':
			return `Stylesheets @imported deeper than the archive limit (${warning.depth}); the deepest are not applied.`
		case 'cyclic-frame-reference':
			return `A frame refers back to one that contains it; it is not shown (part ${warning.partIndex}).`
		case 'unrewritable-reference':
			return `A reference could not be rewritten, so the document containing it is not shown (${warning.element} ${warning.attribute}).`
		case 'warnings-truncated':
			return `…and ${warning.omitted} more.`
	}
}

function describeDiagnostic(diagnostic: Diagnostic): string {
	return `Archive problem: ${diagnostic.type === 'unsupported-feature' ? diagnostic.feature : diagnostic.type}`
}

function renderNotes(lines: readonly string[]): void {
	notes.replaceChildren(
		...lines.map((line) => {
			const item = document.createElement('li')
			item.textContent = line
			return item
		}),
	)
	notesToggle.hidden = lines.length === 0
	notesToggle.textContent = lines.length === 1 ? '1 note' : `${lines.length} notes`
	notesToggle.setAttribute('aria-expanded', 'false')
	notes.hidden = true
}

notesToggle.addEventListener('click', () => {
	notes.hidden = !notes.hidden
	notesToggle.setAttribute('aria-expanded', String(!notes.hidden))
})

/** Parses whatever the file turned out to be into canonical MHTML — the one shape the renderer consumes (docs/architecture.md, "No format-neutral Archive/ArchiveView IR"). */
function toCanonicalMhtml(bytes: Uint8Array): { readonly document: MhtmlDocument | undefined; readonly diagnostics: readonly Diagnostic[]; readonly recognized: boolean } {
	switch (detectArchiveFormatFromBytes(bytes)) {
		case 'webarchive': {
			const parsed = parseWebArchive(bytes)
			if (parsed.document === undefined) {
				return { document: undefined, diagnostics: parsed.diagnostics, recognized: true }
			}
			const converted = convertWebArchiveToMhtml(parsed.document)
			return { document: converted.document, diagnostics: [...parsed.diagnostics, ...converted.diagnostics], recognized: true }
		}
		case 'mhtml': {
			const parsed = parseMhtml(bytes)
			return { document: parsed.document, diagnostics: parsed.diagnostics, recognized: true }
		}
		case undefined:
			return { document: undefined, diagnostics: [], recognized: false }
	}
}

function summarize(result: MhtmlRenderResult, displayName: string): string {
	const { stats } = result
	const parts = [
		`${stats.documents} document${stats.documents === 1 ? '' : 's'}`,
		`${stats.resources + stats.stylesheets} resource${stats.resources + stats.stylesheets === 1 ? '' : 's'}`,
	]
	return `${displayName} — ${parts.join(', ')}`
}

async function load(): Promise<void> {
	loadSequence += 1
	const sequence = loadSequence
	const source = readViewerSource(location.href)
	if (source.kind !== 'archive') {
		releaseCurrent()
		reportFailure(source.kind === 'absent' ? { kind: 'absent-source' } : { kind: 'rejected-source', value: source.value })
		renderNotes([])
		return
	}

	document.title = `${source.displayName} — ArchiveBridge`
	sourceLabel.textContent = source.displayName
	show('loading')

	const read = await readLocalArchive(source.url)
	if (sequence !== loadSequence) {
		return
	}
	if (!read.ok) {
		releaseCurrent()
		reportFailure(read.failure, source.displayName)
		renderNotes([])
		return
	}

	const canonical = toCanonicalMhtml(read.bytes)
	if (!canonical.recognized) {
		releaseCurrent()
		reportFailure({ kind: 'unrecognized-format' }, source.displayName)
		renderNotes([])
		return
	}
	if (canonical.document === undefined) {
		releaseCurrent()
		reportFailure(
			{ kind: 'unparseable', detail: `The archive could not be parsed (${canonical.diagnostics.map((diagnostic) => diagnostic.type).join(', ') || 'no further detail'}).` },
			source.displayName,
		)
		renderNotes(canonical.diagnostics.map(describeDiagnostic))
		return
	}

	// Everything from here mints URLs, so it gets its own registry: if the
	// render throws part way through, only what it created is released, and
	// the archive already on screen is left alone.
	const resources = createResourceRegistry()
	let result: MhtmlRenderResult
	try {
		result = renderMhtml(canonical.document, { createResourceUrl: (bytes, mimeType) => resources.create(bytes, mimeType) })
	} catch (error) {
		resources.release()
		releaseCurrent()
		reportFailure({ kind: 'unparseable', detail: `The archive could not be reconstructed: ${error instanceof Error ? error.message : String(error)}.` }, source.displayName)
		renderNotes([])
		return
	}

	if (result.rootUrl === undefined) {
		resources.release()
		releaseCurrent()
		// The reason the root document was refused can be a *warning* rather
		// than a diagnostic — a reference the renderer could not rewrite is the
		// viewer's own policy decision, not a defect in the archive — so the
		// notes list has to carry warnings here too, or the reader gets
		// "Nothing to display" with nothing to explain it.
		const detail = [...canonical.diagnostics, ...result.diagnostics]
			.map((diagnostic) => (diagnostic.type === 'unsupported-feature' ? diagnostic.feature : diagnostic.type))
			.join('; ')
		const refusal = result.warnings.some((warning) => warning.type === 'unrewritable-reference')
			? 'A reference in this page could not be rewritten safely, so the page is not shown.'
			: undefined
		reportFailure({ kind: 'no-document', detail: refusal ?? (detail.length === 0 ? 'This archive contains no page to display.' : detail) }, source.displayName)
		renderNotes([...canonical.diagnostics.map(describeDiagnostic), ...result.diagnostics.map(describeDiagnostic), ...result.warnings.map(describeWarning)])
		return
	}

	// Point the frame at the new document before releasing the old URLs, so
	// there is no moment in which the tab shows a document whose resources
	// have already been revoked.
	archiveFrame.src = result.rootUrl
	const previous = currentResources
	currentResources = resources
	previous?.release()

	sourceLabel.textContent = summarize(result, source.displayName)
	sourceLabel.title = result.rootLocation ?? source.url
	renderNotes([...canonical.diagnostics.map(describeDiagnostic), ...result.diagnostics.map(describeDiagnostic), ...result.warnings.map(describeWarning)])
	show('archive')
}

function releaseCurrent(): void {
	archiveFrame.removeAttribute('src')
	currentResources?.release()
	currentResources = undefined
}

// Navigating from one archive to another lands on the *same* viewer document,
// because only the fragment differs — so without this the tab would keep
// showing the first archive. It is also the one moment where the previous
// load's resource URLs have to be released by this code rather than by the
// browser tearing the document down.
addEventListener('hashchange', () => {
	void load()
})

// `pagehide` rather than `unload`, because `unload` is deprecated and
// `pagehide` is the event that actually fires. Releasing here is
// belt-and-braces — a document's object URLs die with the document — but it
// makes the ownership explicit rather than implicit.
//
// **`persisted` is deliberately not consulted, and that is a measured
// decision rather than an oversight.** In general `pagehide` also fires for
// a page entering the back/forward cache, where releasing would leave a
// restored tab showing a document whose resources were already revoked. A
// viewer page is never in that position: asked directly (CDP
// `Page.backForwardCacheNotUsed`), Chromium 153 gives two structural
// reasons why `chrome-extension://viewer.html` is ineligible —
// `SchemeNotHTTPOrHTTPS` and `EmbedderExtensionFrame` — and reports the
// same for the archive's own `blob:` child frame. Neither is something an
// extension can opt out of. Measured end to end: opening an archive,
// navigating away and pressing Back produces a *fresh* viewer document
// (page-scoped globals are gone) which re-reads the file and re-renders
// correctly. So on this page `pagehide` only ever means real teardown, and
// a `persisted === true` branch would be dead code guarding a state the
// platform will not create.
addEventListener('pagehide', () => {
	releaseCurrent()
})

// Reading the sandbox back from the DOM keeps this bundle honest about the
// isolation it actually got: an edit to viewer.html that widened the frame's
// privileges would show up here rather than silently shipping.
if (archiveFrame.getAttribute('sandbox') !== ARCHIVE_FRAME_SANDBOX) {
	throw new Error('the archive frame is not sandboxed as the viewer policy requires')
}

void load()
