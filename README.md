# ArchiveBridge

ArchiveBridge is an interoperability layer for saved web page archive
formats: **MHTML/MHT** and **Safari WebArchive** (`.webarchive`). It reads
and writes both formats, converts between them, and exposes that through a
CLI and a browser extension — all built on a shared, format-independent
archive model.

> **Status: early but functional.** Reading, writing, and converting
> between MHTML and Safari WebArchive are implemented for single-document
> archives (no frames yet), along with `inspect`/`convert` in the CLI. See
> [docs/architecture.md](docs/architecture.md) for design rationale and
> [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidelines.

## Goals

- Read and write MHTML/MHT
- Read and write Safari WebArchive
- Convert between archive formats
- `inspect` / `convert` / `extract` from a CLI
- The same functionality from a browser extension (Firefox first, then
  Chrome/Chromium from the same codebase)
- Tolerate real-world broken/incomplete archives without all-or-nothing
  failures
- No unnecessary network access while inspecting an archive
- Treat archive files as untrusted input

## Repository layout

```
archivebridge/
├── apps/extension/          # Browser extension (Firefox first)
├── packages/archivebridge/  # @xarsh/archivebridge — library + CLI
├── fixtures/                 # Shared test fixtures
├── docs/                     # Design docs
└── .github/workflows/        # CI
```

`packages/archivebridge` is published as `@xarsh/archivebridge` and
provides both the JS/TS API and the `archivebridge` CLI executable from a
single package.

## Development

Requires Node.js >= 24 and npm (this repo uses npm workspaces; no other
package manager is supported).

```sh
npm install
npm run check   # typecheck + test + lint, everything
```

Other root scripts: `npm run build`, `npm run typecheck`, `npm test`,
`npm run lint`, `npm run format`. `packages/archivebridge` exposes the
same script names and can be run standalone; `apps/extension` exposes all
but `test`/`check`, since it has no tests yet.

## Packages

- [`packages/archivebridge`](packages/archivebridge) — `@xarsh/archivebridge`,
  the core library and CLI.
- [`apps/extension`](apps/extension) — the ArchiveBridge browser
  extension.

## License

MIT — see [LICENSE](LICENSE).
