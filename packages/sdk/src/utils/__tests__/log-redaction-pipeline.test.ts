import { describe, expect, it } from 'vitest'
import { createLogger, jsonLinesSink, prettySink } from '../log/index.js'
import type { LogRecord, LogSink } from '../log/index.js'

const PLANTED_KEY = 'AKIAIOSFODNN7EXAMPLE'

function capturingSink(): { sink: LogSink; records: LogRecord[] } {
	const records: LogRecord[] = []
	return { sink: { emit: (record) => records.push(record) }, records }
}

function collectingStream(): { stream: NodeJS.WritableStream; text: () => string } {
	const chunks: string[] = []
	const stream = {
		write: (chunk: string) => {
			chunks.push(String(chunk))
			return true
		},
	} as unknown as NodeJS.WritableStream
	return { stream, text: () => chunks.join('') }
}

describe('the redaction scan runs in the pipeline, ahead of every sink', () => {
	it('redacts the same planted key whether the sink is jsonLinesSink, prettySink, or a bare custom sink', () => {
		const jsonOut = collectingStream()
		const prettyOut = collectingStream()
		const custom = capturingSink()

		const options = {
			level: { current: 'info' as const },
			resource: { 'service.name': 'test' },
			scope: 'test',
		}

		const jsonLogger = createLogger({ ...options, sink: jsonLinesSink(jsonOut.stream) })
		const prettyLogger = createLogger({ ...options, sink: prettySink(prettyOut.stream) })
		const customLogger = createLogger({ ...options, sink: custom.sink })

		for (const logger of [jsonLogger, prettyLogger, customLogger]) {
			logger.info('leaked a key', { 'namzu.test.value': PLANTED_KEY })
		}

		expect(jsonOut.text()).toContain('[REDACTED:aws-access-key]')
		expect(jsonOut.text()).not.toContain(PLANTED_KEY)

		expect(prettyOut.text()).toContain('[REDACTED:aws-access-key]')
		expect(prettyOut.text()).not.toContain(PLANTED_KEY)

		expect(custom.records[0]?.attributes['namzu.test.value']).toBe('[REDACTED:aws-access-key]')
		expect(customLogger.counters.redacted).toBe(1)
	})

	it('leaves an unmatched value and its counter untouched', () => {
		const custom = capturingSink()
		const logger = createLogger({
			sink: custom.sink,
			level: { current: 'info' },
			resource: { 'service.name': 'test' },
			scope: 'test',
		})

		logger.info('nothing secret here', { 'namzu.test.value': 'an ordinary sentence' })

		expect(custom.records[0]?.attributes['namzu.test.value']).toBe('an ordinary sentence')
		expect(logger.counters.redacted).toBe(0)
	})
})
