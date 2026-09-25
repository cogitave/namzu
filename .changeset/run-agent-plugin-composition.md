---
'@namzu/sdk': minor
---

`runAgent` accepts a caller-owned `pluginManager` and mounts its toolsets, enabled plugin instructions, and hooks for the invocation. Hosts using the high-level agent entry point can now pass a configured `PluginLifecycleManager` without manually reassembling its contributions. The host still owns plugin admission, enablement, and cleanup.
