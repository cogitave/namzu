/**
 * Stage E2: input an administrator window drops, a cancelled turn, and a
 * locked computer. Every wait here is on a promise or a fake clock.
 */
import { describe, expect, it, vi } from 'vitest'
import { SubprocessComputerUseHost } from '../SubprocessComputerUseHost.js'
import { CuaDriverAdapter } from '../adapters/cua-driver/adapter.js'
import { McpStdioClient } from '../adapters/cua-driver/client.js'
import { ComputerUseLockedError, LOCKED_TEXT } from '../errors.js'
import { BurstInterrupted } from '../foreground/types.js'
import { CallAbortedError } from '../util/call-scope.js'
import {
	type FakeServerScript,
	type ToolCall,
	fakeSpawner,
	pngHeader,
	toolResult,
} from './fake-mcp-process.js'
import { FakeMonitor, baseState, makeLadder } from './foreground-fakes.js'

const run = async <T>(
	ladder: ReturnType<typeof makeLadder>['ladder'],
	sendsInput: boolean,
	fn: () => Promise<T> = async () => undefined as T,
) => ladder.run({ subject: { app: 'editor', pid: 42 }, sendsInput }, fn)

describe('input the system did not register', () => {
	it('says a burst that sent input was dropped when the last-input tick did not move, and names the administrator window', async () => {
		const monitor = new FakeMonitor()
		monitor.endExtra = { inputMoved: false, frontElevated: true }
		const { ladder } = makeLadder({ monitor })
		const outcome = await run(ladder, true)
		expect(outcome).toMatchObject({
			kind: 'ran',
			inputLanded: false,
			inputDroppedWhy: 'An administrator window is in front; Namzu cannot type into it.',
		})
	})

	it('gives a plain reason when nothing elevated explains the dropped input', async () => {
		const monitor = new FakeMonitor()
		monitor.endExtra = { inputMoved: false, frontElevated: false }
		const outcome = await run(makeLadder({ monitor }).ladder, true)
		expect(outcome).toMatchObject({ inputLanded: false })
		expect((outcome as { inputDroppedWhy: string }).inputDroppedWhy).toMatch(/dropped the input/)
	})

	it('does not judge a burst that sent no input, or one the system registered', async () => {
		const monitor = new FakeMonitor()
		monitor.endExtra = { inputMoved: false }
		expect(await run(makeLadder({ monitor }).ladder, false)).not.toHaveProperty('inputLanded')
		const moved = new FakeMonitor()
		moved.endExtra = { inputMoved: true }
		expect(await run(makeLadder({ monitor: moved }).ladder, true)).toMatchObject({
			inputLanded: true,
		})
	})

	it('stops a burst at its next step when an administrator window comes to the front, because the hooks cannot see a person there', async () => {
		const monitor = new FakeMonitor()
		const { ladder } = makeLadder({ monitor })
		let asked = 0
		monitor.state_ = () =>
			++asked > 2
				? {
						...baseState,
						foreground: {
							hwnd: '0x9',
							pid: 9,
							exe: 'tool.exe',
							elevated: true,
						},
					}
				: baseState
		const failure = await ladder
			.run({ subject: { app: 'editor' } }, async (burst) => {
				await burst.checkpoint()
				return 'sent'
			})
			.catch((error: unknown) => error)
		expect(failure).toBeInstanceOf(BurstInterrupted)
		expect((failure as BurstInterrupted).reason).toBe('administrator_window')
	})
})

describe('a window input dropped by Windows, end to end', () => {
	it('reports not_delivered and safe, even though the driver believed it sent', async () => {
		const made = makeLadder()
		made.monitor.endExtra = { inputMoved: false, frontElevated: true }
		const spawner = fakeSpawner(windowScript(() => toolResult({ effect: 'unverifiable' })))
		const adapter = newAdapter(spawner, made.ladder)
		const shot = await adapter.captureWindow('0x111')
		const result = await adapter.executeWindow(shot.captureId, {
			type: 'type_text',
			text: 'hi',
			delivery_mode: 'foreground',
		})
		expect(result).toMatchObject({
			delivery: 'not_delivered',
			retrySafety: 'safe',
		})
		expect(result?.detail).toMatch(/administrator window is in front; Namzu cannot type into it/)
		await adapter.dispose()
	})
})

describe('lock state', () => {
	const stateWith = (patch: Partial<typeof baseState>) => {
		const monitor = new FakeMonitor()
		monitor.state_ = () => ({ ...baseState, ...patch })
		return makeLadder({ monitor }).ladder
	}

	it('is locked on a desktop that is not the normal one, or with the lock screen in front', async () => {
		expect(await stateWith({ desktop: 'Winlogon' }).lockState()).toBe('locked')
		expect(
			await stateWith({
				foreground: {
					hwnd: '0x1',
					pid: 1,
					exe: 'LockApp.exe',
					elevated: false,
				},
			}).lockState(),
		).toBe('locked')
	})

	it('is unlocked on the normal desktop, and null when unsure', async () => {
		expect(await stateWith({}).lockState()).toBe('unlocked')
		expect(await stateWith({ desktop: '(unreadable)' }).lockState()).toBeNull()
		const monitor = new FakeMonitor()
		monitor.startError = new Error('no hooks')
		expect(await makeLadder({ monitor }).ladder.lockState()).toBeNull()
	})
})

