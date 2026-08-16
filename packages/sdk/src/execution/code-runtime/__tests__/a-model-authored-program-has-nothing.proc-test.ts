import { describe, expect, it } from 'vitest'

import type { HostCallResult, RunCodeOptions } from '../types.js'
import { WorkerCodeRuntime } from '../worker.js'

/**
 * A program the MODEL wrote, running with nothing.
 *
 * The program is untrusted text — not code the operator installed, but a
 * string the model produced, possibly under the influence of a web page it
 * was told to summarise. So what matters is not that it runs; it is what it
 * CANNOT do, and every one of those is a property a plausible
 * implementation gets wrong.
 *
 * Process-level: a worker thread is a real thread, and a mocked one would
 * prove only that the mock was called.
 */

const runtime = new WorkerCodeRuntime()

const run = (source: string, over: Partial<RunCodeOptions> = {}) =>
	runtime.run({
		source,
		allowedCalls: [],
		onHostCall: async (): Promise<HostCallResult> => ({ ok: true, value: null }),
		timeoutMs: 5_000,
		maxOutputBytes: 4096,
		...over,
	})

describe('the program has no ambient capability', () => {
	it('cannot require anything', async () => {
		// The parameter SHADOWS the outer name, so a program writing
		// `require` gets the parameter, and the parameter is undefined.
		const result = await run('return typeof require')

		expect(result.outcome).toEqual({ status: 'completed', result: 'undefined' })
	})

	it('cannot see the process', async () => {
		const result = await run('return typeof process')

		expect(result.outcome).toEqual({ status: 'completed', result: 'undefined' })
	})

	it('cannot fetch', async () => {
		const result = await run('return typeof fetch')

		expect(result.outcome).toEqual({ status: 'completed', result: 'undefined' })
	})

	it('is handed no environment at all', async () => {
		// A program that could read `process.env` would read whatever the
		// operator's shell holds — the credential leak `env-scrub.ts` exists
		// to prevent on the shell path, and here there is no reason to pass
		// anything.
		const result = await run('return typeof process')

		expect(result.outcome).toMatchObject({ result: 'undefined' })
	})
})

describe('everything it can do, it does by asking', () => {
	it('reaches a granted capability', async () => {
		const seen: unknown[] = []
		const result = await run('return await call("greet", { who: "world" })', {
			allowedCalls: ['greet'],
			onHostCall: async (request) => {
				seen.push(request.input)
				return { ok: true, value: 'hello world' }
			},
		})

		expect(result.outcome).toEqual({ status: 'completed', result: 'hello world' })
		expect(seen).toEqual([{ who: 'world' }])
	})

	it('is REFUSED a capability it was not granted', async () => {
		const result = await run('try { await call("secret", {}) } catch (e) { return e.message }', {
			allowedCalls: ['greet'],
		})

		expect(result.outcome).toMatchObject({ status: 'completed' })
		expect(String((result.outcome as { result: unknown }).result)).toMatch(/not granted/)
	})

	it('refuses on the HOST side, not inside the worker', async () => {
		// A check inside the worker is a check the program shares a heap
		// with. This one never reaches the handler at all.
		let handlerCalls = 0
		await run('try { await call("secret", {}) } catch {}', {
			allowedCalls: [],
			onHostCall: async () => {
				handlerCalls++
				return { ok: true }
			},
		})

		expect(handlerCalls).toBe(0)
	})

	it('names what IS available when it refuses', async () => {
		const result = await run('try { await call("secret", {}) } catch (e) { return e.message }', {
			allowedCalls: ['greet', 'lookup'],
		})

		expect(String((result.outcome as { result: unknown }).result)).toContain('greet, lookup')
	})

	it('carries a host-side failure back as a rejection', async () => {
		const result = await run(
			'try { await call("greet", {}) } catch (e) { return "caught: " + e.message }',
			{
				allowedCalls: ['greet'],
				onHostCall: async () => ({ ok: false, error: 'the tool said no' }),
			},
		)

		expect((result.outcome as { result: unknown }).result).toBe('caught: the tool said no')
	})

	it('handles two calls in flight at once', async () => {
		// A program awaiting two calls together is ordinary, and a channel
		// that could only carry one would silently serialise them.
		const result = await run(
			'const [a, b] = await Promise.all([call("a", {}), call("b", {})]); return a + b',
			{
				allowedCalls: ['a', 'b'],
				onHostCall: async (request) => ({
					ok: true,
					value: request.name === 'a' ? 1 : 2,
				}),
			},
		)

		expect(result.outcome).toEqual({ status: 'completed', result: 3 })
	})

	it('records every call it made, and whether it worked', async () => {
		const result = await run('await call("ok", {}); try { await call("nope", {}) } catch {}', {
			allowedCalls: ['ok'],
		})

		expect(result.calls).toEqual([
			{ name: 'ok', ok: true },
			{ name: 'nope', ok: false },
		])
	})
})

describe('it is bounded', () => {
	it('is stopped at the wall clock', async () => {
		// Enforced by the backend, not asked of the program. A program that
		// loops forever is the ordinary failure, not the exotic one.
		const result = await run('while (true) {}', { timeoutMs: 200 })

		expect(result.outcome).toEqual({ status: 'timed-out' })
	})

	it('is stopped by a caller’s abort', async () => {
		const controller = new AbortController()
		const running = run('await new Promise(() => {})', {
			timeoutMs: 10_000,
			signal: controller.signal,
		})
		setTimeout(() => controller.abort(), 50)

		expect(await running).toMatchObject({ outcome: { status: 'cancelled' } })
	})

	it('refuses immediately when the signal is already aborted', async () => {
		const result = await run('return 1', { signal: AbortSignal.abort() })

		expect(result.outcome).toEqual({ status: 'cancelled' })
	})

	it('reports truncated output rather than cutting it silently', async () => {
		// A program whose output was cut silently is a model reading a
		// partial answer as a whole one.
		const result = await run('for (let i = 0; i < 500; i++) print("a".repeat(50)); return 1', {
			maxOutputBytes: 200,
		})

		expect(result.outputTruncated).toBe(true)
		expect(Buffer.byteLength(result.output)).toBeLessThanOrEqual(200)
	})

	it('does not claim truncation for output that fit', async () => {
		const result = await run('print("short"); return 1', { maxOutputBytes: 200 })

		expect(result.outputTruncated).toBe(false)
		expect(result.output).toBe('short')
	})

	it('carries what a program printed before it failed', async () => {
		const result = await run('print("got here"); throw new Error("then broke")')

		expect(result.outcome).toMatchObject({ status: 'failed', error: 'then broke' })
		expect(result.output).toBe('got here')
	})
})

describe('a program that throws is a failure, not a crash', () => {
	it('reports the message', async () => {
		const result = await run('throw new Error("nope")')

		expect(result.outcome).toEqual({ status: 'failed', error: 'nope' })
	})

	it('reports a syntax error rather than hanging', async () => {
		const result = await run('this is not javascript')

		expect(result.outcome).toMatchObject({ status: 'failed' })
	})

	it('returns a value the caller can use', async () => {
		const result = await run('return { rows: [1, 2, 3] }')

		expect(result.outcome).toEqual({ status: 'completed', result: { rows: [1, 2, 3] } })
	})
})
