---
type: Reference
title: Native binary analysis
description: The namzu-analysis-native sidecar (a Rust process speaking NDJSON over stdio) and its TypeScript client, for reading ELF, PE and Mach-O files, their symbols and strings, and the JavaScript inside Bun and Node SEA executables, plus the asar reader.
resource: packages/analysis/src/native/index.ts
tags: [analysis, native, sidecar, bun, sea, asar, binary]
status: draft
generated: { by: claude-code/sonnet-5.5, at: 2026-10-21T00:00:00Z }
---

# Native binary analysis

`@namzu/analysis` answers questions about JavaScript. A compiled program is a different input: a file that is a Linux, Windows or macOS executable, often with its JavaScript appended as a payload (a Bun `--compile` build, a Node.js single executable, an Electron `app.asar`). `packages/analysis` carries the native lane beside its JavaScript index: it reads those files, lists what is in them, and can hand the recovered JavaScript to the index later.

The lane lives in `@namzu/analysis`, the package the CLI already depends on for the JavaScript index. The SDK declares the seam a host mounts — `NativeAnalysisProvider` in `types/native-analysis` — and serves the `binary_analysis` tool (`tools/builtins/native-analysis.ts`) over it; the CLI holds one whose constructor spawns nothing until the model's first call, and `namzu doctor` runs the sidecar's hello (`analysisNative.hello`).

## Shape

A Rust executable, `namzu-analysis-native`, reads one JSON request per line on stdin and writes one JSON response per line on stdout. The TypeScript client spawns it, queues requests, and kills and replaces it when a request overruns.

It is a separate process, not a Node addon and not WebAssembly, for three reasons: it can be killed and given a deadline (a hostile or huge file must not hold the host), it needs no Node ABI builds, and the same binary serves the CLI, tests and any other host.

It is read-only. No operation executes, loads or links the target, and nothing is written except by `extract_embedded`, into a directory the caller names.

```text
packages/analysis/
  native/            Rust crate (Cargo.lock committed, deny.toml)
    src/main.rs      the executable: argument parsing, the serve loop
    src/lib.rs       protocol, dispatch, bounded line reader
    src/{info,symbols,imports,strings,embedded}.rs   the ops
    src/{bun,sea}.rs readers for the two payload formats
    src/safepath.rs  confined writes
  src/native/        TypeScript client, asar reader, tests
  scripts/           native.mjs (cargo wrapper), check-licenses.mjs
```

## Protocol

Requests and responses are single-line JSON. The process answers requests in order, one at a time, and survives anything on its input.

```json
{"id": 1, "op": "strings", "params": {"path": "/usr/bin/ls", "contains": "usage", "limit": 2}, "deadlineMs": 5000, "maxBytes": 1048576}
```

```json
{"id":1,"ok":true,"result":{"complete":true,"nextCursor":null,"nextOffset":null,"scannedBytes":166640,"strings":[{"address":132706,"encoding":"ascii","fileOffset":132706,"length":59,"section":".rodata","text":"         default to 1024-byte blocks for file system usage;","truncated":false}],"total":1}}
```

```json
{"error":{"code":"not_regular_file","message":"/dev/zero is not a regular file"},"id":2,"ok":false}
```

- `id` is echoed back (any JSON value). A line that is not valid JSON is answered with `id: null`.
- `deadlineMs` (optional) is a cooperative limit: long loops check it and stop with `deadline_exceeded`. The client also enforces it from outside.
- `maxBytes` (optional, default 4 MiB, clamped to 1 KiB..64 MiB) caps the response. List operations stop adding items when the budget is reached and set `truncated` and a continuation field; a result that is still too large is replaced by `output_too_large`.
- Nothing but responses is ever written to stdout. Diagnostics go to stderr.
- A request line over 1 MiB is discarded without being buffered and answered with `request_too_large`.
- An op that panics is answered with `internal` and the process keeps serving.

Error codes: `bad_request`, `request_too_large`, `unknown_op`, `invalid_params`, `file_error`, `not_regular_file`, `too_large`, `unsupported_format`, `parse_error`, `no_embedded_payload`, `extract_refused`, `out_dir_invalid`, `io_error`, `deadline_exceeded`, `output_too_large`, `internal`. Unknown parameter names are refused (`invalid_params`), so a misspelt option is not silently ignored.

## Operations

