---
'@namzu/sdk': minor
'@namzu/cli': patch
---

Hosts can use `QueryParams.onJobNoticeDelivered(jobIds)` to distinguish background job exits recorded for the model from exits that still need delivery on a later turn. The CLI now keeps a late exit pending for the next turn, retains it after a failed or aborted send, and shows its transcript row once.
