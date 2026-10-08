---
"@namzu/sdk": patch
---

A tool call made from inside another tool (for example through `run_code`) to a tool that declares `requiresApproval` for that input is now refused and audited, even when an allow rule covers it. An approval cannot be requested from inside another tool; call such a tool directly. Hosts that mounted `run_code` with an allow rule on an approval-gated tool will see it refused.
