---
'@namzu/sdk': minor
---

a directory-derived supervisor now has a token budget, a wall clock, and its skills

`BaseAgentConfig` declares `tokenBudget` and `timeoutMs` as **required**.
`deriveSupervisorOptions` supplied them only when `agent.ts` happened to name
them — the uncommon case — and an `as SupervisorAgentConfig` made that compile.
The returned object was therefore typed `tokenBudget: number` while holding
`undefined`.

That is not a type-level nicety. `buildLimitConfig` defaults only
`maxIterations`, so an undefined budget and timeout disable **both** hard stops:
a supervisor derived from a directory ran with no token cap and no wall clock.
And the child-spawn guard computes a delegate's allocation from the parent
budget, so `undefined` became `NaN` — and `NaN <= 0` is `false`, meaning the
refusal that exists to stop an unfunded child let it through with a `NaN`
budget.

Both now default to the same numbers `runAgent` uses, which are exported as
`DEFAULT_TOKEN_BUDGET`, `DEFAULT_TIMEOUT_MS` and `DEFAULT_MAX_ITERATIONS` so the
two front doors cannot drift. Anything `agent.ts` declares still wins, and
`overrides` still wins over that.

The cast is now `satisfies`, so the next missing required field is a compile
error rather than a run with its limits quietly switched off.

Same file, same cast: `skills` were loaded from the project's `skills/`
directory, put on the manifest, and then left out of the config the supervisor
actually ran with. `SupervisorAgentConfig` accepts them and the kernel drives
them; they are now supplied.
