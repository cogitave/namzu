# Conformance vectors

A vector set records what one module of the kernel answers for a fixed list of inputs, in a form that does not depend on TypeScript. A second implementation of the module, in any language, is held to the same answers by running its own code over the same file. The TypeScript implementation is the reference: the file is generated from it, never written by hand.

This folder is not a workspace package. It holds data and this page; the generator is a script and the drift test is in the SDK suite.

## Sets

| Folder | Module | Generator |
|---|---|---|
| `glob-segment/` | `packages/sdk/src/sandbox/glob-segment.ts`, the compiler for one path segment of a glob | `scripts/generate-conformance-vectors.mjs` |

## Shape of `glob-segment/vectors.json`

```json
{
  "about": "text for a reader of the file",
  "limits": { "maxSegmentLength": 1024 },
  "names": ["", "a", "b", ".a"],
  "cases": [
    { "segment": "a", "dot": false, "ok": { "literal": "a", "source": "^a$" }, "matches": "0100" },
    { "segment": "[", "dot": true, "error": { "kind": "too-complex", "message": "..." } }
  ]
}
```

- `names` is the list of file names every compiled expression is tried against.
- Each case is one call, `compileSegment(segment, dot)`, and has exactly one of `ok` and `error`.
- `ok.literal` is the plain name to compare against when the segment has no wildcard, else `null`. `ok.source` is a JavaScript regular expression source, to be compiled with the flags `u` and `s`. `matches` has one character per entry of `names`: `1` when that name matches the expression (or, for a literal, is equal to it), else `0`.
- `error.kind` is `too-complex` for a refusal (`GlobTooComplexError`) or `other` for anything else. `error.message` is the exact text of the message.
- `segment` is a string, or a generator `{ "repeat": "a", "times": 1025 }` meaning the text `repeat` written `times` times. A generator is used for a segment too long to carry in the file, such as one past `limits.maxSegmentLength`. An implementation expands it before the call; a refusal's message shows only the first 60 characters of the pattern and its length, so the file stays small either way.
- A port that cannot run a JavaScript regular expression compares the case after its own translation: it checks `literal` and `matches`, and checks `source` only if it keeps the same dialect.

## Regenerating

```bash
node --import tsx scripts/generate-conformance-vectors.mjs           # write the files
node --import tsx scripts/generate-conformance-vectors.mjs --check   # fail if they differ from the implementation
```

A change to the behaviour of a module with a vector set regenerates its vectors in the same commit, and the diff of the file is the review of what changed. The SDK test `glob-segment-vectors.test.ts` and the `check` step of CI fail when the committed file differs from what the implementation produces. A port that fails a case after a regeneration is told what changed by the diff, not by guessing.
