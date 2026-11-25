import { isClaimableTaskStore } from '../../store/task/file.js'
import type { SessionId, TurnId } from '../../types/ids/index.js'
import type { TaskStore } from '../../types/task/index.js'
import type { ToolDefinition } from '../../types/tool/index.js'
import { buildTaskCreateTool } from './create.js'
import { buildTaskGetTool } from './get.js'
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
	/**
	 * The member the tools act for when the list is shared by a team: the name that moving a task to
	 * in_progress claims it under. Ignored for a store only this session uses.
	 */
	readonly member?: string
}

export function buildTaskTools(taskStore: TaskStore, scope: TaskToolScope): ToolDefinition[] {
	const resolved = { ...scope, turnStartedAt: scope.turnStartedAt ?? Date.now() }
	const tools = [
		buildTaskCreateTool(taskStore, resolved),
		buildTaskUpdateTool(taskStore, resolved),
		buildTaskListTool(taskStore, resolved),
	]
	// A list that several sessions share also lets a task be read in full.
	if (isClaimableTaskStore(taskStore)) tools.push(buildTaskGetTool(taskStore))
	return tools
}

export { buildTaskCreateTool } from './create.js'
export { buildTaskGetTool } from './get.js'
export { buildTaskUpdateTool } from './update.js'
export { buildTaskListTool } from './list.js'
export { plainTaskReceipt } from './number.js'
