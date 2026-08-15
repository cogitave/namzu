---
'@namzu/sdk': patch
---

Delete `DiskThreadStore` — a filesystem persistence backend for the Thread layer that no production code ever constructed

`new DiskThreadStore` appeared zero times in the monorepo outside its own module (`store/thread/disk.ts` and its re-export in `store/thread/index.ts`). It was never exported from `public-runtime.ts` — only `InMemoryThreadStore` was, and still is — and it never entered `.github/scripts/public-surface-baseline.json`, so no consumer inside this repo or out of it could ever have imported the type, let alone constructed it. `@namzu/sdk`'s `package.json#exports` map only publishes `"."` and `"./testing"`, so even a deep import could never have reached it. There was also no `store/thread/__tests__` directory: 220 lines of write-tmp-rename persistence, an id→path index, a CAS path and a tenant guard, with no test exercising any of it.

The CLI wires `InMemoryThreadStore` for threads today (`ThreadManager({ threadStore: new InMemoryThreadStore(), sessionStore })`, `integrations/subagents/runtime.ts`), even though it wires `DiskSessionStore` for sessions in the same function — the Thread layer does not survive a process restart regardless of which store class exists in source, so removing the unused disk backend changes nothing about what a running `namzu` actually persists.

This also had a live, untested correctness defect, deleted along with the code: `listThreads` filtered directory entries by name (`entry.startsWith('thd_')`) but returned and indexed records by the `id` field read out of `thread.json` — a record whose `id` disagreed with the directory it lived in was listed under an address `getThread` could not resolve it back through, except by luck of an already-warm cache.

A durable Thread store is still owed — see the note added to `ThreadStore` in `types/thread/store.ts` — but building one is capability work with a real caller and a real test from day one, not a rename of code that already existed unreached. Decided as branch (a) of NZ-TOPIC-02 (`.work/sessions/ses_020-fit-gap-and-hygiene/README.md`, decision D3): a data migration (NZ-TOPIC-04) was about to be written against a store that had never had a single record written into it.

No public export changes. `DiskThreadStore` and `DiskThreadStoreConfig` were never part of `@namzu/sdk`'s public surface.
