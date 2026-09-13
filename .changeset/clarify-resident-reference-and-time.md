---
"@namzu/sdk": patch
---

Correct resident step guidance that allowed an unnamed follow-up to select one
of several plausible subjects, or treat the latest historical observation as
current. Residents are instructed to distinguish subject corrections from
changes over time, qualify alternatives, obtain fresh permitted evidence for
current-state questions, and report unavailable evidence without claiming that
the unfinished current-state task is complete.

This applies to hosts using `createResidentStepContributions`, including the
CLI's default resident context profile. It adds no inference call, retrieval
permission or stored state. Model interpretation remains fallible; the host's
answer validation contract is unchanged.
