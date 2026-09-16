---
'@namzu/sandbox': minor
---

Read a large file out of a sandbox without the sandbox holding it.

`readFile` used to load the whole file in the guest, base64-encode it into one
JSON object and write that object as a single frame, so the file buffer, the
base64 string, the JSON string and two frame buffers all existed at once —
about 7.7x the file, inside the container the workload shares. A 64 MiB read
grew the guest agent by 405 MiB against the shipped workspace template's
`512Mi` limit, and a file of about 384 MiB or more could not be read at all:
its base64 string exceeds V8's `0x1fffffe8`-character ceiling, so the call
failed with `Cannot create a string longer than 0x1fffffe8 characters`. That
call now succeeds.

- `readFile(path, { offset, length, signal })` reads one slice. The guest
  `pread`s at that position and answers with the whole file's size beside the
  bytes; a range past the end returns what exists. A slice above
  `NAMZU_AGENT_READ_FILE_RANGE_BYTES` (1 MiB default) is refused, not
  shortened.
- `readFileStream(path, options?)` returns an `AsyncIterable<Buffer>` over a
  new `read-file-stream` guest op. A 1 GiB read grows the guest by about
  12 MiB.
- `readFile(path)` with no options is served by that stream against a guest
  that advertises the capability, so callers lose the ceiling without changing
  a line. It still returns one `Buffer`; iterate `readFileStream` to avoid even
  that copy.

The guest opts in. `agent.cjs` advertises `read-file-stream` in its `healthz`
reply, and against a guest that does not, a whole-file read takes the
unchanged single-frame path while a ranged read or a `readFileStream` throws
the new `AgentReadFileStreamUnsupportedError` before dialing — an agent that
predates the feature ignores `offset`/`length` and answers with the whole
file, which you would otherwise read as your slice. Rebuild the guest image
from this release to get the new behaviour; nothing forces you to, and the
guest wire protocol version is unchanged.

A `KubernetesWorkspace` has both shapes too, which is where they matter most:
draining a large output file before `suspend()` or `destroy()` is what a
long-lived workspace is for. Its `readFile` forwards `offset`/`length` to the
guest, and `readFileStream` is present on the interface rather than optional.
Both refuse a suspended workspace by name, as every other data-plane call does.

The two backends that cannot serve a range now REFUSE one rather than ignoring
it: the docker and standby-pool workers answer whole files only, so
`readFile(path, { offset })` against either throws instead of handing back the
file. Previously those backends declared the one-parameter form, which type
checks and silently discards the range. Both also pass `options.signal` to the
request they make. Nothing that compiled before breaks — no caller could pass
the parameter until this release.

Three guest rules to know if you write to this wire yourself. A range must ask
for `base64` (`read_file_range_requires_base64`): a `utf8` slice at an
arbitrary offset can split a multi-byte character. `read-file-stream` serves
regular files only (`read_file_stream_not_a_regular_file`), so a whole-file
read of a fifo or a device node — reachable only if you set
`NAMZU_SANDBOX_READ_ROOTS` — is now refused rather than attempted, and a file
that shrinks under the open fd fails the read instead of coming back short.
A regular file that `stat` reports as zero bytes and that still has content,
the procfs shape, is read to EOF by both new shapes rather than answered as
empty.

New exports: `AgentReadFileStreamUnsupportedError`, `READ_FILE_STREAM_FEATURE`,
`ReadFileStreamRequest`, `ReadFileStreamEvent`. New guest environment
variables: `NAMZU_AGENT_READ_FILE_RANGE_BYTES` (1 MiB),
`NAMZU_AGENT_READ_FILE_STREAM_CHUNK_BYTES` (256 KiB). `defineSandboxConformance`
gains `supportsRangedAndStreamedReads`, default `false`, which gates two new
cases; those two deliberately did not raise `SANDBOX_CONTRACT_VERSION` beyond
the `3` the `walkFiles`, concurrent-`exec` and `exec`-timeout sections took it
to, so a backend that passes those three still passes the suite without
implementing either read shape.
