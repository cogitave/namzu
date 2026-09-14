---
"@namzu/sdk": major
"@namzu/cli": major
---

Resident learning hosts and direct skill promotions now require a `protection` plan with disjoint `verification` and `confirmation` task IDs chosen before candidate generation. Existing hosts without this field are refused before inference. Include at least one real preservation task per round, with two measured successful baseline trials and two successful candidate trials. Missing or uncertain controls block activation; losing one established success rejects the candidate even when aggregate scores improve.

Update `ResidentLearningCycleOptions`, discovery hosts, and `ResidentSkillEvaluation` callers to supply this plan and its actual paired evidence. Historical stored skills remain readable but do not gain protection evidence retroactively. Generic `reviewHarnessCandidate` callers can opt into the same checks with its third argument. CLI learning summaries display protected-task outcomes.
