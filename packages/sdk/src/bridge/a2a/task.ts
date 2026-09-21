import { TERMINAL_STATES, TURN_STATUS_TO_A2A } from '../../constants/a2a/index.js'
import type { WireTurnStatus } from '../../contracts/session/turn-status.js'
import type { WireTurn, WireTurnConfig } from '../../contracts/session/turn.js'
import type {
	A2AArtifact,
	A2AMessage,
	A2AMessageSendParams,
	A2ATask,
	A2ATaskState,
	A2ATaskStatus,
} from '../../types/a2a/index.js'
import type { Message } from '../../types/message/index.js'
import type { ExternalRef, Origin } from '../../types/session/turn.js'
import { extractTextFromA2AMessage, messageToA2A } from './message.js'

// An A2A task is one namzu turn, and an A2A context is one namzu session. The
// task's `id` is the turn id; its `contextId` names the session, either as the
// session id itself or as the caller's own context id that was mapped onto it.

export function isTerminalState(state: A2ATaskState): boolean {
	return TERMINAL_STATES.has(state)
}

export function turnStatusToA2AState(status: WireTurnStatus): A2ATaskState {
	return TURN_STATUS_TO_A2A[status]
}

function buildTaskStatus(turn: WireTurn): A2ATaskStatus {
	const state = turnStatusToA2AState(turn.status)
	const timestamp = turn.completed_at ?? turn.started_at ?? turn.created_at

	const message: A2AMessage | undefined = turn.result
		? { role: 'agent', parts: [{ kind: 'text', text: turn.result }] }
		: turn.last_error
			? { role: 'agent', parts: [{ kind: 'text', text: turn.last_error }] }
			: undefined

	return { state, message, timestamp }
}

function buildArtifacts(turn: WireTurn): A2AArtifact[] | undefined {
	if (!turn.result) return undefined

	return [
		{
			artifactId: `${turn.turn_id}-result`,
			name: 'Agent Response',
			parts: [{ kind: 'text', text: turn.result }],
			metadata: {
				model: turn.model,
				iterations: turn.iterations,
				duration_ms: turn.duration_ms,
				...(turn.usage && {
					input_tokens: turn.usage.input_tokens,
					output_tokens: turn.usage.output_tokens,
					total_cost_usd: turn.usage.total_cost_usd,
				}),
			},
		},
	]
}

export interface MapTurnToA2ATaskOptions {
	/**
	 * The context id the peer addressed this session by, echoed back verbatim.
	 * Defaults to the turn's `session_id`. Pass the peer's own id when the
	 * session was reached through it, so the peer sees the id it sent.
	 */
	readonly contextId?: string
}

/**
 * One turn as an A2A task: `id` is the turn, `contextId` the session.
 *
 * The context is never the project. A host that serves `tasks/get` or
 * `tasks/list` reads the turns from `SessionIndex.listTurns` and hands each
 * one here with the session's messages.
 */
export function mapTurnToA2ATask(
	turn: WireTurn,
	messages?: readonly Message[],
	options: MapTurnToA2ATaskOptions = {},
): A2ATask {
	return {
		id: turn.turn_id,
		contextId: options.contextId ?? turn.session_id,
		status: buildTaskStatus(turn),
		history: messages?.map(messageToA2A),
		artifacts: buildArtifacts(turn),
		metadata: {
			agent_id: turn.agent_id,
			agent_name: turn.agent_name,
			stop_reason: turn.stop_reason,
		},
	}
}

/**
 * What an incoming `message/send` asks for: a new turn of one session.
 *
 * `contextId` is the peer's own name for the session, verbatim. It is any
 * string and is never read as a namzu id or a project id: the project comes
 * from the host's configuration. A host resolves it with
 * `resolveA2AContext` (an existing session, or a new one), and starts the turn
 * with `origin`, which is how the mapping reaches the session log and so
 * survives an index rebuild.
 */
export interface CreateTurnFromA2A {
	readonly agentId: string
	readonly input: string
	/** The peer's context id, when it sent one. Absent means a new session. */
	readonly contextId?: string
	/** The ref the index resolves `contextId` through: `a2a` / `context`. */
	readonly externalRef?: ExternalRef
	/** Recorded on the turn (and on the session when the turn creates it). */
	readonly origin: Origin
	readonly config: WireTurnConfig
}

export function a2aMessageToCreateTurn(
	agentId: string,
	params: A2AMessageSendParams,
): CreateTurnFromA2A {
	const input = extractTextFromA2AMessage(params.message)
	const meta = params.metadata ?? {}

	const config: WireTurnConfig = {
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

	const contextId =
		typeof params.contextId === 'string' && params.contextId.length > 0
			? params.contextId
			: undefined

	return {
		agentId,
		input,
		...(contextId !== undefined && {
			contextId,
			externalRef: { protocol: 'a2a', kind: 'context', externalId: contextId },
		}),
		origin: {
			protocol: 'a2a',
			kind: 'prompt',
			...(contextId !== undefined && { externalSessionId: contextId }),
		},
		config,
	}
}
