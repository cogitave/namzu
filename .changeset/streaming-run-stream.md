---
'@namzu/cli': minor
---

Add `namzu run-stream` — a headless streaming one-shot that runs the same
agent as the TUI but emits one compact NDJSON line per `AgentEvent`
(delta / tool-start / tool-end / error / done) to stdout, instead of
buffering the final text like `run`. Prior conversation history is read
from stdin as a JSON `Message[]`. This lets a host process (e.g. a desktop
UI) line-scan stdout and render a turn live, with the host owning
persistence — the equivalent of the TUI driven from another runtime.
