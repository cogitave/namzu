---
uid: namzu.sdk.runtime.checkpoint-store-conformance
title: Test your own checkpoint store
description: Run the shipped checkpoint-store contract against a backend you wrote yourself — what the suite guarantees, how to wire it to any test runner, the capability flags, and why the contract carries a version number.
type: Guide
diataxis: how-to
owner: cogitave/namzu
status: active
timestamp: 2026-08-09T00:00:00Z
lastReviewed: 2026-08-09
resource: packages/sdk/src/store/run/conformance.ts
tags: [sdk, store, checkpoints, testing, conformance]
---

# Test your own checkpoint store

`CheckpointStore` is an interface, and a host is expected to implement it —
against a database, an object store, whatever the deployment already runs. The
types say what the methods are called. They cannot say that a claim is
exclusive, that it expires, that a superseded write is refused, or that a
listing answers for one tenant and no other.

`@namzu/sdk/testing` ships those rules as a suite you run against your own
backend.

## Why it exists

The two built-in stores once disagreed at the enforcement point. The in-memory
one accepted a checkpoint from a worker that had been superseded and then
released around; the disk one refused it. Nothing was thrown, nothing was
logged, and the completed worker's checkpoint was silently replaced by the dead
worker's — and the class whose source calls itself *the reference a host reads
when writing a backend of its own* was the one carrying the defect.

Reading a reference cannot surface that. Running it can.

## Wire it up

Three runner functions go in; the suite imports no test framework of its own,
so `@namzu/sdk` adds no test dependency to your install.

```typescript
import { describe, expect, it } from 'vitest'
import { defineCheckpointStoreConformance } from '@namzu/sdk/testing'

import { PostgresCheckpointStore } from './store.js'

defineCheckpointStoreConformance({
  describe,
  it,
  expect,

  label: 'postgres',
  contractVersion: 1,
  capabilities: { claims: true, listing: true, multiTenant: true },

  makeStore: async (binding) => {
    const store = await PostgresCheckpointStore.connect(binding)
    return { store, dispose: () => store.close() }
  },
})
```

`makeStore` is called **once per case**, so no case can be affected by
another's writes. Whatever producing the store required — a schema, a
container, a temp directory — is released by `dispose`, which runs whether the
case passed or failed.

Any runner works. The suite uses four matchers (`toBe`, `toEqual`,
`toBeGreaterThan`, `toMatch`) and nothing else, and `describe`/`it` only need
to accept a name and a function.

## What it guarantees

| Group | The rule |
|---|---|
| Claim exclusivity | One taker gets the run; a second gets `null`, not an error. Renewing by the current holder mints a **higher** fence, so a duplicate of that holder cannot write with the number it captured earlier. A lease with no duration is refused. |
| Claim expiry | A run whose holder went away can be taken by somebody else, at a higher fence. Releasing returns it to the queue immediately. A worker that stalled past its lease cannot release a run somebody else now holds. |
| Fenced-out writes | The current holder writes. An **unfenced** write still succeeds on a claimed run, so claims can be rolled out one worker at a time. A superseded fence is refused — including after the new holder released cleanly, and including the fence a holder just gave up itself. |
| Listing scope isolation | A listing for a tenant the store does not hold returns nothing, and the same for a project. A scope with a hole in it (`sessionId` without `projectId`) is refused rather than guessed at. Rows come back as full run scopes, so a row can be resumed. With `multiTenant`, one tenant's runs stay out of another's listing. |

Those are not an arbitrary selection. They are the points at which the two
built-in implementations actually diverged.

## Capability flags

Every flag is required — there is no default. A capability that defaulted to
`false` would let you skip a whole section by forgetting a key, and a suite you
can opt out of by omission reports a pass it did not establish.

- **`claims`** — the store implements `claimRun` / `releaseRun` and enforces
  the fence at `writeCheckpoint`. Set it `false` only for a genuinely
  single-writer backend. It is a deployment shape, not a shortcut: a
  multi-worker deployment on a store without a lease loses work silently.
- **`listing`** — the store implements `listDurableRuns`.
- **`multiTenant`** — one instance can hold more than one tenant's runs. The
  built-in disk layout has no tenant segment in it, so for that store a second
  tenant is a second store; it declares `false` and still answers the isolation
  case that *can* be put to it.

## `contractVersion`, and why you write the number

`CHECKPOINT_STORE_CONTRACT_VERSION` is exported, and the suite's first case
compares it against the `contractVersion` you passed.

**Write the literal.** Re-exporting the constant into that slot makes the check
unfailable, which defeats the point: the number is meant to be frozen in your
source at the moment you wrote the backend. Upgrading `@namzu/sdk` past a
contract revision then fails with a sentence naming both numbers, instead of a
scatter of assertion failures whose common cause is not obvious from any one of
them.

```
expected 'checkpoint-store contract v1' to be 'checkpoint-store contract v2'
```

The version rises only with a `major`, and only when an assertion is added or
tightened. A case added behind a **new** capability flag does not raise it — a
backend that does not declare the capability never runs the case.

## The suite's assertions are public API

Once you wire this in, every assertion in it is something your build fails on.
Adding one is therefore a breaking change for you even though it adds no
export. That is why the version exists and why tightening the suite is a
`major` for this package rather than a `minor`.

## Related

- [Testing agents](testing.md) — scripting the model rather than the store.
- [State and persistence](../architecture/state-and-persistence.md) — where the
  checkpoint store sits in the runtime.
