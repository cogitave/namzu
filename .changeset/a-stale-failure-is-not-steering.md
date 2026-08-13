---
'@namzu/sdk': patch
---

Compaction's failure list now drops its oldest entry, not its middle one

Every list in working state protects its earliest entries when it has to evict, and the reason is written down: early decisions are load-bearing, and the one that set a run's approach should outlive twenty-five incidental notes.

For failures that reasoning is backwards. The earliest failure is the one the model has most likely already worked around; the recent one is what it reads to decide what to do differently. So the slot was permanently protecting the least useful entries and evicting the most useful.

It is not neutral ballast either. Sinha et al., "The Illusion of Diminishing Returns" (arXiv:2509.09677), inject errors into a model's own history at controlled rates and measure accuracy far later in the run: conditioning a model on its own error-prone history raises the likelihood of further errors, and scaling does not rescue it. A permanently-protected stale failure is exactly that input.

Nothing decided failures should keep their oldest entries — the behaviour was inherited from a helper written for a slot where it is correct. Only the failure slot changes; decisions, discoveries and environment keep their existing policy, and there are tests pinning that.

This does not change the rule that error results survive compaction. That rule is about keeping the error that steers, and keeping the recent one honours it better than keeping the first.
