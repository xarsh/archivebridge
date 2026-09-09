# ArchiveBridge

ArchiveBridge is an interoperability layer for saved web page archive
formats: **MHTML/MHT** and **Safari WebArchive** (`.webarchive`). MHTML is
its canonical format — WebArchive converts to and from MHTML directly,
with no shared intermediate model in between. It reads and writes both
formats, converts between them, and exposes that through a CLI and a
browser extension.

> **Status: early but functional.** The library and CLI work; the browser
> extension is a UI placeholder. See
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
- Tolerate real-world broken/incomplete archives without all-or-nothing
  failures: problems come back as diagnostics, not exceptions
- No network access and no archive-script execution while parsing or
  converting — archive files are treated as untrusted input

## Planned

- Capturing and saving the current page from a browser extension. The
  extension is currently a **UI placeholder** (a popup that lists dropped
  files); Chrome, Edge, Firefox, and Safari are all planned first-class
  targets, and that four-browser commitment is an architectural
  constraint, not a wish — see
  [docs/architecture.md](docs/architecture.md#browser-extension-capture-and-save-are-separate-per-browser-concerns).
- A `validate` command (not part of the CLI today).

## Repository layout

```
archivebridge/
├── apps/extension/          # Browser extension — UI placeholder for now
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
npm run check   # typecheck + test + lint + filename policy + build
```

`npm run check` is the pre-PR gate and is exactly what CI runs. Other root
scripts: `npm run build`, `npm run typecheck`, `npm test`, `npm run lint`,
`npm run format`, `npm run check:filenames`. `packages/archivebridge`
exposes the same script names and can be run standalone; `apps/extension`
exposes all but `test`/`check`, since it has no tests yet.

## Packages

- [`packages/archivebridge`](packages/archivebridge) — `@xarsh/archivebridge`,
  the core library and CLI. This is the whole of the working functionality.
- [`apps/extension`](apps/extension) — the ArchiveBridge browser
  extension. UI placeholder; Chrome/Edge/Firefox/Safari are planned
  first-class targets.

## License

MIT — see [LICENSE](LICENSE).
