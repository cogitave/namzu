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
})
