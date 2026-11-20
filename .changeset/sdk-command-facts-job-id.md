---
'@namzu/sdk': minor
---

The typed facts of a command that went to a background job now name the job (`jobId`) and, when its own time limit moved it, that limit in milliseconds (`timeLimitMs`); `admitToolFacts` reads both back. A host can use them to show what the job is doing now. Both fields are optional, so nothing changes for a host that ignores them.
