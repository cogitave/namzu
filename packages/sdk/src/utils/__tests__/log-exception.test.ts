import { describe, expect, it } from 'vitest'
import { errorAttributes } from '../log/exception.js'
import { createLogger } from '../log/index.js'
import type { LogRecord, LogSink } from '../log/index.js'
import { ERR_ATTRIBUTE } from '../log/types.js'

function capturingSink(): { sink: LogSink; records: LogRecord[] } {
	const records: LogRecord[] = []
	return { sink: { emit: (record) => records.push(record) }, records }
}

function buildLogger(sink: LogSink) {
	return createLogger({
		sink,
		level: { current: 'info' },
		resource: { 'service.name': 'test' },
		scope: 'test',
	})
}

/**
 * Builds an Error whose `.cause` chain is `depth` hops deep, built from the
 * root outward so the RETURNED error is `layer 0` and each `.cause` hop is
 * `layer 1`, `layer 2`, … in walk order — a test can then assert exactly
 * how many hops a bounded walk reached by which `layer N` strings appear.
 */
function buildCauseChain(depth: number): Error {
	let current = new Error(`layer ${depth} (root cause)`)
	for (let i = depth - 1; i >= 0; i--) {
		current = new Error(`layer ${i}`, { cause: current })
	}
	return current
}

describe('errorAttributes — direct mapping', () => {
	it('maps type, message and stacktrace as three separate attributes', () => {
		const err = new TypeError('boom')
		const attrs = errorAttributes(err)

		expect(attrs['exception.type']).toBe('TypeError')
		expect(attrs['exception.message']).toBe('boom')
		expect(String(attrs['exception.stacktrace'])).toContain('boom')
		// Mutation: a version that stringifies `err` into `exception.message`
		// instead of reading `.message` would fail this — the message must be
		// exactly the string, not `"Error: boom"` or `[object Error]`.
		expect(attrs['exception.message']).toBe(err.message)
	})

	it('names a thrown non-Error value rather than crashing on it', () => {
		const attrs = errorAttributes('a bare string was thrown')

		expect(attrs['exception.type']).toBe('UnknownError')
		expect(attrs['exception.message']).toBe('a bare string was thrown')
		expect(attrs['exception.stacktrace']).toBe('a bare string was thrown')
	})

	it('never throws on a value whose own serialization throws', () => {
		const circular: Record<string, unknown> = {}
		circular.self = circular

		expect(() => errorAttributes(circular)).not.toThrow()
	})
})

describe('errorAttributes — bounded cause walk', () => {
	it('stops at the documented depth on a chain deeper than the bound, and says so in the value', () => {
		const deepChain = buildCauseChain(20)

		const attrs = errorAttributes(deepChain)
		const stacktrace = String(attrs['exception.stacktrace'])

		// Says so — refuse-do-not-degrade: a silent cut is indistinguishable
		// from "that was the whole chain".
		expect(stacktrace).toContain('truncated at depth 4')
		// And actually stops there: the root cause, 20 hops down, must never
		// appear. A version that ignores `maxDepth` and walks to the end would
		// pass the marker check above (if it also happened to append one) but
		// fail this — the two assertions together are what catches "documents
		// a bound it does not enforce".
		expect(stacktrace).not.toContain('root cause')
		expect(stacktrace).toContain('layer 4')
		expect(stacktrace).not.toContain('layer 5')
	})

	it('walks the whole chain with no truncation note when it fits inside the bound', () => {
		const shortChain = buildCauseChain(3)

		const stacktrace = String(errorAttributes(shortChain)['exception.stacktrace'])

		expect(stacktrace).toContain('root cause')
		expect(stacktrace).not.toContain('truncated')
	})

	it('honours a caller-supplied causeDepth override', () => {
		const chain = buildCauseChain(20)

		const stacktrace = String(errorAttributes(chain, { causeDepth: 1 })['exception.stacktrace'])

		expect(stacktrace).toContain('truncated at depth 1')
		expect(stacktrace).not.toContain('layer 3')
	})

	it('returns instead of looping forever on a self-referencing cause', () => {
		const err = new Error('loopy')
		Object.assign(err, { cause: err })

		// The assertion is that this call returns at all — a naive walk with no
		// `seen` set fails this by timeout, not by a wrong value.
		const stacktrace = String(errorAttributes(err)['exception.stacktrace'])
		expect(stacktrace).toContain('cycle detected')
	})

	it('returns on a cycle that only closes a few hops in, not just on an immediate self-reference', () => {
		const a = new Error('a')
		const b = new Error('b', { cause: a })
		Object.assign(a, { cause: b })

		const stacktrace = String(errorAttributes(b)['exception.stacktrace'])
		expect(stacktrace).toContain('cycle detected')
	})
})

describe('the err reserved attribute — wired through createLogger', () => {
	it('logger.error(constantBody, { err }) produces exception.* attributes and leaves the body untouched', () => {
		const { sink, records } = capturingSink()
		const logger = buildLogger(sink)
		const err = new Error('the operation failed')

		logger.error('Guardrail threw — failing closed', { [ERR_ATTRIBUTE]: err })

		expect(records).toHaveLength(1)
		const record = records[0]
		expect(record?.body).toBe('Guardrail threw — failing closed')
		// Mutation: body built as `${body}: ${err.message}` would pass a loose
		// `toContain` check on the message; this pins the body to be exactly
		// the constant string, nothing appended.
		expect(record?.attributes['exception.type']).toBe('Error')
		expect(record?.attributes['exception.message']).toBe('the operation failed')
		expect(String(record?.attributes['exception.stacktrace'])).toContain('the operation failed')
	})

	it('removes the reserved err key from attributes rather than copying it alongside the mapped fields', () => {
		const { sink, records } = capturingSink()
		const logger = buildLogger(sink)

		logger.error('failed', { [ERR_ATTRIBUTE]: new Error('x'), 'namzu.test.kept': 'yes' })

		// Mutation: `{ ...attrs, ...errorAttributes(rawErr) }` without deleting
		// `err` off `attributes` first would leave a raw Error object sitting
		// in the record's attributes, which is exactly what a sink would then
		// try (and likely fail) to serialize.
		expect(ERR_ATTRIBUTE in (records[0]?.attributes ?? {})).toBe(false)
		expect(records[0]?.attributes['namzu.test.kept']).toBe('yes')
	})

	it('adds no exception.* attributes when no call site sets the reserved key', () => {
		const { sink, records } = capturingSink()
		const logger = buildLogger(sink)

		logger.info('ordinary record', { 'namzu.test.kept': 'yes' })

		const attrs = records[0]?.attributes ?? {}
		expect('exception.type' in attrs).toBe(false)
		expect('exception.message' in attrs).toBe(false)
		expect('exception.stacktrace' in attrs).toBe(false)
	})

	it("passes exception.stacktrace through the redaction pipeline even when the secret is in a NESTED cause's message", () => {
		const { sink, records } = capturingSink()
		const logger = buildLogger(sink)
		const secret = 'sk-ant-FAKE-DO-NOT-LOG-0000000000'
		const nestedCause = new Error(`vendor response echoed Bearer ${secret}`)
		const err = new Error('request failed', { cause: nestedCause })

		logger.error('Provider call failed', { [ERR_ATTRIBUTE]: err })

		const stacktrace = String(records[0]?.attributes['exception.stacktrace'])
		// The whole point: redacting only the TOP-level message would leave
		// this failing, because the secret lives one `cause` hop down.
		expect(stacktrace).toContain('[REDACTED:')
		expect(stacktrace).not.toContain(secret)
		expect(logger.counters.redacted).toBe(1)
	})
})
