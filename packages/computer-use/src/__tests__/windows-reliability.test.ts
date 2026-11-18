/**
 * Window ids in every spelling, a driver that lost the screenshot of a window, a menu that opens
 * and closes again, and a host that does not keep a driver process for a conversation that is not
 * using it. Fake driver, fake clock: nothing here reaches a desktop or waits.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SubprocessComputerUseHost } from '../SubprocessComputerUseHost.js'
import { CuaDriverAdapter, parseWindowId, windowIdOf } from '../adapters/cua-driver/adapter.js'
import type { Adapter } from '../adapters/types.js'
import {
	type FakeServerScript,
	type ToolCall,
	fakeSpawner,
	pngHeader,
	toolResult,
} from './fake-mcp-process.js'

afterEach(() => {
	vi.useRealTimers()
})

const HWND = 0x2b040a

describe('a window id in every spelling', () => {
	it('is one number whether it is decimal, hex, numeric or a handle object', () => {
		for (const spelling of [
			'2819082',
			'0x2b040a',
			'0X2B040A',
			' 0x2b040a ',
			2819082,
			BigInt(2819082),
			{ hwnd: 2819082 },
			{ window_id: '0x2b040a' },
			{ id: '2819082' },
		])
			expect(parseWindowId(spelling), String(spelling)).toBe(HWND)
		expect(windowIdOf(HWND)).toBe('0x2b040a')
		for (const bad of ['', '0', 'x', {}, { id: {} }, [], null, -1, 1.5])
			expect(parseWindowId(bad), JSON.stringify(bad)).toBeUndefined()
	})
})

interface Rig {
	readonly adapter: CuaDriverAdapter
	readonly calls: () => ToolCall[]
	readonly clicks: () => ToolCall[]
	readonly starts: () => number
}

/** A driver that, like the real one, keeps the latest read of each window, and refuses a pixel input when it holds no screenshot. */
function rig(
	options: {
		/** After the first refusal the window is read with a screenshot of this size. */
		recapturedSize?: { width: number; height: number }
		onClick?: (call: ToolCall) => ReturnType<typeof toolResult>
	} = {},
): Rig {
	let driverHasFrame = true
	let shots = 0
	const size = { width: 800, height: 600 }
	const script: FakeServerScript = {
		tool: (call) => {
			switch (call.name) {
				case 'list_windows':
					return toolResult({
						windows: [
							{
								window_id: HWND,
								pid: 9,
								title: 'Menu app',
								app_name: 'menu.exe',
								bounds: { x: 10, y: 20, width: size.width, height: size.height },
								z_index: 1,
							},
						],
					})
				case 'get_window_state': {
					const shot = call.arguments.include_screenshot === true
					driverHasFrame = shot
					if (shot) shots += 1
					// The first screenshot is the one the model sees; a later one may be of a window that changed size.
					const again = shot && shots > 1 && options.recapturedSize !== undefined
					const width = again ? (options.recapturedSize?.width ?? size.width) : size.width
					const height = again ? (options.recapturedSize?.height ?? size.height) : size.height
					return toolResult(
						{
							pid: 9,
							window_id: HWND,
							window_bounds: { x: 10, y: 20, width: size.width, height: size.height },
							screenshot_width: width,
							screenshot_height: height,
							elements: [
								{
									element_index: 0,
									element_token: 't0',
									role: 'Button',
									label: 'Go',
									enabled: true,
									actions: ['invoke'],
								},
							],
						},
						shot
							? [
									{
										type: 'image',
										data: pngHeader(width, height).toString('base64'),
										mimeType: 'image/png',
									},
								]
							: [],
					)
				}
				case 'click':
					if (options.onClick) return options.onClick(call)
					if (!driverHasFrame)
						return {
							result: {
								isError: true,
								content: [
									{
										type: 'text',
										text: `No screenshot frame for window ${HWND}: its latest read had no screenshot and the window changed size since the last one (or it was never captured). Call get_window_state with the default screenshot and take x,y from that image.`,
									},
								],
							},
						} as never
					return toolResult({ effect: 'unverifiable', route: 'synthetic_events' })
				default:
					return toolResult({})
			}
		},
	}
	const spawner = fakeSpawner(script)
	const adapter = new CuaDriverAdapter({
		executable: '/cache/cua-driver.exe',
		env: {},
		spawnProcess: spawner.spawnProcess,
		requestTimeoutMs: 1_000,
		startTimeoutMs: 1_000,
		settle: async () => undefined,
	})
	const calls = (): ToolCall[] => spawner.processes.flatMap((p) => p.toolCalls)
	return {
		adapter,
		calls,
		clicks: () => calls().filter((c) => c.name === 'click'),
		starts: () => spawner.processes.length,
	}
}

