---
'@namzu/cli': minor
---

**The daemon can now host agent sessions (the backend for cross-terminal attach).**

`namzu serve` can host a full agent session: the agent loop runs inside the daemon, every event is appended to a per-session log, and clients attach over HTTP — replaying the log and polling for new events, and sending input. New endpoints: `GET/POST /v1/hosted`, `POST /v1/hosted/:id/message`, `GET /v1/hosted/:id/events?since=N`. This is what makes a session live independently of any one terminal, so it can be observed and driven from another. (The in-TUI attach UI is the next step.)
