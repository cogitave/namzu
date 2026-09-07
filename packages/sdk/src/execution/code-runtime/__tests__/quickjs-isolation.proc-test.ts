import { describe, expect, it } from 'vitest'

import type { RunCodeOptions } from '../types.js'
import { WorkerCodeRuntime, type WorkerCodeRuntimeOptions } from '../worker.js'

function run(
	source: string,
	limits: WorkerCodeRuntimeOptions = {},
	options: Partial<RunCodeOptions> = {},
) {
	return new WorkerCodeRuntime(limits).run({
		source,
		allowedCalls: ['value'],
		onHostCall: async () => ({ ok: true, value: { rows: [{ n: 2 }, { n: 7 }] } }),
		timeoutMs: 2_000,
		maxOutputBytes: 128,
		...options,
	})
}

describe('QuickJS contains every guest constructor', () => {
	it.each([
		'return ({}).constructor.constructor("return typeof process")()',
		'return call.constructor("return typeof process")()',
		'return print.constructor("return typeof require")()',
		'return await (async () => {}).constructor("return typeof fetch")()',
		'return Function("return typeof globalThis.process")()',
	])('keeps the constructor path inside the interpreter: %s', async (source) => {
		expect((await run(source)).outcome).toEqual({ status: 'completed', result: 'undefined' })
	})

	it('refuses dynamic loading of a Node capability', async () => {
		const result = await run(
			'try { await import("node:fs"); return "loaded"; } catch { return "refused"; }',
		)
		expect(result.outcome).toEqual({ status: 'completed', result: 'refused' })
		expect(result.calls).toEqual([])
	})

	it('starts a fresh interpreter for each program', async () => {
		const runtime = new WorkerCodeRuntime()
		const options = {
			allowedCalls: [],
			onHostCall: async () => ({ ok: true }),
			timeoutMs: 2_000,
			maxOutputBytes: 0,
		}
		await runtime.run({ ...options, source: 'globalThis.leftOver = 17' })
		expect((await runtime.run({ ...options, source: 'return typeof leftOver' })).outcome).toEqual({
			status: 'completed',
			result: 'undefined',
		})
	})
})

describe('the promise bridge carries only bounded data', () => {
	it('filters structured host results and supports repeated awaits', async () => {
		const result = await run(
			'const a = await call("value", {}); const b = await call("value", {}); return a.rows.filter(row => row.n > 3).map(row => row.n + b.rows[0].n)',
		)
		expect(result.outcome).toEqual({ status: 'completed', result: [9] })
		expect(result.calls).toHaveLength(2)
	})

	it('keeps serialization intrinsics outside guest replacements', async () => {
		const result = await run(
			'JSON.parse = () => "corrupted"; JSON.stringify = () => "corrupted"; return (await call("value", { requested: true })).rows[0].n',
		)
		expect(result.outcome).toEqual({ status: 'completed', result: 2 })
	})

	it('preserves top-level undefined on both sides', async () => {
		const result = await run(
			'return await call("value")',
			{},
			{
				onHostCall: async (request) => {
					expect(request.input).toBeUndefined()
					return { ok: true, value: undefined }
				},
			},
		)
		expect(result.outcome).toEqual({ status: 'completed', result: undefined })
	})

	it.each([
		'return 1n',
		'return () => 1',
		'return new Map()',
		'return new Date()',
		'const cycle = {}; cycle.self = cycle; return cycle',
	])('fails clearly for a value that cannot cross JSON: %s', async (source) => {
		expect((await run(source)).outcome).toMatchObject({
			status: 'failed',
			error: expect.stringContaining('JSON-safe'),
		})
	})

	it('rejects a huge guest input before dispatch', async () => {
		let dispatched = false
		const result = await run(
			'await call("value", { text: "x".repeat(100) })',
			{ maxValueBytes: 32 },
			{
				onHostCall: async () => {
					dispatched = true
					return { ok: true }
				},
			},
		)
		expect(dispatched).toBe(false)
		expect(result.outcome).toMatchObject({ status: 'failed' })
	})

	it('rejects a huge host result before copying it into the worker', async () => {
		const result = await run(
			'return await call("value", {})',
			{ maxValueBytes: 32 },
			{ onHostCall: async () => ({ ok: true, value: 'x'.repeat(100) }) },
		)
		expect(result.outcome).toMatchObject({ status: 'failed' })
		expect(result.calls).toEqual([{ name: 'value', ok: false }])
	})

	it('enforces result bytes rather than UTF-16 character count', async () => {
		expect((await run('return "😀"', { maxValueBytes: 8 })).outcome).toEqual({
			status: 'completed',
			result: '😀',
		})
		expect((await run('return "😀😀"', { maxValueBytes: 8 })).outcome).toMatchObject({
			status: 'failed',
		})
	})
})

describe('admission and output budgets hold inside the worker', () => {
	it('rejects source before creating an interpreter', async () => {
		expect((await run('return 12', { maxSourceBytes: 8 })).outcome).toMatchObject({
			status: 'failed',
			error: expect.stringContaining('source'),
		})
	})

	it('admits no host effect past the call budget', async () => {
		let admitted = 0
		const result = await run(
			'for (let i = 0; i < 3; i++) { try { await call("value", {}) } catch {} } return 1',
			{ maxHostCalls: 2 },
			{
				onHostCall: async () => {
					admitted++
					return { ok: true }
				},
			},
		)
		expect(result.outcome).toEqual({ status: 'completed', result: 1 })
		expect(admitted).toBe(2)
		expect(result.calls).toHaveLength(2)
	})

	it('bounds concurrent host calls before creating host work', async () => {
		let admitted = 0
		const result = await run(
			'const results = await Promise.allSettled([call("value", {}), call("value", {})]); return results.map(result => result.status)',
			{ maxPendingHostCalls: 1 },
			{
				onHostCall: async () => {
					admitted++
					return { ok: true }
				},
			},
		)
		expect(result.outcome).toEqual({ status: 'completed', result: ['fulfilled', 'rejected'] })
		expect(admitted).toBe(1)
	})

	it('counts UTF-8 prints and their separators in the same budget', async () => {
		const result = await run('print("😀"); print("é"); print("x")', {}, { maxOutputBytes: 8 })
		expect(result.output).toBe('😀\né')
		expect(Buffer.byteLength(result.output)).toBe(7)
		expect(result.outputTruncated).toBe(true)
	})

	it('bounds empty-print flooding and preserves blank lines', async () => {
		const result = await run('for (let i = 0; i < 100_000; i++) print()', {}, { maxOutputBytes: 3 })
		expect(result.output).toBe('\n\n\n')
		expect(result.outputTruncated).toBe(true)
	})

	it('accepts zero as a print-disabled budget', async () => {
		const result = await run('print("hidden"); return 1', {}, { maxOutputBytes: 0 })
		expect(result.output).toBe('')
		expect(result.outputTruncated).toBe(true)
		expect(result.outcome).toEqual({ status: 'completed', result: 1 })
	})

	it('contains bulk allocation exhaustion and can start another interpreter afterward', async () => {
		const limited = await run(
			'const chunks = []; while (true) chunks.push(new Uint8Array(1024 * 1024))',
			{ memoryLimitBytes: 16 * 1024 * 1024 },
		)
		expect(limited.outcome).toMatchObject({ status: 'failed' })
		expect((await run('return 42')).outcome).toEqual({ status: 'completed', result: 42 })
	})
})
