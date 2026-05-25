---
'@namzu/cli': minor
---

**`namzu serve` — a session daemon (foundation for the cross-terminal agent-view).**

`namzu serve` now runs a small loopback HTTP daemon that tracks live namzu sessions, advertised via `~/.namzu/daemon.json` (host/port + bearer token). It exposes `GET /health` and a bearer-authed session API (`GET/POST /v1/sessions`, `PUT/DELETE /v1/sessions/:id`) with automatic pruning of sessions whose process has exited. This is the backend an agent-view will use to list and switch between sessions running in different terminals; the TUI registration, list UI, and attach are the next steps.