describe('a locked computer', () => {
	const lockedHost = () => {
		const monitor = new FakeMonitor()
		monitor.state_ = () => ({ ...baseState, desktop: 'Winlogon' })
		const spawner = fakeSpawner(windowScript(() => toolResult({ effect: 'unverifiable' })))
		const { ladder } = makeLadder({ monitor })
		const adapter = newAdapter(spawner, ladder)
		const host = new SubprocessComputerUseHost({
			adapter,
			foreground: { ladder },
		})
		return { host, adapter, spawner }
	}

	it('refuses to observe, and nothing reaches the driver', async () => {
		const { host, spawner } = lockedHost()
		await expect(host.captureWindow('0x111')).rejects.toBeInstanceOf(ComputerUseLockedError)
		await expect(host.listWindows()).rejects.toThrow(/computer is locked/)
		await expect(host.execute({ type: 'screenshot' })).rejects.toThrow(/computer is locked/)
		expect(spawner.processes.flatMap((p) => p.toolCalls).map((c) => c.name)).not.toContain(
			'list_windows',
		)
		await host.dispose()
	})

	it('answers an action as not delivered and safe to repeat', async () => {
		const { host } = lockedHost()
		const result = await host.execute({ type: 'type_text', text: 'x' })
		expect(result).toMatchObject({
			type: 'ok',
			delivery: 'not_delivered',
			retrySafety: 'safe',
		})
		expect((result as { detail?: string }).detail).toBe(LOCKED_TEXT)
		await host.dispose()
	})

	it('drops a capture that was taken while the screen locked', async () => {
		const monitor = new FakeMonitor()
		let looks = 0
		monitor.state_ = () => ({
			...baseState,
			desktop: ++looks > 1 ? 'Winlogon' : 'Default',
		})
		const spawner = fakeSpawner(windowScript(() => toolResult({})))
		const { ladder } = makeLadder({ monitor })
		const adapter = newAdapter(spawner, ladder)
		const host = new SubprocessComputerUseHost({
			adapter,
			foreground: { ladder },
		})
		await expect(host.captureWindow('0x111')).rejects.toBeInstanceOf(ComputerUseLockedError)
		await host.dispose()
	})
})

describe('a cancelled turn', () => {
	function hungHost() {
		let reachedDriver: () => void = () => undefined
		const reached = new Promise<void>((resolve) => {
			reachedDriver = resolve
		})
		const made = makeLadder()
		const spawner = fakeSpawner(
			windowScript((call) => {
				if (call.name === 'click' || call.name === 'type_text') reachedDriver()
				return { hang: true }
			}),
		)
		const adapter = newAdapter(spawner, made.ladder)
		const host = new SubprocessComputerUseHost({
			adapter,
			foreground: { ladder: made.ladder },
		})
		return { host, adapter, reached, spawner, ...made }
	}

	it('stops waiting for a driver that never answers, and says the input may have been sent', async () => {
		const { host, reached } = hungHost()
		const shot = await host.captureWindow('0x111')
		const controller = new AbortController()
		const pending = host.executeWindow(
			shot.captureId,
			{ type: 'mouse_click', at: { x: 10, y: 10 }, button: 'left' },
			controller.signal,
		)
		await reached
		controller.abort()
		expect(await pending).toMatchObject({
			delivery: 'delivered_unverified',
			retrySafety: 'unsafe',
		})
	})

	it('says nothing happened when it was cancelled before anything was sent', async () => {
		const { host } = hungHost()
		const shot = await host.captureWindow('0x111')
		const controller = new AbortController()
		controller.abort()
		expect(
			await host.executeWindow(
				shot.captureId,
				{ type: 'mouse_click', at: { x: 10, y: 10 }, button: 'left' },
				controller.signal,
			),
		).toMatchObject({ delivery: 'not_delivered', retrySafety: 'safe' })
	})

	it('makes a read throw rather than answer', async () => {
		const { host } = hungHost()
		const controller = new AbortController()
		controller.abort()
		await expect(host.captureWindow('0x111', controller.signal)).rejects.toThrow(/cancelled/)
	})

	it('puts the window and cursor back only after the calls a cancelled foreground burst left in flight have finished', async () => {
		vi.useFakeTimers()
		try {
			const { host, reached, monitor, adapter } = hungHost()
			const shot = await host.captureWindow('0x111')
			const controller = new AbortController()
			const pending = host.executeWindow(
				shot.captureId,
				{ type: 'type_text', text: 'hi', delivery_mode: 'foreground' },
				controller.signal,
			)
			await reached
			controller.abort()
			const result = await pending
			expect(result).toMatchObject({
				delivery: 'delivered_unverified',
				retrySafety: 'unsafe',
			})
			// The driver has not answered: the restore has not run yet.
			await vi.advanceTimersByTimeAsync(500)
			expect(monitor.calls).not.toContain('end')
			// Its request timeout (1 s) kills the stuck driver; only then is the screen given back.
			await vi.advanceTimersByTimeAsync(1_000)
			await vi.runAllTimersAsync()
			expect(monitor.calls).toContain('end')
			await adapter.dispose()
		} finally {
			vi.useRealTimers()
		}
	})
})

