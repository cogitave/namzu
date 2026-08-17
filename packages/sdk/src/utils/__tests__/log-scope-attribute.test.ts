import { describe, expect, it } from 'vitest'
import { createLogger } from '../log/index.js'
import type { LogRecord, LogSink } from '../log/index.js'
import { SCOPE_ATTRIBUTE } from '../log/types.js'

function capturingSink(): { sink: LogSink; records: LogRecord[] } {
	const records: LogRecord[] = []
	return { sink: { emit: (record) => records.push(record) }, records }
}

describe('SCOPE_ATTRIBUTE — the OTel-shaped pipeline (create-logger.ts)', () => {
	it('rebinds scope.name on a child, and does not leave the reserved key in attributes', () => {
		const { sink, records } = capturingSink()
		const logger = createLogger({
			sink,
			level: { current: 'info' },
			resource: { 'service.name': 'test' },
			scope: 'root',
		})

		const child = logger.child({ [SCOPE_ATTRIBUTE]: 'manager/connector' })
		child.info('hello')

		expect(records).toHaveLength(1)
		expect(records[0]?.scope.name).toBe('manager/connector')
		// Mutation: a `{ ...bound, [SCOPE_ATTRIBUTE]: value }` implementation
		// that COPIES the key into `bound` instead of consuming it into
		// `options.scope` would leave it behind here, spelled twice.
		expect(SCOPE_ATTRIBUTE in (records[0]?.attributes ?? {})).toBe(false)
	})

	it('is inherited by a grandchild that does not set it again — scope is stamped once, not per call', () => {
		const { sink, records } = capturingSink()
		const logger = createLogger({
			sink,
			level: { current: 'info' },
			resource: { 'service.name': 'test' },
			scope: 'root',
		})

		const grandchild = logger.child({ [SCOPE_ATTRIBUTE]: 'registry' }).child({ extra: 'kept' })
		grandchild.info('hello')

		expect(records[0]?.scope.name).toBe('registry')
		expect(records[0]?.attributes.extra).toBe('kept')
	})

	it('leaves a plain, un-namespaced `component` binding fully inert — it is an ordinary attribute now', () => {
		const { sink, records } = capturingSink()
		const logger = createLogger({
			sink,
			level: { current: 'info' },
			resource: { 'service.name': 'test' },
			scope: 'root',
		})

		const child = logger.child({ component: 'x' })
		child.info('hello')

		expect(records[0]?.scope.name).toBe('root')
		expect(records[0]?.attributes.component).toBe('x')
	})

	it('rebinds on a second child() call, not only on the first', () => {
		// Ported from the removed `getRootLogger()` half of this file, where a
		// recursive backend hardcoded its scope on every re-entry. The grandchild
		// case above binds the scope once and then something else; this one binds
		// it TWICE, which is what distinguishes "consumed into options.scope" from
		// "consumed the first time and then inherited".
		const { sink, records } = capturingSink()
		const logger = createLogger({
			sink,
			level: { current: 'info' },
			resource: { 'service.name': 'test' },
			scope: 'root',
		})

		logger
			.child({ [SCOPE_ATTRIBUTE]: 'vault' })
			.child({ [SCOPE_ATTRIBUTE]: 'connector/mcp' })
			.info('hello')

		expect(records[0]?.scope.name).toBe('connector/mcp')
	})
})
