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
  when flattening frames during WebArchive → MHTML conversion
  (`mhtml/html-rewrite.ts`) — and, for the archive viewer *and* the
  MHTML → WebArchive `cid:` rewrite, to locate *every* attribute and
  `<style>` body they have to rewrite (`view/html-sites.ts`, shared by
  `view/render.ts` and `convert/cid-references.ts` so that "which
  attributes can name a resource" exists in exactly one place). It's used
  purely to find exact
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
- **No CSS parser**, and that is a decision rather than an omission. The
  viewer (and the converter's `cid:` rewrite) rewrites `url()` and
  `@import` inside archived stylesheets with a
  small hand-written scanner (`view/css-rewrite.ts`) over CSS Syntax Level
  3's relevant tokenizer states: comments, strings, url tokens, and ident
  sequences. That last one is not optional — identifiers may be written
  with escapes and the spec compares a token's *decoded* value, so
  `u\72l(` and `@\69mport` are real spellings that Chromium loads, and a
  scanner matching raw keyword bytes ships them unrewritten. The scanner
  also tracks which function a string token sits in, because a bare string
  in `image-set()` is a URL — including one written in a `var()`/`env()`/
  `if()` fallback inside that call, which substitution puts in the same
  place. What it deliberately does not do is evaluate the cascade: a string
  carried into an `image-set()` by a custom property defined elsewhere is
  rule 1's documented exception, where the viewer's CSP is the mandatory
  mechanism. This is the
  opposite conclusion from HTML above, for a stated reason: HTML
  tokenization has tree-construction feedback where "which text is markup"
  depends on the parse, while a `url(` inside a CSS comment or string is
  unreachable from these flat states. `postcss`/`css-tree`/`lightningcss`
  would each be an order of magnitude larger than the problem. See
  docs/architecture.md, "Resource resolution and CSS".
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
  extension that has one manifest, four entry points and three HTML
  files. See docs/architecture.md, "Building the extension".
- `buffer` and `string_decoder` (dependencies of `apps/extension`) are
  bundle-time polyfills, needed only because `iconv-lite` is written
  against Node's `Buffer`. They are not a new capability and must not
  become one: no extension source may import them. Aliasing
  `iconv-lite` to a stub instead was rejected — it would silently change
  what the library does with a non-UTF-8 resource. Both go away if
  `iconv-lite` does.
- `playwright` (devDependency of `apps/extension`) drives the **Chrome**
  E2E suite. Note the package: `playwright`, **not**
  `@playwright/test` — the runner stays `node:test` (see Testing
  philosophy). Its cost is two packages
  (`playwright` -> `playwright-core`) against the several hundred lines
  of browser-launch, target-discovery and worker-attach code a
  home-grown CDP harness would need us to maintain. See
  docs/architecture.md, "Browser automation".
- **The Firefox E2E suite adds no dependency at all**, and that is a
  deliberate result rather than a happy accident: Playwright cannot load a
  Firefox extension, so the alternatives were `web-ext`/`selenium` or
  Firefox's own remote agent. The remote agent speaks WebDriver BiDi over
  a WebSocket, Node has had a global `WebSocket` since 22, and the
  protocol surface the lane needs is six commands — see
  `e2e/firefox/bidi-session.ts`. `web-ext` stays useful for interactive
  development and must not become a CI requirement.
- `adm-zip` (devDependency of the repo root only, never of a workspace) packages
  the built extension into the Chrome ZIP release artifact
  (`scripts/package-extension.mjs`). It both writes and reads ZIPs, so the
  same dependency verifies the artifact it just built — no second package is
  needed just for inspection. Pinned to `^0.6.1`, the release that fixed two
  high-severity advisories (GHSA-xcpc-8h2w-3j85, GHSA-vwc7-r8mq-g2x9) in
  earlier `0.x` versions; check `npm audit` before ever lowering this range.
- devDependencies are otherwise `typescript`, `@types/node`,
  `@biomejs/biome`. Don't add ESLint, Prettier, Vitest/Jest/Mocha,
  tsx/ts-node, or a CLI argument-parser library without discussing it
  first — these were explicitly excluded from the initial design.
- `@types/chrome` and `@types/firefox-webext-browser` were **not** added.
  `apps/extension` hand-writes ambient declarations for exactly the
  `chrome.*`/`browser.*` members it calls
  (`src/chrome/chrome-api.d.ts`, `src/firefox/firefox-api.d.ts`), so those
  files double as the reviewable list of platform APIs the extension
  depends on. The risk of hand-written types drifting from the runtime is
  covered by exercising every one of them against a real browser in
  `e2e/`. If either surface ever grows past a page or two, reconsider.

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
  JavaScript (`.mjs`) instead: it is bootstrap tooling that must run
  under a bare `node` with no tsconfig and no build step (most of it is
  also dependency-free; `scripts/package-extension.mjs` is the one
  exception — see Dependency policy's `adm-zip` entry), and `scripts/`
  is covered by no workspace tsconfig, so a `.ts` file
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
- `npm run lint` — Biome check (format, lint, and import-sorting diagnostics; no writes).
  `biome.json`'s `files.includes` excludes four paths, and they are four
  rather than a blanket rule on purpose: `**/dist` and `**/dist-firefox`
  are build output, `artifacts/` is generated release packaging, and
  `docs/research/` is intentionally local, git-excluded research. The last
  two exist in a normal working copy and not in CI, so without those two
  entries `npm run check` is green on CI and red on the machine that has
  to pass it. Nothing tracked is excluded, and nothing should be added
  here that is.
- `npm run format` — Biome check --write (applies formatting, import sorting, and safe lint fixes)
- `npm run check:filenames` — verifies file/directory naming policy (see File and directory naming)
- `npm run check:versions` — verifies the locked-step version contract (see Release process below)
- `npm run check` — build + typecheck + test + lint + check:filenames + check:versions (the pre-PR gate)
- `npm run test:e2e` — the extension's Chrome E2E suite (opt-in, see below)
- `npm run test:e2e:firefox` — the extension's Firefox E2E suite (opt-in, see below)
- `npm run package:extension` — builds the extension and packages it into
  `artifacts/archivebridge-chrome-<version>.zip` (see Release process below)

**`build` runs first in `check`, and has to.** `apps/extension` consumes
`@xarsh/archivebridge` as a published package would — through its
`exports` map, from `dist/` — so both its typecheck and its tests need the
library built. Building first keeps that dependency explicit instead of
depending on a stale `dist/` happening to be lying around.

Both workspaces expose the same script names (plus `check` and `clean`)
so either can be run standalone.

## Extension E2E tests

`apps/extension/e2e/` loads the **real built extension** into a real
browser. There are two suites, one per browser, and they are separate
scripts and separate CI jobs because they need different binaries.

### Chrome (`e2e/*.test.ts`, Playwright)

Two lanes. The **save** lane captures a deterministic local page, saves it
in both formats, and verifies the resulting bytes with
`@xarsh/archivebridge` itself. The **view** lane writes a real
`.webarchive` to disk, navigates the browser to its `file://` URL, and
asserts against the archived DOM Chrome laid out after the extension's own
`declarativeNetRequest` rule redirected it — including that a hostile
archive reaches the local beacon server zero times, by request *and* by
TCP connection. There is no fake `chrome` object and no test-only branch
in `src/`.

```sh
npx playwright install chromium   # once
npm run build
npm run test:e2e
```

### Firefox (`e2e/firefox/*.test.ts`, WebDriver BiDi)

Playwright cannot load a Firefox extension — extensions work only in
Chromium, and only with a persistent context — so this lane uses Firefox's
own remote agent over WebDriver BiDi, driven from Node's global
`WebSocket`. **No new dependency, and deliberately not `web-ext`:**
`web-ext` is a fine tool for interactive development (`web-ext run`
against a live profile) and is not required to run these tests.

The suite launches headless Firefox with a throwaway profile, installs
`dist-firefox/` with `webExtension.install`, and drives the extension
through its own pages at a `moz-extension://<uuid>/` address pinned by an
`extensions.webextensions.uuids` pref in that profile (BiDi does not
expose an extension's background realm, so there is no Firefox equivalent
of evaluating inside the service worker). The pref lives in the test
profile, never in `src/`.

Two more things about this lane are forced by measured Firefox behavior
rather than chosen, and both are worth knowing before adding a test:

- **A `saveAs: true` download cannot complete here, and must not be made
  to.** With the native chooser open the `downloads.download` promise
  stays pending and `downloads.search({})` reports *zero* items, so the
  saved bytes are unreadable from the lane. Playwright's replacement of
  Chrome's download pipeline has no Firefox equivalent. The capture and
  conversion path is therefore asserted at the nearest observable browser
  API boundary (`scripting.executeScript` from an extension page, then the
  browser-neutral modules), and the save command is asserted by what it
  *does*: settle promptly when it cannot capture, and still be running
  when it has captured and is waiting on the chooser. Never weaken
  `saveAs: true` in `src/` to get a file on disk.
- **A permission prompt needs a real input event.** BiDi's own
  `userActivation: true` flag does not satisfy
  `browser.permissions.request()`; a synthesized pointer click through
  `input.performActions` does. The doorhanger it would raise is native UI,
  so the test profile sets
  `extensions.webextOptionalPermissionPrompts=false` to answer it — which
  changes who answers the prompt, not whether production asks. The
  gesture, the call site and its ordering are all the real ones.

```sh
npm run build
npm run test:e2e:firefox          # uses `firefox` from PATH
FIREFOX_BIN=/path/to/firefox npm run test:e2e:firefox
```

Firefox is taken from the machine rather than pinned or downloaded, the
same way the Chrome lane uses whatever `npx playwright install chromium`
fetched. The floor that *is* enforced is `manifest.firefox.json`'s
`strict_min_version: "128.0"`, which the browser itself checks at install:
an older Firefox refuses the extension and the suite fails loudly instead
of quietly testing something else.

Neither suite is part of `npm run check`, because both need a browser
binary that the unit-test gate must not require. Each has its own CI job.

Four rules for anything added here:

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
- **Hostile fixtures are hand-built, on purpose.** Blink's capture strips
  `<script>` and drops `srcset`, so a browser-captured archive cannot
  carry the content the security tests exist to prove is inert. The
  hostile and resource fixtures in `e2e/viewer-fixtures.ts` are built
  through the library's own public `serializeWebArchive` — which is also
  the more realistic shape, since real `.webarchive` files come from
  WebKit, whose capture keeps all of it.
- **Never add a branch to `src/` for a test's benefit.** If something is
  hard to observe, the seam probably belongs in the product architecture
  anyway (capture/convert bytes on one side, save through a browser
  adapter on the other) — see docs/architecture.md, "The Chrome v0.1
  pipeline". Where a test needs to reach past the extension it uses a real
  Chrome API from a context of its own — an extension page, or the
  browser's `Target` CDP domain — never a hook in `src/`.

## Release process

ArchiveBridge is one product with **one locked-step version**, not
independently versioned components. These four must always report the same
version:

- root `package.json`
- `packages/archivebridge/package.json`
- `apps/extension/package.json`
- `apps/extension/manifest.json` (Chrome/Edge)
- `apps/extension/manifest.firefox.json`

`npm run check:versions` (`scripts/check-versions.mjs`) enforces this and is
part of `npm run check`, so drift is caught on every push/PR, not only at
release time. Bump all five together; there is no bump-automation tooling
(no Changesets/Lerna/release-please) — this is intentionally simple.

The release tag convention is `v<version>` (e.g. `v0.1.0`), matched against
the root version by `.github/workflows/release.yml`, which also builds
`npm run package:extension`'s output
(`artifacts/archivebridge-chrome-<version>.zip`) and attaches it to the
GitHub Release. `artifacts/` is generated, git-ignored, and safe to delete
locally. Publishing `@xarsh/archivebridge` to npm is a separate, not-yet-done
release concern — the Chrome ZIP bundles the local workspace library code,
so installing the extension never depends on the npm registry version.

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
- **`apps/extension` must not reimplement archive parsing, conversion,
  format detection or archive-content rewriting** — including on the
  capture side: an ArchiveBridge-authored capture (Firefox, later Safari)
  assembles an `MhtmlDocument` and hands it to the library's serializer
  rather than writing MIME by hand. It consumes
  `@xarsh/archivebridge`. Its save path's archive logic is one module,
  `src/core/archive-bytes.ts`, and its viewer's is one call to
  `renderMhtml`; both jobs are to call the library, not to know anything
  about MIME, plists, HTML offsets or CSS tokens. This is also why the
  viewer's reconstruction lives in `packages/archivebridge/src/view/`
  despite being a product feature of the extension: it is browser-neutral
  (its one platform dependency is an injected `createResourceUrl`
  callback), it needs `parse5` and the charset codecs, and putting it here
  is what keeps the later Firefox and Safari viewers a different loader
  rather than a second implementation.
- **`apps/extension/src/core/` stays free of browser APIs.** No
  `chrome.*`, no `browser.*`, no DOM, no `navigator`. Per-browser platform
  code lives in `src/chrome/` and `src/firefox/` (and, later,
  `src/safari/`), which are deliberately parallel rather than shared: the
  two differ in service-worker-vs-event-page lifetime, `contextMenus` vs
  `menus`, and whether an offscreen document exists, and an abstraction
  over those would hide exactly the differences that matter. A little
  duplicated platform glue is the intended cost. This is
  enforced by the type checking split: `core/` is the only source
  directory that compiles under both the browser tsconfig and the Node
  one, and it is what lets the whole byte-generation path be tested
  without a browser.
- **Runtime dependency additions need a stated reason** — see Dependency
  policy above.
