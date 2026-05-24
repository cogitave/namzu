import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createFormatter, isFormatName } from './index.js'

describe('formatter factory', () => {
	let stdout: string
	let stderr: string
	let originalStdoutWrite: typeof process.stdout.write
	let originalStderrWrite: typeof process.stderr.write

	beforeEach(() => {
		stdout = ''
		stderr = ''
		originalStdoutWrite = process.stdout.write.bind(process.stdout)
		originalStderrWrite = process.stderr.write.bind(process.stderr)
		process.stdout.write = ((chunk: string | Uint8Array): boolean => {
			stdout += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
			return true
		}) as typeof process.stdout.write
		process.stderr.write = ((chunk: string | Uint8Array): boolean => {
			stderr += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
			return true
		}) as typeof process.stderr.write
	})

	afterEach(() => {
		process.stdout.write = originalStdoutWrite
		process.stderr.write = originalStderrWrite
	})

	it('isFormatName narrows known names', () => {
		expect(isFormatName('text')).toBe(true)
		expect(isFormatName('json')).toBe(true)
		expect(isFormatName('yaml')).toBe(true)
		expect(isFormatName('xml')).toBe(false)
	})

	it('json formatter emits parseable JSON to stdout', () => {
		const f = createFormatter('json', { quiet: false })
		f.print({ hello: 'world', n: 1 })
		const parsed = JSON.parse(stdout) as Record<string, unknown>
		expect(parsed.hello).toBe('world')
		expect(parsed.n).toBe(1)
	})

	it('yaml formatter emits yaml to stdout', () => {
		const f = createFormatter('yaml', { quiet: false })
		f.print({ hello: 'world' })
		expect(stdout).toContain('hello: world')
	})

	it('text formatter passes strings through verbatim', () => {
		const f = createFormatter('text', { quiet: false })
		f.print('hello')
		expect(stdout).toBe('hello\n')
	})

	it('info is suppressed in quiet mode for every format', () => {
		for (const name of ['text', 'json', 'yaml'] as const) {
			stdout = ''
			stderr = ''
			const f = createFormatter(name, { quiet: true })
			f.info('this should not appear')
			expect(stderr).toBe('')
		}
	})

	it('errors are never suppressed by quiet mode', () => {
		for (const name of ['text', 'json', 'yaml'] as const) {
			stdout = ''
			stderr = ''
			const f = createFormatter(name, { quiet: true })
			f.error({ message: 'boom' })
			expect(stderr).toContain('boom')
		}
	})

	it('json formatter does not crash on circular references', () => {
		const f = createFormatter('json', { quiet: false })
		const obj: Record<string, unknown> = { a: 1 }
		obj.self = obj
		f.print(obj)
		expect(stdout).toContain('"a": 1')
		expect(stdout).toContain('[Circular]')
	})

	it('text formatter does not blow the stack on circular references', () => {
		const f = createFormatter('text', { quiet: false })
		const obj: Record<string, unknown> = { a: 1 }
		obj.self = obj
		f.print(obj)
		expect(stdout).toContain('Circular')
	})

	it('json formatter serializes bigint via toString instead of throwing', () => {
		const f = createFormatter('json', { quiet: false })
		f.print({ big: 12345678901234567890n })
		expect(stdout).toContain('12345678901234567890')
	})
})
