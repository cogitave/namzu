# Resident context comparison — 2026-09-11

Both the `interactive` and `resident` profiles completed the same two-admission
shipping review. Each first admission read pending notes and returned
`wait` with `wakeAfterMs: null`. After that process and claim drained, the
fixture host changed the shipping date from `2026-10-01` to `2026-10-08`, marked
the review approved, and supplied a wake message that did not reveal the new date.
Both second admissions received the exact saved summary, reread current notes,
and completed with the new date and the release packaging checklist as next action.

The [recorded evidence](results/2026-09-11-context-profile-live.json) contains
provider usage, decisions, checked outcomes, build fingerprints, segment hashes,
and paths to synthetic receipts, transcripts and first request envelopes.

Both profiles used the built CLI, Zen's `muse-spark-1.3-contributor-free`, low
effort, `--permission-mode plan`, and `--tool-loading deferred`. Each invocation
allowed one admission, four iterations and 40,000 tokens. Profiles had separate
synthetic project and state directories. The resident profile's second admission
used `resident start`, confirming propagation through the managed worker;
the other three used foreground `run`.

| Provider-reported total across two admissions | Interactive | Resident |
| --- | ---: | ---: |
| Input tokens | 25,034 | 20,189 |
| Completion tokens | 394 | 442 |
| Total tokens | 25,428 | 20,631 |
| Cached input tokens | 12,371 | 9,826 |
| Model responses | 4 | 4 |
| Successful file reads | 2 | 2 |

Input fell **19.35%** and total tokens fell **18.87%**; completion tokens rose
**12.18%**. There was no reduction in model responses or file reads. First-request
input counts were 6,157 / 6,218 for interactive and 4,932 / 4,994 for resident.
Each first request exposed the same nine tools and schema digest.

The resident static system segment stayed at 5,303 characters with the same
SHA-256 across admissions; its dynamic segment grew from 3,484 to 3,800 characters
as the saved summary and wake evidence changed. The interactive static segment
grew from 12,107 to 12,407 characters and changed hash because it contained those
invocation facts. The resident objective and saved state stayed outside its
static prefix. This demonstrates stable placement, not a measured cache hit
between invocations: both resident first requests reported zero cached tokens.
Character counts are not token estimates.

All four steps read only `notes.md`, retained project instructions and curated
memory, settled clean claims, and stopped their runners with confirmed cleanup.
Only the fixture host changed the synthetic notes. These live runs show permitted
read-only behavior; they did not attempt a prohibited mutation. The
[actual-session integration tests](../../packages/cli/src/tui/__tests__/resident-context-reaches-session.test.ts)
separately exercise the real CLI session and SDK query through a fake provider
transport: fresh admissions and changed evidence, stable prefixes, unchanged
interactive guidance, and a discovered memory write refused by plan permissions
while a subsequent file read succeeds. The
[SDK tests](../../packages/sdk/src/prompt/__tests__/resident-step.test.ts)
cover captured snapshots, cache refresh, multiple iterations and compaction retention.

The [SDK factory](../../packages/sdk/src/prompt/resident-step.ts) owns reusable
resident guidance and state contributions. The CLI supplies its output contract,
environment and profile selection through existing session and permission paths.
The shipping review is only a test fixture; it introduces no task-specific
application module.

To repeat, build the workspace first, then use the
[reproducer](context-profile.py):

```bash
python3 -B research/resident/context-profile.py prepare
python3 -B research/resident/context-profile.py run /tmp/namzu-resident-context-<printed-suffix>
python3 -B research/resident/context-profile.py collect /tmp/namzu-resident-context-<printed-suffix>
```

Preparation and collection make no model calls. Explicit execution refuses a
second run in the same prepared directory and does not retry semantic failures.
This observation used exactly four admissions and eight model responses, with
no retries. It is one small synthetic scenario, in fixed profile order, with one
background launch. Both modes succeeded; the results establish neither improved
task quality nor general savings, latency improvement or long-horizon reliability.
All usage was marked unpriced, so monetary cost is unknown despite recorded zero
cost values.
