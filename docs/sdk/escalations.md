---
type: Reference
title: Crossing the tool boundary
description: How a turn turns a file tool's path outside its roots, a command outside its sandbox, or a command whose own program name is decided at runtime, into a reviewed question instead of a refusal — QueryParams.outsideRootAccess and sandboxEscape, ToolCallSummary.escalation, confirmedEscalations, and the audit records.
resource: packages/sdk/src/runtime/query/executor.ts
tags: [sdk, hitl, permissions, sandbox, files]
status: stable
generated: { by: process:claude-code, at: 2026-09-22T00:00:00Z }
---

# Crossing the tool boundary

A turn has two boundaries a tool call can reach past: the **roots** its file tools resolve against (`workingDirectory` and `additionalDirectories`), and, on a sandboxed turn, the **sandbox**. By default both are refusals the tool returns. A host can make either a question asked before the call runs.

A third escalation is not a boundary a host opts into crossing — it is always checked, on every turn, for every tool that declares `ToolDefinition.commandArgument`: a command whose own PROGRAM NAME cannot be read before it runs.

```ts sketch
query({
  // …
  outsideRootAccess: 'review', // a path outside the roots becomes a review
  sandboxEscape: 'review',     // a sandboxed bash call may ask to leave the sandbox
  resumeHandler: createReviewHandler({ mode: 'prompt', prompt, registry }),
})
```

Both default to `'refuse'`, and `ReactiveAgentConfig` carries the same two fields for a child.

## How a call becomes escalated

`prepareBatchForReview` decides it on the prepared value — after repairs and pre-tool hooks — and attaches it to the review call as `ToolCallSummary.escalation`:

- `outsidePaths` — only with `outsideRootAccess: 'review'`, only on a turn **without** a sandbox, and only for a tool that declares `ToolDefinition.pathArgument` (the shipped file tools declare `'path'`). The path is outside when `resolveWithinAnyReal` — the resolver the tools run — refuses it, so review and execution agree about symlinks. `pathOutsideRoots(roots, candidate)` is that check.
- `sandboxEscape: true` — only with `sandboxEscape: 'review'`, only on a turn **with** a sandbox, and only when the tool's `ToolDefinition.sandboxEscapeArgument` is `true` in the input (the shipped `bash` declares `'dangerously_disable_sandbox'`).
- `unknownProgram` — for any tool that declares `ToolDefinition.commandArgument` (the shipped `bash` declares `'command'`), sandboxed or not, with no `QueryParams` opt-in: the command's `commandArgument` is lexed in the tool's `ToolDefinition.commandDialect`, then walked with `resolveScriptPrograms` (`packages/sdk/src/authorization/program.ts`) — the SDK's one answer to "where does this command actually exec a program", shared with the scheduled-run floor and `verifyScheduledScript` so the three never disagree. It unwraps a chain of re-exec wrappers (`sudo`, `env`, `nice`, `ionice`, `nohup`, `setsid`, `timeout`, `stdbuf`, `chrt`, `taskset`, `time`, `command`, `builtin`, `exec`, `xargs`) with each one's own real option grammar — `timeout 5 prog`, `stdbuf -oL prog` and `env VAR=value prog` all take at least one word of their own before the program, so the program is never assumed to be the word right after the wrapper's name — reads each `find -exec`/`-execdir`/`-ok`/`-okdir` clause as its own position, and threads a poisoned resolution environment (a command-prefix or `export` assignment to `PATH`, `LD_PRELOAD`, `LD_LIBRARY_PATH`, `BASH_ENV`, `ENV` or `IFS`) from one command to the next. If any position it visits cannot be resolved to a literal, non-expanding word — the word itself is an expansion (`$(echo rm) -rf x`, `` `echo git` push``, a bare variable `$X push`, a variable in the program's path `"$HOME"/bin/tool`, or one hidden behind a wrapper, `env $(echo git) push`), an option on a wrapper this does not recognise stood in the way, an `xargs` program that is a shell or built from its input, or the resolution environment was poisoned earlier in the same script — `unknownProgram` is set to that command's text and why. `source path`/`. path` and `eval word…` are read the same way a nested `bash -c '<literal>'` payload already is, not as an automatic unknown: a LITERAL path is known — `source`/`.` running that file is exactly as knowable as `bash path` running it, and nothing here inspects either one's contents — and a LITERAL `eval` payload is joined and lexed as a command line of its own, with every position inside it folded into the same check (so `eval 'env $(echo git) push'` is still unknown, transitively). Only an expanding path or argument word (`source "$X"`, `eval "$X"`), or a payload that does not read cleanly, is unknown. An expansion anywhere else in the command — an ordinary argument — does not set it: only a position that actually decides which program runs does, since flagging every expanding argument would put a review in front of nearly every call. No `deny` rule written against the program's real name can be trusted to have matched a name that never appears as such anywhere in the call's own text (`"git push*": deny` does not see `$(echo git) push origin main`, and it does not see `env $(echo git) push origin main` either), which is what this exists to catch.

