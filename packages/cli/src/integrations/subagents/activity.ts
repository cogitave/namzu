import { type RunEvent, type TaskHandle, genericLabel, isTerminalAgentTaskState } from '@namzu/sdk'

const MAX_RETAINED_AGENTS = 80
const MAX_TRANSCRIPT_ROWS = 120
const MAX_ROW_CODE_UNITS = 2_048
const MAX_PROMPT_CODE_UNITS = 4_096
const MAX_LABEL_CODE_UNITS = 240
const NOTIFY_INTERVAL_MS = 100

export type SubagentActivityStatus = 'starting' | 'working' | 'completed' | 'failed' | 'cancelled'

export type SubagentTranscriptRow =
	| {
			readonly id: string
			readonly kind: 'assistant'
			readonly text: string
	  }
	| {
			readonly id: string
			readonly kind: 'tool'
			readonly text: string
			readonly status: 'working' | 'completed' | 'failed'
			readonly detail?: string
	  }
	| {
			readonly id: string
			readonly kind: 'system'
			readonly text: string
	  }

export interface SubagentActivity {
	/** Stable for this screen even before the scheduler returns a task id. */
	readonly viewId: string
	readonly taskId?: string
	readonly runId?: string
	readonly agentId: string
	readonly description: string
	readonly prompt: string
	readonly status: SubagentActivityStatus
	readonly startedAt: number
	readonly completedAt?: number
	readonly latestActivity?: string
	readonly transcript: readonly SubagentTranscriptRow[]
}

/** Read-only side of the current CLI session's child-run monitor. */
export interface SubagentActivitySource {
	getSnapshot(): readonly SubagentActivity[]
	subscribe(listener: () => void): () => void
	/** Start a new conversation scope; late events from the old one are ignored. */
	reset(): void
}

export interface SubagentActivityTracker {
	readonly onEvent: (event: RunEvent) => void
	settle(handle: TaskHandle): void
	fail(error: unknown): void
}

interface MutableActivity {
	readonly epoch: number
	readonly order: number
	readonly viewId: string
	taskId?: string
	runId?: string
	agentId: string
	description: string
	prompt: string
	status: SubagentActivityStatus
	startedAt: number
	completedAt?: number
	latestActivity?: string
	rows: SubagentTranscriptRow[]
	closed: boolean
}

/**
 * Projects each child stream immediately and retains only bounded display
 * state. Raw RunEvents never accumulate here: images, tool inputs and token
 * deltas can be arbitrarily large and the parent TUI must not inherit them.
 */
export class SubagentActivityMonitor implements SubagentActivitySource {
	private readonly records = new Map<string, MutableActivity>()
	private readonly listeners = new Set<() => void>()
	private epoch = 0
	private counter = 0
	private notifyTimer: ReturnType<typeof setTimeout> | undefined
	private closed = false

	begin(input: {
		readonly agentId: string
		readonly description: string
		readonly prompt: string
	}): SubagentActivityTracker {
		const epoch = this.epoch
		const viewId = `agent-${++this.counter}`
		const record: MutableActivity = {
			epoch,
			order: this.counter,
			viewId,
			agentId: bounded(input.agentId, MAX_LABEL_CODE_UNITS),
			description: bounded(input.description, MAX_LABEL_CODE_UNITS),
			prompt: bounded(input.prompt, MAX_PROMPT_CODE_UNITS),
			status: 'starting',
			startedAt: Date.now(),
			rows: [],
			closed: false,
		}
		this.records.set(viewId, record)
		this.prune()
		this.notifyNow()

		const current = (): MutableActivity | undefined => {
			if (this.closed || epoch !== this.epoch || record.closed) return undefined
			return this.records.get(viewId) === record ? record : undefined
		}
		return {
			onEvent: (event) => {
				const owned = current()
				if (!owned) return
				projectEvent(owned, event)
				this.scheduleNotify()
			},
			settle: (handle) => {
				const owned = current()
				if (!owned) return
				owned.taskId = String(handle.taskId)
				owned.agentId = bounded(handle.agentId, MAX_LABEL_CODE_UNITS)
				owned.status = statusOf(handle)
				owned.completedAt = handle.completedAt ?? Date.now()
				owned.latestActivity = terminalLabel(owned.status)
				if (owned.rows.length === 0) {
					pushRow(owned, {
						id: `${owned.viewId}:unavailable`,
						kind: 'system',
						text: 'Live transcript was not exposed by this scheduler; the settled result remains on the parent Agent call.',
					})
				}
				owned.closed = true
				this.prune()
				this.notifyNow()
			},
			fail: (error) => {
				const owned = current()
				if (!owned) return
				const cancelled = cancellationLike(error)
				owned.status = cancelled ? 'cancelled' : 'failed'
				owned.completedAt = Date.now()
				owned.latestActivity = terminalLabel(owned.status)
				pushRow(owned, {
					id: `${owned.viewId}:failure`,
					kind: 'system',
					text: bounded(errorMessage(error), MAX_ROW_CODE_UNITS),
				})
				owned.closed = true
				this.prune()
				this.notifyNow()
			},
		}
	}

