# Production migration plan: adopting the MHTML-canonical architecture

> **This document is temporary.** It exists only to plan the migration of
> production code from the pre-migration `Archive`/`Resource` model to
> the architecture in [architecture.md](architecture.md). It should be
> **deleted once that migration is complete** — any of its constraints
> that still matter afterward (invariants, naming, security posture, test
> layers) belong in `architecture.md` and the test suite themselves, not
> in a standalone migration document kept around indefinitely. Do not add
> new durable architecture rationale here; it belongs in
> [architecture.md](architecture.md) instead.

This document is a plan, not a status report. **No production source has
been changed as part of this plan** — see [architecture.md](architecture.md)
for the target design this plan migrates the codebase toward. This plan
identifies every place the current codebase depends on the model
architecture.md removes, organizes the migration into logical
implementation phases, and calls out breaking changes and risk areas
explicitly.

This migration is expected to land as one coordinated architecture
rewrite against a pre-1.0, unpublished package — not as a sequence of
independently-shippable releases. The "stages" in §4 below are a way to
keep implementation, testing, and review tractable, not a requirement
that each stage individually be buildable, committable, or landable on
its own; see §4's framing note before reading the stage list. The
acceptance bar is the final state of the migration branch/working tree:
`npm run typecheck`, `npm test`, `npm run lint`, `npm run build`, and CLI
behavior all passing together, not each intermediate stage passing in
isolation.

## 1. Current state: every `Archive`/`Resource` usage site

`Archive`, `Resource`, `ArchiveFormat`, `Diagnostic`, and `ParseResult`
are all defined in `packages/archivebridge/src/model/archive.ts`. Current
consumers:

| Site | Dependency |
|---|---|
| `mhtml/parse.ts` (`parseMhtml`) | Builds an `Archive` (`mainUrl`/`mainResource`/`resources`/`frames: []`) as its return shape. |
| `mhtml/serialize.ts` (`serializeMhtml`) | Takes an `Archive`; throws if `archive.frames.length > 0`. |
| `webarchive/parse.ts` (`parseWebArchive`) | Builds an `Archive` the same way; discards `WebResourceResponse`/`WebResourceFrameName`/`WebSubframeArchives` entirely (never read into the model). |
| `webarchive/serialize.ts` (`serializeWebArchive`) | Takes an `Archive`; throws if `archive.frames.length > 0`; never writes `WebResourceResponse`/`WebResourceFrameName`. |
| `index.ts` | Public re-export of `Archive`, `ArchiveFormat`, `Diagnostic`, `ParseResult`, `Resource` as types, plus the four parse/serialize functions. |
| `cli/cli.ts` | Imports `Archive`/`Resource`/`ParseResult`/`Diagnostic` directly; `parseByFormat`/`serializeByFormat` dispatch on `Archive`; `formatArchive`/`formatResource` walk `Archive` recursively (including the currently-always-empty `frames` array) for `inspect` output; cross-format `convert` works today *only* because both formats parse into/serialize from the same `Archive`. |
| `roundtrip.test.ts` | Constructs a literal `Archive` value and asserts `Archive → MHTML → Archive → WebArchive → Archive` round-trips it unchanged via `deepEqual`. |
| `mhtml/parse.test.ts`, `mhtml/serialize.test.ts`, `webarchive/parse.test.ts`, `webarchive/serialize.test.ts` | Construct/assert against literal `Archive`/`Resource` values throughout. |
| `mhtml/parse.golden.test.ts`, `webarchive/parse.golden.test.ts` | Assert parsed golden fixtures produce a specific `Archive` shape. |
| `fixtures.test.ts` | Format-detection smoke test over `fixtures/`; does not construct `Archive` directly but calls `parseMhtml`/`parseWebArchive`, whose return type changes. |
| `cli/cli.test.ts`, `cli/cli.fixtures.test.ts` | Assert CLI stdout, which includes `formatArchive`'s `Frames (0):` line and the `Archive`-shaped structure it walks. |