describe('the driver client and cancellation', () => {
	it('rejects at once and counts the request as in flight until the server answers or is stopped', async () => {
		vi.useFakeTimers()
		try {
			const spawner = fakeSpawner({ tool: () => ({ hang: true }) })
			const client = new McpStdioClient({
				command: 'driver',
				args: [],
				spawnProcess: spawner.spawnProcess,
				requestTimeoutMs: 1_000,
			})
			await client.start()
			const controller = new AbortController()
			const call = client.callTool('click', {}, undefined, {
				signal: controller.signal,
			})
			const outcome = call.catch((error: unknown) => error)
			await vi.advanceTimersByTimeAsync(0)
			controller.abort()
			expect(await outcome).toMatchObject({
				name: 'CallAbortedError',
				sent: true,
			})
			let settled = false
			void client.settled().then(() => {
				settled = true
			})
			await vi.advanceTimersByTimeAsync(500)
			expect(settled).toBe(false)
			await vi.advanceTimersByTimeAsync(1_000)
			expect(settled).toBe(true)
			await client.dispose()
		} finally {
			vi.useRealTimers()
		}
	})

	it('refuses a call that was cancelled before it started, as not sent', async () => {
		const spawner = fakeSpawner({})
		const client = new McpStdioClient({
			command: 'driver',
			args: [],
			spawnProcess: spawner.spawnProcess,
		})
		const controller = new AbortController()
		controller.abort()
		const error = await client
			.callTool('click', {}, undefined, { signal: controller.signal })
			.catch((e: unknown) => e)
		expect(error).toBeInstanceOf(CallAbortedError)
		expect((error as CallAbortedError).sent).toBe(false)
		await client.dispose()
	})
})

describe('the driver cursor', () => {
	it('shows no cursor of Namzu when the driver would not switch its own off', async () => {
		const marks: unknown[] = []
		const presence = {
			mark: (m: unknown) => void marks.push(m),
			warm: () => undefined,
			hide: () => undefined,
			dispose: async () => undefined,
		}
		const refuseCursor = (call: ToolCall) =>
			call.name === 'set_agent_cursor_enabled'
				? { error: { code: -32601, message: 'unknown tool' } }
				: undefined
		const adapter = new CuaDriverAdapter({
			executable: '/cache/cua-driver.exe',
			env: {},
			spawnProcess: fakeSpawner({
				tool: (call) =>
					refuseCursor(call) ??
					windowScript(() => toolResult({}))?.tool?.(call, undefined as never) ??
					toolResult({}),
			}).spawnProcess,
			settle: async () => undefined,
			presence,
		})
		const shot = await adapter.captureWindow('0x111')
		await adapter.executeWindow(shot.captureId, {
			type: 'mouse_click',
			at: { x: 5, y: 5 },
			button: 'left',
		})
		expect(marks).toEqual([])
		await adapter.dispose()
	})
})

function windowScript(act: (call: ToolCall) => unknown): FakeServerScript {
	return {
		tool: (call) => {
			switch (call.name) {
				case 'list_windows':
					return toolResult({
						windows: [
							{
								window_id: 0x111,
								pid: 42,
								title: 'Notes',
								app_name: 'editor.exe',
								bounds: { x: 100, y: 80, width: 1200, height: 700 },
								z_index: 1,
							},
						],
					})
				case 'get_window_state':
					return toolResult(
						{
							pid: 42,
							window_id: 0x111,
							window_bounds: { x: 100, y: 80, width: 1200, height: 700 },
							screenshot_width: 1200,
							screenshot_height: 700,
							elements: [],
						},
						[
							{
								type: 'image',
								data: pngHeader(1200, 700).toString('base64'),
								mimeType: 'image/png',
							},
						],
					)
				case 'click':
				case 'type_text':
				case 'press_key':
					return act(call) as never
				default:
					return toolResult({})
			}
		},
	}
}

function newAdapter(
	spawner: ReturnType<typeof fakeSpawner>,
	foreground: ReturnType<typeof makeLadder>['ladder'],
) {
	return new CuaDriverAdapter({
		executable: '/cache/cua-driver.exe',
		env: {},
		spawnProcess: spawner.spawnProcess,
		requestTimeoutMs: 1_000,
		startTimeoutMs: 1_000,
		settle: async () => undefined,
		foreground,
	})
}
