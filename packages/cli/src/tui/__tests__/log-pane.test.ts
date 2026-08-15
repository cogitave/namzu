import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { getRootLogger } from '@namzu/sdk'

import { installTuiLogSink } from '../log-pane.js'

let stderr: string
let originalWrite: typeof process.stderr.write

beforeEach(() => {
	stderr = ''
	originalWrite = process.stderr.write.bind(process.stderr)
	process.stderr.write = ((chunk: string | Uint8Array): boolean => {
		stderr += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
		return true
	}) as typeof process.stderr.write
})

afterEach(() => {
	process.stderr.write = originalWrite
})

describe('installTuiLogSink', () => {
	it('buffers instead of writing: nothing reaches stderr until flushed', () => {
		const flush = installTuiLogSink({ level: 'debug', format: 'json' })
		getRootLogger().debug('buffered, not written')
		expect(stderr).toBe('')
		flush()
		expect(stderr).toContain('buffered, not written')
	})

	it('flush is idempotent: a second call does not re-emit the drained records', () => {
		const flush = installTuiLogSink({ level: 'debug', format: 'json' })
		getRootLogger().info('one record')
		flush()
		const afterFirst = stderr
		flush()
		expect(stderr).toBe(afterFirst)
	})

	it('respects the resolved level: a warn floor drops a debug record before it ever reaches the buffer', () => {
		const flush = installTuiLogSink({ level: 'warn', format: 'json' })
		getRootLogger().debug('dropped')
		getRootLogger().warn('kept')
		flush()
		expect(stderr).not.toContain('dropped')
		expect(stderr).toContain('kept')
	})

	it('a simulated crash flushes the buffer to stderr and exits EXIT_INTERNAL_ERROR (70)', () => {
		const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)
		installTuiLogSink({ level: 'debug', format: 'json' })
		getRootLogger().error('about to crash')
		process.emit('uncaughtException', new Error('boom'))
		expect(stderr).toContain('about to crash')
		expect(stderr).toContain('boom')
		expect(exit).toHaveBeenCalledWith(70)
		exit.mockRestore()
	})

	it('falls back to a flagless/envless resolution when logging is omitted (a TuiContext built by hand)', () => {
		const previous = process.env.NAMZU_LOG_LEVEL
		process.env.NAMZU_LOG_LEVEL = 'debug'
		try {
			const flush = installTuiLogSink(undefined)
			getRootLogger().debug('reached via env fallback')
			flush()
			expect(stderr).toContain('reached via env fallback')
		} finally {
			if (previous === undefined) delete process.env.NAMZU_LOG_LEVEL
			else process.env.NAMZU_LOG_LEVEL = previous
		}
	})
})
