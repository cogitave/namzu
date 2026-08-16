---
'@namzu/sdk': patch
---

The compaction pass is now decided by a pure planner that needs no run.

The whole algorithm — the leading-system floor scan, the tool-result
pre-pass, the boundary search and its guards — lived inside
`runCompactionCheck` and read the live message array, the logger and the
event emitter off an iteration context. Nothing outside a live iteration
could run it, so the pass was testable only through a full run harness and
unreachable from any host-callable entry point.

Everything with an effect stayed where it was: the model call, the
working-memory re-pin, the array install, the logging, every event. The
arithmetic moved. No behaviour changes and the emitted event and log
sequence is identical; the planner is internal to the package.

This also removes a second copy of the token-budget boundary helper that
had been living in the phase file behind a test-only export.
