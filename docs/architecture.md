# Architecture

This document records the design decisions behind ArchiveBridge and why
they were made, so future contributors (human or agent) don't have to
reverse-engineer intent from the code. See the root
[CONTRIBUTING.md](../CONTRIBUTING.md) for the practical contribution
rules; this file is the "why" behind them. See
[migration-plan.md](migration-plan.md) for how the current production
code (which still implements an earlier design) migrates to what's
described here.

## Goals

See [README.md](../README.md#goals) for what ArchiveBridge does and who
it's for. The library (`packages/archivebridge`, published as
`@xarsh/archivebridge`) is the core; the CLI and the browser extension are
both thin consumers of it — nothing archive-format-specific should live
outside the library. Everything below this point is the *why* behind the
decisions that follow from those goals.

## MHTML is the canonical format

ArchiveBridge treats **MHTML as its canonical serialized representation** —
the format every capture path converges on, and the format every other
capability (inspect, validate, extract, convert) is built against
directly:

```text
Chrome / Edge   live page --native MHTML capture-->  MHTML
Firefox         live page --custom MHTML capture-->  MHTML
Safari          live page --custom MHTML capture-->  MHTML

MHTML --save / inspect / validate / extract
MHTML --convert--> WebArchive
WebArchive --convert--> MHTML
```

This choice was validated by a research corpus of real Chrome-generated
MHTML captures (structural corpus, WPT cross-checks, a metadata-part
Chrome-compatibility matrix, a plist round-trip test, and real WKWebView
`WebSubframeArchives` output) — see "Sources for this section" below.
Nothing about that research is reproduced verbatim here; only the
conclusions that changed this document are.

### Format vs. capture semantics

MHTML the *format* and "what a browser's native capture puts into an
MHTML file" are two different things, and this document treats them as
separate concerns on purpose:

- **MHTML-the-format** is RFC 2557 `multipart/related` + RFC 2045/2046
  MIME. It can represent any resource ArchiveBridge's own serializer
  chooses to put in it, with no inherent fidelity ceiling.
- **Chrome/Blink's native capture semantics** (`Page.captureSnapshot`
  and `chrome.pageCapture.saveAsMHTML()` — confirmed behaviorally
  equivalent to each other) are a snapshot of the **post-load,
  post-script-execution DOM tree, serialized to static markup, with
  `<script>` elements stripped** — not a re-executable bundle, not a
  full resource-cache dump. Concretely, this means Chrome-native capture
  reflects DOM mutations already applied before capture, but never
  captures: live form control state (`value`/`checked`/`selected` set via
  JS), `<canvas>` pixel content, `@font-face`-referenced font files,
  `<link rel=preload>` resources never inserted into the DOM, and
  `blob:` URLs backed by an in-memory `Blob` (as opposed to a `File`).
  Attached shadow roots *are* captured, via declarative Shadow DOM.

These capture-semantics gaps are **properties of what a browser's native
capture API can ever produce**, not properties of the MHTML format
ArchiveBridge reads and writes, and not bugs for ArchiveBridge to work
around in its own serializer (which is not a browser DOM serializer and
does not share these limitations — it writes exactly the resources it is
given). Reader/parser code must stay tolerant of producer quirks;
ArchiveBridge's own writer stays standards-conforming and does not
imitate them.

Chrome's capture corpus is therefore a **compatibility floor** (the shape
any conforming MHTML reader must handle, because it's what a huge amount
of real-world MHTML looks like) — not a **fidelity ceiling** that a
future Firefox or Safari capture adapter is obligated to imitate. A
from-scratch capture implementation for another browser is free to make
different, arguably better, choices for any of the gaps above.

### No format-neutral `Archive`/`ArchiveView` IR

Earlier design work in this repository assumed a format-independent
`Archive`/`Resource` object model that both MHTML and WebArchive parse
into and both serializers consume — with `inspect`/`extract` operating
on that shared model. **This document replaces that approach.** There is
no format-neutral canonical IR in ArchiveBridge's architecture.

Reasons:

- A real MHTML document is not naturally a recursive tree. It is a
  **flat set of MIME parts** in one `multipart/related` envelope; frame
  relationships are expressed by HTML content (`cid:` references), not
  by any structural nesting the parser has to reconstruct into a
  synthetic tree (see "Frame representation" below).
- WebArchive-specific fields (`WebResourceResponse`,
  `WebResourceFrameName`, and any future Apple plist key) have no
  natural home in a format-neutral model without either dropping them or
  letting format-specific metadata bloat the "neutral" model — the
  second option isn't actually neutral anymore.
- MHTML being canonical removes the reason to invent a third shape:
  conversion is WebArchive ⇄ MHTML directly, with no hop through an
  ArchiveBridge-only intermediate representation that both formats have
  to be lossily squeezed into and back out of.

Parsing still produces a **format-native structured result** — this is
expected and different from a cross-format IR. `parseMhtml` should
produce an MHTML-native structure; `parseWebArchive` should produce a
WebArchive-native structure. The distinction that matters is:

> A **format-native parsed representation** (what this document keeps) is
> fine, even necessary. An **ArchiveBridge-invented cross-format
> canonical representation** (what this document removes) is not.

`inspect`, `extract`, and `validate` operate on canonical MHTML — always.
There is no separate WebArchive-native inspection/validation/extraction
path; a WebArchive input converts to canonical MHTML first, and the same
single implementation handles it from there on:

