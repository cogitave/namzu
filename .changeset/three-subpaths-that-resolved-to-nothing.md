---
'@namzu/files': major
---

`./postgres`, `./s3` and `./gcs` are removed. They resolved to nothing.

Each was `export {}` behind a published subpath — a placeholder for an adapter
that had not been written. The import **succeeded**, so a consumer writing

```ts
import { S3BlobStore } from '@namzu/files/s3'
```

got no error from the module system and no module either: `S3BlobStore` was
`undefined`, discovered wherever it was first called rather than at the import.
That shipped in 0.2.1.

Nothing can break that was working, because there was nothing to import. If you
have one of these specifiers in a file, delete the line — it was never giving
you anything. `./`, `./inmem`, `./local`, `./azure-blob` and `./http` are
unchanged.

Major rather than minor because a subpath leaving `exports` is a removal from
the published surface, whatever it contained. The adapters are still intended;
they will arrive as subpaths again when there is something behind them.

`.github/scripts/verify-public-surface.mjs` now fails on any entry point whose
runtime and declared surfaces are both empty, so the next placeholder cannot be
published as though it were an API.
