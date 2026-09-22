---
"@namzu/sdk": major
---

A turn can make a file tool's path outside its roots, or a command outside its
sandbox, a reviewed question instead of a refusal. Both are opt-in and default
to the old refusal: `QueryParams.outsideRootAccess: 'review'` and
`QueryParams.sandboxEscape: 'review'` (also on `ReactiveAgentConfig`).

**What can break.** `AuditOutcome` (and the session log's `audit.outcome`)
gains `'approved'`, written for each approved crossing. A consumer that
switches exhaustively over the outcome must handle it; `replayAudit` skips it.
A session log written by this version with such a record does not parse in an
older SDK.

**New, all optional.** `ToolCallSummary.escalation` names what a call reaches
(`outsidePaths`, `sandboxEscape`); an escalated call is always reviewed, and a
gate `allow`, a remembered grant, a read-only declaration and `accept-edits`
decline to approve it alone. A sandbox escape runs only when the decision lists
its id in the new `confirmedEscalations` (on `approve_tools` and
`modify_tools`); `createReviewHandler` asks for it in every mode, and refuses it
without a `prompt` (`SANDBOX_ESCAPE_UNATTENDED_REFUSAL`) unless
`unattendedSandboxEscape: 'allow'`. Tools declare `pathArgument` and
`sandboxEscapeArgument`; the executor hands an approved call
`ToolContext.approvedPaths` or `sandboxEscapeApproved`. The shipped file tools
declare `pathArgument: 'path'`; `bash` gains an optional
`dangerously_disable_sandbox` input, refused with `SANDBOX_ESCAPE_NOT_APPROVED`
unless approved. `pathOutsideRoots`, `toolRoots` and `OUTSIDE_ROOTS_GUIDANCE`
are exported. A file tool's refusal of a path outside its roots now says how
the boundary is widened instead of ending at "Tools may only reach".