```text
MHTML
  └─ parse → inspect / validate / extract

WebArchive
  └─ parse
      ↓
    convert
      ↓
    canonical MHTML
      ↓
    inspect / validate / extract
```

`parseWebArchive` producing a `WebArchiveDocument` is still necessary —
it's the required first step before conversion can run at all — but that
parsed representation is an intermediate value on the way to canonical
MHTML, not a second, parallel target that `inspect`/`validate`/`extract`
also know how to operate on directly. This keeps format-specific
inspection logic from existing twice.

### MHTML-native representation

The MHTML-native shape mirrors what real MHTML actually is: one
`multipart/related` envelope holding a flat, ordered list of MIME parts,
one of which is resolved as the root.

```ts
interface MhtmlPart {
	/** Content-ID, normalized (no `<...>` wrapper — see "Content-ID"
	 *  below). Not every part has one. */
	readonly contentId: string | undefined
	/** Content-Location: an absolute URL for ordinary resources, or a
	 *  synthetic `cid:` URI for inline content with no natural URL
	 *  (e.g. an extracted <style> block) — this is a real, observed
	 *  producer convention, not an ArchiveBridge invention. Not every
	 *  MIME part has a Content-Location either: a foreign part that
	 *  carries only a Content-ID, or ArchiveBridge's own metadata
	 *  sidecar part (see "Metadata sidecar" below), legitimately has
	 *  none. Absence is not itself fatal to parsing — a part with
	 *  neither a Content-Location nor a Content-ID is still a valid
	 *  parsed `MhtmlPart`; whichever *specific* operation actually
	 *  needs an identity for that part (e.g. resolving a `cid:`
	 *  reference, or `extract` naming an output file) is what reports
	 *  a diagnostic if that operation can't proceed without one. */
	readonly location: string | undefined
	readonly mimeType: string
	readonly textEncoding: string | undefined
	readonly data: Uint8Array
}

interface MhtmlDocument {
	/** All MIME parts in original document order, including the root
	 *  part. Includes frame-root parts too — see "Frame representation"
	 *  below; frames are not a separate field. */
	readonly parts: readonly MhtmlPart[]
	/** Index into `parts` identifying the resolved root part (per RFC
	 *  2387's `start` parameter, the `Snapshot-Content-Location`
	 *  fallback, or "first part" — see `mhtml/parse.ts`'s existing
	 *  `findMainPartIndex`). Not necessarily `0`: `start` can name any
	 *  part regardless of physical position, and this shape preserves
	 *  that position rather than splitting the root out of `parts`
	 *  and losing where it actually sat in the original document. */
	readonly rootPartIndex: number
}
```

Splitting the root part out into its own field (an earlier draft of this
document did this) loses the root's physical position among the other
parts whenever `start` names a part that isn't first — real MHTML makes
no such guarantee. Keeping one flat, order-preserving `parts` array plus
an index is a lossless, direct reflection of the underlying multipart
structure; a `rootPart` accessor can be derived trivially
(`document.parts[document.rootPartIndex]`) without the canonical stored
shape making that split.

**Invariants.** Every `MhtmlDocument` that parsing or construction
successfully produces satisfies:

```ts
document.parts.length > 0
0 <= document.rootPartIndex && document.rootPartIndex < document.parts.length
```

i.e. `rootPartIndex` always indexes a real, present part — there is no
successfully-parsed `MhtmlDocument` with zero parts or with a dangling
root index. When input is malformed enough that a root part can't be
resolved (no parts at all, or a `start`/`Snapshot-Content-Location` that
matches nothing and no part to fall back to), the correct outcome is
**not** an `MhtmlDocument` with, say, `rootPartIndex: -1` or an empty
`parts` array standing in for "no result" — it's the existing
diagnostic/partial-failure policy: no `MhtmlDocument` at all (a
`malformed-archive` diagnostic and an absent parse result), the same
shape `parseMhtml` already returns today for an unparseable envelope.
`MhtmlDocument`'s invariants are conditions on *valid* values of the
type, not conditions a caller needs to defensively check — a function
that receives an `MhtmlDocument` is entitled to assume both hold.

No `frames` field. A part being "the document for some `<iframe>`" is a
*relationship*, derived on demand from HTML content, not a structural
property stored on `MhtmlDocument`/`MhtmlPart` — see below.

### WebArchive-native representation

Unlike MHTML, a real `.webarchive` plist **is** naturally a recursive
tree (`WebSubframeArchives` is an array of full nested WebArchive
dictionaries, confirmed at multiple nesting depths and both same- and
cross-origin siblings against real WKWebView output). Mirroring that
recursive shape here is not the mistake the removed `Archive`/`frames`
design made — the mistake was inventing a recursive shape *shared with
MHTML*, which isn't recursive at all. A format-native structure is
allowed to look like its format.