Every file operation takes `path` and, for a universal Mach-O, `slice` (default 0). File offsets in any result are offsets into the file on disk, also for a slice.

| Op | Parameters | Result |
|---|---|---|
| `hello` | none | Name, version, protocol number, ops, formats, embedded kinds, limits. |
| `binary_info` | `path`, `slice?` | `format` (`elf`, `pe`, `macho`, `macho-fat`, `coff`, `archive`, `unknown`, ...), `kind` (`executable`, `shared`, `relocatable`, `core`; a PIE executable reads `shared`), `arch`, `bits`, `endianness`, `entry`, `sections` (name, segment, address, size, file offset and size, kind, flags), `segments`, `buildId` (ELF), `machoUuid`, `peTimestamp` and `pdb` (PE), `stripped`, `debugInfo`, `slices` for a fat Mach-O, and `embedded`: the payloads found (`bun`, `node-sea`, `go-buildinfo`) with whether each is extractable. |
| `symbols` | `which?` (`all`, `static`, `dynamic`), `contains?`, `kind?`, `definedOnly?`, `demangle?`, `offset?`, `limit?` | Symbols with demangled and raw name, `language` (`cpp`, `msvc`, `rust`), kind, address, size, binding, section, source table. `total` counts every match; `nextOffset` continues. |
| `imports` | `contains?`, `library?`, paging | `libraries` (ELF `DT_NEEDED`, PE import and delay-load tables, Mach-O dylibs) and the imported symbols with their library where the format records one. |
| `exports` | `contains?`, paging | Exported symbols with address or forwarding target. |
| `strings` | `minLength?` (4), `encodings?` (`ascii`, `utf16le`), `contains?`, `section?`, `maxStringLength?` (1024), `offset?`, `cursor?`, `limit?` | Printable runs over the whole file, in offset order, each with file offset, section and virtual address. `nextCursor` is a file offset to continue from without rescanning. UTF-16LE means ASCII-range code units, which is how Windows strings are stored. |
| `extract_embedded` | `outDir?`, `kind?`, `include?` (`source` or `all`), `includeBytecode?`, `includeSourcemaps?`, `maxTotalBytes?` (1 GiB), `offset?`, `limit?` | Lists, and with `outDir` writes, the modules of a Bun or Node SEA payload. Returns `provenance` (`sourceSha256` of the whole file, size, format), `bunVersion`, `layout`, counts, and per-module `path` or `skipped` reason. |

### Embedded payloads

**Bun** (`bun build --compile`): the `.bun` section (ELF, PE) or `__BUN,__bun` (Mach-O) holds a length-prefixed payload with a module table and a `---- Bun! ----` trailer. The layout has no version number and changed between releases, so the reader checks every length and offset against the payload, plus the offsets block's own byte count, and refuses anything that does not fit with a message naming the layout it understands (`bun-standalone-52`: 52-byte module records, measured on Bun 1.3.14 and 1.4.4). A 36-byte-record payload (Bun 1.1 and 1.2) is recognised and reported as unsupported rather than misread. The default writes source and text loaders (`js`, `ts`, `json`, ...) and skips binary assets (`napi`, `wasm`, `file`, ...) with a reason; `include: "all"` writes those too. JavaScriptCore bytecode and source maps are written only when asked.

**Node SEA**: postject stores the blob as an ELF note named `NODE_SEA_BLOB`, a PE resource of that name (`RT_RCDATA`), or the Mach-O section `NODE_SEA,__NODE_SEA_BLOB`. All three were verified against postject output. The blob is parsed as Node 24 writes it (magic, flags, main-script path, main script, assets); a blob that does not parse still yields the raw `sea-blob.bin`, with a note. Output is `sea-blob.bin`, `main/<path>` and `assets/<key>`.

**Go build information** is reported by `binary_info` and not extracted.

## Limits and safety

The target and the payload are hostile input.

