---
"@namzu/sdk": minor
---

Add optional `terminate(signal?): Promise<void>` to `SandboxDetachedProcess` and background `JobProcess` for providers that must confirm a remote process tree stopped. The registry waits for this confirmation before reporting termination. A failed confirmation rejects the stop call and retains the owned running job with optional `recoveryRequired` and a safe `stopError`, so the host can retry recovery without forgetting live work. Providers that use the existing synchronous `kill` method retain their current behavior.
