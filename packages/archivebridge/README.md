# @xarsh/archivebridge

Interoperability layer for saved web page archive formats: MHTML/MHT and
Safari WebArchive (`.webarchive`).

> Early but functional. Reading, writing, and converting between MHTML and
> Safari WebArchive are implemented for single-document archives (no
> frames yet). See the repository root [README](../../README.md) and
> [docs/architecture.md](../../docs/architecture.md) for current status and
> design.

## Install

Not published yet.

## Usage

```ts
import { parseMhtml, serializeWebArchive } from "@xarsh/archivebridge"

const { archive, diagnostics } = parseMhtml(mhtmlBytes)
if (archive) {
  const webArchiveBytes = serializeWebArchive(archive)
}
```

## CLI

```
archivebridge inspect <file>
archivebridge convert <input> <output>
archivebridge extract <file> <output-dir>
```

`inspect` and `convert` are implemented for MHTML and WebArchive.
`extract` is recognized but not implemented yet.
