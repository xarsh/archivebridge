# Architecture

This document records the design decisions behind ArchiveBridge and why
they were made, so future contributors (human or agent) don't have to
reverse-engineer intent from the code. See the root
[CONTRIBUTING.md](../CONTRIBUTING.md) for the practical contribution
rules; this file is the "why" behind them.

## Goals

ArchiveBridge is a compatibility layer for saved web page archive formats:

- Read and write MHTML/MHT
- Read and write Safari WebArchive (`.webarchive`)
- Convert between archive formats
- Inspect/convert/extract from a CLI
- The same functionality from a browser extension (Firefox first, then
  Chrome/Chromium from the same codebase)
- Tolerate real-world broken/incomplete archives
- No unnecessary network access while browsing an archive
- Treat archive files as untrusted input

The library (`packages/archivebridge`, published as `@xarsh/archivebridge`)
is the core; the CLI and the browser extension are both thin consumers of
it. Nothing archive-format-specific should live outside the library.

## The internal Archive model

MHTML and WebArchive are both parsed into one format-independent shape:

```ts
interface Archive {
	mainUrl: string
	mainResource: Resource
	resources: ReadonlyMap<string, Resource>
	frames: readonly Archive[]
}

interface Resource {
	url: string
	mimeType: string
	data: Uint8Array
	textEncoding?: string
}
```

Design decisions:

- **`resources` is a `Map` keyed by URL**, not an array. Both MHTML
  (`Content-Location`) and WebArchive (`WebResourceURL`) resources are
  naturally addressed by URL, and de-duplication/lookup by URL is the
  common case for both parsing and serialization. A duplicate URL
  encountered while parsing becomes a `duplicate-resource-url` diagnostic
  rather than a silent overwrite or a second array entry.
- **`mainResource` is pulled out of `resources` and does not also appear
  inside it.** Every archive has exactly one top-level document; making
  that explicit in the type avoids "what if `resources.get(mainUrl)` is
  missing" bugs at every call site. `resources` holds only the *other*
  resources (stylesheets, scripts, images, ...) a page referenced. Storing
  the main document in both places would create two possible answers to
  "what is the canonical main resource" (`archive.mainResource` vs.
  `archive.resources.get(archive.mainUrl)`) that could drift out of sync;
  keeping it in exactly one place removes that question entirely. A parser
  encountering the same URL for both the main document and a subresource
  reports `duplicate-resource-url` and keeps the main resource, the same as
  any other duplicate URL.
- **`frames` is `Archive[]`, recursively**, rather than a flat resource
  list with frame metadata bolted on. Both formats can nest a full
  sub-document (an iframe/frameset saved as its own archive). Modeling
  frames as nested `Archive` values means code that walks an archive
  (search, size calculation, conversion) is naturally recursive and
  doesn't need a separate "is this a frame" branch. Recursion depth must
  be bounded when parsing (see Security below) — untrusted input must not
  be able to force unbounded recursion.
- **`data` is always fully-decoded bytes.** Format-specific transfer
  encodings (MHTML's `quoted-printable`/`base64`, WebArchive's plist
  `<data>` base64) are undone during parsing and are never visible in the
  model. `textEncoding` records the resource's *character* encoding (e.g.
  `"utf-8"`), which is a separate concern from transfer encoding and does
  matter to callers (rendering, re-serializing as text).
- **Format-specific concepts stay out of the model.** MIME multipart
  boundaries and `Content-ID` (MHTML), and plist dictionary keys
  (WebArchive), are resolved during parsing. If a `Content-ID` needs to
  survive round-tripping, that's a serializer concern (e.g. regenerating
  one deterministically), not something `Archive`/`Resource` should carry.
- **`Resource`/`Archive` favor standard types** (`Uint8Array`, `Map`,
  plain strings for URLs) over custom wrapper classes, per the project's
  "platform APIs first" policy.

`ParseResult` (`{ archive, diagnostics }`) was defined as a type-only
contract ahead of any parser so that `parseMhtml` (`src/mhtml/parse.ts`)
and the eventual `parseWebArchive` land with an established shape rather
than each inventing their own. `parseMhtml` covers a single-level
`multipart/related` message only — no nested frames
(`multipart/mixed`-wrapped sub-documents) yet, so `Archive.frames` is
always `[]` for MHTML today.

Parsers are tolerant of producer-specific MHTML conventions observed in real browsers.
Serializers should prefer standards-conforming output rather than reproducing producer
quirks unless required for interoperability.

## Diagnostics and partial failure

