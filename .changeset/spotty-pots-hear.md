---
'@namzu/sdk': minor
---

Cap model-visible tool output, and spill the overflow instead of losing it.

Nothing bounded tool output. `read` returned a whole file when `limit` was
omitted, `bash` allowed a 100 MB buffer, and the MCP adapter joined every text
block uncapped — so a `read` of a 2 MB lockfile became ~500k tokens in one
`tool_result`, the provider rejected the request, and with no retry the run
died with everything lost. The one existing reducer, `compressShellOutput`,
early-returns for any tool whose category is not `shell` and has no absolute
size cap at all.

- `maxToolOutputChars` (default 40k ≈ 10k tokens), overridable per run. Output
  over budget is written to `<runDir>/tool-output/<toolUseId>.txt` and replaced
  with a head+tail preview naming the path. Spilling beats truncating on every
  axis: nothing is lost, tokens are paid only if the agent decides the rest is
  worth re-reading, and retrieval uses `read`/`grep` — tools it already has.
  Without a run directory it degrades to middle-elision rather than being
  unbounded.
- `read` defaults to a 2000-line window instead of the entire file, and any
  partial read now ends with a `[PARTIAL view — lines X-Y of Z]` notice naming
  the exact next call. A truncated read used to be indistinguishable from a
  short file, so the agent reasoned about a fragment as if it were the whole
  thing.
- `bash` surfaces the sandbox's `stdoutTruncated` / `stderrTruncated` flags,
  which were computed by the backend and dropped at the `SandboxExecResult`
  type boundary — the model saw a complete-looking result that had silently
  lost its tail. Both flags are now part of the contract, along with
  `SandboxExecOptions.signal` so a cancelled run can reach the process.
- `tool_completed` carries `durationMs` (computed since the first version of
  the executor but only ever logged), plus `outputLength`, `outputTruncated`
  and `outputSpillPath`.
