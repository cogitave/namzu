# @namzu/ag-ui

## 3.0.0

### Major Changes

- 567ada8: The AG-UI adapter now reads tools and review metadata from the query's
  `toolsets`, preserving review exemptions and per-tool timeouts after the
  `ToolRegistry` removal. Hosts must return `QueryParams.toolsets` from
  `createQuery` instead of passing a `ToolRegistry` as `tools`. Wrap definitions
  with `toolset(source, definitions)` and require `@namzu/sdk >=48.0.0`; use
  `@namzu/ag-ui` 2.x with SDK 45.1–47. MCP resource tools likewise rely on their
  owning toolset for source trust instead of a removed per-tool provenance field.

### Patch Changes

- 567ada8: Exercise repeated AG-UI runs with one stable native session owner and verify that a host resolving the same session under another tenant is refused before its history reaches a model. This updates the integration checks for the SDK's stricter session attribution; the adapter API is unchanged.

## 2.0.0

### Major Changes

- 73dee65: A paused turn now ends its AG-UI run as an interrupt the client can answer, and `RunAgentInput.resume` continues it.

  **What breaks.**

  - A native pause (`turn_paused`) used to end the run with a `CUSTOM` event named `namzu.turn.paused`, carrying the checkpoint id, followed by `RUN_ERROR` code `NAMZU_TURN_PAUSED`. It now ends with `RUN_FINISHED` whose `outcome` is `{ type: 'interrupt', interrupts }`, and the `CUSTOM` event is gone. A client that waited for `NAMZU_TURN_PAUSED` reads `outcome.type === 'interrupt'` instead; a host that resumed the checkpoint itself from the `CUSTOM` event's `checkpointId` sends the interrupt's answer in `resume` instead.
  - `AGUIEventMapper.map` no longer emits anything for `turn_paused`: it sets `paused`, and the run ends with the new `interrupt(interrupts)`, or `finish()` reports `RUN_ERROR` code `NAMZU_TURN_PAUSED` as before, without the `CUSTOM` event.
  - A request with `resume` is served instead of refused with HTTP 422 `UNSUPPORTED_RESUME`. A resume the adapter cannot apply (unknown, from another thread, already answered, expired, incomplete, malformed, stale, refused by the kernel) ends with `RUN_ERROR` and an `AGUI_*` code. New input on a thread with open interrupts runs nothing and ends with the same interrupts again, where a paused turn used to make it end with `NAMZU_TURN_IN_PROGRESS`.
  - Peer dependencies: `@namzu/sdk` `>=45.1.0` (was `>=44.0.0`), for the `handoff` on `turn_paused`; and `zod` `^3.23.0`, already the SDK's peer, because the adapter now builds tool definitions.
  - `context.signal` in `createQuery` is the signal of the turn the request starts. It still aborts when the request is cancelled while a run reads the turn; it no longer aborts when a request whose run ended with an interrupt closes afterwards.

  **What is new.** `context.interrupts.resumeHandler` and `context.interrupts.prompt` send reviews, questions and plan approvals to the client: a tool review becomes `tool_call` interrupts (answered `{ approved, editedArgs?, reason? }`), `ask_user_question` and `ToolContext.requestPause` become `input_required` interrupts, `ToolResult.handoff` a `namzu:handoff` interrupt, and any other resumable pause `namzu:paused`. Interrupt ids are minted by the adapter and recorded against the native session, turn and checkpoint in an `AGUIInterruptStore` (`interrupts.store`, in memory by default; `interrupts.ttlMs`); an answer applies once. The `frontendTools` option admits tools a client declares in `RunAgentInput.tools` as `context.frontendTools`; a request declaring tools without it is still refused with 422. See the AG-UI guide for payloads, codes and the limits of a question's wait.

### Minor Changes

