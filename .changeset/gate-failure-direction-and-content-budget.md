---
'@namzu/sdk': minor
---

Two findings from a fit-gap against another agent SDK.

**A tool veto that throws now denies.** namzu has several places that can
stop a run, and they disagreed on what happens when the check *itself*
throws: a content guardrail that threw blocked the run — with a comment
saying why, "safety is unknown" — while a tool veto that threw was skipped
and the call proceeded. The same policy inverted its security posture
depending on which surface it was written on.

An observer probe that throws is still skipped, and that asymmetry IS
deliberate: an observer was never asked a question, so it has no answer to
withhold, and taking a run down because a metrics handler crashed would be
the same mistake pointing the other way.

The exposure this trades against is real and is the one the guardrail
already accepted: a buggy veto can refuse every call. The refusal names the
probe, so it is diagnosable; a wrongly permitted destructive call is not
recoverable at all. `docs/sdk/architecture/safety.md` now states the rule
for all four surfaces in one table.

The old behaviour was pinned by a test that described it and never argued
for it, under a header pointing at a design document that had since been
frozen and removed — so the instruction to "update it first" could not be
followed, and the fail-open kept its ratified status with no surviving
justification. The pointer now names a document a reader can open.

**A truncated tool result says what it took with it.** The output budget
takes `output: string` only, so the rich channel was never bounded — and
when the text half truncated, the rich half was dropped with it, silently.
Dropping is right, since the preview is no longer the tool's own payload
and an image alongside it would be illustrating something the model can no
longer read. Doing it silently is not: the model saw a preview with no way
to know an image had ever existed, and reasoned as though the tool returned
text only. The result now names what went, so the agent can ask for a
smaller region instead of retrying the same call.

`maxToolContentBytes` caps the rich channel, and is **off by default** on
purpose. The right number depends on what a host's tools return and on the
model's own image budget; inventing one here would either break screenshot
workflows or be so generous it bounds nothing. Over the cap the channel is
refused whole rather than trimmed — half a base64 payload is not a smaller
image, it is a corrupt one.
