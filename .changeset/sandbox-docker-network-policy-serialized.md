---
"@namzu/sandbox": patch
---

On the docker backend, two overlapping `setNetworkPolicy()` calls on one
sandbox could leave no egress proxy running while a caller was told its policy
was in force, or resolve one call while the other call's policy was the one
applied. Calls on one sandbox now run one at a time, in the order they were
made, and each resolves only once its own policy is running. A call that asks
for the allowlist already in force no longer restarts the proxy. No action is
needed.
