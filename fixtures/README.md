# fixtures

Shared test fixtures for `packages/archivebridge`, the CLI, and
`apps/extension`. Nothing here is workspace-specific — any test in this
repo may reference these files by relative path.

## Layout

- `mhtml/` — MHTML/MHT sample archives
- `webarchive/` — Safari WebArchive sample archives

## Policy

- **Synthetic fixtures for unit tests.** Files like `minimal.mhtml` and
  `minimal.webarchive` are small, hand-written, and only exercise a single
  resource. They back the fast, targeted unit tests colocated with each
  parser/serializer.
- **Golden fixtures for real-world coverage.** Files named `<site>.<browser>.<ext>`
  (e.g. `example-com.chrome.mhtml`, `mdn-background-image.safari.webarchive`)
  are real Chrome/Safari-generated captures, used by the golden fixture
  tests (`*.golden.test.ts`) to regression-test against actual browser
  output. Keep additions reasonably small where the source page allows it,
  and record any third-party source page's license under "Third-party
  content and licensing" below before adding it.
- **Regression fixtures get names, not numbers.** When a bug report leads
  to a fix, add the minimal archive that reproduces it under the
  appropriate format directory with a name describing the bug (e.g.
  `duplicate-content-id.mhtml`), not just an incrementing counter. Note the
  origin (issue link, browser/version that produced it) in a comment or
  sibling `.md` file if it isn't obvious from the name.
- **No fetching from the live web in tests.** Fixtures are committed files;
  don't have tests download archives at runtime.

## Third-party content and licensing

Every fixture here is either hand-authored in this repository or a capture
of content that is explicitly public-domain-dedicated. There is no fixture
whose reuse terms are unresolved.

- `minimal.*`, `frames-nested.*`, `frames-cross-origin.*` — no third-party
  content at all (see the two provenance sections below).
- `example-com.*` — captures of <https://example.com/>, the IANA-operated
  reserved example domain. Its page is boilerplate placeholder text
  reserved for documentation use, and the capture carries no third-party
  asset beyond that text and Chrome's own extracted `cid:` stylesheet.
- `mdn-*` — captures of pages from MDN's example repositories, both of
  which are **CC0 1.0 Universal** (public domain dedication, no attribution
  required, commercial use permitted). Exact provenance below.

### `mdn-*` provenance

| Fixture pair | Captured URL | Upstream repository | License |
| --- | --- | --- | --- |
| `mdn-background-image.{chrome.mhtml,safari.webarchive}` | `https://mdn.github.io/css-examples/learn/backgrounds-borders/background-image.html` | [`mdn/css-examples`](https://github.com/mdn/css-examples) ([LICENSE](https://github.com/mdn/css-examples/blob/main/LICENSE)) | CC0-1.0 |
| `mdn-js-and-css-preload.{chrome.mhtml,safari.webarchive}` | `https://mdn.github.io/html-examples/link-rel-preload/js-and-css/` | [`mdn/html-examples`](https://github.com/mdn/html-examples) ([LICENSE](https://github.com/mdn/html-examples/blob/main/LICENSE)) | CC0-1.0 |

`mdn.github.io/<repo>/` is the GitHub Pages deployment of the
correspondingly-named repository in the `mdn` organization, so each
captured resource maps 1:1 onto a file in that repository. The embedded
third-party resources are, in full:

- `learn/backgrounds-borders/background-image.html`, `learn/styles.css`,
  `learn/backgrounds-borders/star.png`, `learn/backgrounds-borders/balloons.jpg`,
  `learn/playable.js` — all from `mdn/css-examples`
- `link-rel-preload/js-and-css/index.html`,
  `link-rel-preload/js-and-css/style.css`,
  `link-rel-preload/js-and-css/main.js` — all from `mdn/html-examples`

The two `.js` resources appear only in the `.safari.webarchive` half of each
pair, not the `.chrome.mhtml` half. That asymmetry is expected: Chrome's
native capture serializes the post-script-execution DOM with `<script>`
elements stripped, so it never carries a script resource, while WebKit's
`createWebArchiveData()` records the fetched script as an ordinary
subresource (see ../docs/architecture.md, "Format vs. capture semantics").

CC0-1.0 covers all of them, so these fixtures may be redistributed here
without attribution or notice obligations. This section records the
provenance anyway, because knowing which upstream file a fixture resource
came from is what makes the golden tests' URL assertions auditable.

### Why `mdn-background-image.*` is large

`mdn-background-image.*` is ~275 KB across both formats, far larger than
any other fixture, and that is deliberate rather than incidental: **97% of
it is one resource**, `balloons.jpg` (109,360 bytes, byte-identical to the
upstream file). That single large binary is the point of the fixture:

- base64-encoded, it spans on the order of 1,900 wrapped lines of real
  Chrome output, which is the only fixture that exercises the
  line-offset-span body extraction and RFC 2045 §6.8 whitespace stripping
  (`mhtml/parse.ts`) at a scale where an off-by-one in line joining would
  actually show up.
- the golden tests assert the JPEG's trailing `FF D9` end-of-image marker
  specifically to prove the body survived that many lines without
  truncation — an assertion a small JPEG spanning a handful of lines could
  not meaningfully make.

Shrinking it would mean either re-encoding the image (at which point it is
no longer a real browser capture of a real page) or dropping the only
large-binary real-world coverage in the suite. Neither is worth ~275 KB, so
the size stands. This is the documented exception to "keep fixtures small"
in [../CONTRIBUTING.md](../CONTRIBUTING.md)'s fixture rules, not a
violation of it.

## Frame fixture provenance

`frames-nested.*`/`frames-cross-origin.*` (both formats) are real
browser-generated captures of fully local, hand-authored synthetic HTML
fixtures — not captures of any external/third-party site.

- `mhtml/frames-nested.chrome.mhtml`, `mhtml/frames-cross-origin.chrome.mhtml`
  — real `chrome.pageCapture.saveAsMHTML()`/CDP `Page.captureSnapshot`
  output, captured from a local static server. `frames-nested` has a
  2-level same-origin `<iframe>` chain (main → child → grandchild, each a
  `cid:`-linked sibling MIME part, all on `127.0.0.1:8091`);
  `frames-cross-origin` has one `cid:`-linked iframe sibling served from a
  *different* origin than its parent (`127.0.0.1:8092` vs `127.0.0.1:8091`),
  which is what makes it evidence for the claim that Chrome emits frames as
  flat sibling parts regardless of origin (../docs/architecture.md, "Frame
  representation"). Both originate from the
  `mhtml-canonical-experiment` research corpus's `synthetic/iframe-nested`
  and `synthetic/iframe-cross-origin` local fixtures (not tracked in this
  repo).
- `webarchive/frames-nested.safari.webarchive`,
  `webarchive/frames-cross-origin.safari.webarchive` — real WebKit output
  from `WKWebView.createWebArchiveData()`, via a standalone Swift capture
  harness (not part of this repo) driving an off-screen `WKWebView` against
  a local static server — not the Safari GUI app's own "Save As → Web
  Archive," so byte-for-byte equivalence to that path is unconfirmed
  (WebKit is the same engine either way). `frames-nested` has 2-level
  recursive `WebSubframeArchives` nesting (main → child → grandchild, only
  the grandchild's frame carries no `WebSubframeArchives`/`WebSubresources`
  keys at all); `frames-cross-origin` has two sibling subframes at one
  level, one same-origin and one cross-origin.
