# Contributing to ArchiveBridge

This document covers the practical rules for working in this repository:
package manager/dependency policy, TypeScript conventions, testing
philosophy, npm scripts, and how to add fixtures. For what the project is
and its goals, see [README.md](README.md). For *why* the codebase is
shaped the way it is (the archive model, diagnostics, security posture,
CLI/extension design), see [docs/architecture.md](docs/architecture.md).

## Package manager and workspace layout

- **npm only**, using npm workspaces for the monorepo. Do not introduce
  pnpm/yarn/bun, and do not add a task runner beyond npm scripts.
- `packages/archivebridge` is a single package providing both the
  reusable JS/TS API and the `archivebridge` CLI executable. Do not split
  it into `archivebridge-core`/`archivebridge-cli`/etc. unless a concrete
  technical reason emerges — ask before doing so.

## Node.js versions

Three places name a Node version, and they mean different things:

- `engines.node` (`>=24`) is the **supported floor** — the oldest Node a
  consumer of `@xarsh/archivebridge` may run. Every runtime dependency
  supports it, and `@exodus/bytes` exists specifically to hold this floor
  (see Dependency policy below).
- `mise.toml` (`26`) is the **default local development toolchain**, not a
  requirement. Newer than the floor is intentional: contributors work on
  current Node.
- CI's matrix (`24`, `26`) is what actually **proves the floor**. Node 24
  is exercised on every push and pull request, so `>=24` is a tested
  claim rather than an assumption. To reproduce the floor locally, use
  `mise use node@24` (or any Node 24 install) — nothing in the repo
  depends on Node 26 features.

Change `engines.node` only together with the CI matrix, so the declared
floor never stops being the tested floor.

## Dependency policy

- Runtime dependencies start at **zero**. Adding one requires a concrete
  reason: something Node.js standard APIs cannot reasonably do, or a case
  where using an existing, well-tested implementation is clearly
  safer/more compatible than hand-rolling it (e.g. a real MIME parser, if
  it ever comes to that — not preemptively). Before adding any dependency,
  explain why a standard API/existing code can't do the job.
