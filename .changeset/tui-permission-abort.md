---
'@namzu/cli': minor
---

**Interactive tool permission + interruptible turns in the TUI.**

Tools no longer run blind. Before a non-read-only batch (write/edit/bash/append, anything flagged destructive, or any tool not on the read-only allowlist), namzu now shows the proposed call(s) — with a content/diff preview for `write` and `edit` — and waits for **y** (approve) / **n** (reject) / **a** (approve all for this session). Read-only batches (read/glob/grep) still run silently. Rejection feeds the model a decline message so it can adapt; "approve all" stops prompting for the rest of the session.

This is wired through a custom `resumeHandler` bridged to the TUI via an async `onPermission` callback on `send()`; when no callback is supplied the loop auto-approves (non-interactive behaviour unchanged).

Ctrl+C is now context-aware: while a turn is running it **interrupts the turn** (aborts the agent loop) instead of arming exit; while awaiting a permission decision it rejects and aborts; only when idle does the existing double-Ctrl+C exit apply.

Verified end-to-end against the live Anthropic API: asking namzu to write a file triggers a write-permission prompt (destructive, with a content preview); approving runs the write and the file is created.