## What review does with it

An escalated call is always routed to the turn's `resumeHandler`:

- a gate `allow` becomes `review` for it (with `explicitReview`); a gate `deny` still refuses it, and the refusal is recorded as a refused crossing even when every call in the batch was denied;
- a remembered tool grant does not cover it;
- `batchNeedsReview` is true for it even when the tool is read-only, and `accept-edits` does not approve it on its own.

For `outsidePaths`, `createReviewHandler` asks its `prompt` in every mode that got that far — `auto` and a remembered "approve all" included, since both were answers about tools given before the path was named. `strict` refuses it. `plan` asks about a batch in which every call only reads (exempt, not destructive, no explicit review, no escape), since reading is what plan mode is for, and refuses any batch that would change something with `PLAN_MODE_REFUSAL`. With no `prompt` it refuses the batch with `OUTSIDE_ROOTS_UNATTENDED_REFUSAL`; a host with nobody to ask widens the roots up front with `additionalDirectories` instead. An `approve-all` answer to such a prompt latches for ordinary calls, never for the next path.

For `sandboxEscape` an approval is not enough. The decision must list the call's id in `confirmedEscalations` (on `approve_tools` or `modify_tools`); a call it does not list is refused and the rest of the batch runs. `createReviewHandler` fills it only after its `prompt` said yes — it asks in every mode that got that far, `auto` and a remembered "approve all" included — or, with no `prompt`, when `unattendedSandboxEscape: 'allow'`. Otherwise it refuses the batch with `SANDBOX_ESCAPE_UNATTENDED_REFUSAL`. A host's own handler that answers `approve_tools` to everything therefore cannot release an escape by accident.

For `unknownProgram`, `createReviewHandler` asks its `prompt` in every mode that got that far — `auto` and a remembered "approve all" included, the same as `outsidePaths` — naming why: "this call's program cannot be verified ahead of time (`<the command's text>`: `<why that position could not be resolved>`)". A plain `approve` is enough; there is no per-id confirmation the way `sandboxEscape` needs, and no `unattendedSandboxEscape`-style opt-in — an operator who wants an unattended turn to run such a command needs the program name written literally, outside any wrapper option this does not recognise, with a literal, cleanly-parsing path or payload for any `source`/`.`/`eval` in the line. With no `prompt` it refuses the batch with `UNKNOWN_PROGRAM_UNATTENDED_REFUSAL`. A `deny` rule still refuses the call outright, even one that could not have matched the hidden name itself (a rule that denies the tool by name, or a broader pattern an unrelated word in the command satisfies).

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
| `unknown_program` | `approved` | The turn's review approved a call whose program name could not be resolved; `resource` is the command's text and why the position it occupies could not be resolved. |
| `unknown_program` | `refused` | The decision refused the call, or nobody could be asked; `resource` is the same. |

`AuditOutcome` gained `'approved'` for these; `replayAudit` skips it, since it is one action inside a turn, not the turn's verdict.

## Refusals

A path a file tool still refuses — no review asked for, or a glob pattern that climbs out of its `path` — ends with `OUTSIDE_ROOTS_GUIDANCE`: where the tools reach, and that the user can add the directory to the session. Inside a sandbox the refusal says the path is not mounted.
