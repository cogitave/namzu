import { afterEach, describe, expect, it } from 'vitest'

import { createLogger } from '../log/create-logger.js'
import {
	__resetProcessSinkForTests,
	getProcessSink,
	getProcessSinkCounters,
	installProcessSink,
} from '../log/process-sink.js'
import { NOOP_SINK } from '../log/sinks.js'
import type { LogRecord, LogSink } from '../log/types.js'
import { getLogCounters } from '../logger.js'

/**
 * The counters counted, and the count was thrown away.
 *
 * `LogSinkCounters` has five fields, incremented on every record since the
 * sink seam landed, and the comment over `createLogger` said a caller that
 * wants to observe the pipeline — "a test, `namzu doctor` later" — reads
 * `.counters` off the returned logger. Nothing could: the process-wide
 * `getRootLogger()` resolved PER CALL by design, and each resolution built a
 * logger with its own fresh counter set. Two log lines in the same process
 * were never counted together, so every total was either 0 or 1 and no reader
 * could learn anything from it — `declared-but-undriven` with a falsifiable
 * comment sitting on top of it.
 *
 * `installProcessSink` owns one counter set for the process and every logger
 * built over it counts into that one set.
 *
 * **LOG-20 removed the global, and the property outlived it.** `getRootLogger`
 * is gone; a host now builds its own logger and passes the process's counters
 * in. That makes the sharing EXPLICIT rather than automatic, which is exactly
 * why it still needs a test — the argument is droppable at every call site,
 * and dropping it is silent. `hostLogger()` below is `installCliLogging`
 * (`packages/cli/src/logging.ts`) reduced to the two lines under test; the
 * production one is what `namzu doctor`'s `logging.pipeline` check reads
 * through.
 */

function capture(): { sink: LogSink; records: LogRecord[] } {
	const records: LogRecord[] = []
	return { sink: { emit: (r) => records.push(r) }, records }
}

/**
 * What a host does after `installProcessSink`: build a logger on the sink
 * that was installed, counting into the set the process owns.
 *
 * Resolved fresh from `getProcessSink()` on each call rather than captured,
 * because a host that installs a REPLACEMENT destination rebuilds its logger
 * too — see the replacement test below, which is about the counters starting
 * over and would be untestable if this helper kept writing to the dead sink.
 */
function hostLogger(scope = 'host') {
	const installed = getProcessSink()
	if (!installed) throw new Error('no process sink installed')
	return createLogger(
		{
			sink: installed.sink,
			level: { current: 'debug' },
			resource: { 'service.name': 'namzu' },
			scope,
		},
		getProcessSinkCounters(),
	)
}

afterEach(() => {
	__resetProcessSinkForTests()
})

describe('the log counters describe the process, not one expression', () => {
	it('is undefined when nobody installed a sink', () => {
		// Not a zeroed set. With no sink there is no pipeline at all, so five
		// zeros would assert that nothing was dropped or redacted on a process
		// where neither was ever measured. Returning `{ dropped: 0, ... }`
		// here fails this.
		expect(getLogCounters()).toBeUndefined()
	})

	it('accumulates across separately-built loggers', () => {
		// The defect, stated directly. Dropping `createLogger`'s `shared`
		// parameter — so each logger mints its own counters again — leaves
		// this at 1.
		installProcessSink(NOOP_SINK, 'debug')

		hostLogger().info('one')
		hostLogger().info('two')
		hostLogger().info('three')

		expect(getLogCounters()?.dropped).toBe(3)
	})

	it("counts a child logger's records into the same totals as its parent", () => {
		installProcessSink(NOOP_SINK, 'debug')

		const root = hostLogger()
		root.info('parent')
		root.child({ 'namzu.run.id': 'run_1' }).info('child')

		expect(getLogCounters()?.dropped).toBe(2)
	})

	it('starts a replacement destination at zero rather than carrying totals forward', () => {
		// The counts describe the destination that is live. Attributing the
		// previous sink's drops to a sink that never saw those records would
		// send an operator to inspect the wrong one.
		installProcessSink(NOOP_SINK, 'debug')
		hostLogger().info('lost to the noop sink')
		expect(getLogCounters()?.dropped).toBe(1)

		const { sink, records } = capture()
		installProcessSink(sink, 'debug', { replace: true })

		expect(getLogCounters()?.dropped).toBe(0)
		hostLogger().info('reaches the new sink')
		expect(getLogCounters()?.dropped).toBe(0)
		expect(records).toHaveLength(1)
	})

	it('leaves a logger built without a shared set counting only its own', () => {
		// `shared` is optional, and the standalone case must stay standalone:
		// a host that builds its own logger for one subsystem is not writing
		// into the process totals unless it asked to.
		installProcessSink(NOOP_SINK, 'debug')
		hostLogger().info('process')

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
