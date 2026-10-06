import type { SessionLog } from '../../store/session-log/index.js'
import type { SpillRef } from '../../store/session-log/spill.js'
import { readStructuredResultSpill } from '../../store/session-log/structured-result.js'
import { STRUCTURED_OUTPUT_TOOL_NAME } from '../../tools/builtins/structuredOutput.js'
import type { TurnId } from '../../types/ids/index.js'
import { type SessionRecord, SessionRecordSchema } from '../../types/session/records.js'
import type {
	CompletedToolRecord,
	ToolExecutionRecord,
	ToolExecutionSnapshot,
} from '../../types/session/tool-execution.js'
import { parseStructuredResultJson } from '../../utils/structured-result-json.js'

/** Full JSON retained across one recovery snapshot, after superseded calls are removed. */
const STRUCTURED_RECOVERY_MAX_BYTES = 64 * 1024 * 1024

/**
 * Collects the latest execution boundary of selected tool calls from one
 * turn's records, including bounded receipts and optional runtime-owned JSON
 * candidates. Structured spill bodies are hydrated separately, after the
 * whole log has verified; ordinary output spills remain bounded receipts.
 */
export class ToolExecutionCollector {
	private started = false
	private readonly wanted: Set<string>
	private readonly records = new Map<string, ToolExecutionRecord>()
	private readonly structuredSpills = new Map<string, SpillRef>()

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
			this.structuredSpills.delete(event.toolUseId)
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
		const structuredResultSpill = event.structuredResultSpill
		if (structuredResultJson !== undefined || structuredResultSpill !== undefined) {
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
			if (structuredResultSpill !== undefined) {
				// Also refuse malformed references and contradictory inline evidence
				// when the collector is driven outside the strict log reader.
				SessionRecordSchema.parse(record)
			} else {
				parseStructuredResultJson(structuredResultJson)
			}
		}
		this.structuredSpills.delete(event.toolUseId)
		if (structuredResultSpill !== undefined)
			this.structuredSpills.set(event.toolUseId, structuredResultSpill as SpillRef)
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
		// A synchronous fold cannot establish spilled structured evidence.
		// Its snapshot is incomplete until checked hydration finishes.
		return {
			complete: complete && this.started && this.structuredSpills.size === 0,
			records: this.records,
		}
	}

	/** Hydrate only the latest selected completion; overwritten retry bodies are irrelevant. */
	async finishWithSpills(
		log: SessionLog,
		complete = true,
		signal?: AbortSignal,
	): Promise<ToolExecutionSnapshot> {
		signal?.throwIfAborted()
		if (!complete || !this.started) return this.finish(false)
		let totalBytes = 0
		for (const ref of this.structuredSpills.values()) {
			totalBytes += ref.bytes
			if (totalBytes > STRUCTURED_RECOVERY_MAX_BYTES) {
				throw new Error(
					`Structured recovery exceeds the ${STRUCTURED_RECOVERY_MAX_BYTES}-byte aggregate limit.`,
				)
			}
		}
		const records = new Map(this.records)
		for (const [id, ref] of this.structuredSpills) {
			const record = records.get(id)
			if (!record || record.status !== 'completed')
				throw new Error('Structured spill lacks a completed call.')
			const { json: structuredResultJson } = await readStructuredResultSpill(log, ref, signal)
			records.set(id, { ...record, structuredResultJson })
		}
		signal?.throwIfAborted()
		return { complete: true, records }
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
	try {
		for (;;) {
			signal?.throwIfAborted()
			const step = await walk.next()
			if (step.done)
				return collector.finishWithSpills(
					log,
					step.value.intact && step.value.tornBytes === 0,
					signal,
				)
			collector.accept(step.value.record)
		}
	} finally {
		await walk.return({ intact: false, throughSeq: 0, head: null, tornBytes: 0 })
	}
}