```ts
interface WebArchiveResource {
	readonly url: string
	readonly mimeType: string
	readonly data: Uint8Array
	readonly textEncoding: string | undefined
	/** WebResourceFrameName. Present on frame-root resources; WebKit
	 *  synthesizes a `<!--frameN-->` placeholder when no HTML `name`
	 *  attribute was set, numbered sequentially across the whole document. */
	readonly frameName: string | undefined
	/** WebResourceResponse: an opaque NSKeyedArchiver-serialized
	 *  NSURLResponse blob. Observed only on subresources, never on any
	 *  WebMainResource at any depth. Never interpreted, only preserved. */
	readonly response: Uint8Array | undefined
	/** Any other plist key on this resource dictionary that isn't one of
	 *  the fields above, preserved opaquely and unparsed. `unknown` here
	 *  stands in for "an opaque plist value" — see the note after
	 *  `WebArchiveDocument` below for why that's narrower than it looks. */
	readonly extra: ReadonlyMap<string, unknown>
}

interface WebArchiveDocument {
	readonly mainResource: WebArchiveResource
	readonly subresources: readonly WebArchiveResource[]
	readonly subframeArchives: readonly WebArchiveDocument[]
	/** Any plist key on this *document* dictionary itself (sibling to
	 *  `WebMainResource`/`WebSubresources`/`WebSubframeArchives`) that
	 *  isn't one of those three — i.e. a future Apple key at the
	 *  document level, not a per-resource one. `WebArchiveResource.extra`
	 *  above already covers unknown *resource*-dictionary keys; this
	 *  field is the document-level equivalent, so neither level of
	 *  unknown/future WebArchive metadata is dropped. Empty for every
	 *  real fixture observed so far (no undocumented document-level key
	 *  has been seen), but the field exists so a future one is
	 *  preserved rather than silently lost. */
	readonly extra: ReadonlyMap<string, unknown>
}
```