- 443094a: `fromNamzuMessages` now emits the source namzu message's own `id` (`@namzu/sdk`'s new `BaseMessage.id`) as the converted AG-UI message's id, when it has one — which a message read from a session's fold (`foldSessionMessages`, or `namzu history`'s own read of the log) always does. `options.idPrefix` (default unchanged, `namzu-message-`) now only names the fallback for a message with none. This is display-only: `toNamzuMessages` does not read an inbound AG-UI message's id back onto the converted message, because a live run's own streaming events give a client a different, unrelated correlation id for the same content, and resending it would fail `query()`'s reconciliation as an id its session log never recorded (`stale_cached_history`, `'foreign'`). A caller that compared a `fromNamzuMessages` result's ids against `${idPrefix}${index}` in a fixed sequence sees real ids instead; one that only checked they were present, unique and stable per history is unaffected.
- 49491b9: `TOOL_CALL_END` for a call whose arguments could not be read now says why. `metadata.namzu.inputTruncated` is set for arguments that were cut off and for arguments that were malformed alike, so it was all a host had and it could not tell the two apart. When the runtime recorded the cause, the event also carries `metadata.namzu.inputError`, the `ToolInputError` from `tool_input_completed`: `reason` is `'truncated'` or `'malformed'`, with the rest of that error as the runtime recorded it (`finishReason`, `finishDetail`, `parseError`, `offset`, `length`, `precedingLength`, `outputTokens`, `reasoningTokens`). Nothing changes for a host that reads only `inputTruncated`. An `@namzu/sdk` that records no cause, and arguments only the adapter found unparsable, still carry `inputTruncated` alone.

## 1.0.0

### Major Changes

- 3e7a97b: Requires `@namzu/sdk >=44.0.0` (was `>=36.0.0`), where the kernel's run became
  a turn inside a session. Earlier `@namzu/ag-ui` versions break against SDK 44.

  **What changes on the wire.** The AG-UI ids themselves do not: `RUN_*`
  events still echo the client's `threadId` and `runId` verbatim. Only the
  Namzu-owned names change.

  - Error codes on `RUN_ERROR`: `NAMZU_RUN_ERROR`, `NAMZU_RUN_CANCELED` and
    `NAMZU_RUN_PAUSED` are `NAMZU_TURN_ERROR`, `NAMZU_TURN_CANCELED` and
    `NAMZU_TURN_PAUSED`.
  - New `NAMZU_TURN_IN_PROGRESS`: a second run on a thread whose Namzu session
    already has an active turn is answered with `RUN_ERROR` carrying this code
    instead of starting a parallel one.
  - The pause custom event `namzu.run.paused` is `namzu.turn.paused`.

  **What changes for a host.** A thread maps to a Namzu session and each AG-UI
  run to a new turn in it. The client's `runId` is recorded as the turn's
  `origin.externalTurnId`, never used as a Namzu id. `MESSAGES_SNAPSHOT` is the
  session's folded transcript, so it shows the answer after any guardrail or
  review rewrite, never the raw text.

  **Renamed exports.** `AGUIRunContext`, `AGUIRunOptions`, `AGUIRunUI` and
  `AGUIRunUIOptions` are `AGUITurnContext`, `AGUITurnOptions`, `AGUITurnUI` and
  `AGUITurnUIOptions`, with the same shapes. The AG-UI protocol's own names
  (`RunAgentInput`, `onRunFailed` and the other callbacks) are unchanged.

  **What to do.** Upgrade `@namzu/sdk` and `@namzu/ag-ui` together, rename
  imports of the four types above, and rename any client code that matched the
  old error codes or custom event name.

## 0.1.1

### Patch Changes

- 8d5223b: Nothing a consumer installs or calls changes, and that is the whole of this
  release. `vitest` moves from `^3.2.6` to `^4.1.11` in the `devDependencies` of
  all nineteen packages that declared it, and `@vitest/coverage-v8` moves with it
  in `@namzu/sdk`. Every occurrence is a devDependency — checked, not assumed —
  so `dependencies`, `peerDependencies`, exports, types, defaults and the wire
  shape are untouched, and the published tarballs differ from the previous
  release only in `package.json#devDependencies`.

  The reason is a security fix with no 3.x backport. `GHSA-82fw-gwwq-j7x9`
  ("Path Traversal / Arbitrary File Read via `@vitest/mocker` Redirect Mock")
  covers `vitest` and `@vitest/mocker` from `2.1.0` up to `4.1.11`, so `^3.2.6`
  can only be resolved by leaving the 3.x line. `4.1.11` is the first patched
  release and is what the lockfile now resolves for both.

  What this costs anyone who works on the repository rather than with it: the
  upgrade was not a version bump. Vitest 4 changed test discovery, coverage
  configuration, mock construction and reporter output, and each of those broke
  something here that had to be migrated rather than worked around. Those fixes
  are all under `__tests__/`, `vitest.config.ts` files and `scripts/`, none of
  which is published, which is why this is a patch and not a major.

  You do not need to do anything. If you pin `vitest` yourself to run this
  project's own suites, note that the config files it ships are now written for
  `>= 4.1.11` and will not run under 3.x.

## 0.1.0

### Minor Changes

- ddf13ff: Add the optional `@namzu/ag-ui` package for exposing a trusted Namzu query
  configuration through AG-UI typed events or a Fetch-compatible POST/SSE
  endpoint. Hosts resolve authenticated native scope and explicitly admit
  message history; backend tools, request-owned state updates, custom events,
  authoritative final results, usage, cancellation, and bounded payloads are
  supported with the official AG-UI 0.0.59 client.

  Frontend tool definitions and AG-UI resume requests are rejected with HTTP 422. Native pauses report a custom event and a run error; checkpoint
  resumption and durable thread history remain application responsibilities.

- a34d737: Add AGUIRunUI.setInitialMessages for host-authorized display history reconciliation inside createQuery. A validated, detached MESSAGES_SNAPSHOT reaches the client before native query events, subject to existing event byte and queue limits. This does not change model input or automatically trust browser history. Calls after createQuery returns are refused so active message/tool lifecycles cannot be overwritten. Interrupt resumption remains unsupported.
