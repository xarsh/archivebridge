# Architecture

This document records the design decisions behind ArchiveBridge and why
they were made, so future contributors (human or agent) don't have to
reverse-engineer intent from the code. See the root
[CONTRIBUTING.md](../CONTRIBUTING.md) for the practical contribution
rules; this file is the "why" behind them.

It describes the repository as it stands. Where a section discusses an
alternative that was considered and rejected, it does so because the
reasoning still constrains future changes — not as a record of how the
code got here.

## What is implemented today

This document describes the whole architecture, including parts not yet
built. To read it accurately:

**Implemented.** The library (`packages/archivebridge`): MHTML and
WebArchive parsing and serialization, direct WebArchive ⇄ MHTML
conversion, frame flattening/reconstruction, the metadata sidecar,
diagnostics, format detection, and the **archive-viewer reconstruction**
(`renderMhtml`) — plus the `archivebridge inspect` and
`archivebridge convert` CLI subcommands built on top of them. And, in the
**Chrome/Edge extension**: capture and save (the current page saved as
MHTML or WebArchive from a toolbar popup or the page context menu), and
the **local WebArchive viewer** (opening a `file:///….webarchive` renders
it in a sandboxed frame from archived bytes alone).

**Planned.** The extension's **Firefox and Safari** capture/save adapters
and their viewers, and a `validate` command.

Sections below discussing `validate` or non-Chromium browsers are
specifying where that functionality will fit and what invariants it must
respect, not describing code that exists. They are marked where the
distinction could otherwise be missed. The commitment that Chrome, Edge,
Firefox, and Safari are all first-class targets is an architectural
constraint that holds now and binds the implementation whenever it lands.

## Goals

See [README.md](../README.md#what-works-today) for what ArchiveBridge does
and who it's for.

The library (`packages/archivebridge`, published as `@xarsh/archivebridge`)
is the core. The CLI is a thin consumer of it and so is the extension —
nothing archive-format-specific may live outside the library. The
extension's whole archive logic is one browser-neutral module that calls
the library's public API (`core/archive-bytes.ts`); everything else in it
is per-browser platform glue. Everything below this point is the *why*
behind the decisions that follow from those goals.

## MHTML is the canonical format

ArchiveBridge treats **MHTML as its canonical serialized representation** —
the format every capture path converges on, and the format every other
capability is built against directly:

```text
Chrome / Edge   live page --native MHTML capture-->  MHTML
Firefox         live page --custom MHTML capture-->  MHTML   (planned)
Safari          live page --custom MHTML capture-->  MHTML   (planned)

MHTML --inspect
MHTML --convert--> WebArchive
WebArchive --convert--> MHTML
MHTML --save                     (browser extension: Chrome/Edge)
MHTML --validate                                             (planned)
MHTML --view                                                 (planned)
```

This choice rests on a corpus of real Chrome-generated MHTML captures
(structural corpus, WPT cross-checks, a metadata-part Chrome-compatibility
matrix, a plist round-trip test, and real WKWebView `WebSubframeArchives`
output) — see "Sources for this section" below. That corpus is not part of
this repository; only the conclusions drawn from it are recorded here.

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
  full resource-cache dump. Concretely, Chrome-native capture reflects
  DOM mutations already applied before capture, and it *does* capture
  `@font-face`-referenced font files, `blob:` URLs backed by an
  in-memory `Blob`, same-origin and cross-origin subframes, and attached
  shadow roots. It does **not** capture: live form control state
  (`value`/`checked`/`selected` set via JS), `<canvas>` pixel content,
  `adoptedStyleSheets`/constructed stylesheets, or `<link rel=preload>`
  resources never inserted into the DOM (the markup reference survives;
  the bytes do not). It also **drops `srcset` outright**: a responsive
  `<img>` comes back with neither `srcset` nor `src`, so the element
  survives as a permanently broken image (measured on Chromium 153). A
  reader must therefore not treat "no `srcset` in the archive" as evidence
  the page had none, and the viewer's `srcset` handling is exercised
  against hand-built archives — which is also what a Safari-produced
  `.webarchive` looks like, since WebKit does keep it.
- **Blink serializes an attached shadow root as a `<template>` carrying
  the legacy pre-standard attribute `shadowmode="open"`, not the
  standardized `shadowrootmode`.** No current browser hydrates
  `shadowmode`, so shadow content in a Chrome-captured archive is inert
  markup until something rewrites the attribute. Any ArchiveBridge viewer
  that wants native declarative Shadow DOM hydration must normalize
  `shadowmode` to `shadowrootmode` itself, and any fidelity claim this
  project makes about "declarative Shadow DOM" has to name the attribute
  Blink actually writes rather than the one the standard defines.

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

There is deliberately **no format-neutral canonical IR** in ArchiveBridge:
no format-independent `Archive`/`Resource` object model that both MHTML and
WebArchive parse into and both serializers consume. This is the most
tempting shape for a format-interoperability library, so the reasons it is
rejected are worth stating plainly:

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

Parsing does produce a **format-native structured result**, which is a
different thing from a cross-format IR and is entirely intended:
`parseMhtml` produces an MHTML-native structure, `parseWebArchive` a
WebArchive-native one. The distinction that matters is:

> A **format-native parsed representation** is fine, even necessary. An
> **ArchiveBridge-invented cross-format canonical representation** is not.

`inspect` operates on canonical MHTML — always — and `validate` will do the
same when it lands. There is no separate WebArchive-native
inspection/validation path; a WebArchive input converts to canonical MHTML
first, and one implementation handles it from there on:

```text
MHTML
  └─ parse → inspect / validate

WebArchive
  └─ parse
      ↓
    convert
      ↓
    canonical MHTML
      ↓
    inspect / validate
```

`parseWebArchive` producing a `WebArchiveDocument` is necessary — it's the
required first step before conversion can run at all — but that parsed
representation is an intermediate value on the way to canonical MHTML, not
a second, parallel target that `inspect`/`validate` also operate on
directly. This is what keeps format-specific inspection logic from
existing twice.

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
	 *  reference) is what reports a diagnostic if that operation can't
	 *  proceed without one. */
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

**Why an index rather than a separate `rootPart` field.** Splitting the
root part out into its own field would lose the root's physical position
among the other parts whenever `start` names a part that isn't first — and
real MHTML makes no guarantee that it is. Keeping one flat,
order-preserving `parts` array plus an index is a lossless, direct
reflection of the underlying multipart structure; a `rootPart` accessor
derives trivially from it (`document.parts[document.rootPartIndex]`)
without the stored shape having to make that split.

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

**Root resolution is a chain of hints, and every hint is optional.**
`rootPartIndex` is resolved in the priority order RFC 2387's `start`,
then Blink's `Snapshot-Content-Location`, then "the first successfully
parsed part". A hint that *names something not in the document* is
non-conforming input, not a fatal condition: it is reported as
`recovered-non-conforming-input` and resolution falls through to the next
strategy. This matters most for `Snapshot-Content-Location`, which is a
Blink compatibility mechanism ArchiveBridge reads but never writes — a
stale one must not fail an archive whose first part is perfectly usable.
The only genuinely unresolvable case is having no parts to point at.

### Resource bytes and multipart framing

`MhtmlPart.data` holds the MIME entity body's bytes as the file carried
them. Structural parsing (headers, boundary delimiters) may be
line-oriented, but a body is **never** reconstructed by re-joining lines
with a canonical terminator: doing that rewrites a body's original CRLFs
as LFs, which corrupts a `7bit`/`8bit`/`binary` resource at the byte
level and silently changes what a quoted-printable part's *hard* line
breaks decode to. The implementation therefore keeps each line's offsets
into the original buffer and takes a body as one raw span of the source
(`mhtml/parse.ts`). This is not a whole-file text decode — headers and
base64/quoted-printable bodies are ASCII by construction and are the only
spans ever converted to strings.

Which bytes belong to the body is settled by RFC 2046, not convenience:
the CRLF immediately preceding a boundary delimiter line is part of the
**delimiter**, so it is excluded — but every other line ending inside the
body, including a genuine trailing blank line, is part of the resource
and is kept. For quoted-printable, a soft line break is `=` followed by
whatever terminator the input actually used (CRLF, or a bare LF for
non-conforming input this reader still tolerates); base64 continues to
ignore the whitespace RFC 2045 §6.8 permits around line wrapping.

**Missing delimiters split by severity.** A declared boundary that never
appears as an *opening* delimiter means RFC 2046's `multipart-body`
grammar was never entered: there is no MIME entity to parse, so parsing
yields `malformed-archive` and no document, rather than manufacturing one
empty default `text/plain` part and reporting a valid-looking one-part
archive. A missing *closing* `--boundary--` is different: the parts
already collected are real, so they are kept, the document is returned if
a root can be resolved, and the truncation is reported as
`recovered-non-conforming-input` — never treated as fully conforming.

### WebArchive-native representation

Unlike MHTML, a real `.webarchive` plist **is** naturally a recursive
tree (`WebSubframeArchives` is an array of full nested WebArchive
dictionaries, confirmed at multiple nesting depths and both same- and
cross-origin siblings against real WKWebView output), and the
WebArchive-native model mirrors that recursion directly.