- `plist` is used for Safari WebArchive property list parsing and building
  (both binary `bplist00` and XML plists). Binary plists in particular are
  a non-trivial format (an offset table, variable-width integers, object
  references); this project's untrusted-input security assumptions call
  for a battle-tested implementation rather than a hand-written one. See
  `webarchive/parse.ts`/`webarchive/serialize.ts`. Delegating the *format*
  is not the same as trusting the *shape* of the result: every dictionary
  it returns is narrowed through `plist-dict.ts` before any field is read
  (see [docs/architecture.md#security-assumptions](docs/architecture.md#security-assumptions),
  "Only a dictionary's own keys are data"), and any new code that reads
  plist output must go through that boundary too.
- `parse5` is used to locate `<iframe>`/`<frame>` `src` attributes,
  effective `<base href>`, and declarative Shadow DOM frame traversal
  when flattening/reconstructing frames during WebArchive ⇄ MHTML
  conversion (`mhtml/html-rewrite.ts`). It's used purely to find exact
  source-string offsets (`sourceCodeLocationInfo`), never to re-serialize
  the document — only the located attribute span is spliced, so nothing
  else about the HTML changes. A hand-rolled scanner would need to
  correctly reproduce the real HTML5 tokenizer's tag/attribute/RAWTEXT/
  comment states to be safe against adversarial input (a fake `<iframe>`
  inside a comment or a `<script>` string, a duplicate `src` attribute,
  unquoted/single-quoted values); `parse5` already does, and is what
  jsdom and Deno use for the same job. One transitive dependency
  (`entities`). See docs/architecture.md, "Frame representation" for the
  full evaluation.
- `iconv-lite` is used for legacy (non-UTF-8) `textEncoding` decode/encode
  when resource HTML has to be decoded, edited (frame `src` rewriting),
  and re-encoded without changing its declared charset
  (`mhtml/text-codec.ts`). The platform `TextEncoder` is UTF-8-only by
  spec and Node has no built-in general-purpose charset encoder, so there
  is no standard API that can encode into a legacy single-/double-byte
  charset at all — only `TextDecoder` can decode one. Using `iconv-lite`
  for both directions keeps a decode-edit-encode round trip internally
  consistent (the same codec table on both ends), rather than pairing
  `TextDecoder` with some unrelated encoder for the "same" label and
  risking a mismatch between two implementations' notion of what that
  label means. Pure JS, no native bindings to build, widely used. See
  `mhtml/text-codec.ts`'s module doc comment for the full rationale.
- `@exodus/bytes` (`base64.js` submodule only) is used for MHTML base64
  encode/decode instead of the platform `Uint8Array.fromBase64`/`toBase64`.
  That API requires V8 14 (Node 25+); this project's `engines` floor is
  Node 24 (V8 13), which does not have it, and it will not be backported to
  earlier LTS lines. `@exodus/bytes` has zero required dependencies of its
  own and supports Node 24 and 26 (see its own `engines` field). ArchiveBridge
  strips the ASCII whitespace RFC 2045 §6.8 permits around base64 line
  wrapping itself; everything else (alphabet, padding correctness, decoding)
  is left to the library. **Revisit this once Node 26 (or whichever release
  first ships the native API in an LTS line) is the practical minimum for
  this project** — at that point, drop `@exodus/bytes` and switch back to
  `Uint8Array.fromBase64`/`toBase64`.
- `esbuild` (devDependency of `apps/extension`) bundles the extension.
  It became necessary the moment the extension started importing
  `@xarsh/archivebridge`: a service worker, an offscreen document and a
  popup cannot resolve bare npm specifiers, and `tsc` does not bundle.
  esbuild does that one job; a WebExtension framework (WXT and similar)
  was evaluated and rejected because it would also take over the
  manifest, a dev server, per-browser output and an HTML pipeline for an
  extension that has one manifest, three entry points and two HTML
  files. See docs/architecture.md, "Building the extension".
- `buffer` and `string_decoder` (dependencies of `apps/extension`) are
  bundle-time polyfills, needed only because `iconv-lite` is written
  against Node's `Buffer`. They are not a new capability and must not
  become one: no extension source may import them. Aliasing
  `iconv-lite` to a stub instead was rejected — it would silently change
  what the library does with a non-UTF-8 resource. Both go away if
  `iconv-lite` does.
- `playwright` (devDependency of `apps/extension`) drives the extension
  E2E suite. Note the package: `playwright`, **not**
  `@playwright/test` — the runner stays `node:test` (see Testing
  philosophy). Its cost is two packages
  (`playwright` -> `playwright-core`) against the several hundred lines
  of browser-launch, target-discovery and worker-attach code a
  home-grown CDP harness would need us to maintain. See
  docs/architecture.md, "Browser automation".
- devDependencies are otherwise `typescript`, `@types/node`,
  `@biomejs/biome`. Don't add ESLint, Prettier, Vitest/Jest/Mocha,
  tsx/ts-node, or a CLI argument-parser library without discussing it
  first — these were explicitly excluded from the initial design.
- `@types/chrome` was **not** added. `apps/extension` hand-writes
  ambient declarations for exactly the `chrome.*` members it calls
  (`src/chrome/chrome-api.d.ts`), so that file doubles as the reviewable
  list of platform APIs the extension depends on. The risk of
  hand-written types drifting from the runtime is covered by exercising
  every one of them against a real Chromium in `e2e/`. If that surface
  ever grows past a page or two, reconsider.

## TypeScript conventions

Strict compiler settings (`strict`, `noUncheckedIndexedAccess`,
`exactOptionalPropertyTypes`, `erasableSyntaxOnly`,
`verbatimModuleSyntax`) are non-negotiable — see root `tsconfig.json` and
[docs/architecture.md#typescript-configuration](docs/architecture.md#typescript-configuration)
for why each is enabled. Within that:

- Use discriminated unions + string literal types for finite sets
  (`ArchiveFormat`, `Diagnostic`, CLI commands, ...), and prefer
  exhaustive `switch` statements with no `default` case so adding a new
  variant is a compiler error until every call site handles it.
- Prefer explicit `interface`/`type` declarations over clever
  conditional/mapped/recursive/template-literal types. Only reach for
  advanced type-level programming when it makes the actual API or
  implementation clearer — never because "it can be expressed in types."
- Prefer standard platform types (`Uint8Array`, `ArrayBuffer`, `Map`,
  `Set`, `URL`, `TextEncoder`/`TextDecoder`, `Blob`, `ReadableStream`)
  over custom wrapper types.
- Use `unknown` + runtime narrowing for untrusted input (archive bytes,
  CLI args, browser file input, external data); reach for `any` only in a
  narrow, isolated spot where no reasonable type is possible — never as a
  way to avoid modeling something.
- TypeScript's type system is a contract for code *after* runtime
  validation, not a substitute for it. MHTML/WebArchive bytes, CLI
  arguments, and any other external input must be validated at runtime.
- Runtime-only code (CLI, tests) should run directly via Node's built-in
  TypeScript type stripping. The published npm package must ship compiled
  JS + `.d.ts` (via `tsc`) — consumers of `@xarsh/archivebridge` must
  never be required to run TypeScript source directly.
- These conventions govern **workspace source** (`packages/*`, `apps/*`).
  Repo-level tooling under `scripts/` is deliberately plain ESM
  JavaScript (`.mjs`) instead: it is dependency-free bootstrap tooling
  that must run under a bare `node` with no tsconfig and no build step,
  and `scripts/` is covered by no workspace tsconfig, so a `.ts` file
  there would be type-*annotated* without ever being type-*checked* —
  the appearance of safety without the substance. Keep `scripts/` in
  JavaScript unless it grows enough to justify its own tsconfig wired
  into `npm run typecheck`.

## Testing philosophy

- `node:test` + `node:assert/strict` only — no Vitest/Jest/Mocha. Test
  files are TypeScript, run directly via Node's type stripping.
- Prefer returning diagnostics over throwing: one malformed resource
  should not fail parsing an entire archive.
- `playwright` is used only inside `apps/extension/e2e/`, and only to
  drive a real browser. It is not a general-purpose test tool for this
  repository: nothing outside that directory should import it.
- See [docs/architecture.md#testing](docs/architecture.md#testing) for
  the full fixture-layer strategy (unit → golden fixtures → bug
  regression fixtures → round-trip → malformed-input → browser extension
  E2E → opt-in real-world corpus).

## npm scripts

Run from the repo root:

- `npm run build` — build all workspaces
- `npm run typecheck` — typecheck all workspaces
- `npm test` — run all workspace tests (`node --test`)
- `npm run lint` — Biome check (format, lint, and import-sorting diagnostics; no writes)
- `npm run format` — Biome check --write (applies formatting, import sorting, and safe lint fixes)
- `npm run check:filenames` — verifies file/directory naming policy (see File and directory naming)
- `npm run check` — build + typecheck + test + lint + check:filenames (the pre-PR gate)
- `npm run test:e2e` — the extension's browser E2E suite (opt-in, see below)

**`build` runs first in `check`, and has to.** `apps/extension` consumes
`@xarsh/archivebridge` as a published package would — through its
`exports` map, from `dist/` — so both its typecheck and its tests need the
library built. Building first keeps that dependency explicit instead of
depending on a stale `dist/` happening to be lying around.

Both workspaces expose the same script names (plus `check` and `clean`)
so either can be run standalone.

## Extension E2E tests

`apps/extension/e2e/` loads the **real built extension** into a real
Chromium, captures a deterministic local page, saves it in both formats,
and verifies the resulting bytes with `@xarsh/archivebridge` itself.
There is no fake `chrome` object and no test-only branch in `src/`.

```sh
npx playwright install chromium   # once
npm run build
npm run test:e2e
```

It is **not** part of `npm run check`, because it needs a browser binary
that the unit-test gate must not require. It has its own CI job instead.

Three rules for anything added here:

- **Assert on bytes, not on dialogs.** The suite drives the production
  save path unmodified — including `saveAs: true` — and the download
  completes because Playwright *replaces* Chrome's download pipeline, so
  there is neither a chooser nor a filename-determination step (it is not,
  as it looks, headless Chromium auto-accepting a chooser). Never make an
  OS file chooser a CI gate. A test that needs a download to sit *pending*
  has to ask for Chrome's own pipeline back and give up asserting on
  written bytes — see `e2e/save-lifecycle.test.ts`.
- **One browser at a time.** `--test-concurrency=1` is deliberate.
  `chrome.pageCapture.saveAsMHTML` writes through a temp file and
  intermittently fails with `FILE_NOT_FOUND`/`ACCESS_DENIED` when two
  browser sessions run at once (observed at roughly 1 run in 5), which
  looks exactly like a product bug and is not one.
- **Never add a branch to `src/` for a test's benefit.** If something is
  hard to observe, the seam probably belongs in the product architecture
  anyway (capture/convert bytes on one side, save through a browser
  adapter on the other) — see docs/architecture.md, "The Chrome v0.1
  pipeline". Where a test needs to reach past the extension it uses a real
  Chrome API from a context of its own — an extension page, or the
  browser's `Target` CDP domain — never a hook in `src/`.

## File and directory naming

Project-owned files and directories use lowercase kebab-case (e.g.
`to-mhtml.ts`, `html-rewrite.test.ts`). Conventional ecosystem/tool-mandated
names (`README.md`, `package.json`, `tsconfig.json`, `manifest.json`,
`.gitignore`, `.github/`, ...) are exempt. This is enforced by Biome's
`useFilenamingConvention` rule for JS/TS files and by
`npm run check:filenames` (`scripts/check-filenames.mjs`) for everything
else.

## Adding regression fixtures

When fixing a bug reported against a real archive, reduce it to the
smallest archive that reproduces it, add it under `fixtures/mhtml/` or
`fixtures/webarchive/` with a descriptive name (not a counter), and add a
permanent test against it. Keep fixtures small and, where possible,
text-editable — no large binary fixtures without a specific need, and
document the need in `fixtures/README.md` when there is one (as
`mdn-background-image.*` does). A golden fixture captured from a
third-party page also needs its source and license recorded there before
it lands. See [fixtures/README.md](fixtures/README.md).

## Boundaries to keep

- **Browser-specific code does not belong in `packages/archivebridge`.**
  The library must run in Node.js (parsing, serialization, CLI) without
  any DOM/WebExtension API dependency.
- **Node-specific code does not belong in the library's public API
  surface.** Anything exported from `@xarsh/archivebridge`'s main entry
  point should be usable without assuming a Node.js runtime, even though
  the CLI (which does depend on Node) lives in the same package.
- **`apps/extension` must not reimplement archive parsing, conversion or
  format detection.** It consumes `@xarsh/archivebridge`. All of its
  archive logic is one module, `src/core/archive-bytes.ts`, and that
  module's job is to call the library — not to know anything about MIME
  or plists.
- **`apps/extension/src/core/` stays free of browser APIs.** No
  `chrome.*`, no DOM, no `navigator`. Per-browser platform code lives in
  `src/chrome/` (and, later, `src/firefox/`, `src/safari/`). This is
  enforced by the type checking split: `core/` is the only source
  directory that compiles under both the browser tsconfig and the Node
  one, and it is what lets the whole byte-generation path be tested
  without a browser.
- **Runtime dependency additions need a stated reason** — see Dependency
  policy above.
