import type { SessionRecord } from '../../types/session/records.js'
import { SessionRecordSchema } from '../../types/session/records.js'
import { awaitWithAbort } from '../../utils/await-with-abort.js'
import { cloneJsonValue } from '../../utils/json-snapshot.js'
import {
	STRUCTURED_RESULT_MAX_BYTES,
	parseStructuredResultJson,
} from '../../utils/structured-result-json.js'
import type { SessionLog } from './core.js'
import { SpillIntegrityError, type SpillRef, sha256Hex } from './spill.js'

export interface StructuredResultReadOptions {
	readonly signal?: AbortSignal
}

/** Internal checked hydration, also used by completed-call recovery. */
export async function readStructuredResultSpill(
	log: SessionLog,
	ref: SpillRef,
	signal?: AbortSignal,
): Promise<{ json: string; value: unknown }> {
	signal?.throwIfAborted()
	if (
		!Number.isSafeInteger(ref.bytes) ||
		ref.bytes <= 0 ||
		ref.bytes > STRUCTURED_RESULT_MAX_BYTES ||
		!/^tool-results\/[a-f0-9]{64}\.txt$/.test(ref.path) ||
		ref.manifest !== `${ref.path}.manifest.json` ||
		!/^[a-f0-9]{64}$/.test(ref.sha256)
	)
		throw new SpillIntegrityError(ref.path, 'Invalid or oversized structured result reference.')
	const json = await awaitWithAbort(
		log.readSpill(ref, { maxBytes: STRUCTURED_RESULT_MAX_BYTES, signal }),
		signal,
	)
	signal?.throwIfAborted()
	if (
		typeof json !== 'string' ||
		Buffer.byteLength(json, 'utf8') !== ref.bytes ||
		sha256Hex(json) !== ref.sha256
	) {
		throw new SpillIntegrityError(
			ref.path,
			'Structured result bytes do not match their recorded length and SHA-256.',
		)
	}
	let value: unknown
	try {
		value = parseStructuredResultJson(json)
	} catch (error) {
		throw new SpillIntegrityError(ref.path, 'Structured result body is not JSON-safe.', {
			cause: error,
		})
	}
	signal?.throwIfAborted()
	return { json, value }
}

/**
 * Decode accepted structured output from a completed record obtained by the
 * caller from a verified log read. This helper does not walk the chain. Raw log
 * reads keep references; this explicit read checks the body before decoding.
 * No schema, tool or reviewer is rerun. Undefined means no accepted JSON.
 */
export async function readStructuredOutput(
	log: SessionLog,
	record: Extract<SessionRecord, { type: 'turn_completed' }>,
	options: StructuredResultReadOptions = {},
): Promise<unknown> {
	options.signal?.throwIfAborted()
	if (record.type !== 'turn_completed' || record.sessionId !== log.sessionId) {
		throw new TypeError('Structured output requires a completed record from this session.')
	}
	SessionRecordSchema.parse(record)
	const ref = record.structuredOutputSpill
	if (record.settlement.status !== 'completed') {
		if (record.settlement.structuredOutput !== undefined || ref !== undefined) {
			throw new TypeError('A cancelled turn cannot publish accepted structured output.')
		}
		return undefined
	}
	if (
		(ref !== undefined || record.settlement.structuredOutput !== undefined) &&
		record.settlement.resultSource !== 'structured_output'
	) {
		throw new TypeError('Accepted structured output requires the structured_output result source.')
	}
	if (ref !== undefined) {
		const { value } = await readStructuredResultSpill(log, ref, options.signal)
		options.signal?.throwIfAborted()
		return value
	}
	return record.settlement.structuredOutput === undefined
		? undefined
		: cloneJsonValue(record.settlement.structuredOutput, false)
}