This is not in tension with the previous section. What that section
rejects is a recursive shape *shared with MHTML*, which isn't recursive at
all; a format-native structure is allowed — expected — to look like its
own format. Recursion here is fidelity to WebArchive, not a cross-format
abstraction leaking in.

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
	 *  the fields above, preserved opaquely and unparsed. */
	readonly extra: ReadonlyMap<string, PlistValue>
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
	readonly extra: ReadonlyMap<string, PlistValue>
}
```

**`extra` is typed to the plist value domain, not to `unknown`.** Both
`WebArchiveResource.extra` and `WebArchiveDocument.extra` are
`ReadonlyMap<string, PlistValue>`, where `PlistValue` is the `plist`
package's own recursive value type (string, number, boolean, `Date`,
`Uint8Array`, array, nested dictionary, null). That is deliberately
narrower than `unknown`: these fields exist to *preserve plist-shaped data
ArchiveBridge doesn't interpret*, and typing them to the plist domain
states exactly that, while guaranteeing at the type level that whatever
went into `extra` can be written back out as a plist. They are not a
general-purpose bag for arbitrary runtime values.

**`extra` holds unknown keys only, and that is enforced, not just
documented.** The plist keys the typed fields already own
(`WebResourceURL`, `WebResourceMIMEType`, `WebResourceData`,
`WebResourceTextEncodingName`, `WebResourceResponse`,
`WebResourceFrameName` on a resource; `WebMainResource`,
`WebSubresources`, `WebSubframeArchives` on a document) are **reserved**:
one of them appearing inside `extra` is a contradiction — one dictionary
key with two competing sources of truth — and there is no correct way to
resolve it. Letting `extra` win means an `extra` entry can displace
`resource.url`; letting the typed field win means silently discarding
metadata the archive (or a metadata sidecar) claimed would be preserved.
So a collision is *reported*, not resolved: the serializer rejects such a
model outright. The reserved sets live in one place (`model/webarchive.ts`)
and are used by everything that must agree on them — the parser subtracts
them when collecting `extra`, the serializer rejects them, and the
metadata sidecar rejects a sidecar-supplied `resourceExtra`/`documentExtra`
claiming one before it can become a `WebArchiveDocument` at all. That
last point is the load-bearing one: a foreign sidecar is untrusted input
that flows MHTML → WebArchive, so without it a reserved key would be
reachable from an archive file rather than only from a hand-constructed
model.

**Optional fields distinguish "absent" from "present and wrong."**
Absence of `WebResourceTextEncodingName`/`WebResourceFrameName`/
`WebResourceResponse`, or of `WebSubresources`/`WebSubframeArchives`, is
normal and silent. A key that is *present with the wrong plist type* is a
diagnostic (`malformed-resource` for a resource field,
`malformed-archive` for a whole malformed collection) and is then treated
as absent. Reading a wrong-typed value as `undefined` with no diagnostic
would make a real type error indistinguishable from the field simply not
being there — but it is also not worth failing an otherwise-usable
resource or document over one optional field, so this diagnoses and
recovers rather than dropping anything.

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
`multipart/related` documents.

This is worth stating explicitly because RFC 2557 describes a nested
structure, and reading the RFC alone would lead a contributor to expect
one. No real Chrome output uses it. ArchiveBridge models what producers
actually emit.

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
  `cid:<child's-content-id>` in the emitted HTML. The rewriting is done
  with **`parse5`**, used only to locate
  the exact source-string offset of each `<iframe>` element's `src`
  attribute (via `sourceCodeLocationInfo`), never to re-serialize the
  document — the parsed tree is discarded immediately after location
  lookup, and only the located attribute span is spliced, so every other
  byte of the HTML (encoding quirks, formatting, unrelated markup)
  survives untouched. This beat a hand-rolled tokenizer on the criteria
  that mattered: `parse5` implements the real HTML5 tokenizer/tree-
  construction algorithm, so it finds tag/attribute boundaries exactly as
  a real browser would — confirmed against an unquoted attribute value, a
  single-quoted value, a duplicate `src` attribute (per spec, only the
  first is honored, the same one a browser uses — closing off a
  smuggling vector a naive scanner could miss), `IFRAME`/`SRC` case
  variation, a fake `<iframe>` inside an HTML comment or a `<script>`
  raw-text element (correctly ignored — RAWTEXT/comment tokenizer states
  handled for real), a `>` inside a quoted attribute value, and a
  malformed/unterminated quote (degrades to no match rather than a hang
  or a corrupt rewrite). The dependency cost is one small package with a
  single transitive dependency (`entities`), justified the same way
  `plist` is in CONTRIBUTING.md's dependency policy: untrusted HTML input
  is exactly the case where a battle-tested implementation beats a
  hand-rolled one. See `packages/archivebridge/src/mhtml/html-rewrite.ts`.
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
- **Duplicates are a diagnostic on read and a hard failure on write.**
  Two MIME entities claiming the same `Content-ID` within one document is
  malformed input; the *parser* reports it (see "Diagnostics and partial
  failure" below for how this is distinguished from a duplicated
  `Content-Location`) and keeps both parts, because `MhtmlDocument.parts`
  is a lossless reflection of the input. The *serializer* refuses to emit
  such a document at all. Reader tolerance must not become writer
  non-conformance: there is no way to write an ambiguous `Content-ID`
  conformingly, and "repairing" it by regenerating one side would
  silently break whichever existing `cid:` reference meant the part that
  lost — in HTML the serializer does not rewrite. Generated IDs are
  likewise checked against every existing and previously generated ID, so
  generation can never introduce a collision either.
- **The metadata sidecar keys by the normalized `Content-ID`** (see
  "Metadata sidecar" below) — the same identifier form `MhtmlPart.contentId`
  stores, not the header's angle-bracket spelling.

### Writing MIME headers: representability, not an allowlist

An `MhtmlDocument` can originate from a format with no header-syntax
restrictions at all (a WebArchive plist string), so the serializer has to
decide what it will write. The boundary it draws is **representability**,
checked per field, not a narrow allowlist of the shapes ArchiveBridge
itself generates:

- **CR/LF is rejected everywhere.** This is the header-injection case
  (see "Security assumptions"), not merely a conformance one.
- **Other control characters and non-ASCII are rejected everywhere**,
  because RFC 5322/2045 header field values are US-ASCII and carrying
  anything else conformingly needs RFC 2047/2231 encoded words or
  extended parameters. ArchiveBridge implements none of those, and
  emitting the bytes raw would produce a document it claims is conforming
  and isn't. The practical cost is that a non-ASCII IRI in a source
  WebArchive is rejected rather than emitted non-conformingly;
  percent-encoding it instead would be a semantic change the serializer
  is not entitled to make on its own.
- **`mimeType` must be a real `token "/" token`** (RFC 2045 §5.1). That
  one rule makes the value valid both as the `Content-Type` field's own
  value and, quoted, as the top-level `type` parameter — closing off any
  value crafted to break out of `type="..."` and forge a `boundary`.
  Correspondingly, the *parser* recovers a syntactically invalid
  `Content-Type` to RFC 2045 §5.2's recommended default, so *this
  particular* rule is one tolerant reading can never trip. That is a
  property of the media-type rule alone, not a general guarantee — see
  "Parse success does not imply serialize success" below.

  That default is applied as a whole: **`text/plain; charset=us-ascii`,
  charset included**, and a `charset` parameter parsed out of the invalid
  field is discarded rather than carried over. §5.1's grammar is
  `type "/" subtype *(";" parameter)`, so the parameters belong to the
  same production as the media type — once `type "/" subtype` fails to
  parse, there is no valid `Content-Type` field for those parameters to be
  parameters *of*, and honoring one would mean trusting half of a field
  already judged invalid. A *valid* media type that simply omits `charset`
  is a different case and keeps `textEncoding` absent, because for
  `text/html` that absence is what tells a consumer to fall back to the
  document's own `<meta charset>`.
- **`Content-ID` is checked for representability, not grammar.** The
  full RFC 5322 `msg-id`/`addr-spec` grammar is deliberately *not*
  validated: implementing it properly is disproportionate, and an
  incomplete "looks like foo@bar" approximation would reject valid
  preserved IDs (a quoted-string local part, say) for no safety gain.
  What is rejected is an angle bracket inside the value, which would make
  the `<...>` wrapper ArchiveBridge adds on write and strips on read
  ambiguous.
- **Parameter values are always emitted as MIME quoted-strings**, with
  `"` and `\` escaped as quoted-pairs — one form for every parameter,
  valid anywhere a bare token is. The reader unescapes exactly that, and
  its `;`-splitting is quoted-pair-aware so an escaped quote cannot end a
  parameter early. Reader and writer share one module (`mhtml/mime-header.ts`)
  specifically so the two halves cannot drift apart. RFC 2231/RFC 5987
  parameter continuations and extended values, and RFC 2047 encoded
  words, are intentionally unsupported rather than half-supported.

#### Parse success does not imply serialize success

ArchiveBridge is a tolerant reader and a standards-oriented writer, and
those two policies do not meet in the middle: **a document `parseMhtml`
accepts is not guaranteed to be one `serializeMhtml` can write.** The
parser's job is to reflect what the input actually said, including values
a conforming writer has no way to emit; the writer's job is to emit only
what it can represent conformingly. Where those disagree, the writer
refuses rather than silently repairing — repair would be a semantic
change it is not entitled to make (see the non-ASCII bullet above).

The concrete case: a part carrying a raw non-ASCII `Content-Location`
(say `https://example.invalid/café/日本.html`, which real producers do
emit) parses cleanly, with *no* diagnostic — the URL is not malformed,
it simply isn't ASCII. `serializeMhtml` then rejects it, because writing
it would need RFC 2047/2231 encoding ArchiveBridge does not implement. A
`Content-ID` containing an angle bracket behaves the same way.

The invalid-media-type recovery above narrows this gap by one rule, but
does not close it, and no attempt is made to close it in general: doing
so would mean either weakening the writer into emitting non-conforming
MIME, or hardening the reader into rejecting archives it can perfectly
well describe. Both are worse than the honest failure.

The consequence is a requirement on everything layered above: **callers
must treat serializer rejection as a normal, reachable outcome of real
input, not an internal invariant violation.** The CLI's `convert` does
this — parse, convert, and serialize all run inside one `try`, and a
throw becomes an ordinary error message and a non-zero exit rather than
an unhandled stack trace.

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
is a diagnostic — not a hard failure of the surrounding document. This
"expected shape" check applies recursively to each entry of the `resources`
dictionary too, not just the top-level `ArchiveBridgeSchemaVersion`/
`resources` keys: an entry that isn't itself a dictionary, or that has one
of `webResourceResponse`/`webResourceFrameName`/`resourceExtra`/
`documentExtra` present with the wrong plist value type, invalidates the
*entire* sidecar (whole-sidecar rejection), not just that one entry —
silently accepting the entries that happen to look right while discarding
only the malformed one would let a partially-broken, ArchiveBridge-owned
metadata part masquerade as a fully-valid one, which is worse than treating
it as absent. A sidecar whose `resourceExtra`/`documentExtra` claims a
*reserved* WebArchive key is malformed for the same reason and rejected
the same way — see "`extra` holds unknown keys only" above; catching it
at this boundary is what keeps a foreign sidecar from producing a
`WebArchiveDocument` that only fails later, at serialization. Either way,
the sidecar's residual metadata is simply
unavailable (every field it would have supplied is treated as absent,
exactly as if there were no sidecar part at all); parsing the rest of the
`MhtmlDocument` proceeds normally.
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
`Content-ID` to every part it writes — not just the root — so any resource
can be referenced from the sidecar precisely. See "Content-ID:
preservation, generation, and identity" above for the
preservation/generation rules this relies on.
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

- `inspect` — presents it as archive-level metadata, separate from the
  list of the page's actual resources, rather than listing it as just
  another resource among stylesheets/images/etc.
