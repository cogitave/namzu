---
"@namzu/sdk": major
---

Add opt-in structuredOutput.mode:'native', preserving the default tool mode. Capable routes receive the JSON Schema response format; completed JSON is locally validated and host-reviewed with bounded, checkpointed corrections. Cancellation and pending operator corrections are checked before publication. Native output avoids the tool-result preview cap.

Blocked, rewritten, cancelled and failed runs now invalidate structuredOutput. A textual output-guardrail rewrite on a configured structured run stops with output_guardrail instead of exposing the old structured value as success. Consumers must check stopReason and handle an absent structuredOutput; use structuredOutput.review to request schema-valid corrections instead of rewriting final text.
