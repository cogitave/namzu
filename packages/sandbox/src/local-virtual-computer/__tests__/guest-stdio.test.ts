import { spawn } from 'node:child_process'
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SandboxStdioChannel } from '@namzu/sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { localComputerClients } from '../client.js'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
	vi.unstubAllEnvs()
	vi.unstubAllGlobals()
})

async function fixture({ controlledHeartbeat = false } = {}) {
	let receivedHeartbeats = 0
	const heartbeatWaiters = new Map<number, () => void>()
	if (controlledHeartbeat) {
		const actualFetch = fetch
		vi.stubGlobal('fetch', async (...args: Parameters<typeof fetch>) => {
			const response = await actualFetch(...args)
			if (!response.body || new URL(String(args[0])).pathname !== '/execute') return response
			const decoder = new TextDecoder()
			let pending = ''
			return new Response(
				response.body.pipeThrough(
					new TransformStream<Uint8Array, Uint8Array>({
						transform(bytes, controller) {
							pending += decoder.decode(bytes, { stream: true })
							let newline = pending.indexOf('\n')
							while (newline >= 0) {
								const frame = JSON.parse(pending.slice(0, newline))
								pending = pending.slice(newline + 1)
								if (frame.type === 'stdio_heartbeat') {
									expect(frame).toEqual({ type: 'stdio_heartbeat', version: 1 })
									heartbeatWaiters.get(++receivedHeartbeats)?.()
									heartbeatWaiters.delete(receivedHeartbeats)
								}
								newline = pending.indexOf('\n')
							}
							controller.enqueue(bytes)
						},
					}),
				),
				{ status: response.status, headers: response.headers },
			)
		})
	}
	const root = await mkdtemp(join(tmpdir(), 'namzu-owned-stdio-'))
	const program = join(root, 'worker.cjs')
	await copyFile(new URL('../../../worker/server.js', import.meta.url), program)
	if (controlledHeartbeat) {
		// Control only the worker's heartbeat clock; HTTP, subprocess and strict
		// cancellation I/O remain real. Each tick is acknowledged by the worker,
		// so this integration never races an inactivity deadline or wall clock.
		await writeFile(
			program,
			`const originalSetInterval = global.setInterval;
const originalClearInterval = global.clearInterval;
let heartbeatTimer;
global.setInterval = (callback, delay, ...args) => {
  if (delay !== 30000) return originalSetInterval(callback, delay, ...args);
  heartbeatTimer = { callback: () => callback(...args), unref() {} };
  return heartbeatTimer;
};
global.clearInterval = (timer) => {
  if (timer && timer === heartbeatTimer) heartbeatTimer = undefined;
  else originalClearInterval(timer);
};
process.on('message', message => {
  if (message.type !== 'tick_heartbeat') return;
  heartbeatTimer?.callback();
  process.send({ type: 'heartbeat_tick_done', id: message.id, active: !!heartbeatTimer });
});
${await readFile(program, 'utf8')}`,
		)
	}
	const child = spawn(process.execPath, [program], {
		cwd: root,
		env: {
			PATH: process.env.PATH,
			HOME: root,
			NAMZU_SANDBOX_TOKEN: 'fixture-allocation-token',
			NAMZU_SANDBOX_PORT: '0',
			NAMZU_SANDBOX_BIND: '127.0.0.1',
			NAMZU_SANDBOX_WORKSPACE: root,
			NAMZU_SANDBOX_IDLE_TIMEOUT_MS: '0',
			NAMZU_SANDBOX_CANCEL_GRACE_MS: '20',
		},
		stdio: ['ignore', 'pipe', 'pipe', ...(controlledHeartbeat ? (['ipc'] as const) : [])],
	})
	let heartbeatTick = 0
	const advanceHeartbeat = async () => {
		const expectedReceipt = receivedHeartbeats + 1
		const active = await new Promise<boolean>((resolve, reject) => {
			if (!controlledHeartbeat) return reject(new Error('Worker heartbeat clock is not controlled'))
			const id = ++heartbeatTick
			const onMessage = (message: { type?: string; id?: number; active?: boolean }) => {
				if (message.type !== 'heartbeat_tick_done' || message.id !== id) return
				child.off('message', onMessage)
				resolve(message.active === true)
			}
			child.on('message', onMessage)
			child.send({ type: 'tick_heartbeat', id }, (error) => {
				if (error) {
					child.off('message', onMessage)
					reject(error)
				}
			})
		})
		if (active && receivedHeartbeats < expectedReceipt)
			await new Promise<void>((resolve) => {
				heartbeatWaiters.set(expectedReceipt, resolve)
			})
		return active
	}
	const ended = new Promise<void>((resolve) => child.once('close', () => resolve()))
	const { stdout, stderr } = child
	if (!stdout || !stderr) throw new Error('Worker output pipes are missing')
	stderr.resume()
	const port = await new Promise<number>((resolve, reject) => {
		let logs = ''
		stdout.on('data', (bytes) => {
			logs += bytes.toString()
			const match = logs.match(/listening on 127\.0\.0\.1:(\d+)/)
			if (match) resolve(Number(match[1]))
		})
		child.once('error', reject)
		child.once('close', () => reject(new Error('Worker stopped before listening')))
	})
	const channels: SandboxStdioChannel[] = []
	const clients = localComputerClients({
		executionUrl: `http://127.0.0.1:${port}`,
		desktopUrl: `http://127.0.0.1:${port}`,
		token: 'fixture-allocation-token',
		geometry: { width: 1280, height: 800, scaleFactor: 1 },
		async stop() {
			for (const channel of channels) await channel.close().catch(() => {})
			child.kill('SIGKILL')
			await ended
		},
	})
	const open = async (...args: Parameters<NonNullable<typeof clients.sandbox.openStdio>>) => {
		const channel = await clients.sandbox.openStdio!(...args)
		channels.push(channel)
		return channel
	}
	cleanups.push(async () => {
		await clients.sandbox.destroy()
		await rm(root, { recursive: true, force: true })
	})
	return { clients, open, root, port, advanceHeartbeat }
}