- Frame/resource resolution — the sidecar is never a valid target for a
  `cid:` reference or any other resource lookup a page's HTML might
  perform; it is not part of the page's resource graph. `mhtml/sidecar.ts`
  exposes every sidecar-shaped part index (valid, malformed, or duplicate)
  precisely so `mhtml/frames.ts` can exclude all of them from ordinary
  resource/frame grouping.
- `validate` (planned) — the sidecar is itself a validation target (does
  it parse as the expected plist shape, does its `Content-Type` match), as
  part of validating the document as a whole.

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

**One key is excepted, and the exception is a limit of the plist layer,
not a policy choice.** A dictionary key literally named `__proto__` never
reaches ArchiveBridge as a key at all: JavaScript prototype semantics
consume it inside the `plist` package while the dictionary is being built
(see "Security assumptions"), so by the time there is an object to read
there is nothing left to preserve. Such a dictionary is therefore treated
as malformed rather than accepted-and-partially-preserved, and
ArchiveBridge does not claim to round-trip that key. Nothing else about
unknown-key preservation changes: every ordinary unrecognized key is
preserved exactly as described above. Should a future `plist` expose
`__proto__` as a real own key, the existing narrowing carries it through
into `extra` with no further change.

### Sources for this section

This section's conclusions rest on an internal research corpus (real
Chrome/WKWebView captures, WPT cross-checks, and targeted
browser-compatibility experiments) that is not part of this repository and
is not referenced by path from here. Where a claim above depends on that
research, it is stated as a conclusion rather than sourced to a file you
cannot open.

For a contributor cloning this repository, the practical consequence is:
treat these claims as the settled position. The evidence for them lives in
the golden fixtures under [`fixtures/`](../fixtures/) — real Chrome and
WebKit output covering frames at multiple depths, same- and cross-origin
siblings, and large binary resources — which is what the test suite
actually asserts against. If you need to challenge a claim here, do it
with a fixture, not by trying to recover the original corpus.

## Diagnostics and partial failure

Real-world archives are frequently malformed in small ways (one bad
resource, a truncated multipart body, an unknown encoding, an
unresolvable frame reference). The rule is that a single bad resource
degrades the archive rather than failing it outright: parsing returns 99
good resources and one `malformed-resource` diagnostic instead of
throwing. This applies equally to `parseMhtml`, `parseWebArchive`, and the
WebArchive ⇄ MHTML converters.

`Diagnostic` is a discriminated union on `type`:

- `malformed-archive` — the archive as a whole couldn't be parsed
- `malformed-resource` — one resource within an otherwise-parseable archive
- `unsupported-encoding` — a transfer/character encoding we don't handle
- `unresolved-resource` — a referenced URL/`cid:` has no matching part
- `duplicate-content-location` — two parts/resources claim the same
  Content-Location/`WebResourceURL` — an ambiguous resource lookup
- `duplicate-content-id` — two MIME entities claim the same Content-ID, a
  violation of RFC 2045/2392's world-uniqueness requirement — a broken
  frame reference, distinct from a duplicated `Content-Location` (a
  consumer switching over `Diagnostic["type"]` needs to be able to tell
  these apart, which is why they're two variants and not one generic
  "duplicate identity")
- `duplicate-metadata-sidecar` — more than one MIME part matches the
  metadata sidecar's media type in one document (see "Metadata sidecar"'s
  "Cardinality" above) — a third, distinct duplicate-identity case, about
  how many sidecar parts exist rather than resource or frame identity
- `malformed-metadata-sidecar` — the sidecar part exists but failed to
  parse as a plist, or parsed to an unexpected shape; its residual
  metadata is treated as absent, the surrounding document still parses
- `frame-depth-exceeded` — a recursive frame structure (`WebSubframeArchives`
  nesting, or an MHTML `cid:` chain) exceeded the recursion bound (see
  "Security assumptions" below)
- `cyclic-frame-reference` — a `cid:` chain looped back to one of its own
  ancestors (including a part directly referencing its own Content-ID, `A ->
  A`), a distinct, non-truncated-length case from `frame-depth-exceeded`
- `unconsumed-child-frame` — a WebArchive `subframeArchives` entry had no
  matching `<iframe>`/`<frame>` `src` reference anywhere in its parent's
  HTML; the opposite mismatch from `unresolved-resource` (a reference with
  no matching resource, rather than a resource with no referencing
  reference) — the child's resource data is still emitted, not dropped
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

## Security assumptions

Archive files are untrusted input. Concretely:

- Parsers must never execute JavaScript found in an archive.
- Browsing/inspecting an archive must not make network requests — an
  archive is a static snapshot; if it references an external resource
  ArchiveBridge doesn't have, that's an `unresolved-resource` diagnostic,
  not a fetch.
