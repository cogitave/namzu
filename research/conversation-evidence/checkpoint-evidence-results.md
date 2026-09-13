# Conversation evidence after durable CLI recovery

Measured 2026-09-13. This is CLI `drain` recovery of a real `AgentSession`, not
TUI rendering, an autonomy benchmark or an exactly-once guarantee.

The [milestone audit](milestone-audit.md) reruns all three deterministic
variants on `7579aa0c`. The fixture now distinguishes tool-free query preparation
from main inference; its original all-requests-have-tools assertion became
invalid when automatic planning was enabled. Production retrieval is unchanged.

## Missing composition

`createAgentSession` mounted conversation tools only when its host supplied
conversation state. Ordinary sessions did so; `drain` supplied execution scope
but omitted conversation state and compaction/memory/web settings. Its provider
catalogue contained neither `search_conversation` nor `read_conversation`.
The baseline probe's catalogue assertion verified that omission before any
resumed model request. The resulting failed run also exposed a reporting bug:
the command returned exit code 0 because the loop had been resumed at all.

The fix binds a smaller `ConversationContext` to the already persisted Session,
Project and tenant. Retrieval needs their store and hierarchy, not fabricated
goal or UI sidecars, and it must not open a new Project from the current folder.
The invoking run still owns each call; the existing SDK capture, scope checks,
bounded search and exact-read mechanisms remain authoritative. A supplied
checkpoint directory does not become an arbitrary history directory.

The inspected primary source,
[Pydantic AI Harness conversation search at c897c4e8](https://github.com/pydantic/pydantic-ai-harness/blob/c897c4e8bcb7f0e5a8968aaccdb0f8edf42fe504/pydantic_ai_harness/conversation_search/_toolset.py),
also binds search to conversation identity and warns that broader store scope
requires principal isolation. Namzu reuses its existing conversation boundary
and authenticated retrieval; this change does not introduce BM25, embeddings
or a performance-superiority claim.

## Process experiment

Build first, then run `node research/conversation-evidence/checkpoint-evidence-cli.mjs`.
Variants are `--altered`, `--fail-provider`, and `--live`. Each creates an isolated
home and workspace. A scripted model calls the real read and shell tools: the
shell increments a counter and prints a large synthetic receipt document.
The parent kills the seed after that completion is durably recorded, while the
following read is held before completion. The entire batch is checkpointed.
The current receipt document is then replaced, so rereading it cannot supply
the historical code. The original receipt is absent from the visible preview.

Another process invokes the production CLI `drain` command. Scripted controls
replace only the provider; the live variant uses Codex `gpt-5.6-luna`, with a
request adapter explicitly selecting `low`. Each run has a 45,000-token limit,
6 iterations and a 150-second process timeout. Relevant production module
fingerprints are recorded. The earlier baseline/control used 35,000 tokens;
no comparison of performance is inferred from that difference.

| Case | Observed result | Original command executions |
|---|---|---:|
| Missing composition baseline | Neither retrieval tool offered; failed run incorrectly returned exit 0 | 1 |
| Scripted control | Search and exact read recovered the retained receipt; original hash unchanged | 1 |
| Altered retained bytes | Search reported unavailable evidence; no invented receipt or repeat action | 1 |
| Provider failure control | Failed resumed run returned exit 1 | 1 |
| First live run | Correct receipt through direct backing-file access, outside the authenticated retrieval route | 1 |
| Live run after routing guidance | Authenticated search excerpt contained the complete original receipt | 1 |

The first live model followed the generic spill-path hint, tried a workspace
`grep` that refused the path, then used a shell read. That answered the question
but did not validate the intended retrieval route. The CLI now explicitly
identifies those paths as backing files and directs recovery through its
conversation tools. Existing sandbox/permission enforcement is unchanged;
prompt guidance is not a replacement for access control.

The second live run used `search_conversation` and separately checked the
counter. Its authenticated `bash` match included the complete short receipt,
so another exact-read call was unnecessary. Its usage was **15,878 tokens**;
**29,122** remained, with no outstanding reservations or unresolved requests.
The counter remained **1**. This observation does not establish reliable query
selection for every model or task.

The initial live verifier required an exact-read call even when the search
excerpt fully answered the task, and therefore reported an assertion failure.
The recorded result was subsequently checked offline with
`node research/conversation-evidence/verify-checkpoint-evidence.mjs <artifact-directory>`:
correct original code, authenticated source identity, unchanged retained hash,
one original action, completed state, matching ownership and unchanged module
fingerprints. No additional model request or original command was executed.
The scripted control independently verifies `read_conversation`. The
[machine-readable record](checkpoint-evidence-results.json) preserves both the
original assertions and the corrected offline verification.

## Validation and remaining bounds

Workspace tests pass: 6,488 SDK tests and 2,908 CLI tests with 5 declared CLI
skips. New command tests cover mismatched Session/Project/tenant, correct history
binding, option propagation, and failed/cancelled outcomes. Existing real Session
tests cover retained reads after reopening, altered artifacts and foreign
ownership; they use the same retrieval functions now mounted by `drain`.

The SDK execution algorithm was unchanged in this increment. Its 264 process
tests passed in the preceding commit; this increment exercises the new CLI
composition with separate real processes. Workspace typecheck, lint, build,
documentation and applicable integrity gates are checked locally. Release-only
gates and publication remain outside this milestone. The broader kernel goal
remains active.
