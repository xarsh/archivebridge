# @xarsh/archivebridge

Interoperability layer for saved web page archive formats: MHTML/MHT and
Safari WebArchive (`.webarchive`).

> Early but functional. Reading, writing, and converting between MHTML and
> Safari WebArchive are implemented, including frames at arbitrary nesting
> depth and a metadata sidecar that preserves residual WebArchive-only
> fields across a conversion. See the repository root
> [README](../../README.md) and [docs/architecture.md](../../docs/architecture.md)
> for current status and design.

## Install

Not published yet.

## Usage

```ts
import { parseMhtml, convertMhtmlToWebArchive, serializeWebArchive } from "@xarsh/archivebridge"

const { document, diagnostics } = parseMhtml(mhtmlBytes)
if (document) {
  const { document: webArchiveDocument } = convertMhtmlToWebArchive(document)
  const webArchiveBytes = serializeWebArchive(webArchiveDocument)
}
```

## CLI

```
archivebridge inspect <file>
archivebridge convert <input> <output>
```

`inspect` and `convert` both work for MHTML and WebArchive input, and are
the complete command surface — there is no `validate` or `extract`.
Input format is detected from the bytes; `convert`'s output format comes
from the output file's extension (`.mhtml`, `.mht`, or `.webarchive`).

## License

MIT — see [LICENSE](LICENSE).
