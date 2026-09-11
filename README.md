# ArchiveBridge

ArchiveBridge is an interoperability layer for saved web page archive
formats: **MHTML/MHT** and **Safari WebArchive** (`.webarchive`). MHTML is
its canonical format — WebArchive converts to and from MHTML directly,
with no shared intermediate model in between. It reads and writes both
formats, converts between them, and exposes that through a CLI and a
browser extension.

> **Status: early but functional.** The library, the CLI, and both saving
> and viewing from the Chrome/Edge extension all work; the Firefox and
> Safari extension targets do not exist yet. See
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
  web-origin permission required.
- **View local `.webarchive` files** in Chrome/Edge — the one archive
  format Chrome downloads instead of rendering. Open a `.webarchive` and
  the tab becomes an ArchiveBridge viewer: the archive is parsed,
  converted to canonical MHTML, and rebuilt into HTML the browser lays
  out, from archived bytes alone. See
  **[Viewing local archives](#viewing-local-archives-chromeedge)** below —
  it needs one Chrome setting turned on.
- Tolerate real-world broken/incomplete archives without all-or-nothing
  failures: problems come back as diagnostics, not exceptions
- No network access and no archive-script execution while parsing or
  converting — archive files are treated as untrusted input

## What the browser already does

ArchiveBridge fills gaps rather than duplicating what a browser has:

| | Save as MHTML | Save as WebArchive | Open local MHTML | Open local WebArchive |
| --- | --- | --- | --- | --- |
| Chrome / Edge | native | **ArchiveBridge** | native | **ArchiveBridge** |
| Firefox | *planned* | *planned* | shows plain text | *planned* |
| Safari | *planned* | native | *planned* | native |

In particular, **Chrome's own MHTML rendering is left alone.** It is not
merely adequate but stricter than an extension viewer can be — a
deliberately hostile `.mhtml` rendered from `file://` runs no scripts and
makes no network requests at all (measured) — so ArchiveBridge does not
intercept `.mht`/`.mhtml` on Chrome.

## Viewing local archives (Chrome/Edge)

**Chrome requires you to turn on file access for the extension**, and it
is off by default. Open `chrome://extensions`, find ArchiveBridge, choose
**Details**, and enable **"Allow access to file URLs"**. Without it Chrome
neither hands the navigation to the extension nor lets it read the file,
and a `.webarchive` simply downloads as before. The popup says so when the
setting is off; the extension cannot change it itself.

Associating `.webarchive` with Chrome at the OS level is likewise yours to
set up — ArchiveBridge does not manage file associations. Any way of
opening the file in Chrome works, including typing the `file://` URL.

What the viewer will and will not do, deliberately:

- Archived scripts **never run** — not inline ones, not event-handler
  attributes, not even a script the archive contains the bytes for.
- **Nothing is fetched from the network**, not a missing image and not a
  `preconnect` hint. A reference the archive does not contain stays
  missing and is listed in the viewer's notes.
- **Links do not navigate.** An archived link keeps its original target in
  a `data-archivebridge-href` attribute and goes nowhere when clicked,
  because following one would tell a server the archive had been opened.
- **SVG animations do not play.** SVG can animate an attribute with no
  JavaScript at all, including one holding a URL — which would let an
  archive put back a reference the viewer had just removed (measured). The
  animation elements are kept but made inert, so an animated SVG shows its
  first frame. Losing the animation was judged the cheaper half of that
  trade.
- **An icon taken from another archived SVG file may be missing.** SVG's
  `<use href="sprite.svg#icon">` does not copy an image — the browser
  parses the referenced file and runs its contents inside the page, external
  references included (measured). A `<use>` pointing into the same document
  works normally; one pointing at another file is refused and listed in the
  notes.

## Planned

- **Firefox and Safari** extension support. Both need an
  ArchiveBridge-authored capture implementation (neither has a native
  MHTML capture API), and Safari additionally needs a containing macOS
  app. Chrome, Edge, Firefox, and Safari are all first-class targets, and
  that four-browser commitment is an architectural constraint, not a
  wish — see
  [docs/architecture.md](docs/architecture.md#browser-extension-capture-and-save-are-separate-per-browser-concerns).
  Viewing has its own per-browser catch: Firefox cannot intercept a local
  archive automatically at all (neither `webRequest` nor
  `declarativeNetRequest` sees `file://` navigations), so viewing there
  will take an explicit click rather than a double-click.
- A `validate` command (not part of the CLI today).

ArchiveBridge deliberately does **not** try to add formats to the
browser's own Save As dialog (no browser exposes a hook for it) or
override `Cmd-S`, and there is no archive-conversion GUI — converting is
the CLI's job.

## Repository layout

```
archivebridge/
├── apps/extension/          # Browser extension — Chrome/Edge save + view
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

It loads the actual built extension into Chromium: one lane verifies the
bytes both save commands produce, the other navigates the browser to a
real local `.webarchive` and asserts on the archived page Chrome renders
— including that a deliberately hostile archive reaches the test server
zero times. See [CONTRIBUTING.md](CONTRIBUTING.md) for what it does and
does not cover.

## Packages

- [`packages/archivebridge`](packages/archivebridge) — `@xarsh/archivebridge`,
  the core library and CLI. All archive parsing, serialization,
  conversion and viewer reconstruction lives here; nothing else in the
  repository reimplements any of it.
- [`apps/extension`](apps/extension) — the ArchiveBridge browser
  extension. Saves the current page and views local `.webarchive` files on
  Chrome/Edge today; Chrome/Edge/Firefox/Safari are all first-class
  targets.

## License

MIT — see [LICENSE](LICENSE).
