---
"@namzu/cli": patch
---

Secure and verify private state and credential files on long Windows paths by passing extended absolute paths to icacls. Keep the existing current-user ACL proof and fail-closed behavior. Project and conversation directory names remain compatible with existing installations.
