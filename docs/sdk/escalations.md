---
type: Reference
title: Crossing the tool boundary
description: How a turn turns a file tool's path outside its roots, or a command outside its sandbox, into a reviewed question instead of a refusal — QueryParams.outsideRootAccess and sandboxEscape, ToolCallSummary.escalation, confirmedEscalations, and the audit records.
resource: packages/sdk/src/runtime/query/executor.ts
tags: [sdk, hitl, permissions, sandbox, files]
status: stable
generated: { by: process:claude-code, at: 2026-09-22T00:00:00Z }
---

# Crossing the tool boundary

A turn has two boundaries a tool call can reach past: the **roots** its file tools resolve against (`workingDirectory` and `additionalDirectories`), and, on a sandboxed turn, the **sandbox**. By default both are refusals the tool returns. A host can make either a question asked before the call runs.

```ts sketch
query({
  // …
  outsideRootAccess: 'review', // a path outside the roots becomes a review
  sandboxEscape: 'review',     // a sandboxed bash call may ask to leave the sandbox
  resumeHandler: createReviewHandler({ mode: 'prompt', prompt, registry }),
})
```

Both default to `'refuse'`, and `QueryAgentConfig` carries the same two fields for a child.

## How a call becomes escalated

`prepareBatchForReview` decides it on the prepared value — after repairs and pre-tool hooks — and attaches it to the review call as `ToolCallSummary.escalation`:

- `outsidePaths` — only with `outsideRootAccess: 'review'`, only on a turn **without** a sandbox, and only for a tool that declares `ToolDefinition.pathArgument` (the shipped file tools declare `'path'`). The path is outside when `resolveWithinAnyReal` — the resolver the tools run — refuses it, so review and execution agree about symlinks. `pathOutsideRoots(roots, candidate)` is that check.
- `sandboxEscape: true` — only with `sandboxEscape: 'review'`, only on a turn **with** a sandbox, and only when the tool's `ToolDefinition.sandboxEscapeArgument` is `true` in the input (the shipped `bash` declares `'dangerously_disable_sandbox'`).

## What review does with it

An escalated call is always routed to the turn's `resumeHandler`:

- a gate `allow` becomes `review` for it (with `explicitReview`); a gate `deny` still refuses it, and the refusal is recorded as a refused crossing even when every call in the batch was denied;
- a remembered tool grant does not cover it;
- `batchNeedsReview` is true for it even when the tool is read-only, and `accept-edits` does not approve it on its own.

For `outsidePaths`, `createReviewHandler` asks its `prompt` in every mode that got that far — `auto` and a remembered "approve all" included, since both were answers about tools given before the path was named. `strict` refuses it. `plan` asks about a batch in which every call only reads (exempt, not destructive, no explicit review, no escape), since reading is what plan mode is for, and refuses any batch that would change something with `PLAN_MODE_REFUSAL`. With no `prompt` it refuses the batch with `OUTSIDE_ROOTS_UNATTENDED_REFUSAL`; a host with nobody to ask widens the roots up front with `additionalDirectories` instead. An `approve-all` answer to such a prompt latches for ordinary calls, never for the next path.

For `sandboxEscape` an approval is not enough. The decision must list the call's id in `confirmedEscalations` (on `approve_tools` or `modify_tools`); a call it does not list is refused and the rest of the batch runs. `createReviewHandler` fills it only after its `prompt` said yes — it asks in every mode that got that far, `auto` and a remembered "approve all" included — or, with no `prompt`, when `unattendedSandboxEscape: 'allow'`. Otherwise it refuses the batch with `SANDBOX_ESCAPE_UNATTENDED_REFUSAL`. A host's own handler that answers `approve_tools` to everything therefore cannot release an escape by accident.

That unattended setting confirms only the escape. An outside-root path or a tool's `requiresApproval` declaration in the same call or batch still needs a person; without a prompt, the whole batch is refused with that boundary's reason.

## What the tool is handed

For each call that was not denied, the executor sets, on that call's context only:

- `ToolContext.approvedPaths` — the approved `outsidePaths`. `toolRoots(context)` includes them, so every file tool accepts exactly those paths for that call, including a file `write` is about to create: `resolveWithinReal` canonicalizes a root that does not exist yet the way it canonicalizes the candidate.
- `ToolContext.sandboxEscapeApproved: true` — `bash` runs the command on the host instead of in the sandbox, and refuses `dangerously_disable_sandbox` with `SANDBOX_ESCAPE_NOT_APPROVED` when this is absent.

A nested call a tool dispatches inherits neither.

## Resuming across a restart

A durable decision applies to what the reviewer was shown. On resume a re-prepared call is refused when it reaches a path its reviewed escalation did not list, when it asks to escape and the decision did not confirm it, or when nobody reviewed it or its input was modified afterwards.

## The audit trail

Each crossing is an audit record in the session log:

| `action` | `outcome` | When |
| --- | --- | --- |
| `outside_root_access` | `approved` | A reviewed call reached a path outside the roots; `resource` is the path. |
| `outside_root_access` | `refused` | The decision refused the call (`reject_tools`, or a denial in `modify_tools`); `resource` is the path. |
| `sandbox_escape` | `approved` | A reviewer confirmed the escape for the call. |
| `sandbox_escape` | `refused` | The decision refused the call, did not confirm the escape, or a resume could not apply it. |

`AuditOutcome` gained `'approved'` for these; `replayAudit` skips it, since it is one action inside a turn, not the turn's verdict.

## Refusals

A path a file tool still refuses — no review asked for, or a glob pattern that climbs out of its `path` — ends with `OUTSIDE_ROOTS_GUIDANCE`: where the tools reach, and that the user can add the directory to the session. Inside a sandbox the refusal says the path is not mounted.
