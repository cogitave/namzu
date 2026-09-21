import type { SessionLog } from '../../store/session-log/index.js'
import type { TurnId } from '../../types/ids/index.js'
import type { SessionRecord } from '../../types/session/records.js'
import type {
	ToolExecutionRecord,
	ToolExecutionSnapshot,
} from '../../types/session/tool-execution.js'

/**
 * Collects the latest execution boundary of selected tool calls from one
 * turn's records: metadata only, never retained output bodies beyond the
 * completion's own result.
 */
export class ToolExecutionCollector {
	private started = false
	private readonly wanted: Set<string>
	private readonly records = new Map<string, ToolExecutionRecord>()

	constructor(
		private readonly turnId: TurnId,
		ids: readonly string[],
	) {
		if (ids.length > 4096) throw new Error('Tool recovery exceeds the 4096-call scan limit.')
		this.wanted = new Set(ids)
	}

	accept(record: SessionRecord): void {
		if (record.turnId !== this.turnId) return
		if (record.type === 'turn_started') this.started = true
		if (record.type !== 'tool_executing' && record.type !== 'tool_completed') return
		const event = record as SessionRecord & Record<string, unknown>
		if (typeof event.toolUseId !== 'string' || typeof event.toolName !== 'string')
			throw new Error('Tool recovery found an invalid tool identity.')
		if (!this.wanted.has(event.toolUseId)) return
		const identity = { toolUseId: event.toolUseId, toolName: event.toolName }
		if (record.type === 'tool_executing') {
			// A later start invalidates an earlier completion, including retries.
			this.records.set(event.toolUseId, { ...identity, status: 'started' })
			return
		}
		if (typeof event.result !== 'string' || typeof event.isError !== 'boolean')
			throw new Error('Tool recovery found an invalid completion.')
		this.records.set(event.toolUseId, {
			...identity,
			status: 'completed',
			result: event.result,
			isError: event.isError,
		})
	}

	/** Complete only when the turn's beginning was seen and the whole log verified. */
	finish(complete = true): ToolExecutionSnapshot {
		return { complete: complete && this.started, records: this.records }
	}
}

/**
 * Read the latest recorded execution boundary of selected tool calls of one
 * turn. The log is read strictly, so absence of a start is proof only when
 * the snapshot is `complete`.
 */
export async function readToolExecutions(
	log: SessionLog,
	turnId: TurnId,
	ids: readonly string[],
	signal?: AbortSignal,
): Promise<ToolExecutionSnapshot> {
	signal?.throwIfAborted()
	const collector = new ToolExecutionCollector(turnId, ids)
	const walk = log.read({ mode: 'strict' })
	for (;;) {
		signal?.throwIfAborted()
		const step = await walk.next()
		if (step.done) return collector.finish(step.value.intact && step.value.tornBytes === 0)
		collector.accept(step.value.record)
	}
}
