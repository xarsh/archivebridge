# ArchiveBridge

ArchiveBridge is an interoperability layer for saved web page archive
formats: **MHTML/MHT** and **Safari WebArchive** (`.webarchive`). MHTML is
its canonical format — WebArchive converts to and from MHTML directly,
with no shared intermediate model in between. It reads and writes both
formats, converts between them, and exposes that through a CLI and a
browser extension.

> **Status: early but functional.** The library, the CLI, and saving from
> the Chrome/Edge extension all work; viewing archives in the browser and
> the Firefox/Safari extension targets do not exist yet. See
> [docs/architecture.md](docs/architecture.md) for design rationale and
> [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidelines.

## What works today

- Read and write MHTML/MHT
- Read and write Safari WebArchive
- Convert between the two formats directly, including frames
  (`<iframe>` ⇄ `WebSubframeArchives`) at arbitrary nesting depth
- A metadata sidecar that preserves WebArchive-only fields
  (`WebResourceResponse`, `WebResourceFrameName`, unknown plist keys)
  across a conversion to MHTML and back
- `archivebridge inspect` and `archivebridge convert` from the CLI
- **Save the current page** from the Chrome/Edge extension, as either
  MHTML or WebArchive — two commands in the toolbar popup and the page
  context menu, and nothing else. Chrome's own native capture produces
  the MHTML; WebArchive goes through the same converter the CLI uses. No
  host permissions required.
- Tolerate real-world broken/incomplete archives without all-or-nothing
  failures: problems come back as diagnostics, not exceptions
- No network access and no archive-script execution while parsing or
  converting — archive files are treated as untrusted input

## Planned

- **Viewing** local `.mht`/`.mhtml`/`.webarchive` files in the browser,
  for the formats a given browser cannot display itself. The architecture
  and the security constraints are settled; no viewer code exists yet —
  see [docs/architecture.md](docs/architecture.md#archive-viewer).
- **Firefox and Safari** extension support. Both need an
  ArchiveBridge-authored capture implementation (neither has a native
  MHTML capture API), and Safari additionally needs a containing macOS
  app. Chrome, Edge, Firefox, and Safari are all first-class targets, and
  that four-browser commitment is an architectural constraint, not a
  wish — see
  [docs/architecture.md](docs/architecture.md#browser-extension-capture-and-save-are-separate-per-browser-concerns).
- A `validate` command (not part of the CLI today).

ArchiveBridge deliberately does **not** try to add formats to the
browser's own Save As dialog (no browser exposes a hook for it) or
override `Cmd-S`, and there is no archive-conversion GUI — converting is
the CLI's job.

## Repository layout

```
archivebridge/
├── apps/extension/          # Browser extension — Chrome/Edge save commands
├── packages/archivebridge/  # @xarsh/archivebridge — library + CLI
├── fixtures/                # Shared test fixtures
├── docs/                    # Design docs
├── scripts/                 # Repo tooling (filename policy check)
└── .github/workflows/       # CI
```

`packages/archivebridge` is published as `@xarsh/archivebridge` and
provides both the JS/TS API and the `archivebridge` CLI executable from a
single package.

## Development

Requires Node.js >= 24 and npm (this repo uses npm workspaces; no other
package manager is supported).

```sh
npm install
npm run check   # build + typecheck + test + lint + filename policy
```

`npm run check` is the pre-PR gate and is exactly what CI runs. Other root
scripts: `npm run build`, `npm run typecheck`, `npm test`, `npm run lint`,
`npm run format`, `npm run check:filenames`. Both workspaces expose the
same script names and can be run standalone.

The extension's browser end-to-end suite is a separate opt-in lane,
because it needs a real browser binary:

```sh
npx playwright install chromium
npm run test:e2e
```

It loads the actual built extension into Chromium and verifies the bytes
both save commands produce. See [CONTRIBUTING.md](CONTRIBUTING.md) for
what it does and does not cover.

## Packages

- [`packages/archivebridge`](packages/archivebridge) — `@xarsh/archivebridge`,
  the core library and CLI. All archive parsing, serialization and
  conversion lives here; nothing else in the repository reimplements any
  of it.
- [`apps/extension`](apps/extension) — the ArchiveBridge browser
  extension. Saves the current page on Chrome/Edge today;
  Chrome/Edge/Firefox/Safari are all first-class targets.

## License

MIT — see [LICENSE](LICENSE).
