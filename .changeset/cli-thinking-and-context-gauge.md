---
"@namzu/cli": minor
---

A long think reads as work, and `/cost` says how full the context is.

- **Thinking row.** While the model reasons, its current line is shown dim under the Working row (`└ thinking · …`; `└ thinking…` when the provider keeps its reasoning redacted) and disappears the moment the reply or a tool call begins. Reasoning never becomes a transcript row — the run keeps no such record either.
- **Context in `/cost`.** `/cost` now prints `Context: 54,000 / 128,000 tokens (42%)` when the run knows both how full the context is and how large the window is, each term with its provenance; a `~` marks an estimated count or an assumed window, and nothing is printed when there is no window to measure against. The footer stays quiet — the persistent gauge was removed on purpose — so this is on request, where a person asks.
- **`run-stream` wire (minor):** a new `reasoning` event (`{ kind: 'reasoning', text, done? }`) is emitted for reasoning deltas and block ends. Consumers that switch exhaustively on `kind` should add it; everything else is unchanged.
