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
	/**
	 * **Never emitted.** Nothing constructs this variant, so a host that
	 * switches on it has written a branch that cannot run — and a host that
	 * relies on progress arriving will wait for an event that never comes.
	 *
	 * @deprecated No producer. Removed in the next major.
	 */
	| { type: 'progress_updated'; taskId: TaskId; progress: AgentTaskProgress }
	| { type: 'completed'; taskId: TaskId; result: BaseAgentResult }
	| { type: 'failed'; taskId: TaskId; error: string }
	| { type: 'canceled'; taskId: TaskId }

export type AgentLifecycleListener = (event: AgentLifecycleEvent) => void | Promise<void>
