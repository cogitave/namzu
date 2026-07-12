---
"@namzu/sdk": patch
---

**Security.** Fixes an authorization bypass in the verification gate.

The gate was evaluated in the tool-review phase against the tool input as the model proposed it — but a `pre_tool_use` plugin hook may replace that input afterwards (`{ action: 'modify', input }`), and the replacement was dispatched to the tool registry without the gate being re-applied. A hook could therefore rewrite a gate-allowed call into one an explicit deny rule matches (for example `read_file {path:'/tmp/x'}` into `read_file {path:'/etc/passwd'}`) and it would execute.

The deny plane is now re-evaluated inside `ToolExecutor` against the FINAL input, after every hook has run and immediately before dispatch, so no rewrite — plugin hook, human `modify_tools`, or anything added later — can reach a tool without passing the deny rules. Evaluation fails closed: an exception while checking the final input is a denial.

Upgrade if you run with `verificationGate` enabled AND third-party or untrusted `pre_tool_use` plugin hooks. Deployments with no plugin hooks registered were not exposed through that path.
