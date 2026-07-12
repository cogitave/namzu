import type { TaskId } from '../ids/index.js'
import type { BaseAgentResult } from './base.js'
import type { AgentTaskProgress } from './task.js'

export type AgentLifecycleEvent =
	| {
			type: 'pending'
			taskId: TaskId
			agentId: string
			parentAgentId: string
			depth: number
	  }
	| { type: 'running'; taskId: TaskId }
	| { type: 'progress_updated'; taskId: TaskId; progress: AgentTaskProgress }
	/**
	 * The child parked itself awaiting an external decision. NOT terminal: the
	 * task keeps its slot, keeps its sub-session, and is never evicted. It
	 * carries the suspended {@link BaseAgentResult} (`status: 'awaiting_input'`)
	 * so a listener can see what it was doing when it stopped.
	 */
	| { type: 'input_required'; taskId: TaskId; result: BaseAgentResult }
	| { type: 'completed'; taskId: TaskId; result: BaseAgentResult }
	| { type: 'failed'; taskId: TaskId; error: string }
	| { type: 'canceled'; taskId: TaskId }

export type AgentLifecycleListener = (event: AgentLifecycleEvent) => void | Promise<void>
