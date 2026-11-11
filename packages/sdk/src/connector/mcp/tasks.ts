import type { MCPInputRequest } from '../../types/connector/index.js'

/** The extension's identifier, in both the client's and the server's `extensions`. */
export const MCP_TASKS_EXTENSION = 'io.modelcontextprotocol/tasks'

/** Poll no faster than this whatever the server suggests, and no slower than the cap. */
export const MCP_TASK_MIN_POLL_MS = 100
export const MCP_TASK_MAX_POLL_MS = 30_000
/** The interval used when the server names none. */
export const MCP_TASK_DEFAULT_POLL_MS = 1_000

export type MCPTaskStatus = 'working' | 'input_required' | 'completed' | 'failed' | 'cancelled'

/** One reading of a task: what `CreateTaskResult` and a `tasks/get` result both carry. */
export interface MCPTaskState {
	readonly taskId: string
	readonly status: MCPTaskStatus
	readonly statusMessage?: string
	readonly lastUpdatedAt?: string
	readonly pollIntervalMs?: number
	/** `input_required`: what the server wants, as `{ method }` entries. */
	readonly inputRequests?: readonly MCPInputRequest[]
	/** `completed`: the result the original request would have returned. */
	readonly result?: unknown
	/** `failed`: the JSON-RPC error. */
	readonly error?: { readonly code?: unknown; readonly message?: unknown; readonly data?: unknown }
}

const STATUSES = new Set<string>(['working', 'input_required', 'completed', 'failed', 'cancelled'])

/** Is this result a task handle rather than a result? */
export function isCreateTaskResult(raw: unknown): boolean {
	return (
		typeof raw === 'object' &&
		raw !== null &&
		(raw as { resultType?: unknown }).resultType === 'task'
	)
}

/**
 * Read a `CreateTaskResult` or a `tasks/get` result, or refuse it.
 *
 * Returns `undefined` for anything that is not a task with a non-empty
 * `taskId` and a status the extension defines, so a malformed answer ends the
 * wait with a clear error instead of polling a handle nobody can name.
 */
export function decodeTaskState(raw: unknown): MCPTaskState | undefined {
	if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
	const r = raw as Record<string, unknown>
	if (typeof r.taskId !== 'string' || r.taskId.length === 0) return undefined
	if (typeof r.status !== 'string' || !STATUSES.has(r.status)) return undefined
	const inputRequests =
		typeof r.inputRequests === 'object' && r.inputRequests !== null
			? Object.values(r.inputRequests as Record<string, unknown>).filter(
					(item): item is MCPInputRequest =>
						typeof item === 'object' &&
						item !== null &&
						typeof (item as { method?: unknown }).method === 'string',
				)
			: undefined
	return {
		taskId: r.taskId,
		status: r.status as MCPTaskStatus,
		...(typeof r.statusMessage === 'string' ? { statusMessage: r.statusMessage } : {}),
		...(typeof r.lastUpdatedAt === 'string' ? { lastUpdatedAt: r.lastUpdatedAt } : {}),
		...(typeof r.pollIntervalMs === 'number' && Number.isFinite(r.pollIntervalMs)
			? { pollIntervalMs: r.pollIntervalMs }
			: {}),
		...(inputRequests ? { inputRequests } : {}),
		...('result' in r ? { result: r.result } : {}),
		...(typeof r.error === 'object' && r.error !== null
			? { error: r.error as MCPTaskState['error'] }
			: {}),
	}
}

/** How long to wait before the next `tasks/get`, from what the server last suggested. */
export function taskPollDelayMs(suggested: number | undefined): number {
	const wanted = suggested ?? MCP_TASK_DEFAULT_POLL_MS
	return Math.min(Math.max(wanted, MCP_TASK_MIN_POLL_MS), MCP_TASK_MAX_POLL_MS)
}
