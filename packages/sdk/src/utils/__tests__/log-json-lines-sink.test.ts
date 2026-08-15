import { describe, expect, it } from 'vitest'
import { createLogger, jsonLinesSink } from '../log/index.js'

describe('jsonLinesSink', () => {
	it('escapes U+2028 and U+2029 so the record survives as a single NDJSON line', () => {
		const chunks: string[] = []
		const stream = {
			write: (chunk: string) => {
				chunks.push(String(chunk))
				return true
			},
		} as unknown as NodeJS.WritableStream

		const logger = createLogger({
			sink: jsonLinesSink(stream),
			level: { current: 'info' },
			resource: { 'service.name': 'test' },
			scope: 'test',
		})

		const lineSeparator = String.fromCharCode(0x2028)
		const paragraphSeparator = String.fromCharCode(0x2029)
		const planted = `a${lineSeparator}b${paragraphSeparator}c`

		logger.info('line separator test', { 'namzu.test.value': planted })

		expect(chunks).toHaveLength(1)
		const written = chunks[0] ?? ''

		expect(written).not.toContain(lineSeparator)
		expect(written).not.toContain(paragraphSeparator)
		expect(written.trim().split('\n')).toHaveLength(1)

		const parsed = JSON.parse(written)
		expect(parsed.attributes['namzu.test.value']).toBe(planted)
	})
})
