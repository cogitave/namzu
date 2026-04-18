// Sub-barrel for the session-hierarchy entity model.
// Convention #4: concrete types live in sibling files; re-export them here.

export type { ActorRef, SystemRoleId } from './actor.js'
export type { Lineage } from './lineage.js'
export type { Tenant } from './tenant.js'
export type { Project, ProjectConfig } from './project.js'
export type { Thread, ThreadStatus } from './thread.js'
export type { Session, SessionStatus } from './session.js'
export { deriveStatus } from './session.js'
export type {
	SubSession,
	SubSessionStatus,
	SubSessionKind,
	FailureMode,
	CompletionMode,
	DeliverableRef,
} from './sub-session.js'