const echoProgram = 'process.stdin.on("data", b => process.stdout.write(b))'

function simulatedWorker(
	options: {
		unsupported?: boolean
		writeLost?: boolean
		stopUnconfirmed?: boolean
		frames?: readonly Record<string, unknown>[]
	} = {},
) {
	let rejectStop = options.stopUnconfirmed === true
	let executes = 0
	let cancels = 0
	vi.stubGlobal(
		'fetch',
		vi.fn(async (input: string, init?: RequestInit) => {
			init?.signal?.throwIfAborted()
			const route = new URL(input).pathname
			if (route === '/executions/reserve')
				return Response.json({
					ok: true,
					executionId: 'exec_00000000-0000-4000-8000-000000000001',
					...(!options.unsupported ? { stdio: { version: 1, maxLifetimeMs: 1_800_000 } } : {}),
				})
			if (route === '/execute') {
				executes += 1
				return new Response(
					new ReadableStream({
						start(controller) {
							controller.enqueue(new TextEncoder().encode('{"type":"stdio_started","version":1}\n'))
							for (const frame of options.frames ?? [])
								controller.enqueue(new TextEncoder().encode(`${JSON.stringify(frame)}\n`))
							init?.signal?.addEventListener(
								'abort',
								() => controller.error(new Error('Stream cancelled')),
								{ once: true },
							)
						},
					}),
				)
			}
			if (route === '/executions/write' && options.writeLost)
				throw new Error('Lost stdin acknowledgement')
			if (route === '/cancel') {
				cancels += 1
				return rejectStop
					? Response.json({}, { status: 504 })
					: Response.json({ ok: true, state: 'cancelled' })
			}
			throw new Error('Unexpected fixture request')
		}),
	)
	const clients = localComputerClients({
		executionUrl: 'http://127.0.0.1:1',
		desktopUrl: 'http://127.0.0.1:1',
		token: 'fixture-token',
		geometry: { width: 1280, height: 800, scaleFactor: 1 },
		async stop() {},
	})
	cleanups.push(() => clients.sandbox.destroy())
	return {
		clients,
		executes: () => executes,
		cancels: () => cancels,
		allowStop: () => {
			rejectStop = false
		},
	}
}

