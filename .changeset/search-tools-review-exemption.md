---
"@namzu/cli": patch
---

Fixed: under `toolLoading: 'deferred'`, `search_tools` was refused by review in every mode but `auto` — `plan` and `strict` refused it outright, and the interactive default (`prompt`) put up an approval dialog for it on every discovery call, where before the toolsets migration it ran silently. The session's own review-exemption manager is built from `sessionToolsets` alone and never learns about `search_tools` (mounted internally, per turn, by `query()`), so `reviewExemptionFor`'s lookup resolved it as an unknown tool and treated it as never exempt.

`reviewExemptionFor` now falls back to the SDK's own `search_tools` definition for a name the session's manager does not carry, read exactly the way the kernel reads a known tool (`isTrustedReadOnly`), so the exemption holds regardless of whether this turn's `query()` actually mounts it. This does not add `search_tools` to `/tools` or `/permissions` (`promptExemptToolNames`), which still read the session's roster bare and stay fixed at boot, as `tools-and-permissions-agree.test.ts` requires.

This is also what makes the earlier claim in this same release — that a tool `search_tools` reveals in one send stays active in a later send — true for `permissionMode: 'plan'` too; it previously held only for `auto`, since a blocked `search_tools` call never revealed anything to persist.
