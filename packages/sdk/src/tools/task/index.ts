import type { RunId } from '../../types/ids/index.js'
import type { TaskStore } from '../../types/task/index.js'
import type { ToolDefinition } from '../../types/tool/index.js'
import { buildTaskCreateTool } from './create.js'
import { buildTaskListTool } from './list.js'
import { buildTaskUpdateTool } from './update.js'

export function buildTaskTools(taskStore: TaskStore, runId: RunId): ToolDefinition[] {
	return [
		buildTaskCreateTool(taskStore, runId),
		buildTaskUpdateTool(taskStore),
		buildTaskListTool(taskStore, runId),
	]
}

export { buildTaskCreateTool } from './create.js'
export { buildTaskUpdateTool } from './update.js'
export { buildTaskListTool } from './list.js'
