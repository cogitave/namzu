// Scrubs anything secret-shaped out of a record before any sink sees it.
//
// Runs once, in the pipeline, ahead of sink dispatch — not inside
// jsonLinesSink, and not inside any other individual sink. A scan that only
// jsonLinesSink ran would leave prettySink (the one `namzu run` actually
// uses) and every host-supplied sink with no second layer at all, which is
// the gap a scoped-to-one-sink design would reintroduce: the machine-read
// path would be the only protected one.
//
// This is defence in depth, not the guarantee — the primary control is the
// output guardrail upstream (`runtime/query/guardrail-presets.ts`) and the
// allowlist that keeps untrusted text out of attribute values in the first
// place. A match here means that allowlist already had a hole.

import { LOG_SECRET_PATTERNS } from '../../constants/secret-patterns.js'
import type { LogRecord, MutableLogSinkCounters } from './types.js'

export function redactRecord(record: LogRecord, counters: MutableLogSinkCounters): LogRecord {
	const body = redactString(record.body)
	const attributes = redactAttributes(record.attributes)

	if (body === record.body && attributes === record.attributes) return record

	counters.redacted++
	return { ...record, body, attributes }
}

function redactString(text: string): string {
	let out = text
	for (const [label, pattern] of LOG_SECRET_PATTERNS) {
		// Fresh lastIndex: these are module-level /g regexes, reused across
		// every record — the same caution guardrail-presets.ts already takes
		// on the same table.
		pattern.lastIndex = 0
		if (!pattern.test(out)) continue
		pattern.lastIndex = 0
		out = out.replace(pattern, `[REDACTED:${label}]`)
	}
	return out
}

function redactAttributes(
	attributes: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
	let changed = false
	const next: Record<string, unknown> = {}
	for (const [key, value] of Object.entries(attributes)) {
		const redacted = redactValue(value)
		if (redacted !== value) changed = true
		next[key] = redacted
	}
	return changed ? next : attributes
}

// Strings and arrays of primitives are the shapes `LogAttributes` will
// eventually restrict values to (a later increment); anything else passes
// through untouched rather than being stringified, which would be a second,
// unrelated way for structured data to leak.
function redactValue(value: unknown): unknown {
	if (typeof value === 'string') return redactString(value)

	if (Array.isArray(value)) {
		let changed = false
		const next = value.map((entry) => {
			const redacted = redactValue(entry)
			if (redacted !== entry) changed = true
			return redacted
		})
		// Only allocate a new array when something inside it actually changed —
		// `.map()` always returns a fresh array, and comparing that fresh
		// array's reference against the input would mark every array-valued
		// attribute "redacted" whether or not a pattern ever matched.
		return changed ? next : value
	}

	return value
}
