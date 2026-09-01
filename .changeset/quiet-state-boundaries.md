---
'@namzu/cli': patch
'@namzu/sdk': patch
---

Delay durable CLI conversation creation until the first admitted message or explicit conversation operation, preserve user-owned command and plugin scope when the working directory is the home directory, validate feedback against the canonical session run ledger, protect generated project-state partitions with owner-only permissions, and fail closed when a delegated run loses its parent review channel.
