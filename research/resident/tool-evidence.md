# Original tool evidence across resident invocations

2026-09-12. This milestone extends summary/wake recall with original retained
tool text. Namzu remains an agent kernel; this work adds retrieval and lifecycle
guarantees, not an independent reasoning model or a claim of human cognition.

## Source inspection and engineering decision

Inspected Pydantic AI Harness at
[`c897c4e8bcb7f0e5a8968aaccdb0f8edf42fe504`](https://github.com/pydantic/pydantic-ai-harness/blob/c897c4e8bcb7f0e5a8968aaccdb0f8edf42fe504/pydantic_ai_harness/conversation_search/_toolset.py#L360).
Its conversation search explicitly scopes runs, ranks untruncated message text
with BM25, then emits shorter display windows. `_load_sections` loads the
selected runs' messages before ranking. This describes that inspected method,
not a claim about every backend or the repository's latest remote revision.

Adopted the separation between searchable evidence and short display text, and
the requirement for explicit ownership. Namzu's resident boundary adds a
settled claim and captured agenda revision. This implementation uses literal
search with persistent trigram filters and byte-addressed records instead of
loading all historical messages for every query. Negative filters skip bodies;
positive candidates require source verification. It does not supply semantic
ranking, and common queries still have linear worst-case traversal.

The execution test found a separate existing runtime defect: tooling captured
`getRunDir()` before fresh query initialization, so a disk-backed run could
lose large text outside its preview. Resolving the directory at execution time
made actual retention work. Direct unit tests of the output-budget helper had
not covered this composition order. The new query regression exercises the
complete path and checks the persisted manifest field.

## Evidence and limits

The [public contract](../../docs/sdk/retained-tool-evidence.md) names byte,
record, output, scope and cancellation bounds. Source data remains authoritative;
index pages and cursors are authenticated, disposable derivatives. Selected
spill chunks are checked against manifests captured at retention time. A
different workspace file, partial old preview or changed artifact cannot be
substituted for an original receipt.

Deterministic tests exercise:

- Original text in the middle of a 10 MiB spill, spanning a 64 KiB boundary.
- Exact UTF-8 pagination, including emoji, CRLF, BOM characters and NUL.
- Equal outputs at separate sequence addresses, partial/error records, and
  missing, changed, malformed or symlinked sources.
- Cache reuse, corruption recovery and refusal of a valid page placed at the
  wrong index position; independent processes racing initial index creation.
- Pursuit/project/tenant/admission exclusion and unresolved claims, plus
  rejected access from unknown or departed CLI runs.
- A real side-effecting SDK tool called once, followed by both structured and
  sliding-window compaction, and recovery through the registered tools in a
  different Session. Compaction removed the exact original receipt from the
  provider's initial context; the second invocation recovered it without
  repeating the effect.
- Both CLI context profiles using real Session/query/tool/receipt plumbing.
  Their provider is scripted: the first invocation reads a file, the test
  changes that file, and a new invocation reads the retained original.

These tests do not claim hostile-filesystem confinement, semantic recall,
binary/opaque reasoning recovery or unlimited retention. The derived index
follows the original run's archive/removal lifecycle in the CLI. No new central
project directory or ordinary-chat cross-session access is introduced.

## Live CLI experiment

Reproducer, from the repository root after building packages:

```sh
node research/resident/tool-evidence-cli.mjs --live
```

The script owns a temporary application home and workspace. Its seed uses a
scripted provider through the actual CLI resident callback and actual `read`
tool. It records a large synthetic receipt, verifies that both random
identifiers are outside the preview and latest summary, then replaces the
workspace file. The separate CLI process uses **Codex / gpt-5.6-luna / low**,
with an explicit 40,000-token test budget and eight-iteration cap. The actual
model must recover the original text and finish without rereading the mutable
file or executing another action.

The [two recorded results](tool-evidence-results.json) include source fingerprints
and distinguishes seeded work from live provider usage. In both runs,
the model used `search_resident_tools` once and `read_resident_tool` once,
recovered both random identifiers, and completed the pursuit. A subsequent CLI
open admitted no extra step. The original workspace read occurred once across
both invocations; the changed file remained unchanged by the live step.

| Measurement | First run | Final confirmation |
| --- | ---: | ---: |
| Live provider tokens | 17,039 | 17,079 |
| History bytes read during search | 4,505 | 4,505 |
| Invocation/index bytes read during search | 286,529 | 286,529 |
| Transcript records indexed | 27 | 27 |
| Bytes read for the exact text page | 178,388 | 178,388 |
| Returned text code units | 6,000 | 6,000 |

Subscription usage is reported as unpriced tokens; the ledger's zero monetary
cost is not a measured free price. These are two repetitions of one synthetic retrieval task, not a
general intelligence score. Forced compaction is tested separately through the
real query runtime; it was not induced in these live invocations. This milestone
does not establish the completion of Namzu's broader autonomy vision.

## Local verification

The workspace build and type check, workspace lint, all workspace unit tests,
253 SDK process regressions, documentation conformance and fence compilation,
project-reference, test-presence and public-signature export checks passed.
The full unit run recorded 6,261 SDK tests and 2,821 CLI tests (five CLI skips);
the additional index-position regression passed in the final focused run.
The last live confirmation uses the final index-position and file-validation
checks. Existing lint warnings were not promoted to new errors or suppressed.

This is local verification, not a registry release or a claim that every
publish/coverage gate ran. No push or publication is part of this milestone.
