---
"@namzu/sdk": minor
"@namzu/cli": minor
---

Expose explicit paused-turn recovery through optional `AcpAgentGateway.retry` and
`ACPServer.retrySession`. Hosts retain the existing ordered update, review,
cancellation and single active execution owner without inventing a new prompt.

The desktop CLI host advertises scoped retry-status and retry methods. It resumes
only the exact verified checkpoint of a classified retryable provider pause with
resolved original accounting. Human decision holds and uncertain provider usage
remain blocked, including unlimited turns; this feature never resets a ledger or
abandons an active turn. Same-process retries preserve captured approval/effort
and the recorded model. After reconnection, default Retry is unavailable when the
original approval settings cannot be verified; a deliberate host retry must
explicitly select a permission mode in ordinary conversations. Pal recovery also
pins the authenticated original computer generation and environment identity
before sending, and rechecks them at resumed provider/tool entries. A cold,
originally offline, replaced or unavailable Pal computer lifetime cannot be
substituted with the currently ready computer. Pal ownership and current
computer-control guards remain required.