	getSnapshot(): readonly SubagentActivity[] {
		return [...this.records.values()]
			.sort((left, right) => {
				const live = Number(isTerminal(left.status)) - Number(isTerminal(right.status))
				return live !== 0 ? live : left.order - right.order
			})
			.map((record) =>
				Object.freeze({
					viewId: record.viewId,
					...(record.taskId ? { taskId: record.taskId } : {}),
					...(record.runId ? { runId: record.runId } : {}),
					agentId: record.agentId,
					description: record.description,
					prompt: record.prompt,
					status: record.status,
					startedAt: record.startedAt,
					...(record.completedAt !== undefined ? { completedAt: record.completedAt } : {}),
					...(record.latestActivity ? { latestActivity: record.latestActivity } : {}),
					transcript: Object.freeze(record.rows.map((row) => Object.freeze({ ...row }))),
				}),
			)
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener)
		return () => this.listeners.delete(listener)
	}

	reset(): void {
		this.epoch += 1
		this.records.clear()
		this.clearNotifyTimer()
		this.notifyNow()
	}

	close(): void {
		if (this.closed) return
		this.closed = true
		this.records.clear()
		this.clearNotifyTimer()
		this.notifyNow()
		this.listeners.clear()
	}

	private prune(): void {
		const terminal = [...this.records.values()]
			.filter((record) => isTerminal(record.status))
			.sort((left, right) => left.order - right.order)
		while (terminal.length > MAX_RETAINED_AGENTS) {
			const oldest = terminal.shift()
			if (oldest) this.records.delete(oldest.viewId)
		}
	}

	private scheduleNotify(): void {
		if (this.closed || this.notifyTimer) return
		this.notifyTimer = setTimeout(() => {
			this.notifyTimer = undefined
			this.notifyNow()
		}, NOTIFY_INTERVAL_MS)
		this.notifyTimer.unref?.()
	}

	private clearNotifyTimer(): void {
		if (!this.notifyTimer) return
		clearTimeout(this.notifyTimer)
		this.notifyTimer = undefined
	}

	private notifyNow(): void {
		if (this.notifyTimer) this.clearNotifyTimer()
		for (const listener of this.listeners) {
			try {
				listener()
			} catch {
				// Observers are projections, never backpressure or authority. One
				// broken renderer must not keep other surfaces from receiving state.
			}
		}
	}
}