- Archived HTML must never be executed in an extension's privileged
  origin. The viewer renders archived content in a sandboxed iframe with
  no `allow-scripts`, never in the extension's own page, and rewrites
  every statically identifiable reference before the browser sees it —
  CSP is the mandatory backstop for the one class of reference whose
  meaning is synthesized only by browser runtime semantics — see "Archive
  viewer" below for the full contract.
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
- **Only a dictionary's own keys are data.** Delegating plist parsing
  does not mean trusting the *shape* of what comes back. A plist
  dictionary key literally named `__proto__` is not an ordinary key in
  JavaScript: assigning it — which `plist`'s binary backend does while
  building each dictionary — replaces that dictionary object's prototype
  instead. Ordinary property access would then read required fields
  (`WebResourceURL`, `WebMainResource`, the sidecar's schema version)
  straight out of an attacker-supplied object, so a crafted archive could
  report fabricated resources as perfectly valid. Every parsed plist
  dictionary is therefore narrowed at one boundary
  (`packages/archivebridge/src/plist-dict.ts`) before any field is read:
  a specialized prototype is *reported* as malformed under the existing
  diagnostic/recovery policy rather than silently normalized away, and an
  accepted dictionary is copied onto a null-prototype object so field
  access has nothing to inherit through. This is not `Object.prototype`
  pollution — nothing outside the one dictionary is affected — but a
  parser reporting fabricated fields as valid is an integrity failure
  regardless. The rule generalizes past this one dependency: **untrusted
  parser output is narrowed before it is read, never read as-is.**
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

The CLI ships two subcommands, `archivebridge inspect` and
`archivebridge convert`, plus `-h`/`--help` and `--version`. It parses
`process.argv` directly with a hand-written switch rather than taking a
CLI framework/argument-parser dependency: the command surface is two
subcommands with simple positional arguments, which does not justify one.

`extract` was considered and deliberately dropped from scope: this is a
pre-1.0 project, and the durable command surface is kept intentionally
small (read/write, convert, inspect, and — for the browser extension —
capture), not grown to cover every operation a future user might want.

`validate` is **planned, not implemented**: it appears in this document
because the rules it must follow (operate on canonical MHTML, treat the
metadata sidecar as a validation target) are already settled by the
surrounding design, and because `Command`'s exhaustiveness checking means
adding it is a compiler-guided exercise rather than an open question.

`inspect` and `convert` are implemented entirely on top of the library's
public API: format detection, `parseMhtml`/`parseWebArchive` producing
their respective format-native representations, the direct WebArchive ⇄
MHTML converters, and `serializeMhtml`/`serializeWebArchive`. The CLI
itself contains no format-specific inspection/validation logic, only
argument handling, format dispatch, and human-readable output formatting.

- `inspect` always operates on canonical MHTML — an MHTML input is parsed
  directly; a WebArchive input is parsed and then converted to an
  `MhtmlDocument` first (see "No format-neutral `Archive`/`ArchiveView` IR"
  above). Either way, the CLI walks one `MhtmlDocument` shape: its flat
  part list, deriving and displaying frame relationships from `cid:`
  references. There is no WebArchive-shaped code path in the CLI for
  `inspect`.
- `convert` calls the direct converter for the requested direction (this
  is the one command that legitimately deals with both format-native
  shapes, since converting *is* the boundary between them).

Command dispatch is a `switch` over a `Command` string-literal union with
no `default` case, so adding a third subcommand without adding its `case`
is a type error (exhaustiveness checking), the same pattern used for
diagnostics.

## Browser extension: capture and save are separate per-browser concerns

> **Status: Chrome/Edge implemented; Firefox and Safari planned.** The
> Chrome extension saves the current page as MHTML or WebArchive, and
> opens local `.webarchive` files in a viewer of its own — see "Archive
> viewer" below.

### What the browser already does, and what is left for ArchiveBridge

Every design decision here follows from one fact: **no browser exposes any
extension hook into its native Save As format selector.** There is no API
in Chrome, Edge, Firefox or Safari that registers a file format with the
save dialog or participates in the page-save pipeline. Chromium *has* a
MIME-handler extension point (`mime_types` + `mimeHandlerPrivate`, which
is how the built-in PDF viewer works), but it is restricted to
component/allowlisted extensions and offers only `application/pdf` to
public handlers; `file_handlers` is ChromeOS-only. Blink's MHTML
serializer and WebKit's `createWebArchiveData()` are likewise internal.

So the ideal UX — MHTML and WebArchive appearing as extra entries in the
browser's own Save As dialog — is not achievable anywhere, and **taking
over `Cmd-S` is out of scope**: an extension *can* bind it as a `commands`
shortcut, but that replaces the browser's Save Page behavior rather than
extending it, which is a worse product than leaving it alone.

What the browsers already do natively, and where the gaps are:

| | MHTML in native Save As | WebArchive in native Save As | Native MHTML capture API |
| --- | --- | --- | --- |
| Chrome / Edge | **yes** ("Webpage, Single File") | no | **yes** (`chrome.pageCapture.saveAsMHTML()`) |
| Firefox | no | no | no |
| Safari | no | **yes** ("Web Archive") | no |

ArchiveBridge's job in the save direction is therefore exactly the
complement: **WebArchive on Chrome/Edge, both formats on Firefox, and
MHTML on Safari.** That is also why v0.1 offers both commands on Chrome
even though MHTML is already reachable from `Cmd-S` there — the two
commands are the same code path apart from one conversion step, and
offering only one of them would be a stranger UI than offering both.

### Capture and save vary independently

```text
                    Capture                            Save
Chrome / Edge       native MHTML                       downloads API +
                    (chrome.pageCapture.saveAsMHTML(), offscreen document
                    confirmed behaviorally equivalent
                    to CDP's Page.captureSnapshot)
Firefox             custom MHTML capture               downloads API
                    (no native MHTML capture API)      (blob URL directly
                                                       from the background)
Safari              custom MHTML capture               native messaging to
                                                       the containing app
                                                       (no downloads API)
```

- **Capture** produces canonical MHTML bytes from the live page. Chrome
  and Edge get this for free from a native browser API; Firefox and
  Safari need an ArchiveBridge-authored capture implementation (DOM
  walk + serialization), since neither exposes an equivalent native
  MHTML capture API. A from-scratch capture implementation is not
  obligated to reproduce Blink's capture-semantics gaps (see "Format vs.
  capture semantics" above) — it may capture more (or differently) than
  Chrome does, as long as it stays valid MHTML. A Firefox content script
  can in fact read live form state, `<canvas>` pixels and cross-origin
  stylesheet text, all of which Blink's capture drops.
- **Save** is how captured bytes reach the user's disk, which differs by
  platform: Chrome/Edge and Firefox both have `downloads`, but only
  Firefox's background context can mint a blob URL; Safari has no
  `downloads` API at all, so its save path has to go through the macOS
  app that a Safari Web Extension must ship inside anyway.

Keeping these separate means a browser that has native capture but needs
a custom save path (or vice versa) doesn't force capture and save logic
to be coupled together per browser.

### The Chrome v0.1 pipeline

```text
popup button ─┐
              ├─> runSaveCommand(format, tabId)      background service worker
context menu ─┘        │
                       ├─ captureMhtml(tabId)        chrome/capture.ts
                       │     chrome.pageCapture.saveAsMHTML()
                       ├─ archiveBytesFrom(bytes, f) core/archive-bytes.ts
                       │     MHTML:      pass through byte for byte
                       │     WebArchive: parseMhtml -> convertMhtmlToWebArchive
                       │                 -> serializeWebArchive
                       └─ saveBytes(...)             chrome/save.ts
                             offscreen document -> blob: URL
                             chrome.downloads.download({ saveAs: true })
```

Only the two ends are Chrome-specific. `core/` has no `chrome.*` and no
DOM at all, which is what lets the whole byte-generation half be asserted
directly on real captured bytes with no browser involved — and what makes
adding Firefox a matter of swapping the two adapters rather than writing a
second pipeline.

**The save path's permissions are `pageCapture`, `downloads`, `offscreen`,
`contextMenus`, and deliberately nothing else** (the viewer adds
`declarativeNetRequest` and `file:///*` — see "Archive viewer" below, and
note that neither is used by, or of any use to, the save path). In
particular:

- **No web-origin host permission, ever.** Native capture of an ordinary
  `http(s)` tab needs none, which is verified in the E2E suite at both
  build time (the built manifest) and runtime
  (`chrome.permissions.getAll().origins` contains `file:///*` and nothing
  matching `http`).
- **No `tabs`/`activeTab`.** `chrome.tabs.query` returns a tab's `id`
  without any permission; `url` and `title` are the gated fields. The
  download file name is derived from the *archive's own* main-resource
  URL instead of from tab metadata — see `core/file-name.ts`. That keeps
  the permission set minimal and keeps naming browser-neutral.
- **No `notifications`.** Failures surface through the popup's status
  line and, for the context-menu path (which has no popup), the toolbar
  badge and its tooltip. Neither needs a permission.

The UI is two commands — **Save as MHTML…** and **Save as WebArchive…** —
in the toolbar popup and in the page context menu, both routed through the
same `runSaveCommand`. There is no settings screen and no
archive-conversion UI in the browser: conversion is the CLI's job, and the
browser surface stays small on purpose.

### Why the MV3 save path needs an offscreen document

The Chrome save path looks convoluted and is forced by two measured
platform facts that point in opposite directions:

- `URL.createObjectURL` is **undefined in an MV3 service worker**, which
  is where `chrome.pageCapture.saveAsMHTML()` has to run.
- `chrome.downloads` is **undefined inside an offscreen document**, which
  is the only extension context that has `createObjectURL`.

Neither context can do the whole job, so the bytes cross from the worker
to an offscreen document and come back as a `blob:` URL string, which the
worker hands to `chrome.downloads.download`.

**How the bytes cross matters, because the obvious mechanism does not
work.** `chrome.runtime.sendMessage` serializes as JSON: a `Blob` and an
`ArrayBuffer` both arrive as `{}`, and a `Uint8Array` arrives as an object
with one numeric key per byte. Three mechanisms that do work were compared
on a real 12.9 MB `pageCapture` result:

| mechanism | service worker -> offscreen | leaves state behind |
| --- | --- | --- |
| `BroadcastChannel` | 1 ms | no |
| Cache Storage | 9 ms | yes, until deleted |
| IndexedDB | 12 ms | yes, until deleted |

`BroadcastChannel` is chosen: it is a structured-clone message channel
between same-origin extension contexts, so the `Blob` crosses by
reference, and — unlike the two storage APIs — there is nothing that can
outlive a failed save. A crash between "write bytes" and "delete bytes"
would leak archive content into the profile on disk; there is no such
window here. Cache Storage and IndexedDB remain the fallbacks if a future
requirement genuinely needs a handoff that survives service-worker
termination.

**A save can outlive the service worker, and the design has to assume it
will.** Chrome's documented lifecycle terminates an extension service
worker after 30 seconds of inactivity, and after 5 minutes on any single
request; the APIs that are documented to survive longer are the four
user-prompt ones (`desktopCapture.chooseDesktopMedia`,
`identity.launchWebAuthFlow`, `management.uninstall`,
`permissions.request`), and `downloads.download` is not among them.
Measured against the real native chooser in a headed Chrome for Testing
153:

- the initiating worker *is* kept alive while the chooser is open, well
  past the 30-second idle timeout — but it is terminated at ~6 minutes
  with the chooser still up;
- the offscreen document, its `blob:` URL and the `in_progress`
  `DownloadItem` all survive that termination, and the download still
  completes when the user finally picks a file;
- the popup's pending `sendMessage` does not: it rejects with "the message
  channel closed before a response was received", so a save that succeeds
  is reported to the user as a failure.

So the save path is built around the one piece of state the browser keeps
across worker restarts: the `DownloadItem`. Its `url` is the `blob:` URL
the offscreen document minted, which begins with this extension's own
origin, so a restarted worker can recognise its predecessor's save with no
bookkeeping of its own — no IndexedDB, no Cache Storage, no new permission.
Two consequences:

- **The completion handler is registered at global scope**
  (`downloads.onChanged` in `background.ts`), which is what lets Chrome
  start a worker to deliver it. A listener added inside the save path
  cannot: measured, once the worker that registered one dynamically was
  gone, download activity started no new worker, so nothing released the
  bytes and nothing reported the outcome.
- **Cleanup is conditional rather than blind.** A worker start no longer
  assumes a surviving offscreen document is stale; it frees the bytes only
  when no download of this extension's is still `in_progress` and no save
  is running in this worker. Command serialization cannot make that safe,
  because it lives in the memory of the worker that died.

One measured platform fact is worth recording because the code's shape
suggests otherwise: **Chrome reads a `blob:` URL eagerly, before the
chooser is answered.** A 200 MB blob download reported
`bytesReceived === totalBytes` within 250 ms of `download()` returning,
with the chooser still open, and closing the offscreen document at that
point still produced a byte-complete file. Releasing the bytes mid-chooser
is therefore not observably fatal today; the conditional release is kept
because it costs one `downloads.search` call, does not depend on
undocumented staging timing, and covers the window between minting a URL
and Chrome reading it, where no `DownloadItem` exists to speak for the
bytes.

Post-terminal cleanup is best-effort, on the same footing as
`showOutcome`: it releases memory after a save has already succeeded or
failed, so a failure to close the offscreen document must not become — or
mask — the save's outcome.

There is also a registration race worth knowing about, since it is the
kind of thing that reads as correct: taking the download id first and
*then* starting to listen leaves a gap in which the download can reach a
terminal state and no further `onChanged` will ever arrive, hanging the
save until Chrome kills the worker. Measured at 3 of 180 multi-megabyte
blob downloads. The save path closes it by reading the item's current
state after it starts listening, which is enough — no polling.

**Measured ceiling.** The handoff itself is not the limit: a
`BroadcastChannel` mint succeeded at 805 MB in under a millisecond. The
limit is `chrome.downloads` reading a blob URL — a download of real
captured bytes completed at 470 MB and failed with `NETWORK_FAILED` at
503 MB. Anything a page capture realistically produces is far below that.

**No top-level `await` anywhere in the service worker's module graph.** A
service worker script that uses one fails to register at all, and the
failure mode is an extension that silently never starts.

### Building the extension: esbuild, not a framework

`apps/extension` imports `@xarsh/archivebridge`, so `tsc` alone is not
enough — the library and its dependency graph have to be bundled into each
of the four extension contexts (service worker, offscreen document, popup,
archive viewer), none of which can resolve a bare npm specifier.

**esbuild does exactly that and nothing more**, driven by a single
`build.mjs` that bundles the four entry points and copies
`manifest.json`, `popup.html`, `offscreen.html` and `viewer.html`. A
WebExtension framework (WXT and similar) was considered and rejected: it
would additionally own the manifest, a dev server, per-browser output
variants and an HTML pipeline, none of which this extension has a use for
— one hand-written manifest, four entry points, three static HTML files. That is
a lot of machinery to adopt in exchange for a file copy, and it would put
a framework's conventions between this project and the extension platform
whose exact behavior (see the MV3 notes above) it depends on knowing.
Using esbuild's JS API rather than its CLI has the incidental benefit of
not needing the `esbuild` package's postinstall step, so `npm ci` requires
no install-script allowance.

**The library bundles for the browser, with one caveat.** Nothing in
`packages/archivebridge`'s public API imports `node:` anything, and
`plist` ships a `browser` export condition that drops `@xmldom/xmldom` and
`xmlbuilder` in favor of the platform's own `DOMParser`. The one gap is
`iconv-lite`, which is written against Node's `Buffer` and
`string_decoder`; the extension therefore depends on the `buffer` and
`string_decoder` polyfill packages, which esbuild resolves like any other
dependency. Stubbing `iconv-lite` out instead was rejected: it would
silently change what the library does with a non-UTF-8 resource, which is
exactly the class of silent-charset bug `mhtml/text-codec.ts` exists to
prevent. The charset tables dominate the bundle (~400 kB of ~700 kB), and
that is an acceptable price for the library behaving identically in both
runtimes. Because each context is its own bundle (`splitting: false` —
they load independently and share no module instance), the service worker
and the viewer each carry their own copy; that is a one-time install cost
for an extension, not a per-page download, and sharing a chunk between an
MV3 service worker and a document is not something esbuild's code
splitting can express anyway.

This also sharpens CONTRIBUTING.md's boundary rule. "Nothing in the public
API assumes Node" holds in the sense that matters — no `node:` imports, no
`process`, no filesystem — but "runs in a browser" currently means "runs
in a browser with a `Buffer` polyfill". Revisit when `iconv-lite` is
revisited.

### Per-browser manifests

`manifest.json` is a **Chrome MV3 manifest**, and only that: `pageCapture`
and `offscreen` do not exist in Firefox, so this manifest could not load
there even with a `browser_specific_settings.gecko` block (the placeholder
scaffold carried one, because Firefox needs an explicit ID to load an
unsigned extension in development; it has been removed as misleading).
Firefox and Safari will each get their own manifest when their capture and
save adapters land — a per-browser manifest is a normal shape for a
cross-browser extension and does not narrow the four-browser commitment.

## Archive viewer

> **Status: implemented for Chrome/Edge, for `.webarchive` only.** Chrome
> renders `.mht`/`.mhtml` natively and ArchiveBridge deliberately does not
> pre-empt it. Firefox and Safari viewers are planned; the reconstruction
> half is already browser-neutral and waiting for them.

The extension's second responsibility is to *view* local archives the
browser cannot display itself. The native situation is complementary:
Chrome/Edge render MHTML from `file://` natively but download
`.webarchive`; Safari renders `.webarchive` natively but does nothing at
all with `.mhtml` (a blank tab — consistent with LaunchServices, where
Safari claims `com.apple.webarchive` but not `org.ietf.mhtml`); Firefox
shows MHTML as plain text and downloads `.webarchive`. So on Chrome the
gap is exactly one format, and that is exactly what the viewer fills.

### The viewer must reconstruct, not delegate

The tempting shape is to hand the archive to the browser and let it
render:

```html
<iframe src="archive.mhtml">      <!-- does not work -->
<iframe src="archive.webarchive"> <!-- does not work -->
```

Neither makes an unsupporting browser parse the format, and an
unsupported archive MIME type does not become supported by being inside
an iframe. Chrome renders MHTML *only* from `file://`: served over HTTP as
`multipart/related` or `application/x-mimearchive`, or navigated to as a
`blob:chrome-extension://` URL with any of the three archive MIME types,
it is downloaded rather than rendered — while the same blob labelled
`text/html` renders fine, which proves the blob itself was navigable and
the MIME type was the deciding factor. There is no way for the viewer to
delegate to Chrome's own MHTML renderer.

So the viewer reconstructs the document from ArchiveBridge's own parse:

```text
local .webarchive bytes
  -> parseWebArchive
  -> convertWebArchiveToMhtml            (canonical MHTML, as everything else uses)
  -> index parts by Content-Location / Content-ID
  -> rewrite every reference in every live document and stylesheet
     to a viewer-owned resource URL
  -> render the reconstructed root document in a sandboxed iframe
```

This is the same *shape* as PDF.js at the loader/viewer boundary — the
extension owns parsing and resource resolution — but only there.
**ArchiveBridge does not build a rendering engine**: layout, CSS and text
remain the browser's own HTML/CSS engine's job. The viewer's output is
HTML the browser lays out, not pixels ArchiveBridge draws.

Note what this does *not* change: the pipeline is
`WebArchive -> canonical MHTML -> one common viewer`, the same
canonical-format rule the rest of the project follows. It is not a
cross-format `Archive`/`ArchiveView` IR, and adding one is not on the
table (see "No format-neutral `Archive`/`ArchiveView` IR" above). A
`.webarchive` that turns out to contain MHTML is handled by the same path,
because format detection runs on the bytes and only the parse step
differs.

### Where the viewer lives, and why the expensive half is in the library

```text
packages/archivebridge/src/view/     browser-neutral
  resources.ts    reference -> archive part, or nothing (never the network)
  css-rewrite.ts  url() and @import inside a stylesheet
  html-sites.ts   parse5 offsets for every attribute and <style> body
  render.ts       the policy: what each reference becomes, and the frame graph

apps/extension/src/core/             browser-neutral
  viewer-source.ts  what the viewer was asked to open, and refusals
  viewer-policy.ts  the sandbox attribute and the CSP, with their reasons

apps/extension/src/chrome/           Chrome-specific
  file-interception.ts  declarativeNetRequest: file:// -> viewer
  local-archive.ts      reading the bytes, and the file-access diagnosis

apps/extension/src/viewer/           Chrome-specific glue
  viewer.ts             DOM, object URLs, their lifetime, the minimal chrome
```

`renderMhtml` takes a canonical `MhtmlDocument` and one injected function,
`createResourceUrl(bytes, mimeType) -> string`. That single seam is the
only platform-dependent thing in the whole reconstruction: in a browser it
is `URL.createObjectURL` wrapped in whatever owns the URL's lifetime, and
in a test it is a deterministic stand-in, which is what makes the entire
rewrite path assertable byte for byte with no browser at all.

Putting it in the library rather than in the extension keeps both of
CONTRIBUTING.md's boundary rules intact at once. The library gains no DOM
or WebExtension dependency (it has none — the seam is a callback). And the
extension does not reimplement archive parsing or reference resolution,
nor take a `parse5` dependency of its own to do HTML rewriting — which it
would otherwise need, since attribute-offset rewriting on untrusted HTML
is precisely the job `mhtml/html-rewrite.ts` already justifies a real HTML
parser for. It is also what makes the later Firefox and Safari viewers a
different *loader* around the same core rather than a second
implementation: what changes per browser is where the bytes come from,
how a resource URL is minted, and whether a local-file navigation can be
intercepted at all.

### Isolation: a blob-backed document in a sandboxed frame

Two decisions here are forced by measured platform behavior rather than
chosen for taste (all measured on Chromium 153).

**`sandbox="allow-same-origin"`, and no other token.** A sandboxed
document with an opaque origin *cannot load a `blob:` URL* minted by the
extension — Chromium refuses with "Not allowed to load local resource".
Without `allow-same-origin`, every archived image, stylesheet, font and
nested frame would have to be inlined as a `data:` URL instead: a 33%
base64 inflation of every byte of a multi-megabyte capture, embedded in
document text, with no way to release it afterwards and an exponential
blow-up for a resource referenced from several nesting levels of frame.

What makes that trade sound is the absence of `allow-scripts`. Nothing in
the archive can execute, so nothing can act on the origin the frame has;
inline handlers, `javascript:` URLs, `<script>` bodies and `meta refresh`
are all inert as a result (each measured), on top of being rewritten away.
The notorious `allow-scripts allow-same-origin` pair — which lets a frame
remove its own sandbox — therefore cannot arise. Sandbox flags are
inherited by nested browsing contexts and can only be narrowed, so an
archived `<iframe sandbox="allow-scripts">` gains nothing either. Also
absent, deliberately: `allow-forms`, `allow-top-navigation`(`-by-user-
activation`), `allow-popups`, `allow-modals`, `allow-downloads`,
`allow-pointer-lock`, `allow-presentation`,
`allow-popups-to-escape-sandbox`.

**The residual fact, stated plainly:** because the frame is same-origin
with the extension, a `chrome.runtime` object *exists* in its global.
There is no code that can ever reach it — that is what "no
`allow-scripts`" means, and the E2E suite asserts the archive's own script
elements are present and none of them ran — but the honest description of
this design is "unreachable", not "absent". Removing it would mean the
`data:` URL model above, and that trade was judged the wrong one.

**A blob-backed document rather than `srcdoc`.** Both work identically for
rendering (measured, with `allow-same-origin`). Blob URLs win on the
recursive case: a nested archived frame is just another URL, so a frame
tree of any depth is built with no escaping at all, whereas `srcdoc` would
require embedding each descendant document inside its ancestor's attribute
value and getting depth-N HTML escaping right — exactly the kind of string
surgery this codebase avoids. One registry then owns every URL the load
created, documents and resources alike, which is what makes the lifetime
model below a single rule instead of two.

### The security contract, as rules

The browser provides no format-specific protection for a reconstructed
document, so whatever isolation the viewer has, it imposes itself. The
rewrite is the primary mechanism and the CSP is the backstop — in that
order, because some escapes are governed by no CSP fetch directive at all
(`<link rel=preconnect>` and `rel=dns-prefetch` open a connection without
ever making a request). With one measured exception, stated next, where
that order is reversed.

**The invariant, stated so that it is true.** *Every statically
identifiable browser-loadable external reference is neutralized by
`renderMhtml`. CSP is the mandatory backstop for loads whose URL-bearing
meaning emerges only from browser runtime semantics — currently, CSS
custom-property substitution.* That class is rule 1's exception and is
spelled out there. A stronger claim — that removal by `renderMhtml` alone
covers every browser-loadable reference, full stop — was measured to be
false: implementing it would mean evaluating the CSS cascade inside the
rewriter, which the renderer deliberately does not do.

1. **Every reference a browser would load, and that the archive's text
   identifies as a reference, is rewritten.** A reference that resolves to
   an archive part becomes a viewer-owned URL; everything else becomes
   `about:invalid`, a URL guaranteed never to resolve.

   The exception is exact and worth stating in full, because it is the only
   place where the CSP is load-bearing rather than redundant. A bare
   `<string>` inside `image-set()` is a URL (CSS Images 4), and a CSS
   custom property can carry that string in from anywhere in the cascade:
   `:root{--x:"https://…"}` plus `#a{background-image:image-set(var(--x)
   1x)}` loads the URL (measured, Chromium 153 — and likewise through
   `-webkit-image-set`, `mask-image`, `cursor`, `border-image-source`, an
   `@property` `initial-value`, a `@layer`, and a `style=` attribute that
   defines the property on one element for a rule in another sheet to
   consume). Written *in the same declaration* — `image-set(var(--x,
   "https://…") 1x)`, and the same through `env()` and `if()` — the string
   is right there in the text and the scanner neutralizes it. Carried by
   the cascade, it is not a reference in any stylesheet's text at all:
   deciding whether `--x` is a URL means resolving custom-property
   substitution across every sheet, inline style and `@property` initial
   value that could define it. A static rewriter that approximated this by
   rewriting every string that *might* be one would corrupt font names,
   `content` strings and `syntax` descriptors — so the renderer does not
   pretend, and `img-src blob: data:` refuses the load instead. The E2E
   suite asserts both halves against a fixture built for it: the URL is
   still visible in the rendered stylesheet, Chromium really computed it
   into an image URL, every one of them produced a named `img-src`
   violation, and the beacon server recorded zero requests and zero
   connections.
2. **No external network fallback.** A reference the archive cannot
   satisfy is a warning in the viewer's notes list, never a fetch.
3. **Archive-internal resources only**, identified by the archive's own
   recorded URLs (`Content-Location`) and `Content-ID`s. There is
   deliberately no filename or suffix matching fallback: guessing which
   part an unmatched reference "meant" would make the resource graph
   depend on heuristics rather than on what was captured.
4. **Script references are never resolved, even when the archive contains
   the bytes.** `<script src>` and SVG `<script href>` are neutralized
   outright, so an archived script is not merely blocked from running —
   it is never loaded.
5. **Inline event handlers are renamed out of the handler namespace**
   (`onerror` becomes `data-archivebridge-onerror`), and `javascript:`,
   `file:`, `ws:` and extension-origin schemes are rejected before lookup.
   Archived script cannot run even in a context where scripting was
   somehow enabled.
6. **Plugin content and network hints are neutralized**: `<object data>`,
   `<embed src>`, and every `<link rel>` that is a hint rather than a
   resource (`preload`, `prefetch`, `modulepreload`, `preconnect`,
   `dns-prefetch`, `manifest`).
7. **Links stay non-navigable.** An `<a href>` that leaves the document
   becomes `href="#"` with the original preserved in
   `data-archivebridge-href`; an in-page anchor is left exactly alone.
   Making archived links live is a product decision with privacy
   consequences (it can leak that an archive was opened), not a default.
   Form actions, `ping`, `cite` and `longdesc` are neutralized outright.
8. **`<base href>`, `<meta http-equiv=refresh>` and an archived
   `Content-Security-Policy` meta do not survive.** The base URL is an
   *input* to resolution and would only send unrewritten references off
   the archive; a refresh is a navigation to a URL that no longer exists;
   an archived CSP names origins that no longer exist and can only stop
   the viewer's own resource URLs from loading, never make anything safer.
9. **Foreign markup never enters the extension page's DOM.** The viewer
   receives a URL and assigns it to an iframe. It never parses archived
   HTML into, or reads it out of, its own document.
10. **Recursion stays bounded** by the parser's existing `MAX_FRAME_DEPTH`
    and the existing `frame-depth-exceeded`/`cyclic-frame-reference`
    diagnostics — and, for stylesheets, by `MAX_STYLESHEET_IMPORT_DEPTH`.
    The two are separate constants on purpose: frame depth is a property of
    the archive formats and is read by the parser and converter, while an
    `@import` chain exists only inside stylesheet text and is reached only
    by the viewer. Memoization already cuts a *cycle* and makes a diamond
    graph linear, but an acyclic chain through thousands of distinct CSS
    parts recurses once per link and overflowed the stack at roughly 2000
    (measured) — cheap to put in a hostile archive of a few hundred KB.
11. **Nothing can put a reference back after the rewrite.** SVG's
    declarative animation elements (`<set>`, `<animate>`, …) need no
    scripting, so a sandbox without `allow-scripts` does not stop them, and
    they can assign a fresh URL to an attribute the rewrite already
    neutralized. Measured in Chromium 153 inside
    `sandbox="allow-same-origin"`: `<set attributeName="href" to="https://…">`
    on an `<image>`, the same via `<animate values=… fill="freeze">`, the
    same targeting another element by `href="#id"`, the same on
    `<feImage>`, and the same timed off a click (`begin="target.click"`) all
    restored the URL and fetched it. Their operative attributes
    (`attributeName`, `to`, `from`, `by`, `values`) are therefore renamed
    away: animation fidelity is worth less to an archive reader than the
    guarantee that a rendered archive cannot acquire a live reference after
    the fact. Making the mechanism inert is enough, so there is no SVG
    sanitizer.
13. **A reference whose target the browser would parse as more content is
    refused, not resolved.** Three constructs look like resources and are
    really documents:

    - **SVG `<use>` naming another document.** Chromium does not read bytes
      from the target — it parses it as an SVG document and clones the
      referenced subtree into *this* document, where the target's own
      references load. Measured in Chromium 153: an `<image href="https://…">`
      inside the referenced `<symbol>`, a `fill="url(https://…)"` beside it,
      and a further `<use href="https://…">` one level deeper all fetched;
      inside the viewer the same construct reached for the network from an
      archived SVG's bytes, and only the CSP stopped it. Every *other*
      external SVG reference was measured not to instantiate anything —
      `<image>`, a CSS `background-image`, `fill`/`stroke` naming a pattern
      or gradient, `filter`, `mask`, `clip-path`, `marker-*`, `<feImage>`,
      `<textPath>`, `<mpath>`, `<tref>`, and `<pattern href>`/`<linearGradient
      href>`/`<filter href>` template inheritance all fetched the file and
      loaded nothing from inside it. So the exposure is `<use>` alone, and a
      one-element refusal closes it; a `<use href="#id">` naming this
      document keeps working, because the markup it clones has already been
      rewritten. The alternative — recursively rewriting SVG parts and
      minting sanitized copies — would buy back an archived sprite sheet's
      icons, and costs parsing XML with an HTML parser, where a hostile
      `<b>` forces foreign-content breakout and can hide an attribute from
      the rewrite that Chromium's XML parser still loads. That trade is
      available later and is not one to make while closing a hole.
    - **A `data:` stylesheet**, as `<link rel=stylesheet href="data:text/css,…">`
      or `@import "data:text/css,…"`. The bytes travel with the URL; the
      references *inside* them do not. Measured: such a sheet loads its own
      `@import` and `url()` to any origin, and nests a further `data:` sheet
      inside itself.
    - **A `data:` frame** (`<iframe src="data:text/html,…">`), which is a
      document whose markup the rewrite never saw: measured to load its
      images, run its script and nest another `data:` frame.

    A `data:` *image*, font or media reference is kept exactly as written,
    because it genuinely cannot reach anything — a `data:image/svg+xml` in
    an `<img>` or a CSS `url()` is in the image-loading path's secure static
    mode and loaded no external reference of its own (measured). Refusing
    the three above costs no fidelity that the viewer had: under
    `style-src`/`frame-src` neither a `data:` stylesheet nor a `data:` frame
    rendered at all, so this moves them from "silently blocked by the
    backstop" to "refused by the rewrite, with a warning".
14. **CSS values in attribute form are rewritten too.** Not just `style=`:
    SVG's presentation attributes are CSS declarations, and measured in
    Chromium 153 exactly `fill`, `stroke`, `filter`, `mask`, `clip-path`,
    `marker-start`, `marker-mid` and `marker-end` fetch a `url()` written as
    an attribute — with no stylesheet, no `style=` and no script anywhere.
    They go through the same CSS scanner as a `style=` attribute, so
    `fill="url(#gradient) red"` keeps both its same-document reference and
    its fallback paint. (`mask-image`, `cursor`, `color`, `stop-color`,
    `background-image` and the `marker` shorthand fetched nothing in that
    position and are deliberately absent, like the measured `background`
    list above.)
12. **A rewrite that cannot be applied fails the document closed.** HTML
    tree construction merges the attributes of a *second* `<html>`/`<body>`
    start tag onto the element the first one created, and `parse5` records
    no source location for a merged attribute — so
    `…<body><p>x</p><body background="https://…">` leaves a live external
    reference with no span to splice (measured: `parse5` reports it
    unlocatable, and Chromium loads it). Warning and shipping the document
    would leave exactly the URL the rewrite exists to remove, so the
    document is refused instead and the reader is told why. The trigger is
    narrow by construction — it fires only when the renderer *wanted* to
    change a site, not on malformed markup in general.

The CSP behind all that (`core/viewer-policy.ts`, and the manifest's
`content_security_policy.extension_pages`, which a `blob:` document
inherits from the extension page that created it — measured):

```text
default-src 'none'; script-src 'self'; style-src 'unsafe-inline';
img-src blob: data:; font-src blob: data:; media-src blob: data:;
frame-src blob:; object-src 'none'; connect-src file:;
form-action 'none'; base-uri 'none'
```

**Why there is one CSP and not two.** A second, stricter policy injected
into each archive document — `script-src 'none'` and friends in a
`<meta http-equiv>` — was measured and adds nothing. With the frame
sandboxed and `allow-scripts` absent, Chromium refuses script at the
browsing-context level ("Blocked script execution … because the document's
frame is sandboxed and the 'allow-scripts' permission is not set"), which
is strictly stronger than any `script-src` value; an injected
`script-src 'none'` produced an identical result, including for a
`<script src="chrome-extension://…/viewer.js">` that the inherited
`script-src 'self'` would otherwise admit — so that residual is confirmed
unreachable rather than merely assumed to be. An injected
`default-src 'none'`, meanwhile, *broke* the archive's own presentation
(inline styles refused). And injecting any meta CSP would need the renderer
to **insert** markup rather than splice located spans — a new capability
with no reliable insertion point in a malformed document — plus a second
copy of policy intent that can drift from `core/viewer-policy.ts`. So the
model stays: one extension-wide CSP, inherited.

`style-src 'unsafe-inline'` is the one concession, and it is unavoidable:
an archived page's `<style>` blocks and `style=` attributes are the
substance of how it looks, and content that arrives at runtime cannot be
hashed or nonced. Note what is *not* there: no `'self'` in any resource
directive, so archived markup cannot even name the extension's own files;
no network scheme anywhere; `frame-src blob:` covers a frame navigating
*itself*, which is the one navigation the sandbox flags do not; and
`base-uri 'none'` blocks an archived `<base>` a second time, after the
rewrite already removed it.

Two measured facts set the stakes for all of this. Chrome's *native* MHTML
rendering is strikingly inert — a deliberately hostile archive rendered
from `file://` ran no scripts and made zero external requests, while a
plain-HTML twin in the same directory ran its scripts and fired all five
of its beacons. Safari's *native* WebArchive rendering is the opposite: the
same hostile archive executed its scripts and reached the network. So a
naive extension viewer would be *less* safe than what Chrome already does
for `.mhtml` (a good reason not to pre-empt it), and real-world
`.webarchive` files must be expected to contain live script and external
references, because the format's own native renderer runs them.

### Resource resolution and CSS

Resolution is deliberately small. A reference value plus the base URL of
the document or stylesheet it appeared in resolves, in order, to: a
same-document fragment (left alone), a `cid:` reference (through the
Content-ID index — how canonical MHTML links frames and how Chromium names
inline content), a `data:` URL (kept verbatim at a site that loads *bytes*
— an image, a font, a media file — and refused at one that parses a
*document*: a stylesheet, an `@import`, a frame; see rule 13 above), an
archived part by URL, or nothing. HTML sites are
found with `parse5` source offsets, the same technique and the same
reasoning as `mhtml/html-rewrite.ts`, so only located spans are spliced and
every other byte survives. Two parsing choices there are load-bearing:
`scriptingEnabled: false`, because the rendered document has scripting
disabled and the browser will therefore parse `<noscript>` content as live
markup that must be rewritten; and descending into declarative shadow roots
(both spellings) but not into ordinary inert `<template>` content, which no
script will ever activate.

**A resolved archive-part reference keeps no fragment.** The minted URL
names a whole part, so `fill="url(paint.svg#gradient)"` or
`<linearGradient href="filters.svg#f">` resolve and render, but as the
referenced part's default view rather than the named element — the same
loss already noted for `<use href="sprite.svg#icon">` in rule 13 above,
generalized to every cross-part reference that carries a fragment. The fix
belongs with recursive/safe SVG resource reconstruction, not a URL-
concatenation change, for the same XML-vs-HTML-parser reasoning as the
`<use>` refusal, and is not made here.

**CSS gets a bounded scanner, not a parser.** `view/css-rewrite.ts` is a
three-state scanner — comments, strings, url tokens — over CSS Syntax
Level 3's tokenizer rules, handling quoted and unquoted `url()` values,
CSS escapes, `@import` in both string and `url()` form, and unterminated
tokens (which degrade to no rewrite rather than to a corrupt one).

**Keyword matching is not enough, and that is the one place this was
originally wrong.** CSS identifiers and at-keywords may be spelled with
escapes, and every keyword comparison in the spec is made against the
token's *decoded value* (§4.3.4 checks a consumed ident sequence against
`url`; an at-rule's name is the at-keyword token's value). Measured in
Chromium 153, all of `u\72l(…)`, `\75rl(…)`, `\75 rl(…)`,
`\75\72\6c(…)`, `\55RL(…)`, `@\69mport "…"` and
`@\49\4d\50\4f\52\54 "…"` load — and a scanner comparing raw source
bytes sees none of them. The scanner therefore consumes a whole ident
sequence, decoding escapes with the same `readEscape` the url-token reader
uses, and compares the decoded value; reading the whole identifier is also
what makes a tail match (`myurl(`, `my\75rl(`) impossible without a
lookbehind. Two related measurements shaped the same code: a bare
`<string>` argument of `image-set()`/`-webkit-image-set()` is a URL that
loads with no `url()` around it, so a string is treated as a reference when
the innermost enclosing frame is one of those functions; and `url (x)` and
`url/**/(x)` fetch *nothing*, because a function token needs its `(`
immediately — so the scanner no longer rewrites them either, which it used
to.

**Substitution functions are transparent, the cascade is not.** A string
written inside `var()`, `env()` or `if()` ends up wherever that function
sits, so `image-set(var(--x, "u.png") 1x)` loads `u.png` (measured,
Chromium 153, as do the `env()` and `if()` spellings). The scanner
therefore looks past those three frames when deciding whether a string is a
URL — one small rule, and no evaluation: the string is right there in the
text. Everything else keeps its own frame, which is what leaves
`image-set(url(x.png) type("image/png"))`, `font-family: var(--f, "Some
Font")` and an `if()` condition's `style(--c: "…")` alone. The *other*
direction — a string that only becomes a URL once the cascade substitutes
it — is out of reach by construction and is rule 1's documented exception,
where the CSP is the mandatory mechanism. A real
CSS parser (`postcss`, `css-tree`, `lightningcss`) would be a new runtime
dependency an order of magnitude larger than the problem. That is the
opposite conclusion from HTML, and the difference is not arbitrary: HTML
tokenization has tree-construction feedback (RAWTEXT, foster parenting,
`<template>` content, namespace adjustment) where "which text is markup"
genuinely depends on the parse, while a `url(` inside a CSS comment or
string is unreachable from three flat scanner states. Replacement values
are always written as a double-quoted url token with `\`, `"`, newlines
**and `<`/`>`** escaped, so an archive-controlled value can close neither
the token nor — via `</style>` — the enclosing element.

### Frames

Frame relationships are the ones ArchiveBridge already reconstructs:
`convertWebArchiveToMhtml` rewrites each parent's `<iframe src>` to
`cid:<child-content-id>`, and the viewer resolves exactly that link. No
second frame model is introduced.

Each archived HTML part is reconstructed **at most once** and memoized by
part index, which bounds the total work at the number of HTML parts and
makes a diamond frame graph linear rather than exponential. A frame
reached while it is already being reconstructed higher up its own chain is
cut with `cyclic-frame-reference`; a chain longer than `MAX_FRAME_DEPTH`
is cut with `frame-depth-exceeded`; either way the frame's `src` becomes
`about:invalid` and the reader gets a note. An `<iframe srcdoc>` is
rewritten recursively in place, because its content is live markup whose
references would otherwise ship exactly as captured.

### Shadow DOM normalization

Blink writes an attached shadow root as `<template shadowmode="open">` (or
`"closed"`), with `shadowdelegatesfocus` for a delegating root — the
legacy pre-standard spelling, which no browser hydrates (all measured
against a real `chrome.pageCapture` result). The viewer rewrites
`shadowmode` to `shadowrootmode` and `shadowdelegatesfocus` to
`shadowrootdelegatesfocus`, and only there: the rewrite is driven by HTML
structure (a `<template>` element located by the parser), never by text
matching on the attribute name, and it does not touch a template that
already declares the standard attribute. A mode is never invented — a
captured closed root stays closed, and a `shadowmode` value that is
neither `open` nor `closed` is left alone. This is a *deliberate widening*
of what renders, which is why it belongs to the viewer's policy rather
than to the parser.

### Viewer resource lifetime

Every URL minted for one archive load belongs to one registry, and a
registry is released as a unit. There is no global map of archive bytes
and nothing that outlives the tab.

- **Replacing the archive releases the previous one's URLs.** Opening
  another archive in an open viewer tab changes only the fragment, so the
  document is *not* torn down and the viewer must do this itself — it is
  also why the viewer listens for `hashchange` at all, without which the
  tab would keep showing the first archive.
- **The new document is in place before the old URLs go.** There is no
  moment in which the tab shows a document whose resources have already
  been revoked.
- **A failed load releases only what it created.** The render runs into a
  fresh registry; if it throws or produces no document, that registry is
  released and the archive already on screen is left alone.
- **`pagehide` releases the current registry.** Belt and braces — a
  document's object URLs die with the document — but it makes the
  ownership explicit rather than implicit. It deliberately does *not*
  consult `PageTransitionEvent.persisted`, because a viewer page is never
  back/forward-cached: asked directly via CDP
  `Page.backForwardCacheNotUsed`, Chromium 153 gives two structural
  reasons why `chrome-extension://viewer.html` is ineligible —
  `SchemeNotHTTPOrHTTPS` and `EmbedderExtensionFrame` — and the same for
  the archive's `blob:` child frame. Measured end to end: opening an
  archive, navigating away and pressing Back yields a *fresh* viewer
  document that re-reads the file and re-renders correctly. So `pagehide`
  here only ever means real teardown, and a `persisted === true` branch
  would guard a state the platform will not create.

### Chrome: intercepting a local `.webarchive`

Chrome will not render a `.webarchive`: the navigation never commits,
`downloads.onCreated` fires with `mime=application/x-webarchive`, and the
tab is destroyed. The one hook that runs *before* that download decision
is `declarativeNetRequest`, which — unlike `webRequest` on Firefox — does
see `file://` main-frame navigations and can redirect them. That single
fact is what makes the viewer reachable from a double-click with no native
companion.

The rule redirects `^file:///.*\.webarchive$` (case-insensitive,
`main_frame` only) to `viewer.html#<the original URL>`. Four details are
measured rather than assumed:

- **It has to be a dynamic rule.** `regexSubstitution` must name the
  viewer with an absolute URL, and an unpacked extension's own origin is
  not knowable until it is installed, so the substitution is built from
  `chrome.runtime.getURL()` at startup. A static `rule_resources` entry
  with a relative substitution is accepted and then never matches.
- **`host_permissions: ["file:///*"]` is required.** A `redirect` action
  needs host permission for the request URL; without it the rule installs,
  reports no error, and the navigation downloads as before. The same
  permission is what lets the viewer `fetch()` the bytes.
- **The source travels in the fragment, not a query parameter.** Chromium
  percent-encodes `#`, `?`, `%` and space in a `file:` URL but leaves `&`,
  `=` and `+` literal, so `?src=file:///a&b.webarchive` would silently
  truncate. A fragment has no sub-delimiters.
- **`main_frame` only, and no redirect loop.** A `.webarchive` framed or
  referenced by a page is left alone — turning that into a viewer would
  let a web page host archived content inside itself. The redirect target
  is a `chrome-extension://` URL, which cannot match `^file:///`, and the
  viewer reads the archive with `fetch` rather than a navigation.

The viewer does not trust what the redirect hands it. `core/viewer-source.ts`
requires the fragment to parse as a URL, to be `file:` with no host, and to
name a `.webarchive`; anything else is refused by name rather than
repaired.

The viewer page is **not** a web-accessible resource, and the reason is
more specific than "extensions should not expose pages". Chrome documents
that a DNR rule cannot redirect *a public resource request* to a
non-accessible resource, and that *a navigation from a web origin* to an
extension resource is blocked unless it is listed; the navigation this rule
redirects is neither. Chromium's navigation throttle
(`extensions/browser/extension_navigation_throttle.cc`) returns `PROCEED`
before any accessibility check when a navigation has no initiator origin —
the documented case for "a user directly triggers navigation (e.g. using
the omnibox, or the bookmark bar)", which is exactly a double-click on a
`.webarchive`. So this is documented behavior, not a loophole.

