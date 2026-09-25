---
"@namzu/cli": patch
---

Fixed: `namzu acp`'s tool-call/result presenter (added in this release to fix the previously-always-empty ACP presenter) delegated through one connection-global "active session" slot. Two ACP sessions with prompts in flight at the same time could have session A's tool-call/result rendered with session B's tool-specific view once B's prompt started — worse than the pre-fix behaviour (always generic, but never wrong) for exactly the concurrent case `acp-session-isolation.test.ts` otherwise covers.

The presenter now tracks which session's event it is presenting for only the synchronous span of that one event — bracketed around each `record.route(event)` call rather than held for a whole turn — so a second session's prompt starting, or finishing, while the first is still streaming can no longer be read as "active" while the first session's own event is being presented.