**`extra`'s value type is narrower than `unknown` suggests.** Both
`WebArchiveResource.extra` and `WebArchiveDocument.extra` hold *opaque
plist values* — values the underlying plist parser (the project's
existing `plist` dependency) actually produces and can round-trip back
into a plist (string, integer, real, bool, `Data`/`Uint8Array`, `Date`,
array, nested dictionary — plist's own value domain) — not arbitrary
JavaScript values of any shape. `unknown` is used in this document's
illustrative type as a stand-in because a precise `PlistValue`-shaped
union isn't fixed here; production migration should check what the
`plist` package's own types/actual value domain look like and, where
practical, express `extra` as `ReadonlyMap<string, PlistValue>` (or
whatever that package's real value type is called) rather than leaving
it as literally `unknown` in the shipped types. The architectural point
that must survive that narrowing either way: these fields are for
*preserving plist-shaped data ArchiveBridge doesn't interpret*, not a
general-purpose bag for arbitrary runtime values.

`WebArchiveDocument.extra` applies once per document — the top-level
document and each nested `subframeArchives` entry each have their own.
Mapping it into the metadata sidecar reuses the same `Content-ID`-keyed
identity the sidecar already uses for per-resource residual fields,
rather than inventing a second identity space for document-level data:
every `WebArchiveDocument` (top-level or nested) corresponds 1:1 to one
MHTML frame-root part (the top-level document to the MHTML document's
root part; each `subframeArchives` entry to the flat sibling part its
parent's `cid:` reference points at — see "Frame representation" below).
That part's `Content-ID` is therefore also the right key for that
document's `extra`, alongside — not instead of — the resource-level
fields already keyed there for that same part's `mainResource`. The
sidecar shape in "Metadata sidecar" below reflects this: a `documentExtra`
entry sits next to `webResourceResponse`/`webResourceFrameName`/
`resourceExtra` under the same `Content-ID`, precisely because both
describe the same underlying MIME part from two different angles (the
part as a resource, and the part as a frame-root document). This does
**not** reintroduce a copy of the whole source WebArchive into the
sidecar — only the specific residual dictionaries (`extra` on the
resource, `extra` on the document) that have no home in standard MHTML.

### Frame representation: flat parts + `cid:` linkage

Real Chrome-generated MHTML represents frames as **flat sibling MIME
parts**, at every nesting depth, regardless of same- or cross-origin
status — never as nested `multipart/mixed` wrapping several
`multipart/related` documents. This directly contradicted an earlier
draft of this document, which assumed the RFC 2557-style nested shape;
that assumption did not match any real Chrome output and is retired.

The actual mechanism: the owning frame's HTML has its `<iframe src>`
rewritten to `cid:<content-id>`, pointing directly at the sibling part's
`Content-ID`. Nesting depth is not represented structurally at all — it
exists only implicitly, as one HTML part's `cid:` reference pointing to
another HTML part.

Consequences for ArchiveBridge's own model:

- **`MhtmlDocument` needs no recursive frame field.** "Is this part a
  frame root" is answered by scanning `text/html` part bodies for
  `cid:` references that match another part's `Content-ID` — a derived
  relationship, computed when needed (`inspect`, conversion), not stored
  redundantly on the type.
- **Converting a WebArchive frame tree into MHTML is a flattening
  operation**, not a structural translation: assign every resource at
  every depth (main + subresources + every subframe's main + its
  subresources) a `Content-ID`, emit them all as sibling parts of one
  `multipart/related` envelope, and rewrite each parent frame's
  `<iframe src="...">` from its original resolved URL to
  `cid:<child's-content-id>` in the emitted HTML. This is genuinely new
  logic with no existing equivalent in production code today, and *how*
  to implement the HTML rewriting itself (a small targeted
  substitution, a battle-tested HTML parser/tokenizer dependency, or
  some other standards-aware approach) is an open implementation
  decision, not fixed by this document — see migration-plan.md, which
  defers that choice to immediately before the migration stage that
  needs it.
- **Converting flat MHTML frame parts back into a WebArchive tree** is
  the inverse: find `cid:`-referenced `text/html` parts, treat each as a
  subframe root, recursively rebuild `WebSubframeArchives`, and rewrite
  each `cid:` reference in the emitted HTML back to the plain resolved
  URL (WebArchive's `<iframe src>` is never `cid:`-rewritten in real
  Safari/WebKit output — see below).
- **The frame tree itself does not need duplicate storage in the
  metadata sidecar.** Real `WebSubframeArchives` parent→child linkage
  turned out to be *weaker* than MHTML's: WebKit leaves `<iframe src>`
  completely untouched and has no explicit ownership field anywhere in
  the plist — the only real linkage is resolving the iframe's `src`
  against the owning frame's URL and matching the result against a
  candidate child's `WebResourceURL`. MHTML's `cid:` → `Content-ID`
  linkage recovers at least as much structure with no base-URL
  resolution and no ambiguity from two frames sharing a relative path.
  Confirmed against real WKWebView-generated `WebSubframeArchives`
  output at multiple nesting depths and both same- and cross-origin
  siblings — not just documented schema.

### Content-ID: preservation, generation, and identity

RFC 2045/RFC 2392 require a `Content-ID` to be a world-unique identifier
for a MIME entity, but specify no generation algorithm — ArchiveBridge's
own rules for that are an architecture decision, not an RFC requirement,
and are recorded here so parsing, serialization, and the metadata sidecar
all agree on one identity model:

- **Existing IDs are preserved.** Parsing foreign MHTML or
  ArchiveBridge-authored MHTML that already has a `Content-ID` on a part
  keeps it unchanged. A bare parse → serialize round trip must not
  regenerate a `Content-ID` "for no reason" — doing so would silently
  break any existing `cid:` reference in that document's HTML, which is
  the actual linkage frame representation and any other `cid:` reference
  in the input depends on. Preserving existing `cid:` linkage takes
  priority over any cosmetic preference for ArchiveBridge's own ID shape.
- **New IDs are generated only for parts that don't have one, and the
  generated ID must satisfy RFC 2045/2392's global/world-uniqueness
  requirement for the MIME entity it identifies.** That requirement —
  distinct MIME entities never collide on `Content-ID` — is the actual
  architecture contract; it is a property the generated ID must have, not
  a mandate on *how* it's produced. In particular:
  - **Content hash alone must never be the sole identity input**, because
    hashing does not satisfy the uniqueness requirement above: two
    different logical MIME entities (e.g. the same image embedded twice
    for two unrelated reasons) can legitimately share identical bytes,
    and an identity derived purely from those bytes would incorrectly
    collapse them into one `Content-ID`.
  - **Current implementation strategy: UUID-based generation** —
    conceptually `<part-<uuid>@archivebridge>` (the exact prefix and
    right-hand-side domain-like suffix are an implementation constant,
    not fixed by this document). This is the strategy that currently
    satisfies the contract above, not the contract itself; UUIDs happen
    to be non-deterministic, but that's a property of UUIDs, not a
    requirement this document imposes. A different generation strategy
    remains architecture-conforming as long as it still guarantees
    uniqueness across distinct entities.
  - **Test strategy is a separate concern from the production contract.**
    Tests may inject a deterministic ID generator, or normalize generated
    IDs before a `deepEqual` comparison, purely for round-trip-assertion
    ergonomics (see the last bullet below) — that's about how a test
    observes IDs, not a statement about whether production code is or
    isn't allowed to be deterministic. The only thing production code
    must guarantee is the uniqueness property above; determinism is
    neither required nor forbidden by this document.
- **Internal representation vs. serialization syntax.** `MhtmlPart.contentId`
  stores the *normalized* identifier (no `<...>` wrapper). The `<...>`
  angle-bracket form is header-serialization syntax (RFC 2045's
  `msg-id` production), applied only when writing the `Content-ID:`
  header or a `start`/`cid:` reference to it, and stripped again on
  parse — the same normalization `mhtml/parse.ts`'s existing
  `normalizeCid` already performs for the `start` parameter today.
  Converting between a `Content-ID` and its `cid:` URL form respects RFC
  2392's escaping rules (the identifier may need percent-encoding to be
  a valid URI, and decoding must undo that) — no separate, ad hoc
  escaping scheme.
- **Duplicates are a diagnostic, not silently resolved.** Two MIME
  entities claiming the same `Content-ID` within one document is
  malformed input; see "Diagnostics and partial failure" below for how
  this is distinguished from a duplicated `Content-Location`.
- **The metadata sidecar keys by the normalized `Content-ID`** (see
  "Metadata sidecar" below) — the same identifier form `MhtmlPart.contentId`
  stores, not the header's angle-bracket spelling.

### Direct WebArchive ⇄ MHTML conversion

Conversion is a converter function per direction
(`WebArchiveDocument → MhtmlDocument` and `MhtmlDocument →
WebArchiveDocument`), not "parse into a shared IR, then serialize out of
it." Each converter is responsible for:

- Mapping resource fields that both formats represent natively (URL,
  MIME type, bytes, text encoding) directly across.
- Frame flattening/reconstruction (previous subsection).
- Reading/writing the metadata sidecar for whatever residual
  WebArchive-only fields don't map onto MHTML natively (next
  subsection).

### Metadata sidecar

Standard MHTML has no field for `WebResourceResponse`,
`WebResourceFrameName`, or any future Apple plist key. Rather than
dropping that data on WebArchive → MHTML conversion, ArchiveBridge-authored
MHTML may carry one additional MIME part holding it.

**Format:** a **plist** (binary `bplist00`, matching what `mhtml/parse.ts`
and `mhtml/serialize.ts` already base64-encode/decode), not JSON. This
reuses the project's existing `plist` dependency and existing base64
codec with zero new dependencies or encoding logic — a real
`WebResourceResponse` blob pulled from an existing repo fixture was
confirmed to survive plist → MIME-part → plist byte-for-byte identical,
using exactly the encode/decode primitives `mhtml/serialize.ts` and
`mhtml/parse.ts` already have. plist also has direct native support for
every type this needs (`Data`, nested dictionaries/arrays, opaque unknown
keys) without inventing a JSON encoding scheme for binary blobs.

**Content-Type:** `application/vnd.archivebridge.metadata` — a
vendor-tree (`vnd.`) media type naming ArchiveBridge as the
publicly-available software that defines it, per RFC 6838's vendor-tree
convention. This deliberately supersedes the research prototype's
`application/x-archivebridge-metadata+plist`: the unregistered `x-`
prefix is an obsolete/deprecated naming convention (RFC 6648 recommends
against minting new `x-`-prefixed types), and `+plist` claimed a
structured-syntax suffix that was never actually registered with IANA —
neither is appropriate for the name this project commits to long-term.
That the payload is a binary plist is specified in this document's prose
(previous paragraph), not encoded into the media type's suffix.

To be precise about this type's actual standing:
`application/vnd.archivebridge.metadata` is an **ArchiveBridge-defined
vendor-tree media type that is not currently registered with IANA**.
Nothing in this document should be read as claiming registration that
hasn't happened. If/when ArchiveBridge-authored MHTML's interoperability
stabilizes enough to be worth a formal registration, that's a future,
separate decision — this document only fixes the name ArchiveBridge
itself uses consistently starting now, so parser/serializer code and any
already-produced test archives agree on one string.

**Cardinality:** zero or one metadata sidecar part per `MhtmlDocument` is
valid. Zero is the common case (no residual metadata — most MHTML,
including anything not authored by ArchiveBridge, has none). One is the
case that's actually parsed. **Two or more parts matching the sidecar
media type in one document is ambiguous input, not a case to silently
resolve**: it's a diagnostic, and ArchiveBridge must not merge multiple
sidecar parts' contents together (which one would "win," and by what
rule, has no principled answer — treating it as malformed input rather
than inventing a merge/precedence policy is the simpler and more honest
choice).