describe('interactive stdio admission and uncertain delivery', () => {
	it('discards bounded transport heartbeats without exposing them as application bytes', async () => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
		try {
			const worker = simulatedWorker({
				frames: [
					{ type: 'stdio_heartbeat', version: 1 },
					{ type: 'stdio_heartbeat', version: 1 },
					{ type: 'stdio_data', stream: 'stdout', data: Buffer.from('reply').toString('base64') },
					{ type: 'result', exitCode: 0 },
				],
			})
			const channel = await worker.clients.sandbox.openStdio!('guest-only')
			const events: unknown[] = []
			for await (const event of channel.events) events.push(event)
			await channel.closed
			expect(vi.getTimerCount()).toBe(0)
			expect(events).toEqual([{ stream: 'stdout', data: Buffer.from('reply') }])
			expect(worker.clients.sandbox.status).toBe('ready')
			await worker.clients.operatorControl.takeOver()
			expect(worker.cancels()).toBe(0)
		} finally {
			vi.useRealTimers()
		}
	})
	it.each([
		{ type: 'stdio_heartbeat', version: 2 },
		{ type: 'stdio_heartbeat', version: '1' },
		{ type: 'stdio_heartbeat', version: 1, data: 'not-an-application-reply' },
		{ type: 'stdio_heartbeat', version: 1, extra: 'x'.repeat(1024) },
	])('rejects malformed or extended heartbeat frames: %j', async (frame) => {
		const worker = simulatedWorker({ frames: [frame] })
		const channel = await worker.clients.sandbox.openStdio!('guest-only')
		await expect(channel.closed).rejects.toThrow('Invalid guest stdio heartbeat')
		expect(worker.cancels()).toBe(1)
		expect(worker.clients.sandbox.status).toBe('ready')
	})
	it('declines older workers before process dispatch and cancels only the inert reservation', async () => {
		const worker = simulatedWorker({ unsupported: true })
		await expect(worker.clients.sandbox.openStdio!('guest-only')).rejects.toThrow('rebuild')
		expect(worker.executes()).toBe(0)
		expect(worker.cancels()).toBe(1)
		expect(worker.clients.sandbox.status).toBe('ready')
	})
	it('does not replay lost stdin delivery or release uncertainty after a termination retry', async () => {
		const worker = simulatedWorker({ writeLost: true, stopUnconfirmed: true })
		const channel = await worker.clients.sandbox.openStdio!('guest-only')
		const operation = await channel.beginOperation()
		await expect(channel.write('mutable-call')).rejects.toThrow('Lost stdin')
		operation.complete()
		await expect(channel.close()).rejects.toThrow('504')
		await expect(worker.clients.operatorControl.takeOver()).rejects.toThrow('outcome is unknown')
		expect(worker.executes()).toBe(1)
		worker.allowStop()
		await channel.close()
		await channel.closed
		expect(worker.clients.sandbox.status).toBe('busy')
		await expect(worker.clients.sandbox.openStdio!('must-not-run')).rejects.toThrow(
			'outcome is unknown',
		)
		expect(worker.executes()).toBe(1)
	})
})

