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
- devDependencies are `typescript`, `@types/node`, `@biomejs/biome`.
  Don't add ESLint, Prettier, Vitest/Jest/Mocha, tsx/ts-node, or a CLI
  argument-parser library without discussing it first — these were
  explicitly excluded from the initial design.

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
- See [docs/architecture.md#testing](docs/architecture.md#testing) for
  the full fixture-layer strategy (unit → golden fixtures → bug
  regression fixtures → round-trip → malformed-input → extension
  integration → opt-in real-world corpus).

## npm scripts

Run from the repo root:

- `npm run build` — build all workspaces
- `npm run typecheck` — typecheck all workspaces
- `npm test` — run all workspace tests (`node --test`)
- `npm run lint` — Biome check (format, lint, and import-sorting diagnostics; no writes)
- `npm run format` — Biome check --write (applies formatting, import sorting, and safe lint fixes)
- `npm run check:filenames` — verifies file/directory naming policy (see File and directory naming)
- `npm run check` — typecheck + test + lint + check:filenames + build (the pre-PR gate)

`packages/archivebridge` exposes the same script names (plus `check` and
`clean`) so it can be run standalone. `apps/extension` exposes
`build`/`typecheck`/`lint`/`format` the same way, but has no `test` or
`check` script yet since the extension has no tests to run.

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
- **`apps/extension` must not reimplement archive parsing/format
  detection.** It consumes `@xarsh/archivebridge`; if that's not wired up
  yet (see [docs/architecture.md](docs/architecture.md)'s WXT/bundler
  note), keep the extension UI-only rather than duplicating logic.
- **Runtime dependency additions need a stated reason** — see Dependency
  policy above.