Measured against Chromium 153, unpacked: a browser-initiated
`file:///….webarchive` navigation reaches the viewer and renders; a web
page can neither navigate to `viewer.html`, nor frame it, nor navigate to
a `file://` archive. The known limit is that a *click on a link in another
local file* carries a `file://` initiator origin, so it is not
browser-initiated and Chrome refuses it with an error page. Declaring
`web_accessible_resources: [{ resources: ["viewer.html"], matches:
["file:///*"] }]` was measured to fix precisely that case while leaving all
three web-origin attempts refused — so the usual worry that any
web-accessible declaration lets arbitrary pages frame the viewer is not
true for an origin-scoped `matches` list. It is left undeclared anyway,
because the double-click flow does not need it and not declaring it is the
smaller surface. Whether a packed/store install behaves identically was not
verified: the throttle path does not consult install location, but
`--load-extension` cannot test a CRX install.

`redirect.extensionPath` would avoid needing the runtime extension ID and
cannot do this job: substitution is a `regexSubstitution` feature only, so
an `extensionPath` of `/viewer.html#\0` is accepted and lands with the
`\0` **literal** (measured). A static ruleset is therefore not an option
while the archive's location travels in the URL.

**The user must enable file URL access, and the extension says so.**
Chrome's per-extension "Allow access to file URLs" toggle defaults to off,
and without it neither the redirect nor the read can happen. When it is
off, the popup shows one line naming the toggle, and a viewer that cannot
read its archive distinguishes "not allowed to read local files" from
"could not read this one" via `chrome.extension.isAllowedFileSchemeAccess()`.
There is no settings screen: nothing in the extension can change that
toggle, because only the user can.

