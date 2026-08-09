---
'@namzu/sdk': minor
---

Publish the checkpoint-store conformance suite at `@namzu/sdk/testing`

`CheckpointStore` is an interface a host is expected to implement, and the
in-memory store's source calls itself "the reference a host reads when writing a
backend of its own". That claim was unbacked. Two days before this change the
two shipped implementations disagreed at the enforcement point — the in-memory
one accepted a checkpoint from a worker that had been superseded and then
released around, the disk one refused it — and the class documented as the
reference was the one carrying the defect. Nothing threw, nothing logged, and a
completed worker's checkpoint was silently replaced by a dead worker's. A host
writing its own backend had no way to find that out.

New: a `./testing` subpath exporting `defineCheckpointStoreConformance` and
`CHECKPOINT_STORE_CONTRACT_VERSION`. Nothing existing changes; the package's one
existing export is untouched.

```typescript
import { describe, expect, it } from 'vitest'
import { defineCheckpointStoreConformance } from '@namzu/sdk/testing'

defineCheckpointStoreConformance({
  describe, it, expect,
  label: 'my-backend',
  contractVersion: 1,
  capabilities: { claims: true, listing: true, multiTenant: true },
  makeStore: async (binding) => ({ store: await MyStore.connect(binding) }),
})
```

The suite takes `describe`, `it` and `expect` as arguments, so it binds to no
test runner and installing `@namzu/sdk` pulls in no test dependency. It
covers the four rules the types cannot state and the two built-in stores
actually diverged on: claim exclusivity, claim expiry, refusal of a fenced-out
write, and listing scope isolation across tenants. `capabilities` names what
your backend can do so the suite asks only what it can answer.

**Take note before you wire it in.** Once you do, every assertion in the suite
is something your build fails on — so the suite's assertions are public API from
here, and tightening or adding one is a `major` for this package rather than a
`minor`, even though it adds no export. `contractVersion` is the seam that makes
such a bump legible: write the number as a literal (do **not** re-export the
constant, which makes the check unfailable), and a contract revision then fails
with `expected 'checkpoint-store contract v1' to be 'checkpoint-store contract
v2'` instead of a scatter of assertion failures whose common cause is not
obvious.

Documented at `docs/sdk/runtime/checkpoint-store-conformance.md`.
