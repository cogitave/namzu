# Windows shell and desktop event audit — 2026-10-02

## Scope and sources

Compared the current public upstream source with Namzu's ordinary SDK, CLI and
desktop execution paths. Pal computer commands execute in the Linux guest; the
Windows operator process does not choose their interpreter.

Upstream: `openai/codex`, commit
`59f18e8133f2c1d3427677658752ac46697d41b7`, committed
2026-10-01T21:05:10Z. HEAD was checked through `git ls-remote`; the independent,
read-only shallow source checkout is
`/var/tmp/namzu-codex-windows-audit-20261002`. No upstream build or binary run was
performed. Findings below distinguish source behavior from native Namzu proof.

## Shell comparison

| Area | Pinned upstream implementation | Namzu finding and action |
| --- | --- | --- |
| Windows discovery | Explicit shell types; prefers discovered PowerShell, trying pwsh and Windows PowerShell, then CMD fallback. Executable validation distinguishes native executables and incompatible proxies. | Automatic Windows host execution remains Node's platform shell, normally CMD. No automatic PATH bash, WSL or PowerShell switch. This executable default is preserved. |
| Arguments and startup | POSIX login mode uses `-lc`, non-login `-c`; PowerShell adds `-NoProfile` when login mode is off and uses `-Command`; CMD uses `/c`. | POSIX host tools use non-login `-c`. Operator `!` retains `/bin/sh` on POSIX. Native Windows `!` previously tried `/bin/sh`, which was proved to fail with ENOENT; it now uses the native platform shell through the shared runner. |
| Shell interpretation | Shell identity is explicit; PowerShell parsing recognizes supported literals and treats dynamic syntax cautiously. | Windows CMD previously advertised `sh`. A POSIX literal single-quoted echo was inferred as one command, while CMD ran a second command between the quotes. Added explicit opaque `cmd` dialect; automatic command-pattern and skill-pattern allowances decline it. Existing unknown-program exact-call review remains. |
| UTF-8 | Recognized PowerShell command wrappers receive a best-effort Console output-encoding prefix. | SDK shared runner already uses one StringDecoder per stream. Operator `!` now reuses it; desktop stderr now also uses its own decoder. Split UTF-8 from a real Windows child retained Turkish text and emoji. Decoding does not establish that every legacy Windows executable emits UTF-8. |
| Process ownership | Windows Job Objects, suspended-spawn assignment and owned process handles are implemented; containment fallback is explicit. | SDK host runner uses the existing taskkill tree helper. Desktop's CMD launcher formerly received child-only kill, which left Node ACP alive in the native proof. Desktop now waits for EOF cleanup, then targets only the live owned PID with `taskkill /pid /t /f` and awaits close. OS stop failure rejects and is retryable. A wrapper PID that has already exited is not targeted. This is not a Job Object implementation. |
| `.cmd` forwarding | Low-level Windows spawning owns argument quoting and PATH/PATHEXT handling. | Desktop uses a fixed `namzu acp --desktop` command through CMD; project paths are cwd rather than command interpolation. A production RuntimeClient using an isolated npm-style `.cmd` shim retained exact `acp`, `--desktop` arguments on native Windows. |
| Resume command | Shell-specific command construction. | Existing resume formatter correctly quotes PowerShell executable/arguments, doubles apostrophes and gates execution on successful `Set-Location`. Verified in Windows PowerShell 5.1 with spaces, apostrophes and metacharacters. No resume rewrite was required. |

Primary upstream sources:

- [Shell discovery](https://github.com/openai/codex/blob/59f18e8133f2c1d3427677658752ac46697d41b7/codex-rs/shell-command/src/shell_detect.rs).
- [Startup arguments](https://github.com/openai/codex/blob/59f18e8133f2c1d3427677658752ac46697d41b7/codex-rs/core/src/shell.rs).
- [PowerShell parsing and UTF-8 wrapper](https://github.com/openai/codex/blob/59f18e8133f2c1d3427677658752ac46697d41b7/codex-rs/shell-command/src/powershell.rs).
- [Windows Job ownership](https://github.com/openai/codex/blob/59f18e8133f2c1d3427677658752ac46697d41b7/codex-rs/utils/pty/src/win/job.rs).
- [Windows executable/argument construction](https://github.com/openai/codex/blob/59f18e8133f2c1d3427677658752ac46697d41b7/codex-rs/utils/pty/src/win/psuedocon.rs).

Namzu source: `packages/sdk/src/tools/command-shell.ts`,
`authorization/shell-lexer.ts`, `authorization/rules.ts`,
`authorization/skill-grant.ts`, `runtime/query/executor.ts`,
`runtime/query/prompt.ts`, `tools/builtins/bash.ts`;
`packages/cli/src/tui/shell-escape.ts`, `resume-shell.ts`;
`packages/desktop/src/main/index.ts`, `rpc-client.ts`.

The explicit CMD metadata change is a public default change: its changeset
requests a major SDK release. Exhaustive ShellDialect consumers must handle
`cmd`, and must not relabel CMD as `sh` to preserve old pattern approvals.
Explicit POSIX interpreter overrides and guest `sh` retain their semantics.
The CLI's confirmed-script schema remains POSIX-only; native CMD is not added
as a scheduled-script interpreter. The scheduled-run floor refuses a native
CMD command whose protected effects cannot be verified.

## Event and review comparison

| Area | Pinned upstream source | Namzu behavior verified or observed |
| --- | --- | --- |
| Correlation | Pending JSON-RPC requests keyed by RequestId; duplicate IDs are rejected; server requests have their own response route. | RuntimeClient increments a per-client request ID and resolves only its pending map entry. Permission responses use the original wire ID; Operator stores a separate UI ID bound to the running session. Native fixture proved request/permission/response targeting. |
| Thread and turn identity | Notifications and interactive requests route by explicit thread ID, with turn/item IDs for text coalescing and interaction lifecycle. | ACP updates carry sessionId; CLI keeps a per-session route owner and synchronously binds the presenter during each callback. Native Operator checks current project-client identity and session-running state before forwarding events. Projection keys tool rows by admitted turn plus tool ID. |
| Ordering | Per-thread replay coalesces only adjacent text deltas with matching thread/turn/item identity and bounded bytes. | Stdio newline frames are consumed in stream order. Operator assigns monotonic conversation projection revisions; renderer ignores an event at or behind its current revision. Native protocol fixture proved agent message before turn-ended update and prompt result. There is no claim of network-wide ordering or durable event replay. |
| Reconnect | Out-of-process reconnect initializes a fresh client, rejoins threads via ordinary resume/history, reconciles confirmed submissions and quarantines uncertain submissions. Embedded sessions cannot reconnect in place. | Desktop reconnect reopens the canonical project, closes its previous client, replaces it, rejects stale client callbacks and marks conversations for session/load. Disconnection clears running state and outstanding reviews. Uncertain prompts are not automatically replayed. Durable restoration is text history, not reconstructed tool receipts. |
| Human review replay | Pending interactive replay tracks unresolved approvals/input/elicitations and clears them by response, eviction and terminal turn events. | Outstanding ACP requests are abort-bound and connection-local. Operator approval requires a still-pending wire ID and running session; stale requests are rejected. A disconnect clears UI permissions. No previous approval is silently replayed after a new connection. |
| Backpressure | Transport lag is explicit; per-thread replay has finite event/byte budgets; slow network clients can be disconnected. | RuntimeClient has a protocol-frame cap and pending request deadlines. This audit did not establish bounded native-to-renderer event queues or a lost-event marker. A richer remote/resident transport would need explicit bounded replay and authoritative recovery. |

Primary upstream event sources:

- [Request IDs and remote delivery](https://github.com/openai/codex/blob/59f18e8133f2c1d3427677658752ac46697d41b7/codex-rs/app-server-client/src/remote.rs).
- [Thread event targeting](https://github.com/openai/codex/blob/59f18e8133f2c1d3427677658752ac46697d41b7/codex-rs/tui/src/app/app_server_event_targets.rs).
- [Bounded replay/coalescing](https://github.com/openai/codex/blob/59f18e8133f2c1d3427677658752ac46697d41b7/codex-rs/tui/src/app/thread_event_buffer.rs).
- [Reconnection](https://github.com/openai/codex/blob/59f18e8133f2c1d3427677658752ac46697d41b7/codex-rs/tui/src/app/reconnect.rs).
- [Pending interactive replay](https://github.com/openai/codex/blob/59f18e8133f2c1d3427677658752ac46697d41b7/codex-rs/tui/src/app/pending_interactive_replay.rs).

Namzu source: `packages/sdk/src/bridge/acp/server.ts`, `update.ts`;
`packages/cli/src/commands/acp.ts`;
`packages/desktop/src/main/rpc-client.ts`, `operator.ts`,
`shared/projection.ts`. The native SDK query in this audit uses MockLLMProvider;
it proves the actual request receives CMD shell metadata without model network
or credentials. Native transport approvals use an isolated protocol fixture,
not a paid-provider turn.

## Verification and remaining limits

[Native receipt](artifacts/windows-shell-events-native-receipt.json) records
actual `process.platform=win32`, Node v22.20.0 and checks against production
modules bundled without external installation. The controlled child and shim
files are created in an owned temporary directory and cleaned up. Source:
[Windows proof harness](windows-shell-events-native-proof.ts). Bundle that
entry with the existing Vite esbuild dependency to a Windows local temp `.mjs`
and execute it with native Node; it intentionally refuses a non-Windows host.

Focused SDK tests cover CMD opacity, gate and skill allowances, shell selection,
actual query review routing, and flat/minimal/segmented/cached host-vs-guest
metadata. CLI bang tests cover the shared cancellation/output contract and
native-compatible exit handling. Desktop tests cover EOF grace, live-PID tree
stop, failed-stop retry, exited-PID refusal and split UTF-8 diagnostics. Timers
in shutdown unit tests are fake; native process proof awaits actual events.

An additional [native Pal TUI receipt](artifacts/native-pal-tui-receipt.json)
records 13 passed checks in a real PowerShell-created Windows console, with
stdin/stdout/stderr TTY flags all true. The production CLI and Ink renderer
opened `pal chat`, accepted Win32 console keyboard events and displayed a local
HTTP fixture reply through the real Ollama driver. The exact printed PowerShell
resume command reopened the same conversation and rendered prior history. At
the resumed provider call, the real Pal runtime held an active admission,
reported guest cwd `/home/namzu/workspace` and returned an actual 21,164-byte PNG
from its existing Podman guest. Both exits returned zero; owned processes and
container were absent afterward, with the Pal home volume retained.
[Harness and reproduction instructions](native-tui-proof/README.md) describe
the loopback fixture and console instrumentation. The text-only Ollama driver
displayed its tool capability warning; this does not prove a model using the
computer. Console artifacts are buffer text captures, not pixel screenshots.

Not established: complete visual coverage of native TUI states, pwsh availability, a
credentialed model, all legacy output encodings, a Job Object equivalent,
upstream binary execution, or a live remote reconnect service. No dependency or
system installation, publish, push, or upstream code modification was used.