const CLICK = { type: 'mouse_click', at: { x: 40, y: 30 }, button: 'left' } as const

describe('a click on a window the driver holds no screenshot of', () => {
	it('takes the screenshot again for the driver and sends the click once more, by any spelling of the id', async () => {
		for (const spelling of ['0x2b040a', '2819082']) {
			const { adapter, calls, clicks } = rig()
			const shot = await adapter.captureWindow(spelling)
			// A read of the controls, as one made to judge the click, replaces the driver's screenshot.
			await adapter.uiSnapshot(spelling)
			const result = await adapter.executeWindow(shot.captureId, CLICK)
			expect(result?.delivery, spelling).not.toBe('not_delivered')
			expect(result?.detail ?? '', spelling).not.toMatch(/No screenshot frame/)
			// Refused once, then sent again after the window was read with a screenshot.
			expect(clicks(), spelling).toHaveLength(2)
			// The read just before the second click is a screenshot of the window.
			const all = calls()
			const second = all.lastIndexOf(clicks()[1] as ToolCall)
			const read = all
				.slice(0, second)
				.reverse()
				.find((call) => call.name === 'get_window_state')
			expect(read?.arguments).toMatchObject({ window_id: HWND, include_screenshot: true })
			await adapter.dispose()
		}
	})

	it('says nothing was sent, and that it is safe to try again, when the window is no longer the size that was seen', async () => {
		const { adapter, clicks } = rig({ recapturedSize: { width: 640, height: 480 } })
		const shot = await adapter.captureWindow('0x2b040a')
		await adapter.uiSnapshot('0x2b040a')
		const result = await adapter.executeWindow(shot.captureId, CLICK)
		expect(clicks()).toHaveLength(1)
		expect(result).toMatchObject({ delivery: 'not_delivered', retrySafety: 'safe' })
		expect(result?.detail).toMatch(/nothing was sent/)
		expect(result?.detail).not.toMatch(/may have been sent/)
		await adapter.dispose()
	})
})

/** A menu app: a click on File opens a popup window (or does not), which may close again by itself. */
function menuRig(behaviour: { opens: boolean; closesAfterReads?: number }) {
	let clicked = false
	let readsAfterClick = 0
	const windows = () => [
		{
			window_id: HWND,
			pid: 9,
			title: 'Menu app',
			app_name: 'menu.exe',
			bounds: { x: 10, y: 20, width: 800, height: 600 },
			z_index: 1,
		},
		...(clicked && behaviour.opens && readsAfterClick <= (behaviour.closesAfterReads ?? 99)
			? [
					{
						window_id: 0x777,
						pid: 9,
						title: 'File menu',
						app_name: 'menu.exe',
						bounds: { x: 10, y: 40, width: 120, height: 200 },
						z_index: 0,
					},
				]
			: []),
	]
	const script: FakeServerScript = {
		tool: (call) => {
			switch (call.name) {
				case 'list_windows':
					if (clicked) readsAfterClick += 1
					return toolResult({ windows: windows() })
				case 'get_window_state':
					return toolResult({
						pid: 9,
						window_id: HWND,
						elements: [
							{
								element_index: 0,
								element_token: 'f0',
								role: 'MenuItem',
								label: 'File',
								enabled: true,
								actions: ['invoke', 'expand'],
							},
						],
					})
				case 'click':
					clicked = true
					return toolResult({ effect: 'unverifiable', route: 'synthetic_events' })
				default:
					return toolResult({})
			}
		},
	}
	const spawner = fakeSpawner(script)
	const adapter = new CuaDriverAdapter({
		executable: '/cache/cua-driver.exe',
		env: {},
		spawnProcess: spawner.spawnProcess,
		requestTimeoutMs: 1_000,
		startTimeoutMs: 1_000,
		settle: async () => undefined,
	})
	return adapter
}