Real-world archives are frequently malformed in small ways (one bad
resource, a truncated multipart body, an unknown encoding). The design
goal is: a single bad resource should degrade the archive, not fail it
outright — parsing should be able to return 99 good resources and one
`malformed-resource` diagnostic, not throw.

`Diagnostic` is a discriminated union on `type`:

- `malformed-archive` — the archive as a whole couldn't be parsed
- `malformed-resource` — one resource within an otherwise-parseable archive
- `unsupported-encoding` — a transfer/character encoding we don't handle
- `unresolved-resource` — a referenced URL has no matching resource
- `duplicate-resource-url` — the same URL appeared more than once
- `unsupported-feature` — recognized but intentionally-unhandled input
- `recovered-non-conforming-input` — input violated the spec but a
  reasonable recovery was possible (this is distinct from
  `malformed-resource`: it's for cases where we *did* recover, logged for
  visibility, not for cases we gave up on)

Using a discriminated union rather than an error code/string means adding
a new diagnostic variant is a compiler-checked exercise: anything that
switches over `Diagnostic["type"]` without a `default` case will fail to
type-check until every call site handles the new variant. Problems are
never silently dropped — every code path either produces a `Diagnostic` or
succeeds; there is no "ignore and move on" without a trace.

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
  multi-gigabyte `Uint8Array`.
- Recursive structures (nested `frames`) must have a depth limit during
  parsing; exceeding it is a diagnostic, not unbounded recursion.
- Partial failure must be handled safely: a `malformed-resource`
  diagnostic must not leave the rest of the `Archive` in an inconsistent
  state.
- Extension-privileged code and archived page content are separate trust
  domains and must be kept separate in the extension's architecture, not
  just by convention in one code path.

## CLI

The CLI (`archivebridge inspect|convert|extract`) parses `process.argv`
directly with a hand-written switch, not a CLI framework/argument-parser
dependency. The command surface is three subcommands with simple
positional arguments — a dependency isn't justified yet.

`inspect` and `convert` are implemented entirely on top of the library's
public API (`detectArchiveFormatFrom*`, `parseMhtml`/`parseWebArchive`,
`serializeMhtml`/`serializeWebArchive`): the CLI itself contains no
format-specific logic, only argument handling, format dispatch, and
human-readable output formatting. `extract` is still wired up as a
recognized subcommand that prints "not implemented yet" and exits
non-zero — it's out of scope until extraction lands in the library.

Command dispatch is a `switch` over a `Command` string-literal union with
no `default` case, so adding a fourth subcommand without adding its
`case` is a type error (exhaustiveness checking), the same pattern used
for diagnostics.

## Browser extension: WXT was considered, not adopted yet

`apps/extension` is a plain Manifest V3 WebExtension (Firefox first,
`browser_specific_settings.gecko`), built with `tsc` alone — no bundler.

WXT was evaluated for this initial scaffold and deliberately **not**
adopted yet:

- The extension currently has zero non-DOM imports (its `popup.ts` only
  touches the DOM), so there is nothing for a bundler to do yet.
- Wiring the extension up to actually use `@xarsh/archivebridge` will
  require *some* bundling strategy, because browsers can't resolve a bare
  `node_modules` workspace import without either a bundler or manual
  import-map/copy wiring. That decision is deferred to when the extension
  first needs to call into the library — at that point, re-evaluate WXT
  (or a lighter bundler) against just copying the built library output.
- Introducing a build tool ahead of actually needing it would violate the
  project's "no dependency without a concrete reason" policy.

This means today's extension is UI-only: a popup that accepts a file via
drag-and-drop or file picker and lists the selected file name(s). It does
not detect archive format or parse anything, specifically so it does not
duplicate any logic that belongs in the library.

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
   handling, base64/quoted-printable, plist handling, diagnostics.
2. **Golden fixtures** — real Chrome/Safari-generated archives, used for
   regression testing once parsers exist.
3. **Bug regression fixtures** — every reported archive bug gets reduced
   to a minimal fixture under `fixtures/` and a permanent regression test.
4. **Round-trip tests** — MHTML→Archive→MHTML,
   WebArchive→Archive→WebArchive, and cross-format
   MHTML→Archive→WebArchive→Archive.
5. **Malformed-input tests** — broken boundaries, invalid base64,
   duplicate URLs, bad charsets.
6. **Browser extension integration tests** — Firefox and Chrome, once the
   extension does more than accept a file.
7. **Real-world compatibility corpus** — periodic snapshots of real sites,
   run as an opt-in smoke test, never a required CI gate (no external
   network access in normal CI).

`fixtures/` is shared across the library, CLI, and extension so the same
sample archives back tests everywhere. See [fixtures/README.md](../fixtures/README.md)
for the fixture policy.
