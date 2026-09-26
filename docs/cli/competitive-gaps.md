---
type: Analysis
title: Where the CLI stands against its peers
description: Revision-pinned comparisons of tool feedback, animation and harness boundaries, with local regressions and remaining work.
tags: [cli, sdk, product, backlog]
status: draft
---

# Where the CLI stands against its peers

Reviewed on 2026-09-06 against Codex commit
`ac192cd7937b0d73edc6dffe009940ae53782dd4` and Pi commit
`9767ba275f3e9a5ee0f5c5342249b629ab1b2282`. These source comparisons identify
implementation choices, not benchmark rankings. A feature in Namzu does not
establish that every other harness lacks it.

## Tool feedback

Codex keeps a bounded incremental command preview with head and tail lines,
line-length limits and chunk-boundary handling in
[live_output.rs](https://github.com/openai/codex/blob/ac192cd7937b0d73edc6dffe009940ae53782dd4/codex-rs/tui/src/exec_cell/live_output.rs#L13).
Pi consumes stdout and stderr as they arrive in its
[shell tool](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/coding-agent/src/core/tools/bash.ts#L79)
and preserves output beyond the inline limit in its
[harness implementation](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/agent/src/harness/tools/bash.ts#L74).

Namzu already has progress events and a bounded observer queue: one report
in flight, one latest pending report, an 8 KiB message limit and closure before
completion. The CLI matches progress and completion by tool-use ID and turn ID,
ignoring late progress. Codex also requires the matching call ID in its
[execution model](https://github.com/openai/codex/blob/ac192cd7937b0d73edc6dffe009940ae53782dd4/codex-rs/tui/src/exec_cell/model.rs#L115).
Those boundaries should survive further presentation work.

This review reproduced three gaps in Namzu:

- Host shell execution did not report progress; sandbox execution treated
  chunks as complete lines. Both paths now assemble bounded progress
  independently for stdout and stderr.
- Sandbox timeouts discarded captured output, and truncated errors could
  advise rerunning a command that had already changed state. Partial output
  now remains available and clipping does not request a blind replay.
- The CLI removed the end of a long first line and every line after 200 before
  expansion or `/raw` could recover them. Retained presentation lines now
  survive; the renderer bounds the default preview, including long single lines.

The completed-output preview now shows three beginning and three ending lines,
with an omission count between them. Final test failures can remain visible
before expansion. Screen regressions verify that Ctrl+O and raw view restore
the omitted middle, terminal controls remain inert, and the height estimator
uses the same projection as the renderer.

## Motion and redraw cost

Codex uses a two-second text shimmer with palette-aware rendering in
[shimmer.rs](https://github.com/openai/codex/blob/ac192cd7937b0d73edc6dffe009940ae53782dd4/codex-rs/tui/src/shimmer.rs#L21)
and centralizes reduced-motion choices in
[motion.rs](https://github.com/openai/codex/blob/ac192cd7937b0d73edc6dffe009940ae53782dd4/codex-rs/tui/src/motion.rs#L38).
Namzu uses a clockwise composer-border light and a shared animation scheduler.
These are different visual choices; parity does not require the same animation.

Production-renderer terminal probes confirmed Namzu's complete clockwise lap,
stationary composer children and quiet idle, unfocused and disabled-color
states. Regression coverage exercises the corners and cleanup. The review
also found a fixed message header overflowing very narrow frames; the label
now yields to the frame width.

Pi coalesces redraw requests in its
[terminal renderer](https://github.com/earendil-works/pi/blob/9767ba275f3e9a5ee0f5c5342249b629ab1b2282/packages/tui/src/tui.ts#L952).
Namzu already bounds its mutable transcript tail by both message count and
available terminal rows. New activity furniture must participate in that
budget rather than relying on the scheduler to absorb extra work.

## Harness correctness before additional features

Separate local probes found two cancellation failures: a cancelled post-tool
hook could erase an already completed tool's receipt, and closing a provider
generator blocked in `next()` could stall cancellation when the idle watchdog
was disabled. The fixes preserve execution status while withholding unreviewed
result content, settle calls that never started explicitly, and let cancellation
finish without assuming unknown provider usage is zero. See
[Harness invariants](../sdk/harness-invariants.md).

An additional real-process probe found that foreground host shell aborts and
timeouts killed the shell wrapper while its descendants continued running.
Host execution now owns and terminates its POSIX process group, escalates after
a bounded grace period and preserves timeout and command-failure output. Linux
regressions cover ordinary and termination-resistant descendants. A child that
creates a separate session can escape that group, but its inherited pipes can
no longer hold cancellation open indefinitely. This establishes a host
process-group boundary, not containment of arbitrary descendants.

The next review should prioritize:

1. Remaining cancellation boundaries on Windows and remote sandboxes, using
   real subprocess tests. Linux host results do not establish those paths.
2. Restart and cross-process races in the budget ledger, using durable receipts
   and held provider responses rather than only mocked totals.
3. Discoverable artifact access for output beyond the runtime limit, preserving
   source ownership and avoiding command replay.

This review does not attribute ARC scores to any one of these defects. That
requires a controlled comparison with the same model, effort, budget, tools
and task state. Deterministic regressions establish individual failures
without spending model credits.

## `Claude Code` and Codex CLI check, 2026-09-26

The newer comparison inspected a local checkout of
[Codex CLI at `e72da2b5`](https://github.com/openai/codex/tree/e72da2b53805894878023d01949a25a082e0a5cb)
and the
[`Claude Code` public repository at `7779afb1`](https://github.com/anthropics/claude-code/tree/7779afb12e3635f46f56ec823979d68350ae000b),
alongside its [official subagent documentation](https://code.claude.com/docs/en/sub-agents).
The public repository does not contain its full CLI runtime, so
the worktree behavior below is attributed to its official documentation,
not inferred from example code. The Namzu baseline was `ee54f2bd`;
the entries below describe the changes built from it for the next release.

| Verified gap | Source evidence | Namzu outcome |
| --- | --- | --- |
| Operator-owned Git worktrees and conversation continuation | Codex's [worktree library](https://github.com/openai/codex/blob/e72da2b53805894878023d01949a25a082e0a5cb/codex-rs/worktree/src/lib.rs) and [TUI worktree browser](https://github.com/openai/codex/blob/e72da2b53805894878023d01949a25a082e0a5cb/codex-rs/tui/src/worktree_browser.rs) | `namzu worktree create|list|fork|resume` creates a checkout at the selected committed HEAD and can copy a settled conversation into it. It does not move dirty source files. See [Managed Git worktrees](worktrees.md). |
| Delegated work in a separate checkout | `Claude Code` documents [`isolation: worktree`](https://code.claude.com/docs/en/sub-agents); Codex's [worktree tests](https://github.com/openai/codex/blob/e72da2b53805894878023d01949a25a082e0a5cb/codex-rs/worktree/tests/worktree.rs) exercise its checkout ownership. | The CLI Agent tool accepts `workspace: "worktree"`. The child executes against that checkout and reports its path and branch. Retention applies after completion, failure or cancellation; an unadmitted checkout is rolled back. See [Delegated work](delegated-work.md). |
| MCP server management and authorization | Codex's [`mcp` command](https://github.com/openai/codex/blob/e72da2b53805894878023d01949a25a082e0a5cb/codex-rs/cli/src/mcp_cmd.rs) includes add, list, get, login, logout and remove. | `namzu mcp list|get|add|remove` manages user entries with redacted output and environment-backed headers. Interactive OAuth login/logout remains a gap; implementing it requires a private issuer-bound credential store and the official MCP client's authorization flow. See [Tool servers](mcp-servers.md). |
| Inspecting whether a skill can actually load | Codex's [skills runtime](https://github.com/openai/codex/blob/e72da2b53805894878023d01949a25a082e0a5cb/codex-rs/core/src/skills.rs) makes skill availability part of execution. | `namzu skills --audit` checks winning file skills through the same SDK loader used by a turn and reports invalid, disabled and operator-only entries. See [Skills](skills.md). |

For OAuth, the implementation target is the
[official TypeScript MCP client](https://github.com/modelcontextprotocol/typescript-sdk/blob/7f7a94c22017e121a960e071bb50ec75e34450bd/docs/clients/oauth.md).
An explicit `mcp login` should own browser consent and validate callback state and issuer.
Ordinary tool use should only attach or refresh a previously saved credential,
bound to the exact configured endpoint, and never open a browser by itself.
HTTP authorization failures during protocol discovery must surface as such,
without trying a legacy handshake. A URL change, failed callback or logout
must leave no usable token for that endpoint.

Modern MCP catalogue updates were also checked against the
[2026-07-28 protocol](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/docs/specification/2026-07-28/basic/transports/streamable-http.mdx).
Namzu's modern client now listens for advertised tool, prompt and resource
changes, refreshes its live toolsets, and stops retrying a permanently rejected
subscription. This is a protocol correctness change, not a claim that every
Codex or `Claude Code` server uses that revision. See
[MCP protocol eras](../sdk/mcp-protocol-eras.md).

The Codex source also contains plugin distribution and optional terminal
interaction modes. Their presence alone does not justify importing their
marketplace or input model into Namzu: Namzu already loads local plugins,
and a distribution feature needs an explicit trust, update and permission
contract. This audit did not establish a comparable user need or an
acceptance test for those additions.

## Scheduled tasks

Reviewed on 2026-09-23 against Hermes Agent commit
`5f47c35d37a40fb651e4a00571d03e12b23d11f9`, whose `cron/` package runs agent
jobs on a schedule. Namzu's [Scheduled tasks](scheduled-tasks.md) now cover the
same ground with these differences, each deliberate:

- Hermes catches up occurrences missed while a job was paused; namzu skips them
  (pausing is the operator's intent) and catches up only time the scheduler
  could not run, one run for the most recent occurrence within seven days.
- Hermes guards the scheduler from its own runs with a lifecycle guard
  (`cron/lifecycle_guard.py`) that expands `~` and resolves paths; namzu's
  floor is a narrower pattern check that matches the usual spellings of a path
  (absolute, `~/…`, `$HOME/…`) and resolves nothing. Namzu adds a confirmation
  digest over each job, so a job file changed by anything but the CLI is held
  until it is confirmed again.
- Both dedupe repeated failures (`cron/incidents.py`) and hold a job during a
  provider quota window (`cron/quota_hold.py`); namzu also pauses a job after
  five failures in a row.
- A job's run never approves a call on its own in namzu: it parks and waits for
  the operator, who answers the exact parked batch later in the TUI.
