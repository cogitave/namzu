---
"@namzu/cli": minor
---

Compose installed Codex CLI app-server and Claude Code persistent stream-json
engines behind the ordinary desktop conversation host, with their native model catalogues,
exact session/profile/workspace binding, streamed message replacement,
one-request native tool approval and confirmed interruption/shutdown.
Keep these routes separate from Namzu's borrowed Codex and Anthropic provider credentials.
The desktop selects the engine before first dispatch and manages conversations
as peer tabs with their own drafts, engine bindings and selected models.

The native app-server adapter offers its declared review policies, including
explicitly confirmed Full access; the initial stream-json adapter offers
supervised and plan modes. Both omit unsupported controls
and explicitly deny unsupported typed questions. Codex models advertise only
their discovered effort options; the initial Claude adapter offers no effort
control, and neither route accepts attachments yet.
Native metadata is not proof of successful account authentication. Retain
uncertain sends and approvals for reconciliation rather than replaying them;
the initial engine has no authoritative history-query adapter.