- **Regular files only.** A path is checked with `stat` (following symlinks to regular files) and again on the opened descriptor, which is opened non-blocking so a FIFO swapped in after the check cannot stall the process. Devices, directories and FIFOs are refused. A file over 4 GiB is refused (`--max-file-bytes` changes it).
- **Read-only mapping.** The file is memory-mapped read-only; this is the crate's one `unsafe` call, justified in `source.rs`, and every other line is `#![deny(unsafe_code)]` Rust. The known hazard is another process truncating the file while it is mapped, which ends the sidecar; the client treats that as a failed request and starts a new process.
- **Output directory.** `outDir` must not exist (it is created) or be an empty real directory, never a symlink. Files are created with `O_EXCL`, so an existing link is never followed and nothing is overwritten.
- **Confined names.** A module name is reduced to plain path components: known Bun prefixes (`/$bunfs/root/`, `B:/~BUN/root/`) are stripped, then `..`, absolute paths, drive letters and `:`, NUL and control characters, components ending in a dot or space, Windows device names, over-long names, any component starting with `.namzu-` (reserved for the client's `.namzu-provenance.json`) and case-insensitive collisions are skipped and reported with a reason, never written. `maxTotalBytes` bounds what is written.
- **Bounded work.** Request lines, results, string length and page sizes are capped; loops check `deadlineMs`. A Bun payload may declare at most 100 000 modules and 16 MiB of module-name bytes in total (counted per record, so a table whose records overlap cannot reuse one name more often than that); past either, `extract_embedded` answers `extract_refused` and `binary_info` reports the payload as not valid. Names are borrowed from the mapped file and only the requested `offset`/`limit` page of module entries is built, so memory stays near the size of the page whatever the table declares. The client refuses a request longer than the sidecar's `maxRequestBytes` (1 MiB, or `--max-request-bytes`) with `request_too_large` before sending it, and rejects the request in flight when the sidecar answers with `id: null` (an over-long line or invalid JSON) instead of waiting for the deadline.
- **No panics on corrupt files.** The Rust tests truncate each synthetic fixture at hundreds of points and flip bytes at random, for every op, and require an answer without an `internal` error.

### Memory and the process

The sidecar's memory is the mapped file (page cache, not anonymous memory) plus the response being built. Node cannot cap a child's memory portably, and a `ulimit -v` wrapper is not used (it breaks memory mapping). The package enforces instead: the file-size limit, the per-request `maxBytes` (also checked by the client, which kills a process whose response line passes the cap, code `response_too_large`), and the deadline. A request that runs `deadlineMs` plus `killGraceMs` (2 s) without answering gets the process killed with `SIGKILL` and a fresh one started for the next request (code `deadline_exceeded`); a crash fails only the request in flight (`sidecar_exited`, with the process's last stderr). An operating-system memory cap (cgroups, Job objects) is left to the host.

## TypeScript client

The client is `createNativeAnalysis(options)`.

```ts sketch
import { createNativeAnalysis } from '@namzu/analysis'

const native = createNativeAnalysis({ deadlineMs: 30_000, maxOutputBytes: 4 << 20 })
const info = await native.binaryInfo({ path: '/usr/bin/ls' })
const { total, symbols } = await native.symbols({ path: '/usr/bin/ls', contains: 'getopt', limit: 20 })

const recovered = await native.extractEmbedded({
	path: '~/.local/share/claude/versions/2.1.306',
	outDir: `${cacheDir}/embedded/${sha}`,
})
// recovered.embeddedProvenance: sourcePath, sourceSha256, format, kind, bunVersion, layout, sidecarVersion
// (also written to <outDir>/.namzu-provenance.json)
await native.close()
```

The binary is found in this order: `binaryPath`, the `NAMZU_ANALYSIS_NATIVE_BIN` environment variable, the optional per-platform package `@namzu/analysis-native-<platform>-<arch>` (its `bin/namzu-analysis-native`), then `target/release` and `target/debug` of a checkout. An explicit path or variable that names a missing file is an error, not a fallthrough. Nothing is spawned until the first request; requests are sent one at a time in order. Errors are `NativeAnalysisError` with the sidecar's `code`, or `sidecar_not_found`, `sidecar_exited`, `response_too_large`, `protocol_error`, `closed`.

Relative `path` and `outDir` are resolved against the caller's working directory before they are sent; the sidecar itself runs in the temporary directory with an empty environment, so a crash cannot leave a core file in the project.

## asar

`extractAsar(archive, outDir, options?)` reads an Electron archive: the Pickle header, the JSON file tree, packed files by offset, and files marked `unpacked` from the sibling `<archive>.unpacked/` directory. Every file's `integrity` record (SHA-256 of the file, and of each block) is checked when present; a mismatch is reported and the file is left out unless `onIntegrityMismatch: 'write'`. `expectedHeaderSha256` checks the header JSON against a hash the caller read from the host application (Electron's `ElectronAsarIntegrity`). Symbolic links inside the archive are reported and never created. An unpacked file is resolved with `realpath` and must stay under the real `.asar.unpacked` directory (a symlinked directory inside it is refused), is opened with `O_NOFOLLOW` and `O_NONBLOCK`, and is checked with `fstat` on the descriptor; the archive itself is opened the same way and an archive path that is a link is refused. Files are written mode `0644`: the header's `executable` flag is not honoured. The same confinement as above applies (plain names only, `O_EXCL`, new or empty directory), plus caps on header entries (200 000, counting every node the header names: files, directories and malformed entries), total bytes (2 GiB) and header size (64 MiB), and a packed entry whose range lies outside the archive is skipped. It is implemented in TypeScript with no dependency: the format is a header and offsets, and a reader is about a hundred lines. The test fixture was written by `@electron/asar` 4.0.1.

## Build, test, lint

| Command | What it runs |
|---|---|
| `pnpm --filter @namzu/analysis build` | `cargo build --release --locked`, then `tsc --build`. |
| `... test` | `cargo test --locked`, then `vitest run`. |
| `... lint` | Biome on `src/`, `cargo fmt --check`, `cargo clippy --all-targets -D warnings`, and the licence check. |

`scripts/native.mjs` always sets `CARGO_TARGET_DIR` to `packages/analysis/target` (gitignored), because the shell may export it for another project. Without `cargo` the Rust step is skipped with a logged line when `CI` is unset and **fails when `CI` is set**; the TypeScript suites that spawn the real sidecar follow the same rule (skipped with a logged reason locally, failing in CI if the binary is absent). One test — extraction of the developer's locally installed Bun-compiled CLI (its installed path under `~/.local/share`) — is local-only and skipped in CI because that file is only on one machine.

Because the package's scripts are named `build`, `test` and `lint`, `pnpm -r build`, `pnpm -r test` and `pnpm lint` already include the Rust steps; no workflow change is needed.

## Dependencies and licences

Exact versions are pinned in `native/Cargo.toml` and `Cargo.lock`. Direct dependencies: `object` 0.40.0 (Apache-2.0 OR MIT; ELF, PE, Mach-O parsing), `symbolic-demangle` and `symbolic-common` 13.9.0 (MIT; C++, MSVC and Rust demangling), `memmap2` 0.9.12 (MIT OR Apache-2.0), `memchr` 2.8.3 (Unlicense OR MIT), `sha2` 0.10.9 (MIT OR Apache-2.0), `serde` 1.0.229 and `serde_json` 1.0.154 (MIT OR Apache-2.0). `scripts/check-licenses.mjs` reads `cargo metadata` and fails on any crate whose licence is not on an allow list (MIT, Apache-2.0, BSD, ISC, Zlib, Unicode-3.0, Unlicense, CC0, 0BSD); `native/deny.toml` carries the same policy for `cargo deny check licenses bans sources`. No GPL, LGPL or AGPL crate is in the tree, and the design excludes linking Rizin, radare2 or Ghidra-derived code. The executable is about 1.2 MB stripped.

## Not yet

Per-platform packaging and publishing (`@namzu/analysis-native-<platform>-<arch>`), function discovery, disassembly, cross-references, decompilation, DWARF/PDB names, and feeding recovered JavaScript into the index are later steps. Node SEA with a V8 snapshot or code cache keeps its raw blob only.

The SDK seam is `NativeAnalysisProvider` (`packages/sdk/src/types/native-analysis/index.ts`), and the `binary_analysis` deferred tool in `packages/sdk/src/tools/builtins/native-analysis.ts` serves it — `info`, `symbols`, `imports`, `exports` and `strings` under the model's control, one `path` resolved as `read` resolves its own, refused inside a sandboxed turn. The CLI mounts the provider (the `nativeAnalysis` config key mirrors `codeAnalysis`: on by default, `{ "enabled": false }` keeps the tool off the session and the deferred hint out of every request, off in any file stays off) and runs the sidecar's hello in `namzu doctor` (`analysisNative.hello`). `createNativeAnalysisProvider` in `packages/analysis/src/native/provider.ts` is the adapter: it spawns nothing and resolves no binary until the model's first call, so a host can hold one without paying for it before it is used.
