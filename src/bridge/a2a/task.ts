import { RUN_STATUS_TO_A2A, TERMINAL_STATES } from '../../constants/a2a/index.js'
import type { Run, RunConfig, RunStatus, ThreadMessage } from '../../contracts/index.js'
import type {
	A2AArtifact,
	A2AMessage,
	A2AMessageSendParams,
	A2ATask,
	A2ATaskState,
	A2ATaskStatus,
} from '../../types/a2a/index.js'
import { extractTextFromA2AMessage, threadMessageToA2A } from './message.js'

export function isTerminalState(state: A2ATaskState): boolean {
	return TERMINAL_STATES.has(state)
}

export function runStatusToA2AState(status: RunStatus): A2ATaskState {
	return RUN_STATUS_TO_A2A[status]
}

function buildTaskStatus(run: Run): A2ATaskStatus {
	const state = runStatusToA2AState(run.status)
	const timestamp = run.completed_at ?? run.started_at ?? run.created_at

	const message: A2AMessage | undefined = run.result
		? { role: 'agent', parts: [{ kind: 'text', text: run.result }] }
		: run.last_error
			? { role: 'agent', parts: [{ kind: 'text', text: run.last_error }] }
			: undefined

	return { state, message, timestamp }
}

function buildArtifacts(run: Run): A2AArtifact[] | undefined {
	if (!run.result) return undefined

	return [
		{
			artifactId: `${run.id}-result`,
			name: 'Agent Response',
			parts: [{ kind: 'text', text: run.result }],
			metadata: {
				model: run.model,
				iterations: run.iterations,
				duration_ms: run.duration_ms,
				...(run.usage && {
					input_tokens: run.usage.input_tokens,
					output_tokens: run.usage.output_tokens,
					total_cost_usd: run.usage.total_cost_usd,
				}),
			},
		},
	]
}

export function runToA2ATask(run: Run, messages?: readonly ThreadMessage[]): A2ATask {
	return {
		id: run.id,
		contextId: run.thread_id ?? undefined,
		status: buildTaskStatus(run),
		history: messages?.map(threadMessageToA2A),
		artifacts: buildArtifacts(run),
		metadata: {
			agent_id: run.agent_id,
			agent_name: run.agent_name,
			stop_reason: run.stop_reason,
		},
	}
}

export interface CreateRunFromA2A {
	readonly agentId: string
	readonly input: string
	readonly threadId?: string
	readonly config: RunConfig
}

export function a2aMessageToCreateRun(
	agentId: string,
	params: A2AMessageSendParams,
): CreateRunFromA2A {
	const input = extractTextFromA2AMessage(params.message)
	const meta = params.metadata ?? {}

	const config: RunConfig = {
		...(typeof meta.model === 'string' && { model: meta.model }),
		...(typeof meta.tokenBudget === 'number' && { tokenBudget: meta.tokenBudget }),
		...(typeof meta.timeoutMs === 'number' && { timeoutMs: meta.timeoutMs }),
		...(typeof meta.temperature === 'number' && { temperature: meta.temperature }),
		...(typeof meta.maxResponseTokens === 'number' && {
			maxResponseTokens: meta.maxResponseTokens,
		}),
		...((meta.permissionMode === 'plan' || meta.permissionMode === 'auto') && {
			permissionMode: meta.permissionMode,
		}),
		...(typeof meta.systemPrompt === 'string' && { systemPrompt: meta.systemPrompt }),
	}

	return {
		agentId,
		input,
		threadId: params.contextId,
		config,
	}
}
