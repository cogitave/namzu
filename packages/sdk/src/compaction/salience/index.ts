export { buildGoal, type GoalSources } from './goal.js'
export {
	DEFAULT_SALIENCE_CONFIG,
	DEFAULT_SALIENCE_WEIGHTS,
	type ProtectedReason,
	type SalienceConfig,
	type SalienceWeights,
	type ScoreOptions,
	type ScoredMessage,
	messageText,
	scoreMessages,
} from './score.js'
export {
	type WorkingSetAction,
	type WorkingSetOptions,
	type WorkingSetPlan,
	isStubbedNarration,
	planWorkingSet,
} from './working-set.js'
