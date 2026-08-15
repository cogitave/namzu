import { afterEach, describe, expect, it, vi } from 'vitest'
import { createLogger } from '../log/index.js'
import type { LogRecord, LogSink } from '../log/index.js'
import { __resetProcessSinkForTests, installProcessSink } from '../log/process-sink.js'
import { SCOPE_ATTRIBUTE } from '../log/types.js'
import { configureLogger, getRootLogger } from '../logger.js'

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
})

describe('SCOPE_ATTRIBUTE — the legacy Logger backends (utils/logger.ts)', () => {
	afterEach(() => {
		__resetProcessSinkForTests()
		vi.restoreAllMocks()
	})

	it('rebinds scope.name through getRootLogger() once a process sink is installed — the fromSink regression', () => {
		const { sink, records } = capturingSink()
		installProcessSink(sink, 'debug', { replace: true })

		// Before the fix: fromSink's recursive child() call hardcoded
		// scope: 'namzu' on every call, so this assertion would read 'namzu'
		// no matter what SCOPE_ATTRIBUTE this child() bound.
		const child = getRootLogger().child({ [SCOPE_ATTRIBUTE]: 'manager/connector' })
		child.info('hello')

		expect(records).toHaveLength(1)
		expect(records[0]?.scope.name).toBe('manager/connector')
	})

	it('threads scope through a second child() call on the process-sink path, not just the first', () => {
		const { sink, records } = capturingSink()
		installProcessSink(sink, 'debug', { replace: true })

		const grandchild = getRootLogger()
			.child({ [SCOPE_ATTRIBUTE]: 'vault' })
			.child({ [SCOPE_ATTRIBUTE]: 'connector/mcp' })
		grandchild.info('hello')

		expect(records[0]?.scope.name).toBe('connector/mcp')
	})

	it('renames the console bracket prefix through the stderr fallback when no process sink is installed', () => {
		// `test-setup.ts` silences the root logger for the whole suite, so this
		// test has to raise its own floor or it measures the silencing rather
		// than the prefix. Restored in the `finally` below: leaving the level
		// up would make every later test in this process noisy, and worse,
		// would make an assertion about silence pass or fail by test ORDER.
		const writeSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
		configureLogger({ level: 'info' })

		const child = getRootLogger().child({ [SCOPE_ATTRIBUTE]: 'registry' })
		child.info('hello')

		expect(writeSpy).toHaveBeenCalledTimes(1)
		const line = String(writeSpy.mock.calls[0]?.[0])
		expect(line).toContain('[registry]')
		expect(line).not.toContain('[namzu]')
		configureLogger({ level: 'silent' })
	})
})