async function fileRef(adapter: CuaDriverAdapter): Promise<string> {
	const snapshot = await adapter.uiSnapshot('0x2b040a')
	const found: string[] = []
	const walk = (e: typeof snapshot.root): void => {
		if (e.ref && e.name === 'File') found.push(e.ref)
		for (const child of e.children ?? []) walk(child)
	}
	walk(snapshot.root)
	if (!found[0]) throw new Error('no File item')
	return found[0]
}

describe('expand reports verified only for a menu that is open and stays open', () => {
	it('is verified when the menu opened and is still there a moment later', async () => {
		const adapter = menuRig({ opens: true })
		const result = await adapter.uiAct(await fileRef(adapter), 'expand')
		expect(result.delivery).toBe('delivered_verified')
		expect(result.detail).toMatch(/is open/)
		await adapter.dispose()
	})

	it('is not verified when the menu opened and closed again', async () => {
		// Present for the first look, gone at the second.
		const adapter = menuRig({ opens: true, closesAfterReads: 1 })
		const result = await adapter.uiAct(await fileRef(adapter), 'expand')
		expect(result.ok).toBe(true)
		expect(result.delivery).toBe('delivered_unverified')
		expect(result.detail).toMatch(/opened and closed again/)
		await adapter.dispose()
	})

	it('is not verified when nothing opened, and says what was seen', async () => {
		const adapter = menuRig({ opens: false })
		const result = await adapter.uiAct(await fileRef(adapter), 'expand')
		expect(result.delivery).toBe('delivered_unverified')
		expect(result.detail).toMatch(/no menu or new control showed/)
		await adapter.dispose()
	})
})

/** An adapter that only counts how often it was let go of. */
function countingAdapter() {
	const state = { released: 0, disposed: 0, calls: 0 }
	const adapter: Adapter = {
		capabilities: {
			displayServer: 'win32',
			screenshot: true,
			mouse: true,
			keyboard: true,
			cursorPosition: true,
			clipboard: false,
		},
		getDisplayGeometry: async () => {
			state.calls += 1
			return { width: 100, height: 100, scaleFactor: 1 }
		},
		execute: async () => {
			state.calls += 1
			return { type: 'ok' }
		},
		release: async () => {
			state.released += 1
		},
		dispose: async () => {
			state.disposed += 1
		},
	}
	return { adapter, state }
}

