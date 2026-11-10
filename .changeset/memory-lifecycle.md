---
'@namzu/sdk': minor
'@namzu/cli': major
---

Namzu now keeps memory small by use and sets aside what a provider refused; nothing is deleted on its own.

**Breaking default for `@namzu/cli`:** when you are away, a memory a turn recorded on its own that has not been recalled for 21 days is archived (and exact copies of recorded memories, keeping the newest), so it stops appearing in recall and in `/memory`'s active list. It stays on disk; `/memory` lists it as retired and Restore brings it back. A memory you or Namzu saved is never changed. To keep every record active for ever, set `memory.retireAfterDays: 0` in your own config (a project file cannot set it); exact copies are still archived. Counting starts when the first usage file is written, so nothing is retired for being unused before the first window has passed. `/memory tidy` runs the sweep now.

**Breaking default for `@namzu/cli`:** when the provider refuses a message and the request carried recalled memories, those memories are set aside (recall will not offer them until you restore them in `/memory`) and the step is retried once without the memory entries before any other model is tried. The conversation keeps leaving memory out of its requests. There is no setting to turn this off; restoring a memory in `/memory` lets recall offer it again.

`@namzu/sdk` (additive): `QueryParams.withholdOnRefusal` (recorded-context keys to leave out of a refused request's one retry, history unchanged) and `QueryParams.withheldKeys`; `PrepareStepContext.withheldKeys`; a `model_refusal` event with `outcome: 'withheld'` (carrying `withheldKeys` and `withheldMemoryIds`; a host that switches over `outcome` should add a case); `createMemoryRecallStep` option `excluded` and export `recalledMemoryIds`.
