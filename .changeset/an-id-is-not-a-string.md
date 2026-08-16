---
'@namzu/sdk': major
---

The id types are nominal. `const runId: RunId = 'run_abc'` no longer compiles, and neither does passing a `SessionId` where a `RunId` was asked for.

Every id in `types/ids/index.ts` — 40 of them — is now `Id<Prefix, Tag>`: its wire shape intersected with a unique-symbol brand. The prefix stays in the type, so a hover still reads `` `run_${string}` `` and a log line is still legible; what changes is that a matching string is no longer *assignable* to the type. Before this, `const a: AgentId = 'agt_made-up'` compiled and was indistinguishable from an id a factory minted, which made the "branded ids" the design claimed a comment rather than a property.

**Migrating.** An id comes from one of three places, and each satisfies the type with no assertion at the call site:

- `generateRunId()` and friends — mint a new one.
- `asRunId(value)` and friends — check a string from a log line, a URL, a flag, or a model's tool input. Throws `InvalidIdError` naming the prefix it wanted.
- In this repo's own tests, `fixtureId.run('a')` from `test-support/ids.ts`, which skips the check because a fixture is not testing prefix validation.

A `value as RunId` assertion still compiles — that is TypeScript's assertion rule, not an oversight, and `types/ids/__tests__/an-id-is-not-a-string.test.ts` pins it as a stated gap rather than leaving a reader to assume a fake id is now impossible. The brand makes a rule against `as <IdType>` enforceable; it does not replace one.

**`ActorRef.agentId` is now `string`, and that is a correction.** It was annotated `AgentId` (`` `agt_${string}` ``) and every value that ever reached it was an agent's registry key — `'worker'`, `'supervisor'` — put there through a cast. Nothing in this kernel has ever minted an `agt_` id; there is no `generateAgentId`. `AgentId` and `asAgentId` are kept for one release and marked `@deprecated`, so a consumer that annotated its own variable still compiles and gets a warning; `asAgentId` would throw on every identifier the kernel actually produces.

**`LockAcquireResult.holder` is optional.** The `{ acquired: false }` branch is also reached when the lock was released between the attempt and the read, and it used to report `'' as RunId` for that — an empty string wearing an id type, which no caller could tell apart from a real holder. An absent `holder` says what is true: there is nobody to name. Read it as `result.holder` where you previously compared against `''`.

**A prefix can no longer drift from its type inside the id factory itself.** `generateId`, `parseId` and `makeIdParser` take the prefix as an inferred type parameter constrained by the id's own shape, so `generateRunId` returning `generateId('ses_')` is a compile error. That constraint was written wrong the first time — supplying one of two type parameters explicitly makes the other fall back to its default, so `makeIdParser<RunId>('ses_')` compiled and the check was vacuous. It is now supplied by annotation instead, and mutating any constructor's prefix fails the build.

`unsafeId` in `types/ids/brand.ts` is the only unchecked way to produce one, and it is not exported from the package barrel.
