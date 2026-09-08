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
  output. Keep additions reasonably small where the source page allows it.
- **Regression fixtures get names, not numbers.** When a bug report leads
  to a fix, add the minimal archive that reproduces it under the
  appropriate format directory with a name describing the bug (e.g.
  `duplicate-content-id.mhtml`), not just an incrementing counter. Note the
  origin (issue link, browser/version that produced it) in a comment or
  sibling `.md` file if it isn't obvious from the name.
- **No fetching from the live web in tests.** Fixtures are committed files;
  don't have tests download archives at runtime.
