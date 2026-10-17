---
'@namzu/sdk': minor
---

The built-in background job registry now mints ids as `b` plus eight random characters from `0-9a-z` (for example `b1k3x9q2z`) instead of `job_1`, `job_2`, … counted per registry. The counter restarted in every session and after every resume, so a resumed conversation that still said `job_1` about a dead job could be answered by a different, newer `job_1`. The new ids are never reused within a registry.

Ids are opaque: a host must not parse them or rely on their shape (nothing in the types ever promised `job_<n>`). `createBackgroundJobId()` mints one for a host that supplies its own registry, and `isBackgroundJobId(id)` answers whether an id looks like one this SDK minted; neither is required. The `job` and `wait_for_job` tools do not check shape: they refuse only input that cannot be an id (empty, over 128 characters, or containing whitespace or control characters) and pass every other id to the registry, whose existing "No background job <id>." covers an unknown one. Hosts with their own registry and ids keep working unchanged.
