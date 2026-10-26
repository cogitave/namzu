---
"@namzu/sdk": minor
---

Learning moves out of the resident module into its own, because it is not specific to residents. Nothing breaks: every exported name that began with `Resident` (`runResidentLearningCycle`, `SqliteResidentLearningStore`, `runStoredResidentLearningCycle`, `runStoredResidentLearningFromObservations`, `hashResidentSkill`, `projectResidentLearning`, `ResidentSkillCandidate`, `ResidentLearningState`, and the rest) still works and is the same value or type as its new name (`runLearningCycle`, `SqliteLearningStore`, `runStoredLearningCycle`, `runStoredLearningFromObservations`, `hashLearningSkill`, `projectLearning`, `LearningSkillCandidate`, `LearningState`, ...). The old names are marked `@deprecated` and will be removed in the next major release; switch to the new names when convenient. Also new: `SqliteLearningStore.pruneObservations(shouldDrop)`, which removes unclaimed observations a host no longer wants to keep.