No file outside `packages/archivebridge` references `Archive`/`Resource`
today: `apps/extension` is UI-only (`popup.ts` only touches the DOM,
confirmed in architecture.md) and does not import `@xarsh/archivebridge`
at all yet. **This means the entire migration is contained inside
`packages/archivebridge`; the extension has nothing to migrate this
round.**

## 2. Public API impact

`packages/archivebridge`'s public entry point (`index.ts`) currently
exports:

```ts
export { detectArchiveFormatFromBytes, detectArchiveFormatFromFilename } from './format/detect.ts'
export { parseMhtml } from './mhtml/parse.ts'
export { serializeMhtml } from './mhtml/serialize.ts'
export type { Archive, ArchiveFormat, Diagnostic, ParseResult, Resource } from './model/archive.ts'
export { parseWebArchive } from './webarchive/parse.ts'
export { serializeWebArchive } from './webarchive/serialize.ts'
```

**Breaking changes** the migration will introduce to this surface:

- `Archive` and `Resource` are removed. There is no replacement type with
  the same shape — they're not renamed, they no longer exist as a
  concept (architecture.md, "No format-neutral `Archive`/`ArchiveView`
  IR").
- `ParseResult` (`{ archive: Archive | undefined, diagnostics }`) is
  removed as a single shared type. `parseMhtml` and `parseWebArchive`
  need their own format-native result shapes (e.g. `{ document:
  MhtmlDocument | undefined, diagnostics }` / `{ document:
  WebArchiveDocument | undefined, diagnostics }` — exact naming is an
  implementation decision for the stage that lands it, not fixed by this
  plan).
- `serializeMhtml`/`serializeWebArchive` change their parameter type from
  `Archive` to their own format-native document type. Callers that
  build an `Archive` by hand and feed it to either serializer directly
  (the pattern `roundtrip.test.ts` uses today) no longer compile.
- New exports are needed for the direct converters (e.g.
  `convertMhtmlToWebArchive`/`convertWebArchiveToMhtml`) that replace
  today's implicit "parse into `Archive`, serialize out of it" conversion
  path — today nothing exports a converter function at all; conversion
  is just parse-then-serialize composed by the caller (`cli.ts`'s
  `runConvert`).
- `ArchiveFormat` (`'mhtml' | 'webarchive'`) is **not** a breaking
  change — it names the file format, not the removed IR, and stays as-is.
- `Diagnostic` survives conceptually (architecture.md keeps the
  discriminated-union diagnostics design) but its exact variant set may
  need small adjustments once format-native parsing has different
  failure shapes to describe (e.g. an unresolved `cid:` reference); this
  plan does not fix the final variant list, only flags that
  `Diagnostic`'s call sites (every `switch` over `diagnostic.type`) are
  compiler-enforced to update wherever it does change.

This is a pre-1.0, unpublished package (`"Not published yet"` per
`packages/archivebridge/README.md`), so there is no compatibility
obligation to any external consumer today — but the impact is still
listed in full because it's real, not because it's blocking.

## 3. New responsibilities that don't exist in production code today

These aren't migrations of existing logic — they're genuinely new
capabilities the current codebase has no equivalent of at all:

- **Frame support end-to-end.** Both serializers currently `throw` if
  `archive.frames.length > 0`, and both parsers always produce
  `frames: []`. Nothing about frame parsing, frame serialization, or
  frame conversion exists today in any form.
- **`cid:`-based frame-root derivation** for MHTML (scanning `text/html`
  part bodies for `cid:` references matching another part's
  `Content-ID`).
- **HTML `<iframe src>` rewriting** in both conversion directions
  (resolved-URL → `cid:` for WebArchive→MHTML; `cid:` → resolved URL for
  MHTML→WebArchive) — see risk notes below.
- **The metadata sidecar**, both writing it (WebArchive→MHTML, when the
  source has residual fields) and reading it (MHTML→WebArchive, when
  present).
- **`WebSubframeArchives` parsing/serialization** — `webarchive/parse.ts`
  and `webarchive/serialize.ts` don't touch this key today at all.
- **`WebResourceResponse`/`WebResourceFrameName` read/write** —
  currently read-and-discarded (parse) or never written (serialize).

## 4. Migration stages

**Framing note:** these stages are logical phases for organizing
implementation, testing, and review — not independent-landing
requirements. Later stages depend on earlier ones, and that's fine; there
is no requirement to keep every stage separately buildable/committable,
and no requirement to add temporary compatibility wrappers or keep the
old `Archive` model working longer than necessary just so an intermediate
stage looks shippable on its own. Where a stage's output can reasonably
be tested in isolation before the next stage wires it in (e.g. new types
against literal values, a converter against direct in-memory documents),
test it that way, because it's cheap and catches problems early — but
that's a testing convenience, not an architectural requirement that the
repository be in a fully working state after every single stage.

### Stage 1 — New format-native representations, additive only

Add `MhtmlDocument`/`MhtmlPart` and `WebArchiveDocument`/`WebArchiveResource`
(architecture.md's shapes) as new types, without touching `Archive` or
any existing parser/serializer yet. Testable in isolation: pure type
definitions plus, if useful, construction helpers, with unit tests
against literal values — no behavior change to anything existing.

### Stage 2 — Parsers move to format-native output

Change `parseMhtml` to return `MhtmlDocument`-shaped results and
`parseWebArchive` to return `WebArchiveDocument`-shaped results
(including, for the first time, reading `WebSubframeArchives`,
`WebResourceResponse`, and `WebResourceFrameName` into the new
`WebArchiveResource` fields). `Archive` still exists in the tree but
nothing produces it anymore. Testable via updated unit + golden tests
per parser, independently of the other parser or of serialization.
This is also the stage that needs **new golden fixtures**: a real
multi-frame Chrome-captured `.mhtml` and a real WKWebView/Safari
`.webarchive` with `WebSubframeArchives` populated — neither exists in
`fixtures/` today (see §6, risk notes).

### Stage 3 — Serializers move to format-native input

Change `serializeMhtml` to take an `MhtmlDocument` and
`serializeWebArchive` to take a `WebArchiveDocument`, including writing
`WebSubframeArchives`/`WebResourceResponse`/`WebResourceFrameName` when
present. The `frames.length > 0` throw is deleted — frames are now a
normal case, not an unsupported one. Testable via each serializer's own
round-trip test (format-native document → bytes → format-native
document, single format, no cross-format conversion involved yet).

### Stage 4 — Metadata sidecar read/write

Add sidecar plist construction/parsing as its own unit (build the
sidecar dict from a `WebArchiveDocument`'s residual fields; read it back
and attach fields to reconstructed `WebArchiveResource`s). Testable
standalone against literal in-memory documents, independent of the full
WebArchive↔MHTML converters that will call it in Stage 5.

### Stage 5 — Direct converters (frame flattening/reconstruction + sidecar wiring)

Implement `convertWebArchiveToMhtml`/`convertMhtmlToWebArchive`,
composing: field mapping, frame flattening/reconstruction with `cid:`
rewriting (the highest-risk new logic — see §6), and the Stage 4 sidecar
read/write. Testable via direct cross-format round-trip tests
(`WebArchiveDocument → MHTML bytes → WebArchiveDocument`, and the
reverse), including at least one case with frames and one with sidecar
metadata — this replaces `roundtrip.test.ts`'s current
`Archive`-mediated round trip.

### Stage 6 — CLI and public API migration

Update `index.ts`'s exports (§2), and `cli.ts`'s `parseByFormat`/
`serializeByFormat`/`runConvert`/`formatArchive`/`formatResource` to use
the new types and call the Stage 5 converters directly instead of
composing parse+serialize by hand. `inspect` output changes to reflect
real frame relationships instead of an always-`Frames (0):` line.
Testable via updated CLI fixture/output tests
(`cli.test.ts`/`cli.fixtures.test.ts`); this is also the stage where
`extract` can move from "not implemented yet" to a real implementation,
since it's the first point where inspecting parts/resources without the
removed `Archive` model is fully wired up end-to-end — though shipping
`extract` itself is a separate scope decision, not mandated by this
migration.

### Stage 7 — Remove the old model

Delete `Archive`, `Resource`, and the old `ParseResult` from
`model/archive.ts` (keep `ArchiveFormat` and whatever `Diagnostic` shape
Stage 2 settled on). Delete/rewrite every test that constructed a
literal `Archive` (`roundtrip.test.ts` was already replaced in Stage 5;
`mhtml/parse.test.ts`, `mhtml/serialize.test.ts`,
`webarchive/parse.test.ts`, `webarchive/serialize.test.ts`,
`*.golden.test.ts` need their literal `Archive`/`Resource` fixtures
rewritten against the new types). This stage should be almost entirely
deletion once Stages 1–6 are done, since nothing should still reference
the old model by then — a stray import at this point is a compile error,
which is the actual confirmation that the migration is complete, not a
separate manual check. Whether this cleanup lands as its own commit or
folded into the same change as Stage 6 is an implementation-time
judgment call, not something this plan mandates either way.

## 5. Test/fixture impact summary

- `roundtrip.test.ts` — fully rewritten (Stage 5) against direct
  converters instead of a literal `Archive`.
- `mhtml/parse.test.ts`, `mhtml/serialize.test.ts`,
  `webarchive/parse.test.ts`, `webarchive/serialize.test.ts` — literal
  `Archive`/`Resource` fixtures rewritten against `MhtmlDocument`/
  `MhtmlPart`/`WebArchiveDocument`/`WebArchiveResource` (Stages 2–3).
- `mhtml/parse.golden.test.ts`, `webarchive/parse.golden.test.ts` —
  assertions rewritten for the new shapes (Stage 2); **new fixtures
  needed**, not just new assertions, to actually exercise frames (see
  §6).
- `cli/cli.test.ts`, `cli/cli.fixtures.test.ts` — stdout assertions
  updated for the new `inspect` frame output and any new `convert`/
  `extract` behavior (Stage 6).
- `fixtures.test.ts` — likely minimal change (it smoke-tests format
  detection over `fixtures/`, which doesn't depend on `Archive` shape),
  but should be re-run at each stage as a cheap sanity check.
- `fixtures/README.md`'s policy (golden fixtures must be real
  browser-generated captures, not hand-authored) applies directly to the
  new frame fixtures this migration needs — they cannot be fabricated
  data labeled as golden.

## 6. Risk areas, ranked

1. **HTML `<iframe src>` rewriting during conversion (Stage 5) —
   implementation strategy not yet decided.** This is the one piece of
   genuinely new, format-crossing logic with no existing equivalent in
   the codebase to build on: rewriting one specific attribute value
   inside otherwise-untrusted HTML bytes, in both directions (resolved
   URL → `cid:` for WebArchive→MHTML, `cid:` → resolved URL for the
   reverse). **How** to implement that rewrite is an open question,
   deliberately not settled by this document, with at least three
   candidate approaches:
   - a small, targeted tokenizer/rewriter scoped to just this
     substitution;
   - an existing, battle-tested HTML parser/tokenizer dependency;
   - some other standards-aware approach that isn't a full general HTML
     parser/DOM but is more principled than ad hoc string matching.

   Evaluate these against: (1) correctness, (2) safety against
   malformed/adversarial/untrusted HTML (this project's security posture
   treats all archive input as untrusted — see "Security assumptions" in
   architecture.md), (3) actual conformance to HTML parsing/serialization
   syntax rather than an approximation of it, (4) round-trip behavior,
   (5) implementation/maintenance complexity, and (6) dependency cost.
   CONTRIBUTING.md's dependency policy already allows adding a dependency
   when hand-rolling it would be clearly less safe/compatible than using
   an existing, well-tested implementation (the same reasoning that
   justified `plist` for binary plist parsing) — "zero dependencies" is
   not an absolute goal here, and a small, battle-tested HTML
   parsing/tokenizing dependency should be a real option on the table,
   not ruled out by default, if it is clearly safer or simpler than a
   hand-rolled rewriter. **This decision should be made immediately
   before starting Stage 5**, using real Chrome/WebKit-generated fixtures
   plus deliberately adversarial synthetic HTML (malformed attributes,
   unusual quoting, nested/duplicate `src`-like attributes, encoding
   edge cases) to compare candidates concretely, not decided in the
   abstract ahead of time.
2. **New golden fixtures don't exist yet.** No repo fixture today has
   frames on either side (`fixtures/mhtml/*` has none with `cid:`-linked
   frames; `fixtures/webarchive/*` has none with `WebSubframeArchives`).
   Per `fixtures/README.md`'s policy, these must be real browser
   captures, not synthetic data — acquiring them (a real multi-frame
   Chrome MHTML capture, a real WKWebView/Safari WebArchive with nested
   frames) is a prerequisite for Stage 2's golden tests and blocks
   meaningfully testing Stages 2–6 against real-world shapes rather than
   only hand-built literals.
3. **`Content-ID` test ergonomics.** architecture.md's "Content-ID:
   preservation, generation, and identity" section already settles the
   production rule (UUID-based generation for new parts, existing IDs
   preserved, never content-hash-derived) — this is no longer an open
   design question. What Stage 5/7's test updates still need to work out
   is the mechanical detail of asserting round-trip equality against
   non-deterministic generated IDs (ID normalization before `deepEqual`,
   or a test-only injectable ID generator), without making the
   *production* algorithm deterministic to simplify that assertion.
4. **Diagnostic variant changes ripple everywhere there's an exhaustive
   `switch`.** architecture.md flags at least one concrete split
   (`duplicate-resource-url` splitting into a `Content-Location`-duplicate
   and a `Content-ID`-duplicate variant, see its "Diagnostics and partial
   failure" section) without fixing the complete final variant set —
   that's left to whichever stage actually needs it. Whatever the final
   set turns out to be, the ripple is mechanical but wide: `cli.ts`'s
   `formatDiagnostic`, `index.ts`'s re-export, and every test asserting
   on a specific `Diagnostic` shape. The compiler catches every missed
   site (that's the point of the no-`default`-case pattern), but the
   number of sites touched should be expected to be non-trivial.
5. **Sidecar/foreign-MHTML interaction.** MHTML→WebArchive conversion
   must degrade correctly when there is no metadata sidecar at all (any
   non-ArchiveBridge-authored MHTML, which is the common case) —
   `WebResourceResponse`/`WebResourceFrameName` are simply absent on the
   output, not an error. This should be cheap to get right but easy to
   under-test if only ArchiveBridge-round-trip cases are covered.

## 7. Extension impact

None this round. `apps/extension` doesn't import `@xarsh/archivebridge`
today (confirmed: `popup.ts` only touches the DOM), so nothing in
Stages 1–7 touches it. The capture/save adapter work architecture.md
describes (per-browser capture, per-browser save, `chrome.pageCapture
.saveAsMHTML()` for Chrome/Edge, custom capture for Firefox/Safari) is
downstream of this migration landing, not part of it, and is explicitly
out of scope for this planning pass.

## 8. Suggested order and smallest next step

The stage order in §4 is the recommended order: it's already sequenced
so each stage is testable on its own and later stages build on strictly
earlier ones (representations → parsers → serializers → sidecar →
converters → CLI/public API → cleanup). The **smallest concrete next
step**, if/when implementation work begins, is Stage 1 — adding
`MhtmlDocument`/`MhtmlPart`/`WebArchiveDocument`/`WebArchiveResource` as
new, additive types with no behavior change to any existing code path,
which is low-risk, immediately reviewable, and unblocks every later
stage.
