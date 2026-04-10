import type { AgentRun, RunEvent, RunEventListener } from '../types/run/index.js'
import { formatCost } from '../utils/cost.js'
import { type Logger, getRootLogger } from '../utils/logger.js'

function formatDuration(ms: number): string {
	if (ms < 1000) return `${ms}ms`
	const seconds = Math.floor(ms / 1000)
	if (seconds < 60) return `${(ms / 1000).toFixed(1)}s`
	const minutes = Math.floor(seconds / 60)
	const remainingSeconds = seconds % 60
	return `${minutes}m ${remainingSeconds}s`
}

export interface RunReporter {
	listener: RunEventListener
	summary(run: AgentRun): void
}

export type SessionReporter = RunReporter

export function createRunReporter(parentLogger?: Logger): RunReporter {
	const log = (parentLogger ?? getRootLogger()).child({
		component: 'RunReporter',
	})

	const listener: RunEventListener = (event: RunEvent) => {
		switch (event.type) {
			case 'run_started':
				log.info('Run started', {
					runId: event.runId,
					hasSystemPrompt: !!event.systemPrompt,
					systemPromptLength: event.systemPrompt?.length ?? 0,
				})
				break

			case 'iteration_started':
				log.info(`Iteration ${event.iteration} started`, {
					runId: event.runId,
					iteration: event.iteration,
				})
				break

			case 'iteration_completed':
				log.info(`Iteration ${event.iteration} completed`, {
					runId: event.runId,
					iteration: event.iteration,
					hasToolCalls: event.hasToolCalls,
				})
				break

			case 'tool_executing':
				log.info(`Tool executing: ${event.toolName}`, {
					runId: event.runId,
					tool: event.toolName,
				})
				break

			case 'tool_completed':
				log.info(`Tool completed: ${event.toolName}`, {
					runId: event.runId,
					tool: event.toolName,
				})
				break

			case 'llm_response':
				log.info('LLM response received', {
					runId: event.runId,
					hasToolCalls: event.hasToolCalls,
				})
				break

			case 'token_usage_updated':
				log.info('Token usage updated', {
					runId: event.runId,
					promptTokens: event.usage.promptTokens,
					completionTokens: event.usage.completionTokens,
					totalTokens: event.usage.totalTokens,
					totalCost: event.cost.totalCost,
				})
				break

			case 'run_completed':
				log.info('Run completed', { runId: event.runId })
				break

			case 'run_failed':
				log.error('Run failed', {
					runId: event.runId,
					error: event.error,
				})
				break

			case 'activity_created':
			case 'activity_updated':
			case 'plan_ready':
			case 'plan_approved':
			case 'plan_rejected':
			case 'plan_step_updated':
			case 'tool_review_requested':
			case 'tool_review_completed':
			case 'checkpoint_created':
			case 'run_paused':
			case 'run_resuming':
				break

			case 'agent_pending':
				log.info(`Agent task pending: ${event.childAgentId}`, {
					runId: event.runId,
					taskId: event.taskId,
					parentAgentId: event.parentAgentId,
					childAgentId: event.childAgentId,
					depth: event.depth,
				})
				break

			case 'agent_completed':
				log.info('Agent task completed', {
					runId: event.runId,
					taskId: event.taskId,
					status: event.result.status,
					iterations: event.result.iterations,
				})
				break

			case 'agent_failed':
				log.error('Agent task failed', {
					runId: event.runId,
					taskId: event.taskId,
					error: event.error,
				})
				break

			case 'agent_canceled':
				log.info('Agent task canceled', {
					runId: event.runId,
					taskId: event.taskId,
				})
				break

			case 'task_created':
				log.info(`Task created: ${event.subject}`, {
					runId: event.runId,
					taskId: event.taskId,
					status: event.status,
				})
				break

			case 'task_updated':
				log.info(`Task updated: ${event.subject}`, {
					runId: event.runId,
					taskId: event.taskId,
					status: event.status,
					owner: event.owner,
				})
				break

			case 'plugin_hook_executing':
				log.debug('Plugin hook executing', {
					runId: event.runId,
					pluginId: event.pluginId,
					hookEvent: event.hookEvent,
				})
				break

			case 'plugin_hook_completed':
				log.debug('Plugin hook completed', {
					runId: event.runId,
					pluginId: event.pluginId,
					hookEvent: event.hookEvent,
					action: event.result.action,
				})
				break

			default: {
				const _exhaustive: never = event
				throw new Error(`Unhandled run event type: ${(_exhaustive as RunEvent).type}`)
			}
		}
	}

	function summary(run: AgentRun): void {
		const elapsed = (run.endedAt ?? Date.now()) - run.startedAt
		const { tokenUsage, costInfo, currentIteration, stopReason } = run

		log.info('Run summary', {
			runId: run.id,
			agent: run.metadata.agentName,
			status: run.status,
			stopReason: stopReason ?? 'unknown',
			iterations: currentIteration,
			promptTokens: tokenUsage.promptTokens,
			completionTokens: tokenUsage.completionTokens,
			totalTokens: tokenUsage.totalTokens,
			cost: formatCost(costInfo.totalCost),
			duration: formatDuration(elapsed),
		})
	}

	return { listener, summary }
}

export const createSessionReporter = createRunReporter
