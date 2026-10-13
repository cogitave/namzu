---
'@namzu/sandbox': minor
---

Add optional `suspendedTarget` and the exported `KubernetesWorkspaceDeleteOptions` type to `deleteKubernetesWorkspace`. Hosts with durable exclusion and capture proof can delete the same suspended disk without waking it. The SDK validates the complete target before I/O, verifies the original resources, and sends one UID/resource-version conditional DELETE. Keep exclusion until retained-target reconciliation confirms all original dependents are gone; a successful DELETE alone is not completion. Calls that omit the new option retain their existing behavior.
