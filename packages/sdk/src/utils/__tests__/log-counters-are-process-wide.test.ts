import { afterEach, describe, expect, it } from 'vitest'

import { createLogger } from '../log/create-logger.js'
import { __resetProcessSinkForTests, installProcessSink } from '../log/process-sink.js'
import { NOOP_SINK } from '../log/sinks.js'
import type { LogRecord, LogSink } from '../log/types.js'
import { getLogCounters, getRootLogger } from '../logger.js'

/**
 * The counters counted, and the count was thrown away.
 *
 * `LogSinkCounters` has five fields, incremented on every record since the
 * sink seam landed, and the comment over `createLogger` said a caller that
 * wants to observe the pipeline — "a test, `namzu doctor` later" — reads
 * `.counters` off the returned logger. Nothing could: `getRootLogger()`
 * resolves PER CALL by design (so a logger handed out before
 * `installProcessSink` ran cannot keep writing to stderr forever), and each
 * resolution built a logger with its own fresh counter set. Two log lines
 * in the same process were never counted together, so every total was
 * either 0 or 1 and no reader could learn anything from it —
 * `declared-but-undriven` with a falsifiable comment sitting on top of it.
 *
 * `installProcessSink` now owns one counter set for the process and hands
 * it to every logger routed through it.
 */

function capture(): { sink: LogSink; records: LogRecord[] } {
	const records: LogRecord[] = []
	return { sink: { emit: (r) => records.push(r) }, records }
}

afterEach(() => {
	__resetProcessSinkForTests()
})

describe('the log counters describe the process, not one expression', () => {
	it('is undefined when nobody installed a sink', () => {
		// Not a zeroed set. With no sink the legacy stderr writer runs, which
		// has no redaction pass and no caps, so five zeros would assert that
		// nothing was dropped or redacted on a process where neither was ever
		// measured. Returning `{ dropped: 0, ... }` here fails this.
		expect(getLogCounters()).toBeUndefined()
	})

	it('accumulates across separate getRootLogger() resolutions', () => {
		// The defect, stated directly. Dropping `createLogger`'s `shared`
		// parameter — so `fromSink` mints its own counters again — leaves
		// this at 1.
		installProcessSink(NOOP_SINK, 'debug')

		getRootLogger().info('one')
		getRootLogger().info('two')
		getRootLogger().info('three')

		expect(getLogCounters()?.dropped).toBe(3)
	})

	it("counts a child logger's records into the same totals as its parent", () => {
		installProcessSink(NOOP_SINK, 'debug')

		const root = getRootLogger()
		root.info('parent')
		root.child({ 'namzu.run.id': 'run_1' }).info('child')

		expect(getLogCounters()?.dropped).toBe(2)
	})

	it('starts a replacement destination at zero rather than carrying totals forward', () => {
		// The counts describe the destination that is live. Attributing the
		// previous sink's drops to a sink that never saw those records would
		// send an operator to inspect the wrong one.
		installProcessSink(NOOP_SINK, 'debug')
		getRootLogger().info('lost to the noop sink')
		expect(getLogCounters()?.dropped).toBe(1)

		const { sink, records } = capture()
		installProcessSink(sink, 'debug', { replace: true })

		expect(getLogCounters()?.dropped).toBe(0)
		getRootLogger().info('reaches the new sink')
		expect(getLogCounters()?.dropped).toBe(0)
		expect(records).toHaveLength(1)
	})

	it('leaves a logger built without a shared set counting only its own', () => {
		// `shared` is optional, and the standalone case must stay standalone:
		// a host that builds its own logger for one subsystem is not writing
		// into the process totals unless it asked to.
		installProcessSink(NOOP_SINK, 'debug')
		getRootLogger().info('process')

		const standalone = createLogger({
			sink: NOOP_SINK,
			level: { current: 'debug' },
			resource: { 'service.name': 'namzu' },
			scope: 'standalone',
		})
		standalone.info('mine')
		standalone.info('also mine')

		expect(standalone.counters.dropped).toBe(2)
		expect(getLogCounters()?.dropped).toBe(1)
	})
})
