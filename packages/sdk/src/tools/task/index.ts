import type { SessionId, TurnId } from '../../types/ids/index.js'
import type { TaskStore } from '../../types/task/index.js'
import type { ToolDefinition } from '../../types/tool/index.js'
import { buildTaskCreateTool } from './create.js'
import { buildTaskListTool } from './list.js'
import { buildTaskUpdateTool } from './update.js'

/**
 * The turn the task tools act for. Tasks are kept per session; each records
 * the turn that created it, and the listing shows the open tasks of every
 * turn plus those closed in this one (spec §4.5).
 */
export interface TaskToolScope {
	readonly sessionId: SessionId
	readonly turnId: TurnId
	/**
	 * When the turn started (epoch milliseconds); a resumed turn passes the
	 * time it first started. Absent: the time the tools were built.
	 */
	readonly turnStartedAt?: number
}

export function buildTaskTools(taskStore: TaskStore, scope: TaskToolScope): ToolDefinition[] {
	const resolved = { ...scope, turnStartedAt: scope.turnStartedAt ?? Date.now() }
	return [
		buildTaskCreateTool(taskStore, resolved),
		buildTaskUpdateTool(taskStore),
		buildTaskListTool(taskStore, resolved),
	]
}

export { buildTaskCreateTool } from './create.js'
export { buildTaskUpdateTool } from './update.js'
export { buildTaskListTool } from './list.js'
