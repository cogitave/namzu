import {
	NOOP_SINK,
	createLogger,
	getLogCounters,
	getRootLogger,
	installProcessSink,
} from '@namzu/sdk'
import type { LogRecord, LogSink } from '@namzu/sdk'
import { describe, expect, it } from 'vitest'

import { DoctorRegistry } from '../../registry.js'
import { describeLogPipeline, loggingPipelineCheck } from '../logging.js'

/**
 * `LogSinkCounters` counted five things on every record and nothing read
 * any of them, while the comment over `createLogger` said `namzu doctor`
 * would. These tests are what make the counters load-bearing: each one
 * asserts an EXACT count, because "greater than zero" passes against an
 * off-by-one and against a counter that fires twice per record.
 */

const CTX = { cwd: process.cwd(), env: {}, projectRoot: null }

function capturingSink(): { sink: LogSink; records: LogRecord[] } {
	const records: LogRecord[] = []
	return { sink: { emit: (r) => records.push(r) }, records }
}

describe('the doctor reports what the log pipeline did', () => {
	it('counts exactly the records a NOOP_SINK swallowed, not merely some', () => {
		// The acceptance criterion is `=== 3`. An implementation that counted
		// per `child()` call, or that double-counted a record failing two
		// caps, passes `> 0` and fails this.
		installProcessSink(NOOP_SINK, 'debug', { replace: true })
		const log = createLogger({
			sink: NOOP_SINK,
			level: { current: 'debug' },
			resource: { 'service.name': 'namzu' },
			scope: 'test',
		})
		log.info('one')
		log.info('two')
		log.info('three')

		expect(log.counters.dropped).toBe(3)
	})

	it('reports a redaction count equal to the records a credential appeared in', () => {
		// Proves the redaction layer is LIVE rather than assumed. A pipeline
		// with the redaction pass deleted emits the same three records and
		// reports 0 here.
		const { sink, records } = capturingSink()
		const log = createLogger({
			sink,
			level: { current: 'debug' },
			resource: { 'service.name': 'namzu' },
			scope: 'test',
		})
		log.info('boot', { token: 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' })
		log.info('boot', { note: 'nothing sensitive here' })

		expect(log.counters.redacted).toBe(1)
		expect(records).toHaveLength(2)
		expect(JSON.stringify(records[0])).not.toContain('sk-ant-api03-AAAA')
	})

	it('fails — not passes, not skips — when records were dropped', () => {
		const result = describeLogPipeline({
			dropped: 2,
			redacted: 0,
			attributesDropped: 0,
			valuesTruncated: 0,
			recordsTruncated: 0,
		})

		expect(result.status).toBe('fail')
		expect(result.message).toContain('2 log record(s)')
	})

	it('passes and reports every counter by name when nothing was dropped', () => {
		// Field-by-field, so adding a sixth counter to `LogSinkCounters`
		// without reporting it is visible here rather than silently omitted.
		const result = describeLogPipeline({
			dropped: 0,
			redacted: 4,
			attributesDropped: 1,
			valuesTruncated: 2,
			recordsTruncated: 3,
		})

		expect(result.status).toBe('pass')
		for (const field of [
			'dropped=0',
			'redacted=4',
			'attributesDropped=1',
			'valuesTruncated=2',
			'recordsTruncated=3',
		]) {
			expect(result.message).toContain(field)
		}
	})

	it('is inconclusive, never passing, when no sink was installed', () => {
		// The case that must not read as health. Returning five zeros here
		// would make the row green on a process where nothing was measured —
		// and green is exactly the answer a reader would act on. That
		// `getLogCounters()` IS undefined with no sink installed is asserted
		// in the SDK, where the process-sink reset is reachable; this test
		// owns the mapping from that answer to a doctor row.
		const result = describeLogPipeline(undefined)

		expect(result.status).toBe('inconclusive')
		expect(result.status).not.toBe('pass')
		expect(result.message).toContain('no log sink installed')
	})

	it('accumulates across separate loggers once a sink owns the process', () => {
		// The reason the counters were unreadable: `getRootLogger` resolves
		// per call and used to build a logger with its own fresh counters, so
		// two log lines could never be counted together. Reverting
		// `createLogger`'s `shared` parameter fails this.
		installProcessSink(NOOP_SINK, 'debug', { replace: true })
		// Through `getRootLogger()`, which is the path that was broken: it
		// resolves per call, so these are two different logger objects.
		getRootLogger().info('a')
		getRootLogger().info('b')

		expect(getLogCounters()?.dropped).toBe(2)
	})
})

describe('the check is actually reachable', () => {
	it('runs through the registry and drives the exit status to 1 on a drop', async () => {
		// A check written but never registered reports nothing, and a check
		// that can only pass or skip cannot move the exit code off 0 — the
		// two ways this work could have been inert. Both are asserted here
		// rather than in prose.
		const registry = new DoctorRegistry()
		registry.register({
			id: loggingPipelineCheck.id,
			category: loggingPipelineCheck.category,
			run: () =>
				Promise.resolve(
					describeLogPipeline({
						dropped: 1,
						redacted: 0,
						attributesDropped: 0,
						valuesTruncated: 0,
						recordsTruncated: 0,
					}),
				),
		})

		const report = await registry.run(CTX)

		expect(report.checks.map((c) => c.id)).toContain('logging.pipeline')
		expect(report.summary.fail).toBe(1)
		expect(report.exit).toBe(1)
	})
})
