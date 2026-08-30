import { afterEach, describe, expect, it, vi } from 'vitest'

import { HttpWorkerClient, execViaHttpWorker } from './http-worker-client.js'

const EXECUTION_ID = 'exec_00000000-0000-4000-8000-000000000001'

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'content-type': 'application/json' },
	})
}

function ndjson(lines: readonly unknown[]): Response {
	return new Response(`${lines.map((line) => JSON.stringify(line)).join('\n')}\n`, {
		status: 200,
		headers: { 'content-type': 'application/x-ndjson' },
	})
}

function reservation(): Response {
	return json(
		{
			ok: true,
			protocolVersion: 2,
			executionId: EXECUTION_ID,
			leaseExpiresAt: Date.now() + 30_000,
		},
		201,
	)
}

function cancelled(started: boolean): Response {
	return json({
		ok: true,
		state: 'cancelled',
		started,
		result: {
			exitCode: 1,
			timedOut: false,
			durationMs: 20,
			...(started ? { signal: 'SIGTERM' } : {}),
			stdoutTruncated: false,
			stderrTruncated: false,
		},
	})
}

afterEach(() => {
	vi.restoreAllMocks()
	vi.unstubAllGlobals()
})

describe('the shared HTTP worker execution client', () => {
	it('reserves every command before admission, including commands without a caller signal', async () => {
		const output: Array<{ stream: string; data: string }> = []
		const fetch_ = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
			const url = String(input)
			if (url.endsWith('/executions/reserve')) return reservation()
			if (!url.endsWith('/execute')) throw new Error(`unexpected URL ${url}`)
			return ndjson([
				{ type: 'stdout_delta', data: 'hello' },
				{ type: 'stderr_delta', data: 'warn' },
				{
					type: 'result',
					exitCode: 0,
					timedOut: false,
					durationMs: 12,
					stdoutTruncated: true,
					stderrTruncated: false,
				},
			])
		})
		vi.stubGlobal('fetch', fetch_)

		const result = await execViaHttpWorker('http://worker', 'echo', ['hello'], {
			onOutput: (chunk) => output.push(chunk),
		})

		expect(fetch_).toHaveBeenCalledTimes(2)
		expect(fetch_.mock.calls.map((call) => String(call[0]))).toEqual([
			'http://worker/executions/reserve',
			'http://worker/execute',
		])
		expect(JSON.parse(String(fetch_.mock.calls[1]?.[1]?.body))).toMatchObject({
			executionId: EXECUTION_ID,
		})
		expect(result).toMatchObject({
			exitCode: 0,
			stdout: 'hello',
			stderr: 'warn',
			durationMs: 12,
			stdoutTruncated: true,
			stderrTruncated: false,
		})
		expect(output).toEqual([
			{ stream: 'stdout', data: 'hello' },
			{ stream: 'stderr', data: 'warn' },
		])
	})

	it('falls back only after an explicit old-worker response and caches that peer capability', async () => {
		const paths: string[] = []
		const fetch_ = vi.fn(async (input: string | URL | Request) => {
			const url = String(input)
			paths.push(url)
			if (url.endsWith('/executions/reserve')) return json({ error: 'not_found' }, 404)
			if (url.endsWith('/execute')) {
				return ndjson([{ type: 'result', exitCode: 0, timedOut: false, durationMs: 1 }])
			}
			throw new Error(`unexpected URL ${url}`)
		})
		vi.stubGlobal('fetch', fetch_)
		const client = new HttpWorkerClient('http://old-worker')

		await expect(client.exec('true', [], undefined)).resolves.toMatchObject({ exitCode: 0 })
		await expect(client.exec('true', [], undefined)).resolves.toMatchObject({ exitCode: 0 })

		expect(paths).toEqual([
			'http://old-worker/executions/reserve',
			'http://old-worker/execute',
			'http://old-worker/execute',
		])
	})

	it('admits nothing for an already-aborted caller', async () => {
		const fetch_ = vi.fn()
		vi.stubGlobal('fetch', fetch_)
		const caller = new AbortController()
		caller.abort(new Error('stopped before admission'))

		const result = await execViaHttpWorker('http://worker', 'dangerous', [], {
			signal: caller.signal,
		})

		expect(fetch_).not.toHaveBeenCalled()
		expect(result).toMatchObject({ exitCode: 1, timedOut: false })
		expect(result).not.toHaveProperty('signal')
	})

	it('refuses an old worker instead of claiming cancellation works', async () => {
		const fetch_ = vi.fn(async (_input: string | URL | Request) =>
			json({ error: 'not_found' }, 404),
		)
		vi.stubGlobal('fetch', fetch_)

		await expect(
			execViaHttpWorker('http://old-worker', 'sleep', ['30'], {
				signal: new AbortController().signal,
			}),
		).rejects.toThrow(/rebuild the worker image or standby-pool profile/i)
		expect(fetch_).toHaveBeenCalledTimes(1)
		expect(String(fetch_.mock.calls[0]?.[0])).toContain('/executions/reserve')
	})

	it('drains the terminal tail after cancellation acknowledgement', async () => {
		let releaseTail: (() => void) | undefined
		let executionStarted: (() => void) | undefined
		let executeSignal: AbortSignal | undefined
		const started = new Promise<void>((resolve) => {
			executionStarted = resolve
		})
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode('{"type":"stdout_delta","data":"before"}\n'))
				releaseTail = () => {
					controller.enqueue(
						new TextEncoder().encode(
							'{"type":"stdout_delta","data":"-after"}\n' +
								'{"type":"result","exitCode":-1,"timedOut":false,"durationMs":25,"signal":"SIGTERM","stdoutTruncated":true,"stderrTruncated":false}\n',
						),
					)
					controller.close()
				}
			},
		})
		const paths: string[] = []
		const fetch_ = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const url = String(input)
			paths.push(url)
			if (url.endsWith('/executions/reserve')) return reservation()
			if (url.endsWith('/execute')) {
				executeSignal = init?.signal ?? undefined
				executionStarted?.()
				return new Response(stream, { status: 200 })
			}
			if (url.endsWith('/cancel')) {
				setTimeout(() => releaseTail?.(), 30)
				return cancelled(true)
			}
			throw new Error(`unexpected URL ${url}`)
		})
		vi.stubGlobal('fetch', fetch_)
		const caller = new AbortController()
		const running = execViaHttpWorker('http://worker', 'hold', [], {
			signal: caller.signal,
		})
		await started
		caller.abort(new Error('operator stopped'))

		const result = await running
		expect(executeSignal).not.toBe(caller.signal)
		expect(executeSignal?.aborted).toBe(true)
		expect(result).toMatchObject({
			stdout: 'before-after',
			signal: 'SIGTERM',
			stdoutTruncated: true,
			stderrTruncated: false,
		})
		expect(paths).toEqual([
			'http://worker/executions/reserve',
			'http://worker/execute',
			'http://worker/cancel',
		])
	})

	it('returns a cancelled result when cancellation wins before worker admission', async () => {
		let executionStarted: (() => void) | undefined
		const started = new Promise<void>((resolve) => {
			executionStarted = resolve
		})
		const fetch_ = vi.fn(async (input: string | URL | Request) => {
			const url = String(input)
			if (url.endsWith('/executions/reserve')) return reservation()
			if (url.endsWith('/execute')) {
				executionStarted?.()
				return json({ error: 'execution_cancelled' }, 409)
			}
			if (url.endsWith('/cancel')) return cancelled(false)
			throw new Error(`unexpected URL ${url}`)
		})
		vi.stubGlobal('fetch', fetch_)
		const caller = new AbortController()
		const running = execViaHttpWorker('http://worker', 'hold', [], {
			signal: caller.signal,
		})
		await started
		caller.abort(new Error('operator stopped'))

		const result = await running
		expect(result).toMatchObject({
			exitCode: 1,
			timedOut: false,
		})
		expect(result).not.toHaveProperty('signal')
	})

	it.each([
		['malformed event', 'not-json\n', undefined],
		[
			'malformed terminal metadata',
			'{"type":"result","exitCode":0,"timedOut":false,"durationMs":1,"signal":7}\n',
			undefined,
		],
		[
			'multiple terminal events',
			'{"type":"result","exitCode":0,"timedOut":false,"durationMs":1}\n' +
				'{"type":"result","exitCode":0,"timedOut":false,"durationMs":1}\n',
			undefined,
		],
		[
			'output callback failure',
			'{"type":"stdout_delta","data":"chunk"}\n',
			() => {
				throw new Error('consumer failed')
			},
		],
	])('cancels after a post-reservation %s', async (_label, body, onOutput) => {
		const paths: string[] = []
		const fetch_ = vi.fn(async (input: string | URL | Request) => {
			const url = String(input)
			paths.push(url)
			if (url.endsWith('/executions/reserve')) return reservation()
			if (url.endsWith('/execute')) return new Response(body, { status: 200 })
			if (url.endsWith('/cancel')) return cancelled(true)
			throw new Error(`unexpected URL ${url}`)
		})
		vi.stubGlobal('fetch', fetch_)

		await expect(
			execViaHttpWorker('http://worker', 'hold', [], {
				signal: new AbortController().signal,
				...(onOutput ? { onOutput } : {}),
			}),
		).rejects.toThrow(/termination was confirmed.*stream was incomplete/i)
		expect(paths.at(-1)).toBe('http://worker/cancel')
	})

	it('retries cancellation after a lost acknowledgement', async () => {
		let cancelCalls = 0
		let executionStarted: (() => void) | undefined
		let finishExecution: (() => void) | undefined
		const started = new Promise<void>((resolve) => {
			executionStarted = resolve
		})
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				finishExecution = () => {
					controller.enqueue(
						new TextEncoder().encode(
							'{"type":"result","exitCode":-1,"timedOut":false,"durationMs":15,"signal":"SIGTERM"}\n',
						),
					)
					controller.close()
				}
			},
		})
		const fetch_ = vi.fn(async (input: string | URL | Request) => {
			const url = String(input)
			if (url.endsWith('/executions/reserve')) return reservation()
			if (url.endsWith('/execute')) {
				executionStarted?.()
				return new Response(stream, { status: 200 })
			}
			if (url.endsWith('/cancel')) {
				cancelCalls += 1
				if (cancelCalls === 1) throw new Error('response was lost')
				finishExecution?.()
				return cancelled(true)
			}
			throw new Error(`unexpected URL ${url}`)
		})
		vi.stubGlobal('fetch', fetch_)
		const caller = new AbortController()
		const running = execViaHttpWorker('http://worker', 'hold', [], {
			signal: caller.signal,
		})
		await started
		caller.abort()

		await expect(running).resolves.toMatchObject({ signal: 'SIGTERM' })
		expect(cancelCalls).toBe(2)
	})

	it('retries a malformed cancellation result instead of returning invalid SDK metadata', async () => {
		let cancelCalls = 0
		let executionStarted: (() => void) | undefined
		const started = new Promise<void>((resolve) => {
			executionStarted = resolve
		})
		const fetch_ = vi.fn(async (input: string | URL | Request) => {
			const url = String(input)
			if (url.endsWith('/executions/reserve')) return reservation()
			if (url.endsWith('/execute')) {
				executionStarted?.()
				return await new Promise<Response>(() => undefined)
			}
			if (url.endsWith('/cancel')) {
				cancelCalls += 1
				if (cancelCalls === 1) {
					return json({ ok: true, state: 'cancelled', started: false, result: {} })
				}
				return cancelled(false)
			}
			throw new Error(`unexpected URL ${url}`)
		})
		vi.stubGlobal('fetch', fetch_)
		const caller = new AbortController()
		const running = execViaHttpWorker('http://worker', 'hold', [], { signal: caller.signal })
		await started
		caller.abort()

		await expect(running).resolves.toMatchObject({ exitCode: 1, timedOut: false })
		expect(cancelCalls).toBe(2)
	})

	it('distinguishes confirmed termination from an incomplete result drain', async () => {
		let executionStarted: (() => void) | undefined
		const started = new Promise<void>((resolve) => {
			executionStarted = resolve
		})
		const fetch_ = vi.fn(async (input: string | URL | Request) => {
			const url = String(input)
			if (url.endsWith('/executions/reserve')) return reservation()
			if (url.endsWith('/execute')) {
				executionStarted?.()
				return new Response(new ReadableStream<Uint8Array>(), { status: 200 })
			}
			if (url.endsWith('/cancel')) return cancelled(true)
			throw new Error(`unexpected URL ${url}`)
		})
		vi.stubGlobal('fetch', fetch_)
		const caller = new AbortController()
		const running = execViaHttpWorker('http://worker', 'hold', [], { signal: caller.signal })
		await started
		caller.abort(new Error('operator stopped'))

		try {
			await running
			expect.unreachable('the incomplete terminal stream must be refused')
		} catch (error) {
			expect(error).toBeInstanceOf(Error)
			expect((error as Error).message).toMatch(/termination was confirmed.*stream was incomplete/i)
			expect(error).toMatchObject({
				acknowledgement: { state: 'cancelled', started: true },
			})
		}
	}, 3_000)

	it('requires exactly one terminal result and cancels an unexpected EOF', async () => {
		let cancelCalls = 0
		const fetch_ = vi.fn(async (input: string | URL | Request) => {
			const url = String(input)
			if (url.endsWith('/executions/reserve')) return reservation()
			if (url.endsWith('/execute')) {
				return ndjson([{ type: 'stdout_delta', data: 'partial' }])
			}
			if (url.endsWith('/cancel')) {
				cancelCalls += 1
				return cancelled(true)
			}
			throw new Error(`unexpected URL ${url}`)
		})
		vi.stubGlobal('fetch', fetch_)

		await expect(
			execViaHttpWorker('http://worker', 'hold', [], {
				signal: new AbortController().signal,
			}),
		).rejects.toThrow(/termination was confirmed.*stream was incomplete/i)
		expect(cancelCalls).toBe(1)
	})

	it('bounds a blackholed execute observation and reconciles through cancellation', async () => {
		const paths: string[] = []
		let executeSignal: AbortSignal | undefined
		const fetch_ = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const url = String(input)
			paths.push(url)
			if (url.endsWith('/executions/reserve')) return reservation()
			if (url.endsWith('/execute')) {
				executeSignal = init?.signal ?? undefined
				return await new Promise<Response>(() => undefined)
			}
			if (url.endsWith('/cancel')) return cancelled(false)
			throw new Error(`unexpected URL ${url}`)
		})
		vi.stubGlobal('fetch', fetch_)

		const startedAt = Date.now()
		const observed = execViaHttpWorker('http://worker', 'hold', [], {
			signal: new AbortController().signal,
			timeout: 10,
		}).then(
			(result) => ({ settled: true as const, result }),
			(error) => ({ settled: true as const, error }),
		)
		let settleTimer: ReturnType<typeof setTimeout> | undefined
		const outcome = await Promise.race([
			observed,
			new Promise<{ settled: false }>((resolve) => {
				settleTimer = setTimeout(() => resolve({ settled: false }), 1_200)
			}),
		])
		if (settleTimer) clearTimeout(settleTimer)

		expect(Date.now() - startedAt).toBeLessThan(2_000)
		expect(outcome).toMatchObject({ settled: true })
		if (!outcome.settled || !('result' in outcome))
			throw new Error('execution did not settle safely')
		expect(paths).toEqual([
			'http://worker/executions/reserve',
			'http://worker/execute',
			'http://worker/cancel',
		])
		expect(executeSignal?.aborted).toBe(true)
		expect(outcome.result).toMatchObject({ exitCode: 1, timedOut: true })
		expect(outcome.result).not.toHaveProperty('signal')
	}, 3_000)
})
