---
type: Reference
title: Advisory context
description: What a configured SDK advisor receives, how the conversation window is bounded, and what the projection cannot establish.
resource: packages/sdk/src/advisory/executor.ts
tags: [sdk, advisory, context, evidence]
---

# Advisory context

A configured SDK advisor can be consulted by a trigger or through
`consult_advisor`. Both use `AdvisoryExecutor`: the advisor's system prompt,
optional context and the consultation question form one tool-free provider
request. This is an opt-in SDK mechanism. It does not enable a default CLI
reviewer or certify the main agent's answer.

## Public conversation records

When `includeContext` is not false, the executor projects the supplied messages
as JSON records in chronological order. Each record retains its role and text.
Assistant records retain tool call IDs, names, arguments and available public
text phases. Tool records retain the matching call ID, text blocks and the
explicit error flag when known. Missing error status stays unknown.

Host provenance identifies runtime feedback, goal continuations, project
instructions and compaction summaries. Provider/model attribution can accompany
assistant records. A user-role record with host provenance is not presented as
an operator-authored instruction. Text escaping preserves embedded newlines as
content rather than allowing them to fabricate extra record delimiters.

Images and documents become metadata with `contentOmitted: true`; user
attachments are treated the same way. Private reasoning, signatures,
adapter replay state, stored attachment references and binary payloads are not
sent in this text projection. It cannot evaluate media contents. A tool result
can still quote an unsupported claim: source attribution is not verification.

## Conversation window

`AdvisorDefinition.maxContextTokens` bounds serialized conversation records
using the existing estimate of four characters per token. Roles, tool metadata,
JSON escaping and record separators count. It keeps a contiguous suffix of
whole records, without cutting a tool's text into an unmarked partial claim.
Omitted or zero preserves the existing unbounded record window.

If the newest record cannot fit, no earlier record is substituted for it.
The context explicitly reports the number of messages excluded by the window.
A result retained at the boundary may lack its earlier call; the framing warns
about this. An omitted record is not evidence that the full history lacks it.

This is a record-window estimate, not a tokenizer or a total-request ceiling.
Fixed framing, working-state summary, runtime tool summary, system prompt and
question remain outside that window. Hosts must budget those separately. An
existing tight window may now retain fewer records because rich content and
metadata are correctly charged; increase the configured window if needed.

## Context and lifecycle limits

Automatic and tool-initiated consultations use a snapshot of the successfully
dispatched SDK request when available. That includes request-only step context
and prepared system guidance. The request is captured before driver mutation;
image-recovery retries replace it with the successfully repaired request. This
is the SDK message shape, not a promise about provider-native wire formatting.

`AdvisoryCallContext.turn` carries an `AdvisoryTurnContext`: the iteration,
`requestMessages`, and `subsequentMessages` starting with that response. The
projection labels records `request` or `subsequent` and applies one shared
conversation window. It does not append a duplicate of canonical history.
Later committed tool results, inbound messages and task notices retain their
position after the request. They do not become something the earlier model
call had already seen. A tool-initiated consultation during a batch cannot see
sibling results that have not yet been appended to the conversation.

The trajectory is bound to the current iteration and the exact response object
in the live history. If that anchor is unavailable, the executor uses canonical
history and labels the request snapshot unavailable. `messages` still carries
the canonical history for callers supplying their own context. An explicit
`turn` takes precedence for the advisor projection; `includeContext: false`
omits both. This does not reinterpret edits to earlier canonical records as
later appended observations or establish current workspace state.

The snapshot is transient: it is released at every iteration exit, including
cancellation, retry and early settlement. It is not checkpointed; a resumed
turn captures its newly dispatched request. The projection itself does not
recover compacted originals or replay tools. Scoped evidence retrieval must
supply those originals before dispatch, as it does for
[answer review](verification.md).

Advice is not an execution permission. The advisor has no executable tools in
this request. Existing turn cancellation, response ceilings and shared usage
accounting still apply. Automatic consultation remains awaited; this change
does not add concurrent judges or background evaluations.

The [source-support experiment](../../research/conversation-evidence/source-support-results.md)
records bounded live CLI review controls and their limitations. Its correction
callback is a research host configuration, not an enabled product default.

The [request-snapshot controls](../../research/conversation-evidence/advisory-turn-results.md)
cover changed evidence, late input, image repair, resume and cancellation, plus
a bounded live SDK transition and a separate interactive CLI recall check.
