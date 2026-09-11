---
'@namzu/sdk': major
'@namzu/cli': major
---

Resident wake calls now retain all accepted inputs until the next step settles, instead of replacing the previous wake reason. `ResidentState.wakeEvidence` exposes immutable reasons and receipt times; the SDK resident prompt and both CLI resident profiles include the complete batch. CLI resident status shows pending input counts.

The new default accepts at most 16 pending inputs and 16,000 total reason characters per pursuit. Overflow rejects the new wake without discarding accepted evidence. Callers that previously sent an unlimited series of replacement wakes must process each batch before sending more, or coalesce superseded inputs before calling `wake`. Custom callbacks should read `wakeEvidence` rather than only the latest `reason`.

Standalone resident records now write schema 2 and agenda records schema 6. Older processes refuse these new formats: upgrade all processes sharing the store together. Prior formats remain readable without inventing historical inputs. Crashed steps keep their pending evidence; only successful exact-claim settlement or explicit inspected reconciliation consumes it.
