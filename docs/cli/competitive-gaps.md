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
completion. The CLI matches progress and completion by tool-use ID and run ID,
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

The completed-output preview still favors the beginning. A head/tail preview
is a candidate improvement for immediate visibility of final test failures.
It needs clear omission markers and must preserve expansion, terminal safety
and the viewport budget.

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

The next review should prioritize:

1. Process-tree cancellation on supported hosts and sandboxes, using real
   subprocess tests. An `AbortSignal` alone does not prove all descendants stop.
2. Restart and cross-process races in the budget ledger, using durable receipts
   and held provider responses rather than only mocked totals.
3. Completed-output head/tail previews and discoverable artifact access, with
   screen tests that measure wrapping, scrollback and expansion.

This review does not attribute ARC scores to any one of these defects. That
requires a controlled comparison with the same model, effort, budget, tools
and task state. Deterministic regressions establish individual failures
without spending model credits.