describe('a host that keeps no process for a conversation that is not using it', () => {
	it('lets go of the adapter when it has been idle, and holds it while a call runs', async () => {
		vi.useFakeTimers()
		const { adapter, state } = countingAdapter()
		const host = new SubprocessComputerUseHost({ adapter, idleReleaseMs: 5_000 })
		await host.getDisplayGeometry()
		await vi.advanceTimersByTimeAsync(4_999)
		expect(state.released).toBe(0)
		// A call starts the count again.
		await host.getDisplayGeometry()
		await vi.advanceTimersByTimeAsync(4_999)
		expect(state.released).toBe(0)
		await vi.advanceTimersByTimeAsync(1)
		expect(state.released).toBe(1)
		// Once released, idleness is not counted again until the next call.
		await vi.advanceTimersByTimeAsync(60_000)
		expect(state.released).toBe(1)
		await host.execute({ type: 'cursor_position' })
		await vi.advanceTimersByTimeAsync(5_000)
		expect(state.released).toBe(2)
		expect(state.disposed).toBe(0)
		await host.dispose()
		expect(state.disposed).toBe(1)
		await vi.advanceTimersByTimeAsync(60_000)
		expect(state.released).toBe(2)
	})

	it('keeps its process for the life of the host when told not to', async () => {
		vi.useFakeTimers()
		const { adapter, state } = countingAdapter()
		const host = new SubprocessComputerUseHost({ adapter, idleReleaseMs: 0 })
		await host.getDisplayGeometry()
		await vi.advanceTimersByTimeAsync(10 * 60_000)
		expect(state.released).toBe(0)
		await host.dispose()
	})

	it('the driver process ends when released and starts again for the next call', async () => {
		const { adapter, starts, calls } = rig()
		await adapter.listWindows()
		expect(starts()).toBe(1)
		await adapter.release()
		await adapter.listWindows()
		expect(starts()).toBe(2)
		expect(calls().filter((call) => call.name === 'list_windows')).toHaveLength(2)
		await adapter.dispose()
	})

	it('a click after an idle release still lands on the screenshot the model took', async () => {
		const { adapter, starts, clicks } = rig()
		const shot = await adapter.captureWindow('0x2b040a')
		await adapter.release()
		const result = await adapter.executeWindow(shot.captureId, CLICK)
		expect(starts()).toBe(2)
		expect(result?.detail ?? '').not.toMatch(/stale|driver restarted/)
		expect(result?.delivery).not.toBe('not_delivered')
		// The input is judged by a read of the controls, which the driver counts as replacing its
		// screenshot; that one refusal is the retry path above, not the stale-screenshot refusal.
		expect(clicks().length).toBeGreaterThanOrEqual(1)
		await adapter.dispose()
	})

	it('does not clear anything or end the helpers when a call began while it was winding down', async () => {
		const released: string[] = []
		const spawner = fakeSpawner({
			tool: (call) => (call.name === 'list_windows' ? toolResult({ windows: [] }) : toolResult({})),
		})
		const adapter = new CuaDriverAdapter({
			executable: '/cache/cua-driver.exe',
			env: {},
			spawnProcess: spawner.spawnProcess,
			requestTimeoutMs: 1_000,
			startTimeoutMs: 1_000,
			settle: async () => undefined,
			presence: {
				mark: () => undefined,
				warm: () => undefined,
				hide: () => undefined,
				release: () => void released.push('overlay'),
				dispose: async () => undefined,
			},
		})
		await adapter.listWindows()
		// The host says a call began (its own epoch moved) while the process was ending.
		let idle = true
		const pending = adapter.release(() => idle)
		idle = false
		await pending
		expect(released).toEqual([])
		// And the same when a call started its own process during the wind-down.
		await adapter.listWindows()
		const second = adapter.release()
		await adapter.listWindows()
		await second
		expect(released).toEqual([])
		await adapter.dispose()
	})

	it('lets go of the overlay helper and the accessibility host with the driver, not only the driver', async () => {
		const released: string[] = []
		const presence = {
			mark: () => undefined,
			warm: () => undefined,
			hide: () => undefined,
			release: () => void released.push('overlay'),
			dispose: async () => undefined,
		}
		const a11y = {
			id: 'fake',
			isReady: false,
			warm: () => undefined,
			release: () => void released.push('a11y'),
		}
		const spawner = fakeSpawner({ tool: () => toolResult({}) })
		const adapter = new CuaDriverAdapter({
			executable: '/cache/cua-driver.exe',
			env: {},
			spawnProcess: spawner.spawnProcess,
			requestTimeoutMs: 1_000,
			startTimeoutMs: 1_000,
			settle: async () => undefined,
			presence,
			a11y: a11y as never,
		})
		await adapter.release()
		expect(released.sort()).toEqual(['a11y', 'overlay'])
		await adapter.dispose()
	})

	it('stays bounded: many conversations, never more drivers than conversations in use', async () => {
		vi.useFakeTimers()
		// One fake driver per conversation; a driver counts as running from its start until it is released.
		let running = 0
		let peak = 0
		const conversations = Array.from({ length: 6 }, () => {
			let up = false
			const adapter: Adapter = {
				capabilities: {
					displayServer: 'win32',
					screenshot: true,
					mouse: true,
					keyboard: true,
					cursorPosition: true,
					clipboard: false,
				},
				getDisplayGeometry: async () => {
					if (!up) {
						up = true
						running += 1
						peak = Math.max(peak, running)
					}
					return { width: 1, height: 1, scaleFactor: 1 }
				},
				execute: async () => ({ type: 'ok' }),
				release: async () => {
					if (up) {
						up = false
						running -= 1
					}
				},
				dispose: async () => {
					if (up) {
						up = false
						running -= 1
					}
				},
			}
			return new SubprocessComputerUseHost({ adapter, idleReleaseMs: 1_000 })
		})
		// Six conversations, each used once, one after the other, a little apart.
		for (const host of conversations) {
			await host.getDisplayGeometry()
			await vi.advanceTimersByTimeAsync(1_500)
		}
		expect(peak).toBe(1)
		expect(running).toBe(0)
		for (const host of conversations) await host.dispose()
	})
})
