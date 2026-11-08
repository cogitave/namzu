---
'@namzu/sdk': major
---

Remove the resident feature, which was deprecated, and the `Resident`-prefixed learning aliases.

Removed exports. Nothing replaces the first group; use `namzu schedule` for recurring work, `/goal` for work across turns and background agents for parallel work:

- the resident manager: `DiskResidentStore`, `ResidentConflictError`, `runResident`, `stepResident`, `DiskResidentAgenda`, `ResidentHost`, `inspectResidentConsumption`, `createResidentSelector`, `validateResidentProposal`, `deliverResidentMessage`, `createResidentDeliveryWindow`, and every `Resident<X>` type that described them (`ResidentState`, `ResidentStore`, `ResidentAgendaState`, `ResidentAgendaStore`, `ResidentPursuit`, `ResidentHostOptions`, `ResidentHostResult`, `ResidentHostRunOptions`, `ResidentStep`, `ResidentStepResult`, `ResidentLoopOptions`, `ResidentProposal`, `ResidentOutbox*`, `ResidentDelivery*`, `ResidentMessage*`, `ResidentConsumption*`, `ResidentActivity*`, `ResidentArchive*`, `ResidentHistory*`, `ResidentSelect*`, and the rest of that family);
- the resident step prompt and tools: `createResidentStepContributions`, `createResidentStepContext`, `ResidentStepPromptOptions`, `ResidentStepContextOptions`, `ResidentStepContextBundle`, `buildResidentHistoryTools`, `buildResidentToolEvidenceTools`, `createResidentToolEvidenceSource`, `createResidentEvidenceRecallStep` and the `ResidentToolEvidence*` and `ResidentEvidenceRecallOptions` types;
- `SessionPaths.residentDir`.

Removed aliases. The `Resident`-prefixed learning names were deprecated aliases; use the names without the prefix: `SqliteLearningStore` (was `SqliteResidentLearningStore`), `runLearningCycle`, `runStoredLearningCycle`, `runStoredLearningFromObservations`, `hashLearningSkill`, `projectLearning`, and the matching `Learning<X>` types (`ResidentLearningEvidence` is `LearningEvidence`, `ResidentSkillCandidate` is `LearningSkillCandidate`, `ResidentLearnedSkill` is `LearnedSkill`, `ResidentProfileUpdate` is `LearningProfileUpdate`, `ResidentSkillEvaluation` is `LearningSkillEvaluation`, and so on).

Changed. `LearningCycleOptions.agenda` is now `guidance` and takes the new `DiskLearningGuidance` instead of a resident agenda; `LearningCycleResult.agendaRevision` is now `guidanceRevision`. `DiskLearningGuidance`, `LearningGuidanceConflictError` and `earlierGuidanceDirectory` are new exports.

Learning data carries over. Guidance and journals an earlier version kept under `residents/<name>/` are read the first time they are used (`earlierGuidanceDirectory` points at them): the files are copied, nothing is deleted from the old location, and a journal that names the revision `agendaRevision` is still read.

Unchanged on purpose. The wire values `'resident'` (session `Origin.protocol`, peer session kind) and `'resident-step'` (turn origin kind) still parse, so a log or peer record an earlier version wrote can be read; nothing writes them any more.
