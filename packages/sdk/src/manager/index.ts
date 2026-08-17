export { RunPersistence } from './run/persistence.js'
export { EmergencySaveManager } from './run/emergency.js'

export { ConnectorManager } from './connector/lifecycle.js'
export type { ConnectorManagerConfig } from './connector/lifecycle.js'

export { TenantConnectorManager } from './connector/tenant.js'
export type { TenantConnectorManagerConfig } from './connector/tenant.js'

export { EnvironmentConnectorManager } from './connector/environment.js'
export type {
	EnvironmentConnectorSetup,
	EnvironmentConnectorManagerConfig,
} from './connector/environment.js'

export { PlanManager } from './plan/lifecycle.js'
export type { PlanEvent, PlanEventListener, PlanApprovalHandler } from './plan/lifecycle.js'

export {
	TopicManager,
	/** @deprecated Use {@link TopicManager}. Literal identity re-export -- instanceof/=== still hold. Removal is NZ-TOPIC-05. */
} from './topic/lifecycle.js'
export type { TopicManagerDeps } from './topic/lifecycle.js'

export { AgentManager } from './agent/lifecycle.js'

export { ProjectManager, requireOpenProject } from './project/lifecycle.js'
export type { ProjectManagerDeps } from './project/lifecycle.js'

// One round of an objective, from debit to verdict. The store holds the
// rules; these hold the sequence, so a host writes the work and not the
// bookkeeping.
export {
	ObjectiveNotProgressingError,
	advanceObjective,
	driveObjective,
} from './topic/objective.js'
export type { AdvanceObjectiveParams, DriveObjectiveParams } from './topic/objective.js'
