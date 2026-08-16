import type { LogRecord, LogSink } from '../utils/log/types.js'

/**
 * A `LogSink` adapter for a collector that wants nested objects.
 *
 * This file is the source of the adapter shown in
 * `docs/sdk/observability/logging.md`. The page embeds it verbatim and a
 * test asserts the two are byte-identical, so the snippet cannot drift
 * from code that compiles — a documented example nobody runs is a
 * documented example that rots.
 *
 * The mapping it performs is the cost the page names. Namzu attribute keys
 * are flat and dotted (`namzu.run.id`), which is what makes them
 * collision-free across modules and greppable in an NDJSON stream. A
 * collector with a nested schema wants `{ namzu: { run: { id } } }`, and
 * the two shapes are not interchangeable: `namzu.run.id` and
 * `namzu.run.id.value` cannot both exist as nested objects, though both
 * are valid flat keys. An adapter either accepts that some key sets will
 * conflict on the way in, or keeps the flat form and gives up the nesting.
 * This one takes the first branch and says so at the conflict.
 */

export interface CollectorPayload {
	readonly timestamp: string
	readonly severity: string
	readonly message: string
	readonly fields: Record<string, unknown>
}

export function nestedAttributeSink(send: (payload: CollectorPayload) => void): LogSink {
	return {
		emit(record: LogRecord): void {
			send({
				timestamp: new Date(record.timestamp).toISOString(),
				severity: record.severityText,
				message: record.body,
				fields: nest(record.attributes),
			})
		},
	}
}

/** `{'a.b': 1}` becomes `{a: {b: 1}}`. Throws where the two shapes disagree. */
export function nest(flat: Readonly<Record<string, unknown>>): Record<string, unknown> {
	const out: Record<string, unknown> = {}
	for (const [key, value] of Object.entries(flat)) {
		const parts = key.split('.')
		let node = out
		for (const [i, part] of parts.slice(0, -1).entries()) {
			const existing = node[part]
			if (existing !== undefined && !isPlainObject(existing)) {
				// `refuse-do-not-degrade`: silently overwriting one of the two
				// keys loses a field the caller logged, and which one it loses
				// depends on `Object.entries` order.
				throw new Error(
					`cannot nest ${key}: ${parts.slice(0, i + 1).join('.')} is already a value, not an object`,
				)
			}
			if (existing === undefined) node[part] = {}
			node = node[part] as Record<string, unknown>
		}
		node[parts[parts.length - 1] as string] = value
	}
	return out
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}
