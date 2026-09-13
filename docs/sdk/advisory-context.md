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

Automatic and tool-initiated consultations receive the live canonical run
messages. Request-only step context is not automatically included unless it is
in the supplied messages. This differs from the candidate request snapshot
available to [answer review](verification.md). The projection does not recover
compacted originals or replay tools; use scoped evidence access for that work.

Advice is not an execution permission. The advisor has no executable tools in
this request. Existing run cancellation, response ceilings and shared usage
accounting still apply. Automatic consultation remains awaited; this change
does not add concurrent judges or background evaluations.

The [source-support experiment](../../research/conversation-evidence/source-support-results.md)
records bounded live CLI review controls and their limitations. Its correction
callback is a research host configuration, not an enabled product default.
