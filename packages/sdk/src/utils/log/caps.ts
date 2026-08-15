// Cardinality and size caps, enforced once at the pipeline boundary — not
// per sink, and not left to whichever sink happens to serialize the record.
// A prose rule here would not survive the first attribute added under
// deadline; these are type-and-code boundaries a caller cannot route around
// by picking a different sink.
//
// Order matters and is fixed by createLogger: redact, THEN cap. Truncating
// first could slice a secret in half and ship the surviving fragment: a
// `[REDACTED:label]` placeholder is short and never needs truncating itself,
// but half of a real key still leaks half a key.

import type { LogRecord, MutableLogSinkCounters } from './types.js'

export const MAX_ATTRIBUTES = 64
export const MAX_VALUE_BYTES = 8 * 1024
export const MAX_RECORD_BYTES = 16 * 1024

/**
 * At most 64 attributes. Excess keys are dropped in ascending key order —
 * the same deterministic rule `capTotalSize` uses below, so a reader who has
 * learned one learns both.
 */
export function capAttributeCount(record: LogRecord, counters: MutableLogSinkCounters): LogRecord {
	const keys = Object.keys(record.attributes)
	if (keys.length <= MAX_ATTRIBUTES) return record

	const dropCount = keys.length - MAX_ATTRIBUTES
	const dropped = new Set([...keys].sort().slice(0, dropCount))

	const attributes: Record<string, unknown> = {}
	for (const key of keys) {
		if (!dropped.has(key)) attributes[key] = record.attributes[key]
	}

	counters.attributesDropped += dropCount
	return { ...record, attributes }
}

/**
 * Each string attribute value truncated at 8 KiB, tail replaced by
 * `…[truncated N bytes]` inside the value — self-describing, so no extra
 * flag field is minted for something the value already says about itself.
 */
export function truncateValues(record: LogRecord, counters: MutableLogSinkCounters): LogRecord {
	let changed = false
	const attributes: Record<string, unknown> = {}

	for (const [key, value] of Object.entries(record.attributes)) {
		if (typeof value !== 'string') {
			attributes[key] = value
			continue
		}
		const [text, wasTruncated] = truncateToByteLength(value, MAX_VALUE_BYTES)
		attributes[key] = text
		if (wasTruncated) {
			changed = true
			counters.valuesTruncated++
		}
	}

	return changed ? { ...record, attributes } : record
}

function truncateToByteLength(value: string, maxBytes: number): [text: string, truncated: boolean] {
	const totalBytes = Buffer.byteLength(value, 'utf8')
	if (totalBytes <= maxBytes) return [value, false]

	// Walk by Unicode codepoint, not UTF-16 code unit, so the cut point never
	// lands inside a surrogate pair — splitting one produces an unpaired
	// surrogate that some JSON readers choke on or silently mangle.
	let kept = ''
	let bytes = 0
	for (const ch of value) {
		const chBytes = Buffer.byteLength(ch, 'utf8')
		if (bytes + chBytes > maxBytes) break
		kept += ch
		bytes += chBytes
	}

	const removedBytes = totalBytes - bytes
	return [`${kept}…[truncated ${removedBytes} bytes]`, true]
}

/**
 * Total serialized record ≤ 16 KiB. Per-value and per-count caps are
 * independently satisfiable by a record with many small attributes, so this
 * is the last line and measures the whole record, not one dimension of it.
 * Attributes are dropped in ascending key order until it fits, and
 * `namzu.log.truncated = true` is set on what remains — the marker a
 * downstream reader needs to tell "this record is smaller than what was
 * logged" from "this is genuinely all there was".
 */
export function capTotalSize(record: LogRecord, counters: MutableLogSinkCounters): LogRecord {
	if (serializedByteLength(record) <= MAX_RECORD_BYTES) return record

	const sortedKeys = Object.keys(record.attributes).sort()
	for (let dropCount = 1; dropCount <= sortedKeys.length; dropCount++) {
		const keptKeys = sortedKeys.slice(dropCount)
		const attributes: Record<string, unknown> = {}
		for (const key of keptKeys) attributes[key] = record.attributes[key]

		const candidate: LogRecord = { ...record, attributes }
		if (keptKeys.length === 0 || serializedByteLength(candidate) <= MAX_RECORD_BYTES) {
			counters.recordsTruncated++
			return { ...record, attributes: { ...attributes, 'namzu.log.truncated': true } }
		}
	}

	// Unreachable: the final iteration of the loop above always has
	// `keptKeys.length === 0` and returns from inside it. Kept as a typed
	// fallback rather than a non-null assertion on the loop's last candidate.
	counters.recordsTruncated++
	return { ...record, attributes: { 'namzu.log.truncated': true } }
}

function serializedByteLength(record: LogRecord): number {
	return Buffer.byteLength(JSON.stringify(record), 'utf8')
}
