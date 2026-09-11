# Resident tool-context experiment — 2026-09-11

Small resident steps were carrying the entire interactive CLI tool roster. This
experiment changes schema availability while keeping standing instructions,
project context, memory recall, tool handlers and permission enforcement intact.
It uses the existing query/discovery loop, not a second agent runtime.

## Primary implementation evidence

- Pydantic AI's [PreparedToolset](https://github.com/pydantic/pydantic-ai/blob/62f1e8302a356d09962c55117f41a282cf1eb243/pydantic_ai_slim/pydantic_ai/toolsets/prepared.py#L23)
  prepares an existing tool set and rejects newly invented or renamed tools.
  This supports keeping schema selection separate from tool implementation.
- Its [ToolSearch](https://github.com/pydantic/pydantic-ai/blob/62f1e8302a356d09962c55117f41a282cf1eb243/pydantic_ai_slim/pydantic_ai/capabilities/_tool_search.py#L35)
  supports deferred definitions and local discovery where native discovery is
  unavailable. Namzu already had local discovery; the missing primitive here
  was independent availability for each run.
- Pydantic AI Harness [SpendLimits](https://github.com/pydantic/pydantic-ai-harness/blob/c897c4e8bcb7f0e5a8968aaccdb0f8edf42fe504/pydantic_ai_harness/spend/_capability.py#L188)
  refuses deferred enforcement because unloaded hooks would miss requests.
  Namzu therefore defers tool schemas, never its permission, cancellation,
  budget or answer-review machinery.

These are inspected source snapshots, not a claim of equivalent behavior or a
performance comparison against Pydantic AI. No external implementation was copied.

## Implemented boundary

`ToolRegistry.fork()` isolates membership and availability. Definitions, handlers
and configuration remain shared; it is not a deep clone or a security boundary.
The CLI creates one fork per fresh send after plugin refresh and keeps that fork
through every query iteration and permission callback. Core file/shell/job/web
tools and any already-active discovery tool stay ready. Other active tools become
deferred; already-deferred or suspended tools are never revived by the retained
list. Runtime task tools join the same fork as deferred tools.

`resident run|start --tool-loading deferred` opts in. The default remains eager.
Checkpoint resume does not restore a fork's activation state; resident work
refuses checkpoint replay and retains interrupted claims for inspection.

## Live CLI comparison

Four isolated synthetic cases used the built CLI, Zen's
`muse-spark-1.3-contributor-free`, low effort, plan permissions, one admitted step,
four maximum iterations and a 40,000-token per-step ceiling. Each task had one
sample per mode. The no-tool deferred case used `resident start` to check that
the option reaches the detached worker; the other cases used foreground `run`.

| Task | Eager input tokens | Deferred input tokens | Model responses in each mode |
| --- | ---: | ---: | ---: |
| Exact short completion, no tools | 8,314 | 5,882 | 1 |
| Read README once and report its tag | 16,982 | 12,062 | 2 |

Reported input fell 29.25% and 28.97% respectively. Initial schemas went from
22 to 9. Both reads used `read` exactly once; both no-tool cases used zero tools.
All four claims settled complete, cleanup was confirmed, runners stopped at their
one-step limit and fixtures were unchanged. Six responses consumed 43,998 total
tokens. The provider ledger marked the tokens unpriced: zero reported monetary
cost is not evidence of a measured bill.

The no-tool system text **grew** from 12,637 to 13,845 characters because the
deferred catalogue and discovery guidance were added. The reduction came from
schemas, not removing standing instructions. Request receipts record tool names
and a digest, not full schemas; actual input-token counts come from provider
usage reports. This is a small smoke comparison, not evidence of higher task
quality, long-horizon performance, or universal savings. Neither task needed a
deferred tool, so neither measures the extra discovery round trip.

The [live evidence](results/2026-09-11-tool-loading-live.json) records individual
usage, objectives, build fingerprints and checked outcomes. To repeat explicitly:

```bash
python3 research/resident/tool-loading.py prepare
python3 research/resident/tool-loading.py run /tmp/namzu-resident-tools-<printed-suffix>
```

Preparation and `collect` make no model calls. `run` invokes the selected public
model and keeps artifacts in private synthetic directories. It does not modify
the working project or the user's ordinary Namzu state.

The reproduction script now explicitly selects `--context-profile interactive`
to retain the prompt used for this schema-loading comparison. The recorded
September 11 commands predate that option; their archived evidence is unchanged.
The resident-specific prompt profile is a separate comparison.

## Boundaries still to improve

A controlled fake-provider capture used the real CLI session and SDK query.
The no-tool request serialized to 34,242 characters with eager loading and
23,920 with deferred loading (30.1% smaller). Shared schemas were identical and
the static system block differed only by added discovery guidance. An optional
task required `task_create` then a final response in eager mode, versus discovery,
`task_create` and a final response in deferred mode. Across those requests,
serialized bodies grew from 69,316 to 75,811 characters (9.4%). These
[wire-shape measurements](results/2026-09-11-tool-loading-wire.json) count serialized
characters, not provider tokens, compressed bytes or elapsed time. Mock usage
values are deliberately excluded. Repeat without any model calls using
`node research/resident/tool-loading-wire.mjs` after building the packages.

The [session integration tests](../../packages/cli/src/tui/__tests__/tool-loading-reaches-session.test.ts)
exercise discovery through the real query, activation reset on the next send,
an existing discovery tool, retained project/memory/continuation instructions,
and memory writes permitted or refused by the actual CLI policy.

Discovery adds a request when an optional tool is needed. Mutable schema prefixes
can also affect provider caching; input reduction does not imply equal bill or
latency reduction. Each independent resident step starts from an unloaded roster.
The full CLI working/delegation/plan instructions still dominate the remaining
text. Prompt-profile work, bounded discovery catalogues, persisted availability
for checkpoint resume and provider-native tool search need separate evidence and
tests before changing defaults.