**Discovery:** by scanning MIME parts for one whose **parsed**
Content-Type matches the sidecar media type — not a raw, whole-header
string comparison. Concretely:

- The comparison is on the media type proper (the `type/subtype` pair,
  e.g. `application/vnd.archivebridge.metadata`), parsed out of the
  `Content-Type` header the same way `mhtml/parse.ts` already parses
  `Content-Type` for every other part (splitting off `;`-separated
  parameters before comparing).
- Media type comparison is **case-insensitive**, per MIME's own rule
  that media types and subtypes are case-insensitive (RFC 2045 §5.1) —
  `Application/Vnd.ArchiveBridge.Metadata` matches just as validly as
  the canonical lowercase spelling. This is a real, specified MIME rule,
  not an ArchiveBridge convenience relaxation.
- Parameters (if any are ever present on the sidecar part's
  `Content-Type`, e.g. a future `charset` or version-hinting parameter)
  are parsed and compared separately from the media type itself, the
  same `type`/`params` split `mhtml/parse.ts`'s existing
  `parseContentType` already produces for every part — discovery must
  not depend on the exact byte-for-byte spelling of the full header
  value, parameter order, or whitespace.

This mechanism is the same one the research prototype validated (Chrome
opens and renders files with an added, unreferenced, unknown-`Content-Type`
part identically to the original, with or without a `start` parameter
present). **RFC 2387's `start-info` is not used as the discovery
mechanism.** It was evaluated specifically for this purpose and rejected
as the primary/load-bearing locator:

- Chrome's MHTML loader showed no observable difference across the
  variants actually tested: no `start-info` at all, a well-formed
  Content-ID-shaped value, and a well-formed opaque-string value —
  consistent with Chrome not interpreting `start-info` at all. Malformed
  `start-info` values (unterminated quotes, non-ASCII, extreme length)
  were not tested and are not covered by this conclusion; the claim
  above is scoped to well-formed-vs-absent, not malformed input.
- RFC 2387 documents `start-info` as an opaque, application-specific
  auxiliary string belonging to the **start part's own declared
  content-type**, not as a general-purpose secondary pointer to an
  unrelated part. Using it to reference the metadata part's `Content-ID`
  is syntactically legal and empirically tolerated by Chrome today, but
  is a repurposing beyond the field's documented intent.

`start-info` may be added later as a non-normative, best-effort hint
layered on top of `Content-Type` scanning, but ArchiveBridge must never
depend on it being present or interpreted correctly.