### Viewer UI

One thin bar naming the archive and summarizing what was reconstructed, a
collapsible notes list that appears only when there is something to say,
and the archive filling the rest of the tab. On failure, a title and a
sentence in place of the frame — plus, for the file-access case only, the
one Chrome-specific instruction that fixes it. There is no archive
library, no history, no conversion button, no settings and no inspector:
conversion is the CLI's job, and the successful state should feel close to
simply opening a saved page.

### Per-browser viewer reach, for later

- **Chrome/Edge:** done, as described above.
- **Firefox:** viewing is possible, automatic interception is not. Neither
  `webRequest` nor `declarativeNetRequest` sees `file://` navigations, so
  a double-click cannot be turned into an ArchiveBridge viewer; the
  realistic flow is an extra click from the plain-text page a content
  script *can* run on. Everything downstream of "here are the bytes" —
  `renderMhtml`, the resource graph, the rewrite, the sandbox and CSP
  constants — is reused unchanged.
- **Safari:** not reachable from the extension at all — `file://` is
  unsupported for Safari Web Extensions, so reading local archives needs
  the containing app and native messaging. Safari also renders
  `.webarchive` natively, so its gap is `.mhtml`, and the same
  reconstruction serves it (canonical MHTML is what `renderMhtml` already
  consumes).

