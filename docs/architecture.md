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
diagnostics, and format detection — plus the `archivebridge inspect` and
`archivebridge convert` CLI subcommands built on top of them.

**Planned.** Browser `capture` and `save` (the extension's whole reason
to exist), a `validate` command, and the extension's four-browser
production support. `apps/extension` today is a UI placeholder — a popup
that accepts files and lists their names, with no archive logic in it at
all.

Sections below discussing `validate`, `capture`, or `save` are specifying
where that functionality will fit and what invariants it must respect, not
describing code that exists. They are marked where the distinction could
otherwise be missed. The commitment that Chrome, Edge, Firefox, and Safari
are all first-class targets is an architectural constraint that holds now
and binds the implementation whenever it lands.

## Goals

See [README.md](../README.md#what-works-today) for what ArchiveBridge does
and who it's for.

The library (`packages/archivebridge`, published as `@xarsh/archivebridge`)
is the core. The CLI is a thin consumer of it, and the extension is
required to be one — nothing archive-format-specific may live outside the
library, which is why the extension stays UI-only rather than
reimplementing parsing while its bundler question is open. Everything
below this point is the *why* behind the decisions that follow from those
goals.

## MHTML is the canonical format

ArchiveBridge treats **MHTML as its canonical serialized representation** —
the format every capture path converges on, and the format every other
capability is built against directly:

```text
Chrome / Edge   live page --native MHTML capture-->  MHTML   (planned)
Firefox         live page --custom MHTML capture-->  MHTML   (planned)
Safari          live page --custom MHTML capture-->  MHTML   (planned)

MHTML --inspect
MHTML --convert--> WebArchive
WebArchive --convert--> MHTML
MHTML --save / validate                                      (planned)
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

> **Status: planned.** Everything in this section describes a design not
> yet built. `apps/extension` today is a UI placeholder — see "Current
> state of `apps/extension`" at the end of this section.

The extension targets **Chrome, Edge, Firefox, and Safari** as an
architecture matter — implementation is free to build one browser before
another, but the design is not allowed to be single-browser. Two
responsibilities are kept as distinct browser-adapter concerns, because
they vary independently per browser:

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

### Current state of `apps/extension`

The extension is a **UI placeholder**: a popup that accepts files via
drag-and-drop or a file picker and lists the selected file names. It
contains no archive parsing, no format detection, and no capture or save
logic. `popup.ts` imports nothing but DOM APIs.

That is deliberate rather than merely unfinished. `apps/extension` has no
bundler, so it cannot import `@xarsh/archivebridge` without either adding
one or duplicating library logic inside the extension — and duplicating it
is ruled out by CONTRIBUTING.md's boundary rules. Staying UI-only is the
option that keeps the boundary intact while the bundler question is open.

**The bundler choice (WXT vs. plain `tsc` vs. something else) is
deliberately not decided here.** The trigger for deciding it is wiring the
extension up to actually call `@xarsh/archivebridge`, which is what
capture/save adapters will require. Until then there is nothing to bundle:
the extension has zero non-DOM imports.

**Why the manifest currently looks Firefox-specific.** `manifest.json`
carries a `browser_specific_settings.gecko` block (an extension ID and a
`strict_min_version`), because Firefox requires an explicit ID to load an
unsigned extension during development and the scaffold is loaded there
first. The key is additive and ignored by Chromium browsers, so it does
not make the extension Firefox-only and does not narrow the four-browser
commitment above — it reflects which browser the placeholder is currently
loaded in, nothing more. Chrome, Edge, Firefox, and Safari all remain
first-class targets.

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

Only `node:test` + `node:assert/strict` — no Vitest/Jest/Mocha. Layers 1–5
below exist today; layers 6 and 7 are planned and marked as such. In
increasing order of scope:

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
6. **Browser extension integration tests** *(planned)* — Chrome, Edge,
   Firefox, and Safari, once the extension does more than accept a file.
   `apps/extension` has no test script today for exactly that reason.
7. **Real-world compatibility corpus** *(planned)* — periodic snapshots of
   real sites, run as an opt-in smoke test, never a required CI gate (no
   external network access in normal CI).

`fixtures/` is shared across the library, CLI, and extension so the same
sample archives back tests everywhere. See [fixtures/README.md](../fixtures/README.md)
for the fixture policy.
