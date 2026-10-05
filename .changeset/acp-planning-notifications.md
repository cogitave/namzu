---
"@namzu/sdk": minor
---

Add optional `namzu/tasks/update` planning notifications, exported `AcpTask` and `AcpTaskUpdate` shapes, and `ACP_TASK_CAPABILITY`. Hosts enable `supportsTaskNotifications` and clients declare `namzu/tasks`; existing core updates and default wire behavior remain unchanged. Notifications preserve planning IDs, failed status, dependency and owner clears, and deletion without forwarding private task descriptions or metadata.
