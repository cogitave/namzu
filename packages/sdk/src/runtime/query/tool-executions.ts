import type { SessionLog } from '../../store/session-log/index.js'
import { STRUCTURED_OUTPUT_TOOL_NAME } from '../../tools/builtins/structuredOutput.js'
import type { TurnId } from '../../types/ids/index.js'
import type { SessionRecord } from '../../types/session/records.js'
import type {
	CompletedToolRecord,
	ToolExecutionRecord,
	ToolExecutionSnapshot,
} from '../../types/session/tool-execution.js'
import { parseStructuredResultJson } from '../../utils/structured-result-json.js'

/**
 * Collects the latest execution boundary of selected tool calls from one
 * turn's records, including bounded receipts and optional runtime-owned JSON
 * candidates. Original output bodies are never recovered from spill references.
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
		const inputFailure = event.inputFailure
		if (
			inputFailure !== undefined &&
			(typeof inputFailure !== 'string' ||
				!['invalid_json', 'schema_validation', 'input_truncated'].includes(inputFailure) ||
				event.isError !== true)
		)
			throw new Error('Tool recovery found an invalid input failure classification.')
		const skipped = event.skipped
		if (
			skipped !== undefined &&
			(skipped !== true || event.isError !== false || inputFailure !== undefined)
		)
			throw new Error('Tool recovery found an invalid skipped completion classification.')
		const structuredResultJson = event.structuredResultJson
		if (structuredResultJson !== undefined) {
			if (
				event.toolName !== STRUCTURED_OUTPUT_TOOL_NAME ||
				event.isError !== false ||
				skipped !== undefined ||
				inputFailure !== undefined ||
				event.via !== undefined
			)
				throw new Error(
					'Tool recovery found an invalid durable structured completion classification.',
				)
			parseStructuredResultJson(structuredResultJson)
		}
		this.records.set(event.toolUseId, {
			...identity,
			status: 'completed',
			result: event.result,
			isError: event.isError,
			...(inputFailure !== undefined
				? { inputFailure: inputFailure as CompletedToolRecord['inputFailure'] }
				: {}),
			...(skipped ? { skipped: true as const } : {}),
			...(structuredResultJson !== undefined
				? { structuredResultJson: structuredResultJson as string }
				: {}),
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
