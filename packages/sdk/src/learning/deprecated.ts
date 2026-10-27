/**
 * The learning module used to live under `manager/resident` and carried a
 * `Resident` prefix. Learning is a feature of all of Namzu, not of residents,
 * so every name now lives in `learning/` without the prefix. The old names stay
 * as aliases of the new ones until the next major release.
 */
import { runLearningCycle } from './cycle.js'
import type * as Cycle from './cycle.js'
import type * as Observation from './observation.js'
import { hashLearningSkill, projectLearning } from './skill.js'
import type * as Skill from './skill.js'
import {
	SqliteLearningStore,
	runStoredLearningCycle,
	runStoredLearningFromObservations,
} from './store.js'
import type * as Store from './store.js'

/** @deprecated Renamed to `LearningEvidence`; the old name is removed in the next major release. */
export type ResidentLearningEvidence = Skill.LearningEvidence

/** @deprecated Renamed to `LearningSkillCandidate`; the old name is removed in the next major release. */
export type ResidentSkillCandidate = Skill.LearningSkillCandidate

/** @deprecated Renamed to `LearnedSkill`; the old name is removed in the next major release. */
export type ResidentLearnedSkill = Skill.LearnedSkill

/** @deprecated Renamed to `LearningState`; the old name is removed in the next major release. */
export type ResidentLearningState = Skill.LearningState

/** @deprecated Renamed to `LearningProfileUpdate`; the old name is removed in the next major release. */
export type ResidentProfileUpdate = Skill.LearningProfileUpdate

/** @deprecated Renamed to `LearningSkillEvaluation`; the old name is removed in the next major release. */
export type ResidentSkillEvaluation = Skill.LearningSkillEvaluation

/** @deprecated Renamed to `LearningProjectionOptions`; the old name is removed in the next major release. */
export type ResidentLearningProjectionOptions = Skill.LearningProjectionOptions

/** @deprecated Renamed to `LearningSource`; the old name is removed in the next major release. */
export type ResidentLearningSource = Skill.LearningSource

/** @deprecated Renamed to `LearningProjection`; the old name is removed in the next major release. */
export type ResidentLearningProjection = Skill.LearningProjection

/** @deprecated Renamed to `LearningStage`; the old name is removed in the next major release. */
export type ResidentLearningStage = Cycle.LearningStage

/** @deprecated Renamed to `LearningReceipt`; the old name is removed in the next major release. */
export type ResidentLearningReceipt = Cycle.LearningReceipt

/** @deprecated Renamed to `LearningConsumption`; the old name is removed in the next major release. */
export type ResidentLearningConsumption = Cycle.LearningConsumption

/** @deprecated Renamed to `LearningCycleEvent`; the old name is removed in the next major release. */
export type ResidentLearningCycleEvent = Cycle.LearningCycleEvent

/** @deprecated Renamed to `LearningCycleContext`; the old name is removed in the next major release. */
export type ResidentLearningCycleContext = Cycle.LearningCycleContext

/** @deprecated Renamed to `LearningGenerationContext`; the old name is removed in the next major release. */
export type ResidentLearningGenerationContext = Cycle.LearningGenerationContext

/** @deprecated Renamed to `LearningExplorationContext`; the old name is removed in the next major release. */
export type ResidentLearningExplorationContext = Cycle.LearningExplorationContext

/** @deprecated Renamed to `LearningExploration`; the old name is removed in the next major release. */
export type ResidentLearningExploration = Cycle.LearningExploration

/** @deprecated Renamed to `LearningEvaluationContext`; the old name is removed in the next major release. */
export type ResidentLearningEvaluationContext = Cycle.LearningEvaluationContext

/** @deprecated Renamed to `LearningCycleOptions`; the old name is removed in the next major release. */
export type ResidentLearningCycleOptions = Cycle.LearningCycleOptions

/** @deprecated Renamed to `LearningCycleResult`; the old name is removed in the next major release. */
export type ResidentLearningCycleResult = Cycle.LearningCycleResult

/** @deprecated Renamed to `SqliteLearningStoreOptions`; the old name is removed in the next major release. */
export type SqliteResidentLearningStoreOptions = Store.SqliteLearningStoreOptions

/** @deprecated Renamed to `LearningArtifact`; the old name is removed in the next major release. */
export type ResidentLearningArtifact = Store.LearningArtifact

/** @deprecated Renamed to `LearningRecordedUsage`; the old name is removed in the next major release. */
export type ResidentLearningRecordedUsage = Store.LearningRecordedUsage

/** @deprecated Renamed to `LearningCycleSummary`; the old name is removed in the next major release. */
export type ResidentLearningCycleSummary = Store.LearningCycleSummary

/** @deprecated Renamed to `LearningDiscoveryOptions`; the old name is removed in the next major release. */
export type ResidentLearningDiscoveryOptions = Store.LearningDiscoveryOptions

/** @deprecated Renamed to `LearningDiscoveryResult`; the old name is removed in the next major release. */
export type ResidentLearningDiscoveryResult = Store.LearningDiscoveryResult

/** @deprecated Renamed to `LearningObservation`; the old name is removed in the next major release. */
export type ResidentLearningObservation = Observation.LearningObservation

/** @deprecated Renamed to `LearningObservationRecord`; the old name is removed in the next major release. */
export type ResidentLearningObservationRecord = Observation.LearningObservationRecord

/** @deprecated Renamed to `LearningTarget`; the old name is removed in the next major release. */
export type ResidentLearningTarget = Observation.LearningTarget

/** @deprecated Renamed to `hashLearningSkill`; the old name is removed in the next major release. */
export const hashResidentSkill = hashLearningSkill

/** @deprecated Renamed to `projectLearning`; the old name is removed in the next major release. */
export const projectResidentLearning = projectLearning

/** @deprecated Renamed to `runLearningCycle`; the old name is removed in the next major release. */
export const runResidentLearningCycle = runLearningCycle

/** @deprecated Renamed to `runStoredLearningCycle`; the old name is removed in the next major release. */
export const runStoredResidentLearningCycle = runStoredLearningCycle

/** @deprecated Renamed to `runStoredLearningFromObservations`; the old name is removed in the next major release. */
export const runStoredResidentLearningFromObservations = runStoredLearningFromObservations

/** @deprecated Renamed to `SqliteLearningStore`; the old name is removed in the next major release. */
export const SqliteResidentLearningStore = SqliteLearningStore
/** @deprecated Renamed to `SqliteLearningStore`; the old name is removed in the next major release. */
export type SqliteResidentLearningStore = SqliteLearningStore
