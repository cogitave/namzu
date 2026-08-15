import { describe, expect, it } from 'vitest'
import { createLogger, prettySink } from '../log/index.js'

describe('prettySink', () => {
	it('renders ANSI escape sequences and raw control bytes as inert text, in both body and scope', () => {
		const chunks: string[] = []
		const stream = {
			write: (chunk: string) => {
				chunks.push(String(chunk))
				return true
			},
		} as unknown as NodeJS.WritableStream

		const esc = String.fromCharCode(0x1b)
		const eraseLineAndReturn = `${esc}[2K\r`

		const logger = createLogger({
			sink: prettySink(stream),
			level: { current: 'info' },
			resource: { 'service.name': 'test' },
			scope: `scope${esc}[31mred`,
		})

		logger.info(`line one${eraseLineAndReturn}FAKE: refused`)

		const written = chunks.join('')

		expect(written).not.toContain(esc)
		expect(written).toContain('scope\\x1b[31mred')
	})

	it('renders ANSI escapes and DEL as inert text in an ATTRIBUTE value too — not only body/scope', () => {
		// LOG-11 moves untrusted text OUT of body and INTO an attribute at the
		// two live CWE-117 sites. If escaping stayed scoped to body/scope the
		// way it originally shipped, that move would have walked the attacker
		// straight past this sink's only defence — the payload would reach the
		// terminal raw, just one field over from where it used to be.
		const chunks: string[] = []
		const stream = {
			write: (chunk: string) => {
				chunks.push(String(chunk))
				return true
			},
		} as unknown as NodeJS.WritableStream

		const esc = String.fromCharCode(0x1b)
		const del = String.fromCharCode(0x7f)
		const payload = `${esc}[2K\rFAKE: refused${del}`

		const logger = createLogger({
			sink: prettySink(stream),
			level: { current: 'info' },
			resource: { 'service.name': 'test' },
			scope: 'test',
		})

		logger.info('connected', { 'namzu.test.value': payload })

		const written = chunks.join('')

		expect(written).not.toContain(esc)
		expect(written).not.toContain(del)
		expect(written).toContain('\\u001b[2K\\rFAKE: refused\\x7f')
	})

	it('escapes U+2028 and U+2029 in an attribute value so the record survives as a single line', () => {
		const chunks: string[] = []
		const stream = {
			write: (chunk: string) => {
				chunks.push(String(chunk))
				return true
			},
		} as unknown as NodeJS.WritableStream

		const logger = createLogger({
			sink: prettySink(stream),
			level: { current: 'info' },
			resource: { 'service.name': 'test' },
			scope: 'test',
		})

		const lineSeparator = String.fromCharCode(0x2028)
		const paragraphSeparator = String.fromCharCode(0x2029)
		const planted = `a${lineSeparator}b${paragraphSeparator}c`

		logger.info('line separator test', { 'namzu.test.value': planted })

		const written = chunks.join('')
		expect(written).not.toContain(lineSeparator)
		expect(written).not.toContain(paragraphSeparator)
		expect(written.trim().split('\n')).toHaveLength(1)
	})
})