// Real subprocess/loopback integration; await actual protocol events, never a
// timing sentinel. Vitest owns the legitimate process/I/O timeout.
describe.skipIf(process.platform !== 'linux')('allocation-owned interactive stdio', () => {
	it('keeps quiet services live without settling requests and stops heartbeats on confirmed close', async () => {
		const { clients, open, root, advanceHeartbeat } = await fixture({ controlledHeartbeat: true })
		const channel = await open(process.execPath, ['-e', echoProgram], { cwd: root })
		const iterator = channel.events[Symbol.asyncIterator]()
		expect(await advanceHeartbeat()).toBe(true)
		expect(clients.sandbox.status).toBe('ready')
		await clients.operatorControl.takeOver()
		expect(await advanceHeartbeat()).toBe(true)
		await expect(channel.write('forbidden')).rejects.toThrow('operator')
		await clients.operatorControl.returnControl()
		const operation = await channel.beginOperation()
		expect(await advanceHeartbeat()).toBe(true)
		expect(clients.sandbox.status).toBe('busy')
		await expect(clients.operatorControl.takeOver()).rejects.toThrow('work')
		await channel.write('exact-reply')
		await expect(iterator.next()).resolves.toMatchObject({
			done: false,
			value: { stream: 'stdout', data: Buffer.from('exact-reply') },
		})
		operation.complete()
		await channel.close()
		await channel.closed
		expect(await advanceHeartbeat()).toBe(false)
		await expect(iterator.next()).resolves.toMatchObject({ done: true })
	}, 15_000)
	it('preserves bytes and guest-only environment without holding idle control', async () => {
		vi.stubEnv('NAMZU_TEST_HOST_SECRET', 'must-not-inherit')
		const { clients, open, root } = await fixture()
		const channel = await open(process.execPath, ['-e', echoProgram], { cwd: root })
		const iterator = channel.events[Symbol.asyncIterator]()
		expect(clients.sandbox.status).toBe('ready')
		await clients.operatorControl.takeOver()
		await expect(channel.beginOperation()).rejects.toThrow('operator')
		await expect(channel.write('forbidden')).rejects.toThrow('operator')
		await clients.operatorControl.returnControl()
		const operation = await channel.beginOperation()
		expect(clients.sandbox.status).toBe('busy')
		await expect(clients.operatorControl.takeOver()).rejects.toThrow('work')
		const bytes = Uint8Array.from([0, 255, 226, 130, 172, 10])
		await channel.write(bytes)
		const next = await iterator.next()
		expect(next.done).toBe(false)
		expect(next.value).toEqual({ stream: 'stdout', data: Buffer.from(bytes) })
		operation.complete()
		expect(clients.sandbox.status).toBe('ready')
		await channel.close()
		await channel.closed
		await expect(iterator.next()).resolves.toMatchObject({ done: true })
		const env = await open(
			process.execPath,
			[
				'-e',
				'console.log(JSON.stringify({guest:process.env.GUEST_VALUE,host:process.env.NAMZU_TEST_HOST_SECRET,token:process.env.NAMZU_SANDBOX_TOKEN}))',
			],
			{ cwd: root, env: { GUEST_VALUE: 'only-guest' } },
		)
		let output = ''
		for await (const event of env.events) output += Buffer.from(event.data).toString()
		await env.closed
		expect(JSON.parse(output)).toEqual({ guest: 'only-guest' })
		expect(clients.sandbox.status).toBe('ready')
	}, 15_000)
	it('keeps unknown application outcomes fenced after server exit and late completion', async () => {
		const { clients, open, root } = await fixture()
		const channel = await open(process.execPath, ['-e', echoProgram], { cwd: root })
		const operation = await channel.beginOperation()
		operation.outcomeUnknown()
		operation.complete()
		await channel.close()
		await channel.closed
		expect(clients.sandbox.status).toBe('busy')
		await expect(clients.operatorControl.takeOver()).rejects.toThrow('outcome is unknown')
		await expect(clients.sandbox.exec('must-not-run')).rejects.toThrow('outcome is unknown')
		await clients.sandbox.destroy()
		expect(clients.sandbox.status).toBe('destroyed')
		await expect(clients.sandbox.openStdio!('must-not-run')).rejects.toThrow('lease has ended')
	}, 15_000)
	it('rechecks writer authority and retains the control reservation during asynchronous checks', async () => {
		const { clients, open, root } = await fixture()
		let allowed = true
		const wait: { current?: Promise<void> } = {}
		const channel = await open(process.execPath, ['-e', echoProgram], {
			cwd: root,
			async assertExecutionAllowed() {
				await wait.current
				if (!allowed) throw new Error('writer retired')
			},
		})
		await expect(channel.beginOperation(AbortSignal.abort(new Error('pre-abort')))).rejects.toThrow(
			'pre-abort',
		)
		expect(clients.sandbox.status).toBe('ready')
		allowed = false
		await expect(channel.write('forbidden')).rejects.toThrow('writer retired')
		expect(clients.sandbox.status).toBe('ready')
		allowed = true
		let release!: () => void
		wait.current = new Promise<void>((resolve) => {
			release = resolve
		})
		const acquiring = channel.beginOperation()
		await expect(clients.operatorControl.takeOver()).rejects.toThrow('work')
		release()
		const operation = await acquiring
		operation.complete()
		await channel.close()
	}, 15_000)
	it('confirms TERM-ignoring server and descendant group termination', async () => {
		const { open, root } = await fixture()
		const descendant = 'process.on("SIGTERM",()=>{});process.send("READY");setInterval(()=>{},1000)'
		const script = `const {spawn}=require('node:child_process');process.on('SIGTERM',()=>{});const c=spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:['ignore','ignore','ignore','ipc']});c.once('message',()=>{require('node:fs').writeFileSync('pids.json',JSON.stringify([process.pid,c.pid]));console.log('READY')});setInterval(()=>{},1000)`
		const channel = await open(process.execPath, ['-e', script], { cwd: root })
		const iterator = channel.events[Symbol.asyncIterator]()
		await iterator.next()
		const pids = JSON.parse(await readFile(join(root, 'pids.json'), 'utf8')) as number[]
		await channel.close()
		await channel.closed
		for (const pid of pids) {
			try {
				process.kill(pid, 0)
				throw new Error('Guest process survived confirmed close')
			} catch (error) {
				expect(error).toMatchObject({ code: 'ESRCH' })
			}
		}
	}, 15_000)
	it('requires authenticated capability before accepting interactive input', async () => {
		const { port } = await fixture()
		const response = await fetch(`http://127.0.0.1:${port}/executions/write`, {
			method: 'POST',
			body: JSON.stringify({ executionId: 'invalid', data: '' }),
		})
		expect(response.status).toBe(401)
	}, 15_000)
})
