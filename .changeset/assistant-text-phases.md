---
"@namzu/sdk": minor
"@namzu/cli": minor
"@namzu/openai": patch
---

Preserve provider-identified public assistant message items through streaming,
settlement and conversation persistence. The SDK adds optional `textParts`
snapshots, `textPart` delta metadata and `selectAssistantText`. Completed content
selects explicitly final answers instead of concatenating intermediate progress
into the answer; ordinary unphased streams retain their existing behavior.

The Codex subscription driver maps native message phases and verifies the original
public parts before native replay. The CLI exposes optional item metadata on
delta events, separates streamed item bubbles and uses the settled answer for
turn completion. Consumers that manually concatenate deltas should use completed
content when they want the final answer; deltas still contain public progress.
