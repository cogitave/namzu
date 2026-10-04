---
'@namzu/sdk': minor
'@namzu/cli': patch
---

Add `buildPalSystemPrompt` and `PalSystemPromptOptions` for hosts to compose a
Pal's saved identity, conversational language, public output discipline and
truthful computer availability. The helper does not acquire execution authority.
CLI Pal sessions use these shared instructions while retaining their pinned
model and execution policy. Authenticated name and appearance edits update the
next turn's display identity without rewriting the original introduction.

Add `PalRuntime.admitConversation`, `PalConversationAdmission` and
`PalRuntime.computerChanging`. Hosts can admit exclusive model-only chat without
starting a computer, with current pause, cancellation and ownership checks.
Guest acquisition remains separate and requires the real guarded environment;
the existing mandatory `admit` contract is unchanged. CLI manual chat supplies
zero tools while offline or operator-controlled, then adopts the actual guest
toolset on a later turn after explicit startup or returned control. Directed
dispatch and checkpoint resume continue to require guest admission.
The standalone `pal chat` command keeps its existing computer-startup preflight.

Add `palConversationGreeting` and `PalConversationGreeting` to reconstruct a
stable English onboarding prelude from an owned conversation's original profile
revision. CLI Pal claim and list results expose this separate host-authored
intro without starting a model request or manufacturing a journal turn.
Pal desktop history omits explicit assistant commentary and tool-call narration
from its public display projection while retaining the original journal.