## TypeScript configuration

- `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
  `erasableSyntaxOnly`, and `verbatimModuleSyntax` are all enabled from
  the start (see root `tsconfig.json`).
- `module/moduleResolution: nodenext` for `packages/archivebridge` and the CLI,
  since that code runs on Node.js. Relative imports use explicit `.ts`
  extensions in source files so Node.js can execute them directly using built-in
  type stripping during development. rewriteRelativeImportExtensions rewrites
  those extensions to `.js` in emitted package output.
- `apps/extension` splits its type checking in two, because its files
  run in two different runtimes. `tsconfig.json` covers the extension
  source that ships: `module: esnext`/`moduleResolution: bundler` and DOM
  libs (it targets a browser and is resolved by a bundler, not by Node),
  with `types: []` so nothing can quietly reach for a Node API.
  `tsconfig.test.json` covers the files Node runs — unit tests and the
  `e2e/` suite — and extends the root config for that reason; it adds the
  DOM lib as well, since a Playwright `evaluate` callback is authored in a
  Node file but executes in the browser. The split is what makes the
  browser-neutrality of `core/` a checked property rather than a claim:
  `core/` is the only source directory that type-checks under both.
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

Only `node:test` + `node:assert/strict` — no Vitest/Jest/Mocha. Layers 1–6
below exist today; layer 7 is planned and marked as such. In increasing
order of scope:

1. **Unit tests** — parsing, serialization, URL resolution, MIME/charset
   handling, base64/quoted-printable, plist handling, `cid:` frame-root
   derivation, diagnostics.
2. **Golden fixtures** — real Chrome/Safari-generated archives, used for
   regression testing, including real multi-frame MHTML captures
   (`fixtures/mhtml/frames-nested.chrome.mhtml`,
   `fixtures/mhtml/frames-cross-origin.chrome.mhtml`) and real
   WebKit-generated `.webarchive`s with populated `WebSubframeArchives`
   (`fixtures/webarchive/frames-nested.safari.webarchive`,
   `fixtures/webarchive/frames-cross-origin.safari.webarchive`) — see
   `fixtures/README.md`'s frame fixture provenance notes.
3. **Bug regression fixtures** — every reported archive bug gets reduced
   to a minimal fixture under `fixtures/` and a permanent regression test.
4. **Round-trip tests** — MHTML→MHTML (through the MHTML-native
   representation), WebArchive→WebArchive, and direct cross-format
   WebArchive→MHTML→WebArchive / MHTML→WebArchive→MHTML, including at
   least one case with frames and one with a metadata sidecar.
5. **Malformed-input tests** — broken boundaries, invalid base64,
   duplicate identities, bad charsets, malformed/foreign metadata
   sidecar parts, `cid:` references with no matching part.
6. **Browser extension E2E** — a real Chromium with the real built
   extension loaded. Two lanes: **save**, which captures a deterministic
   local page, saves it in both formats and verifies the written bytes
   with `@xarsh/archivebridge` itself; and **view**, which writes a real
   `.webarchive` to disk, navigates the browser to its `file://` URL, and
   asserts against the archived DOM Chrome actually laid out after the
   extension's own `declarativeNetRequest` rule redirected it. The view
   lane's security half runs against **hand-built** hostile archives,
   because Blink's capture strips `<script>` (see "Format vs. capture
   semantics") while WebKit's does not — so a hand-built one is both the
   only way to test the threat and the more realistic shape of a real
   `.webarchive`. Chrome/Chromium only today; see "Browser automation"
   below.