**Malformed sidecar:** if the part identified by discovery fails to parse
as a valid plist, or parses but isn't the expected dictionary shape, that
is a diagnostic — not a hard failure of the surrounding document. The
sidecar's residual metadata is simply unavailable (every field it would
have supplied is treated as absent, exactly as if there were no sidecar
part at all); parsing the rest of the `MhtmlDocument` proceeds normally.
An optional, auxiliary part being broken must never hard-fail an
otherwise-valid archive — this is the same "degrade, don't fail outright"
policy "Diagnostics and partial failure" below applies everywhere else,
applied here specifically.

**Content:** a dictionary keyed by `Content-ID`, holding only the
residual, per-resource fields MHTML cannot represent — never a full
embedded copy of the source WebArchive, and never a duplicate of resource
bytes already carried by an ordinary MHTML part:

```text
{
  ArchiveBridgeSchemaVersion: 1,
  resources: {
    "<content-id-of-some-mhtml-part>": {
      webResourceResponse: <Data>,      // opaque, only if present on the source
      webResourceFrameName: "...",      // frame-root resources only
      resourceExtra: { ... },           // WebArchiveResource.extra for this resource, if non-empty
      documentExtra: { ... },           // WebArchiveDocument.extra, only when this Content-ID
                                         // is a frame-root part (see "WebArchive-native
                                         // representation" above), if non-empty
    },
    ...
  }
}
```

Everything MHTML *can* represent naturally — URL, MIME type, resource
bytes, text encoding, and (via `cid:` linkage) frame relationships —
stays in ordinary MHTML parts and is never duplicated into the sidecar.

**Resource identity:** ArchiveBridge's own serializer assigns a
`Content-ID` to every part it writes (not only the root part, as the
current implementation does), so any resource can be referenced from the
sidecar precisely — see "Content-ID: preservation, generation, and
identity" above for the preservation/generation rules this relies on.
Metadata lookups key by `Content-ID`, not URL — no real capture in the
research corpus produced two different byte payloads under one URL
within a single archive, so this isn't fixing an observed bug, but
`Content-ID` is strictly more precise than URL (a real MIME entity
identity, immune to any future same-URL-different-bytes case) and costs
nothing extra to implement once every part already carries one. Adopted
prophylactically, not because it was proven necessary.

**The sidecar is auxiliary archive metadata, not a saved-page resource.**
At the MIME level it's an `MhtmlPart` like any other, but semantically it
does not represent something the original web page fetched or rendered —
it's ArchiveBridge's own bookkeeping. That distinction has to hold at
every operation that walks a document's resources, not just in prose:

- `validate` — the sidecar is itself a validation target (does it parse
  as the expected plist shape, does its `Content-Type` match), as part of
  validating the document as a whole.
- `inspect` — may present it as archive-level metadata, separate from the
  list of the page's actual resources, rather than listing it as just
  another resource among stylesheets/images/etc.
- `extract` — must not extract the sidecar part as if it were an ordinary
  saved-page resource; a user extracting a page's resources to a
  directory should not find an opaque ArchiveBridge-internal plist file
  mixed in with the page's real assets.
- Frame/resource resolution — the sidecar is never a valid target for a
  `cid:` reference or any other resource lookup a page's HTML might
  perform; it is not part of the page's resource graph.

This does not require a new cross-format IR or a larger type hierarchy to
express. A single small classification check over a part's parsed
Content-Type — conceptually "is this part's media type
`application/vnd.archivebridge.metadata`" — is sufficient for every
operation above to treat the sidecar differently from an ordinary
resource part.

### Semantic losslessness

WebArchive ⇄ MHTML round-tripping targets **semantic losslessness**, not
byte-for-byte identity with the original file. Binary plist key
ordering, serialization internals, and other non-semantic encoding
details are not required to survive a round trip unchanged. What must
survive is the *meaning*:

- resource bytes, URLs, MIME types, text encodings
- frame relationships (via `cid:` linkage, reconstructed correctly on
  each side)
- `WebResourceResponse`, `WebResourceFrameName`
- any unrecognized/future WebArchive plist key, preserved opaquely

### Sources for this section

This section's conclusions were validated by an internal research
corpus (real Chrome/WKWebView captures, WPT cross-checks, and targeted
browser-compatibility experiments) that is not part of this repository's
tracked history and is not referenced by path from here. Where a claim
above depends on that research, it's stated as a conclusion, not sourced
to a scratch file — treat every claim in this section as the settled
position, not as an invitation to re-derive it from raw experiment
output that isn't checked in.

## Diagnostics and partial failure

Real-world archives are frequently malformed in small ways (one bad
resource, a truncated multipart body, an unknown encoding, an
unresolvable frame reference). The design goal is unchanged from before:
a single bad resource should degrade the archive, not fail it outright —
parsing should be able to return 99 good resources and one
`malformed-resource` diagnostic, not throw. This applies equally to
`parseMhtml`, `parseWebArchive`, and the WebArchive ⇄ MHTML converters.

`Diagnostic` is a discriminated union on `type`, e.g.:

- `malformed-archive` — the archive as a whole couldn't be parsed
- `malformed-resource` — one resource within an otherwise-parseable archive
- `unsupported-encoding` — a transfer/character encoding we don't handle
- `unresolved-resource` — a referenced URL/`cid:` has no matching part
- `unsupported-feature` — recognized but intentionally-unhandled input
- `recovered-non-conforming-input` — input violated the spec but a
  reasonable recovery was possible (distinct from `malformed-resource`:
  this is for cases where recovery *did* succeed, logged for visibility)

