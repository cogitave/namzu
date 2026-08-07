import type { TaskId } from '../ids/index.js'
import type { BaseAgentResult } from './base.js'

export type AgentLifecycleEvent =
	| {
			type: 'pending'
			taskId: TaskId
			agentId: string
			parentAgentId: string
			depth: number
	  }
	| { type: 'running'; taskId: TaskId }
	| { type: 'completed'; taskId: TaskId; result: BaseAgentResult }
	| { type: 'failed'; taskId: TaskId; error: string }
	| { type: 'canceled'; taskId: TaskId }

export type AgentLifecycleListener = (event: AgentLifecycleEvent) => void | Promise<void>