7. **Real-world compatibility corpus** *(planned)* — periodic snapshots of
   real sites, run as an opt-in smoke test, never a required CI gate (no
   external network access in normal CI).

`fixtures/` is shared across the library, CLI, and extension so the same
sample archives back tests everywhere. See [fixtures/README.md](../fixtures/README.md)
for the fixture policy.

### Browser automation

Layer 6 uses **Playwright** (the `playwright` package, not
`@playwright/test`) driven from `node:test`. Playwright documents and
maintains first-class Chromium extension support — `launchPersistentContext`
with `--load-extension`, the `serviceworker` event, `evaluate` inside an MV3
service worker, and opening extension pages — which is precisely the set of
operations a home-grown CDP harness would have to own: browser launch,
target discovery, worker attach/detach, execution-context lifetime and all
the races between them. That is several hundred lines of the code most
likely to be flaky, traded for a dependency graph of two packages
(`playwright` -> `playwright-core`). The test *runner* stays `node:test`,
which is why the dependency is `playwright` and not `@playwright/test`.

Two properties of the suite are deliberate:

- **It asserts on bytes, not on dialogs.** The tests drive the production
  save path unmodified and then read the file it wrote, parsing it with
  `@xarsh/archivebridge`. That works because Playwright *replaces* Chrome's
  download pipeline (`Browser.setDownloadBehavior` with `allowAndName`), so
  `saveAs: true` completes with no chooser and no filename-determination
  step at all — not, as it first appears, because headless Chromium
  auto-accepts the chooser. Hand Chrome's own pipeline back and a
  `saveAs` download in headless ends as `interrupted`/`USER_CANCELED`
  (measured). Either way, no branch exists in `src/` for the benefit of
  tests. Whether the chooser really appears is verified separately and
  occasionally, by hand or by an agent, in a headed browser: the download
  item stays `in_progress` with an empty filename and all bytes staged,
  which is Chrome waiting on the user. **The OS file chooser is never a CI
  gate.**
- **Worker lifetime is tested, not assumed.** `e2e/save-lifecycle.test.ts`
  terminates the MV3 service worker mid-save through the browser's `Target`
  CDP domain (reached via `browser.newBrowserCDPSession()` — Playwright's
  own connection, no second launch) and asserts what the restarted worker
  does with the save it inherited. Holding a download pending needs Chrome's
  download pipeline, so that suite asks for it and gives up the ability to
  assert on written bytes in exchange; a
  `chrome.downloads.onDeterminingFilename` deferral registered from a
  test-owned extension page reproduces the chooser's observable state
  (`in_progress`, empty filename, bytes staged) and releases it on cue.
  Chrome cancels a download whose filename stays undetermined for ~15
  seconds, so the hold is a budget, not a pause.
- **It is not part of `npm run check`.** It needs a browser binary
  (`npx playwright install chromium`) that the unit-test gate must not
  require, so it is its own script (`npm run test:e2e`) and its own CI
  job. See CONTRIBUTING.md, "Extension E2E tests".

### Browser automation: where this is going

Chrome's suite is the first lane of an eventual **browser conformance
suite**: a live deterministic page -> browser capture -> MHTML ->
WebArchive conversion -> parse/inspect assertions -> open/view assertions.
The whole of that chain except the last hop already runs in one browser
(capture in Chrome, convert with the library, view in Chrome); what is
still missing is running the view step in a *different* browser from the
capture step. Assertions stay semantic (part lists, frame
nesting, resource bytes); screenshots may supplement them but never
replace them, because a pixel diff cannot tell a rendering change from a
fidelity regression.

- **Chrome/Chromium** — done: fully automated extension loading, MV3
  service-worker testing, and local-file navigation into the archive
  viewer, headless.
- **Firefox** *(planned)* — temporary extension installation via
  `web-ext`, then browser automation against the running Firefox. The
  interesting tests there are of the custom capture implementation, since
  Firefox has no native MHTML capture: form state, `<canvas>`,
  cross-origin frames and stylesheets are all reachable from a content
  script and all need their own assertions.
- **Safari** *(planned, macOS-only)* — needs full Xcode, a containing app
  and a signed Safari Web Extension, so it gets its own macOS lane.
  Safari automation is explicitly **not** a blocker for Chrome work.

The test server records every request it serves **and every TCP connection
opened to it**, which is what turns the viewer's "no external network
fallback" rule (see "Archive viewer") into an assertion rather than an
aspiration. Both counters are needed: requests cover `<img>`, `fetch`, a
stylesheet and a frame, but `preconnect`/`dns-prefetch` connect without
ever sending a request, and no CSP fetch directive governs them — a viewer
that counted only requests could call itself silent while talking to a
server.

One capability of the harness is worth recording because it looks like a
contradiction: the view lane reads the archived DOM out of a frame that
has no `allow-scripts`. That works because Playwright evaluates in an
**isolated world** over the automation protocol, which a sandboxed frame
still has, while the page's own scripting stays off — which is exactly
what those tests assert. One thing is *not* reachable: Chrome's
per-extension "Allow access to file URLs" toggle is granted
unconditionally by `--load-extension` and re-granted on every launch (a
patched profile preference does not survive), so the denied branch of the
viewer's failure UX is covered by unit tests rather than by the browser.