Using a discriminated union rather than an error code/string means adding
a new diagnostic variant is a compiler-checked exercise: anything that
switches over `Diagnostic["type"]` without a `default` case fails to
type-check until every call site handles the new variant. Problems are
never silently dropped — every code path either produces a `Diagnostic`
or succeeds; there is no "ignore and move on" without a trace.

**Duplicate-identity diagnostics are not finalized as one variant.** The
pre-migration codebase has a single `duplicate-resource-url`, because
its only identity concept was a URL. The Content-ID-based identity model
("Content-ID: preservation, generation, and identity" above) makes
`Content-Location` and `Content-ID` two distinct identities that can each
be duplicated independently and mean different things when they are:

- the same `Content-Location` on two parts (candidate name:
  `duplicate-content-location`) — two parts claiming to be the same
  resource by location/URL, the case the old `duplicate-resource-url`
  covered.
- the same `Content-ID` on two MIME entities (candidate name:
  `duplicate-content-id`) — a violation of RFC 2045/2392's world-unique
  identity requirement, a case the pre-migration codebase had no way to
  detect at all, since it never gave non-root parts a `Content-ID` to
  begin with.

These should not be collapsed into one generic "duplicate identity"
variant, since a consumer switching over `Diagnostic["type"]` needs to
tell them apart (a duplicated `cid:` target is a broken frame reference;
a duplicated `Content-Location` is an ambiguous resource lookup — quite
different failure modes for a caller to react to). A third case in the
same family: more than one MIME part matching the metadata sidecar's
media type in one document (see "Metadata sidecar"'s "Cardinality"
above) is also a duplicate-identity situation, distinct again from the
two above (it's about how many *sidecar* parts exist, not about resource
or frame identity) and is likewise not assigned a final variant name
here. This document does not fix the complete final `Diagnostic` variant
set — that is deferred to the migration itself (see migration-plan.md),
since production source is unchanged this round and the exhaustive-`switch`
pattern means every call site update is compiler-enforced whenever the
set does change.

## Security assumptions

Archive files are untrusted input. Concretely:

- Parsers must never execute JavaScript found in an archive.
- Browsing/inspecting an archive must not make network requests — an
  archive is a static snapshot; if it references an external resource
  ArchiveBridge doesn't have, that's an `unresolved-resource` diagnostic,
  not a fetch.
- Archived HTML must never be executed in an extension's privileged
  origin. A future renderer must run archived content in a sandboxed
  context (e.g. a sandboxed iframe / restricted origin), never in the
  extension's own page.
- Malformed input must not cause infinite loops (e.g. a multipart parser
  must make bounded progress per iteration; a boundary that never
  terminates is a diagnostic, not a hang).