function projectEvent(record: MutableActivity, event: RunEvent): void {
	switch (event.type) {
		case 'agent_pending':
			record.taskId = String(event.taskId)
			record.agentId = bounded(event.childAgentId, MAX_LABEL_CODE_UNITS)
			record.latestActivity = 'Starting'
			return
		case 'run_started':
			record.runId = String(event.runId)
			record.status = 'working'
			record.latestActivity = 'Working'
			return
		case 'text_delta': {
			record.status = 'working'
			record.latestActivity = 'Answering'
			const id = `${record.viewId}:assistant:${event.messageId ?? event.runId}`
			const current = record.rows.at(-1)
			if (current?.kind === 'assistant' && current.id === id) {
				record.rows[record.rows.length - 1] = {
					...current,
					text: appendBounded(current.text, event.text),
				}
			} else {
				pushRow(record, {
					id,
					kind: 'assistant',
					text: bounded(event.text, MAX_ROW_CODE_UNITS),
				})
			}
			return
		}
		case 'tool_executing': {
			record.status = 'working'
			const label = `${event.toolName}(${genericLabel(event.input)})`
			record.latestActivity = bounded(label, MAX_LABEL_CODE_UNITS)
			pushRow(record, {
				id: `${record.viewId}:tool:${event.toolUseId}`,
				kind: 'tool',
				text: bounded(label, MAX_ROW_CODE_UNITS),
				status: 'working',
			})
			return
		}
		case 'tool_progress': {
			const id = `${record.viewId}:tool:${event.toolUseId}`
			const index = record.rows.findIndex((row) => row.id === id)
			if (index < 0) return
			const row = record.rows[index]
			if (!row || row.kind !== 'tool') return
			record.rows[index] = {
				...row,
				detail: bounded(event.message, MAX_ROW_CODE_UNITS),
			}
			record.latestActivity = bounded(event.message, MAX_LABEL_CODE_UNITS)
			return
		}
		case 'tool_completed': {
			const id = `${record.viewId}:tool:${event.toolUseId}`
			const index = record.rows.findIndex((row) => row.id === id)
			if (index >= 0) {
				const row = record.rows[index]
				if (row?.kind === 'tool') {
					record.rows[index] = {
						...row,
						status: event.isError ? 'failed' : 'completed',
						...(event.result ? { detail: bounded(event.result, MAX_ROW_CODE_UNITS) } : {}),
					}
				}
			}
			record.latestActivity = event.isError ? `${event.toolName} failed` : `${event.toolName} done`
			return
		}
		case 'provider_retry':
			record.latestActivity = `Retrying (${event.attempt}/${event.maxRetries})`
			return
		case 'agent_completed':
			record.status = event.result.status === 'completed' ? 'completed' : 'failed'
			record.completedAt = Date.now()
			record.latestActivity = terminalLabel(record.status)
			return
		case 'agent_failed':
			record.status = 'failed'
			record.completedAt = Date.now()
			record.latestActivity = 'Failed'
			pushRow(record, {
				id: `${record.viewId}:agent-failed`,
				kind: 'system',
				text: bounded(event.error, MAX_ROW_CODE_UNITS),
			})
			return
		case 'agent_canceled':
			record.status = 'cancelled'
			record.completedAt = Date.now()
			record.latestActivity = 'Cancelled'
			return
		case 'run_failed':
			record.latestActivity = 'Failed'
			pushRow(record, {
				id: `${record.viewId}:run-failed`,
				kind: 'system',
				text: bounded(event.error, MAX_ROW_CODE_UNITS),
			})
			return
		default:
			return
	}
}

function pushRow(record: MutableActivity, row: SubagentTranscriptRow): void {
	record.rows.push(row)
	if (record.rows.length > MAX_TRANSCRIPT_ROWS) {
		record.rows.splice(0, record.rows.length - MAX_TRANSCRIPT_ROWS)
	}
}

function statusOf(handle: TaskHandle): SubagentActivityStatus {
	if (handle.state === 'canceled') return 'cancelled'
	if (handle.state === 'failed' || handle.state === 'rejected') return 'failed'
	if (handle.result && handle.result.status !== 'completed') {
		return handle.result.status === 'cancelled' ? 'cancelled' : 'failed'
	}
	if (isTerminalAgentTaskState(handle.state)) return 'completed'
	return 'working'
}

function isTerminal(status: SubagentActivityStatus): boolean {
	return status === 'completed' || status === 'failed' || status === 'cancelled'
}

function terminalLabel(status: SubagentActivityStatus): string {
	switch (status) {
		case 'starting':
			return 'Starting'
		case 'working':
			return 'Working'
		case 'completed':
			return 'Completed'
		case 'failed':
			return 'Failed'
		case 'cancelled':
			return 'Cancelled'
	}
}

function bounded(value: string, max: number): string {
	if (value.length <= max) return value
	const suffix = '… [clipped]'
	return `${value.slice(0, Math.max(0, max - suffix.length))}${suffix}`
}

function appendBounded(current: string, delta: string): string {
	const joined = current + delta
	if (joined.length <= MAX_ROW_CODE_UNITS) return joined
	const prefix = '… [earlier text clipped]\n'
	return prefix + joined.slice(-(MAX_ROW_CODE_UNITS - prefix.length))
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}

function cancellationLike(error: unknown): boolean {
	return error instanceof Error && (error.name === 'AbortError' || error.name === 'RunCancelled')
}
