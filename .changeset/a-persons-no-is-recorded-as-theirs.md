---
"@namzu/sdk": minor
"@namzu/cli": minor
---

A tool call a person declined at review is now recorded as declined by them, with what they said, so a host that reopens the conversation can show it. Nothing you already send or receive changes shape, and no code needs to change to upgrade.

New and optional: `ToolReviewAnswer`'s `reject`, `AcpPermissionOutcome`'s `reject` and the `reject_tools` decision take `declined?: { note?: string }`; an ACP client's `reject` answer takes the same field; and a generic `ToolCallView` result carries `declined?: { note?: string }`. A host that sets `declined` on its reject gets, on that call's `tool_completed`, a view whose `label` is the call's target (path or command) and whose `note` is the person's words, cut at 4,000 characters. A host that does not set it, a call the authorization gate refused even when the person rejects the rest of its batch, and every other refusal by policy (strict or plan mode, no one to ask, the authorization gate, a repeated failure), is recorded exactly as before: an error result with no presentation. The text the model reads is unchanged. `ToolExecutor.executeBatch` takes an optional fifth argument for the same purpose.

The CLI's ACP server passes the field through, so a client such as Namzu Desktop that reports "the person said no" now shows "Declined" after a reload instead of "details unavailable". The terminal UI does not report it yet, so a call declined there still reloads as before.