- Allocations must not be sized directly from attacker-controlled length
  fields without a sanity bound — an MHTML header claiming a resource is
  larger than the surrounding file is a malformed archive, not a
  multi-gigabyte `Uint8Array`. The same applies to plist parsing (both
  MHTML's own detection and the metadata sidecar): binary plist parsing
  is delegated to the `plist` package specifically because untrusted
  plist input (offset tables, variable-width integers, object
  references) is not something to hand-roll safely.
- Recursive structures — MHTML's `cid:`-linked frame chains and
  WebArchive's `WebSubframeArchives` nesting alike — must have a depth
  limit while parsing/converting; exceeding it is a diagnostic, not
  unbounded recursion.
- Partial failure must be handled safely: a `malformed-resource`
  diagnostic must not leave the rest of the parsed result in an
  inconsistent state.
- The metadata sidecar is untrusted input like everything else in an
  archive: unrecognized/future keys are preserved opaquely (never
  evaluated, executed, or used to drive control flow), and a malformed
  or absent sidecar degrades to "no residual metadata for this resource,"
  never a hard failure of the surrounding archive.
- Extension-privileged code and archived page content are separate trust
  domains and must be kept separate in the extension's architecture, not
  just by convention in one code path.

## CLI

The CLI (`archivebridge inspect|convert|extract`) parses `process.argv`
directly with a hand-written switch, not a CLI framework/argument-parser
dependency. The command surface is three subcommands with simple
positional arguments — a dependency isn't justified yet.

`inspect`, `convert`, and `extract` are implemented entirely on top of
the library's public API: format detection, `parseMhtml`/`parseWebArchive`
producing their respective format-native representations, the direct
WebArchive ⇄ MHTML converters, and `serializeMhtml`/`serializeWebArchive`.
The CLI itself contains no format-specific inspection/validation/extraction
logic, only argument handling, format dispatch, and human-readable output
formatting.

- `inspect` and `extract` always operate on canonical MHTML — an MHTML
  input is parsed directly; a WebArchive input is parsed and then
  converted to an `MhtmlDocument` first (see "No format-neutral
  `Archive`/`ArchiveView` IR" above). Either way, the CLI walks one
  `MhtmlDocument` shape: its flat part list, deriving and displaying
  frame relationships from `cid:` references. There is no
  WebArchive-shaped code path in the CLI for either command.
- `convert` calls the direct converter for the requested direction (this
  is the one command that legitimately deals with both format-native
  shapes, since converting *is* the boundary between them).
- `extract` writes each MHTML part's bytes to the output directory, using
  its `Content-Location` (or, absent one, its `Content-ID`) — sanitized
  against path-traversal, since these are untrusted-input-derived
  strings — to name the file.

Command dispatch is a `switch` over a `Command` string-literal union with
no `default` case, so adding a fourth subcommand without adding its
`case` is a type error (exhaustiveness checking), the same pattern used
for diagnostics.

## Browser extension: capture and save are separate per-browser concerns

The extension targets **Chrome, Edge, Firefox, and Safari** from the
start as an architecture matter — implementation is free to build one
browser before another, but the design is not allowed to be Chrome-only.
Two responsibilities are kept as distinct browser-adapter concerns,
because they vary independently per browser:

```text
                    Capture                        Save
Chrome / Edge       native MHTML (chrome.pageCapture  browser download path
                    .saveAsMHTML(), confirmed
                    behaviorally equivalent to CDP's
                    Page.captureSnapshot)
Firefox             custom MHTML capture (no native   browser download path
                    MHTML capture API)
Safari              custom MHTML capture               Safari-specific save path
```

- **Capture** produces canonical MHTML bytes from the live page. Chrome
  and Edge get this for free from a native browser API; Firefox and
  Safari need an ArchiveBridge-authored capture implementation (DOM
  walk + serialization), since neither exposes an equivalent native
  MHTML capture API. A from-scratch capture implementation is not
  obligated to reproduce Blink's capture-semantics gaps (see "Format vs.
  capture semantics" above) — it may capture more (or differently) than
  Chrome does, as long as it stays valid MHTML.
- **Save** is how captured bytes reach the user's disk, which differs by
  platform (standard browser download APIs for Chrome/Edge/Firefox;
  Safari has its own save path).

Keeping these separate means a browser that has native capture but needs
a custom save path (or vice versa) doesn't force capture and save logic
to be coupled together per browser.

This document intentionally does not decide a bundler/build-framework
question here (WXT vs. plain `tsc` vs. anything else) — that decision is
separate from this architecture update and stays deferred, as it was
before: the extension currently has zero non-DOM imports (`popup.ts`
only touches the DOM), and wiring it up to actually call
`@xarsh/archivebridge` (which will be needed once capture/save adapters
land) is what triggers re-evaluating a bundling strategy, not this
document. Today's extension remains UI-only: a popup that accepts a file
via drag-and-drop or file picker and lists the selected file name(s),
specifically so it doesn't duplicate logic that belongs in the library.

## TypeScript configuration

- `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
  `erasableSyntaxOnly`, and `verbatimModuleSyntax` are all enabled from
  the start (see root `tsconfig.json`).
- `module/moduleResolution: nodenext` for `packages/archivebridge` and the CLI,
  since that code runs on Node.js. Relative imports use explicit `.ts`
  extensions in source files so Node.js can execute them directly using built-in
  type stripping during development. rewriteRelativeImportExtensions rewrites
  those extensions to `.js` in emitted package output.
- `apps/extension` uses its own `tsconfig.json` (not extending the root
  one) with `module: esnext`/`moduleResolution: bundler` and DOM libs,
  since it targets a browser, not Node — a different module resolution
  story than the library/CLI.
- `erasableSyntaxOnly` means the source never uses `enum`, parameter
  properties, `import =`/`export =`, or namespaces with runtime code —
  anything that isn't just "strip the types and it's valid JavaScript".
  This is what lets `node --test` run `.ts` test files and the CLI's
  source directly via Node's built-in type stripping, with no build step,
  during development.
- Published package output (`packages/archivebridge/dist`) is always
  compiled JS + `.d.ts`, produced by `tsc` — consumers of
  `@xarsh/archivebridge` are never expected to run TypeScript source
  directly, only Node.js/CLI-local code is.

## Testing

Only `node:test` + `node:assert/strict` — no Vitest/Jest/Mocha. Planned
layers, in increasing order of scope:

1. **Unit tests** — parsing, serialization, URL resolution, MIME/charset
   handling, base64/quoted-printable, plist handling, `cid:` frame-root
   derivation, diagnostics.
2. **Golden fixtures** — real Chrome/Safari-generated archives, used for
   regression testing, including at least one real multi-frame MHTML
   capture and one real WebKit-generated `.webarchive` with
   `WebSubframeArchives` (neither exists in `fixtures/` yet — see the
   production migration plan).
3. **Bug regression fixtures** — every reported archive bug gets reduced
   to a minimal fixture under `fixtures/` and a permanent regression test.
4. **Round-trip tests** — MHTML→MHTML (through the MHTML-native
   representation), WebArchive→WebArchive, and direct cross-format
   WebArchive→MHTML→WebArchive / MHTML→WebArchive→MHTML, including at
   least one case with frames and one with a metadata sidecar.
5. **Malformed-input tests** — broken boundaries, invalid base64,
   duplicate identities, bad charsets, malformed/foreign metadata
   sidecar parts, `cid:` references with no matching part.
6. **Browser extension integration tests** — Chrome, Edge, Firefox, and
   Safari, once the extension does more than accept a file.
7. **Real-world compatibility corpus** — periodic snapshots of real sites,
   run as an opt-in smoke test, never a required CI gate (no external
   network access in normal CI).

`fixtures/` is shared across the library, CLI, and extension so the same
sample archives back tests everywhere. See [fixtures/README.md](../fixtures/README.md)
for the fixture policy.
