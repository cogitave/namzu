# Public progress and settled answers

Recorded 2026-09-13 against base `e7bc7a13` plus this change.
[Native process fixture](text-phases-cli.mjs) ·
[Live ambiguity probe](reference-context-cli.mjs) ·
[Observations](text-phases-results.json).

## Evidence and interpretation

The preceding [ambiguity experiment](reference-context-results.md) asked the
right clarification twice in its settled answer. Inspection of its stored
native response showed two distinct public message items: one `commentary`,
one `final_answer`, with equal text. This was not evidence of a TUI redraw.

OpenAI's [phase guidance](https://developers.openai.com/api/docs/guides/latest-model?model=gpt-5.5)
distinguishes intermediate commentary from final answers and requires preserving
original assistant phases during manual replay. The
[Responses API schema](https://developers.openai.com/api/reference/typescript/resources/beta/subresources/responses/methods/create)
describes the native field. These primary sources support the wire interpretation;
they do not establish Namzu's correctness or a model-quality improvement.

The driver now preserves that distinction in SDK public text items. Shared
aggregation selects explicit final text while retaining all public items.
Auxiliary planning/review inference uses the same selection; commentary does
not get concatenated in front of a JSON result. Native replay keeps the original
response items, guarded by route, content, text parts and tool calls.

## Checks performed

| Check | Observed result | Scope |
| --- | --- | --- |
| Native process fixture | One real file read; equal commentary/final messages produce one settled `Which record?` | Real CLI and Codex driver, scripted native responses, zero live tokens |
| New process resume | Original commentary/final phases and tool result appear in the next native request; result `RESUMED`, zero tool calls | Same fixture conversation reopened by another CLI process |
| Interactive TUI | Separate progress and answer bubbles; one read activity; composer returns idle; clean `/exit` | Real 80-column PTY, same native fixture |
| Live ambiguity follow-up | `Hangi kaydı kastediyorsunuz: **DELTA** mı, **OMEGA** mı?` once; no tool calls or file changes | One Luna low sample after scripted seed and process restart |

Run the reproducible process checks from the repository:

```sh
node research/conversation-evidence/text-phases-cli.mjs
node research/conversation-evidence/reference-context-cli.mjs --case=ambiguous --live
```

The first command prints its isolated home, workspace, CLI and preload paths.
For manual TUI inspection, set `NAMZU_HOME` to that fixture home, run Node with
the printed `--import` preload and CLI path from its workspace, then send
`Read note.txt and ask which record I mean.`. Submit text and Enter as separate
terminal inputs. The PTY driver initially delivered text and carriage return
in one chunk, which the composer treated as pasted content; removing that
character and sending Enter separately submitted the intended prompt.

The live run used two native requests: planning **760 tokens**, answering
**8,317**, total **9,077**, with no cache hits. All recorded build fingerprints
remained stable. It used four-iteration/25,000-token admission and a 120-second
process deadline; these are admission controls, not a guaranteed billing cap.
Its native responses contained final items only. It confirms live mapping and
clarification wiring, while the deterministic fixture is what exercises the
equal commentary/final case. This single sample is not a benchmark score.

Focused SDK tests also cover unphased byte preservation, explicit repeated
final items, late settlement metadata, cancellation, auxiliary JSON selection
with full usage accounting, and refusal to fail over after a text snapshot.
The driver test checks native replay after JSON persistence and rejection when
public parts have been edited.

Workspace typecheck, build, lint and package tests passed. The final suite
included 6,635 SDK tests, 2,934 CLI tests (five skipped) and 123 OpenAI driver
tests. Lint retained existing warnings. Documentation conformance and compiled
fences, exported signature types, SDK test presence and publish metadata also
passed. No release or registry publication was performed; these checks do not
claim the remaining release-only gates ran.

## Remaining boundaries

This change does not hide equal public progress and final messages from the
transcript. It separates their identity and prevents progress being treated as
part of the settled answer. Drivers with no phase mapping retain their existing
unphased behavior. Late metadata corrects SDK settlement but does not split an
already displayed untagged TUI bubble retroactively. Evidence search still
indexes selected completion text, not each excluded commentary item.

The broader follow-up task remains: the earlier missing-SIGMA case withheld an
unverified value, but recalled unrelated literal matches first. Phase handling
does not repair subject-specific retrieval precision or prove long-horizon
continuity across arbitrary conversations.
