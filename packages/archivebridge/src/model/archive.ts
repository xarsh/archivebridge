/**
 * Format identity and diagnostics: the two concepts that stay
 * format-neutral even though ArchiveBridge's parsed representations do
 * not (see `model/mhtml.ts`/`model/webarchive.ts` and docs/architecture.md,
 * "No format-neutral Archive/ArchiveView IR").
 *
 * Format identity and diagnostics belong here precisely *because* they are
 * the only two things every format shares without being squeezed into a
 * shared shape: a `Diagnostic` describes a problem, not a resource, and an
 * `ArchiveFormat` names a format rather than modelling one. Nothing that
 * describes archive *content* belongs in this file — that is what makes it
 * format-neutral without becoming a cross-format IR.
 */

/** Archive formats ArchiveBridge understands. */
export type ArchiveFormat = 'mhtml' | 'webarchive'

/**
 * Non-fatal and fatal problems surfaced while parsing or converting an
 * archive. Parsing real-world archives should prefer returning diagnostics
 * over throwing, so a single malformed resource does not discard an
 * otherwise-readable archive. See docs/architecture.md, "Diagnostics and
 * partial failure".
 */
export type Diagnostic =
	| {
			readonly type: 'malformed-archive'
			readonly message: string
	  }
	| {
			readonly type: 'malformed-resource'
			readonly url?: string
			readonly message: string
	  }
	| {
			readonly type: 'unsupported-encoding'
			readonly encoding: string
	  }
	| {
			/** A referenced URL or `cid:` has no matching part/resource. */
			readonly type: 'unresolved-resource'
			readonly url: string
	  }
	| {
			/** Two parts/resources claim the same Content-Location/WebResourceURL. */
			readonly type: 'duplicate-content-location'
			readonly url: string
	  }
	| {
			/** Two MIME entities claim the same Content-ID, violating RFC 2045/2392's world-uniqueness requirement. */
			readonly type: 'duplicate-content-id'
			readonly contentId: string
	  }
	| {
			/** More than one part matches the metadata sidecar's media type in one document. */
			readonly type: 'duplicate-metadata-sidecar'
			readonly count: number
	  }
	| {
			/** The metadata sidecar part exists but failed to parse as a plist, or parsed to an unexpected shape. Its residual metadata is treated as absent; the surrounding document still parses. */
			readonly type: 'malformed-metadata-sidecar'
			readonly message: string
	  }
	| {
			/** A recursive frame structure (WebSubframeArchives nesting, or an MHTML cid: chain) exceeded the recursion bound. */
			readonly type: 'frame-depth-exceeded'
			readonly depth: number
	  }
	| {
			/** A `cid:` chain looped back to one of its own ancestors (e.g. A -> B -> A), or a part whose HTML directly references its own Content-ID (A -> A). The cyclic edge is dropped rather than re-expanded or duplicated into the frame tree; distinct from `frame-depth-exceeded`, which is a legitimate (non-cyclic) chain that simply got too long. */
			readonly type: 'cyclic-frame-reference'
			readonly partIndex: number
	  }
	| {
			/** A WebArchive `subframeArchives` entry had no matching `<iframe>`/`<frame>` `src` reference anywhere in its parent's rewritten HTML — the opposite mismatch from `unresolved-resource` (a reference with no matching resource): here a resource exists but nothing referenced it. The child's resource data is still emitted as MHTML parts, just with no frame-src `cid:` link pointing at it. */
			readonly type: 'unconsumed-child-frame'
			readonly url: string
	  }
	| {
			readonly type: 'unsupported-feature'
			readonly feature: string
	  }
	| {
			readonly type: 'recovered-non-conforming-input'
			readonly message: string
	  }
