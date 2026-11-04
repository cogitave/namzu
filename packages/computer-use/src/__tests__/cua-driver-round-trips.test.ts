/**
 * How many driver calls one window action costs. `list_windows` is a global
 * UI Automation walk (over a second on a real desktop) and a tree read is two
 * to three seconds in a browser, so the count of each per action is the
 * latency of the action. These tests pin the counts, and with them the
 * verdicts and refusals the same calls produce.
 */
import { describe, expect, it } from 'vitest'
import { CuaDriverAdapter } from '../adapters/cua-driver/adapter.js'
import {
	type FakeServerScript,
	type ToolCall,
	fakeSpawner,
	pngHeader,
	toolResult,
} from './fake-mcp-process.js'

interface Line {
	role: string
	label: string
}

const BOUNDS = { x: 100, y: 80, width: 1200, height: 700 }

interface RigOptions {
	/** The windows the driver lists; the default is the one window. */
	windows?: (listed: number) => Record<string, unknown>[]
	/** Called before each wait of the adapter's, with its length. */
	onWait?: (ms: number, page: Line[]) => void
	/** Called on each tree read, counting from 1. */
	onTree?: (n: number) => void
	now?: () => number
}

function theWindow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		window_id: 0x111,
		pid: 42,
		title: 'Notes',
		app_name: 'editor.exe',
		bounds: BOUNDS,
		z_index: 1,
		...overrides,
	}
}

function rig(onInput: (call: ToolCall, page: Line[]) => unknown, options: RigOptions = {}) {
	const page: Line[] = [
		{ role: 'Button', label: 'Save' },
		{ role: 'Text', label: 'Notes' },
	]
	let listed = 0
	let trees = 0
	const script: FakeServerScript = {
		tool: (call) => {
			switch (call.name) {
				case 'list_windows':
					listed += 1
					return toolResult({ windows: options.windows?.(listed) ?? [theWindow()] })
				case 'get_window_state': {
					const shot = call.arguments.include_screenshot === true
					if (!shot) options.onTree?.(++trees)
					return toolResult(
						{
							pid: 42,
							window_id: 0x111,
							window_bounds: BOUNDS,
							screenshot_width: 1200,
							screenshot_height: 700,
							elements: page.map((line, index) => ({
								element_index: index,
								element_token: `e${index}`,
								role: line.role,
								label: line.label,
								enabled: true,
								actions: ['invoke'],
							})),
						},
						shot
							? [
									{
										type: 'image',
										data: pngHeader(1200, 700).toString('base64'),
										mimeType: 'image/png',
									},
								]
							: [],
					)
				}
				case 'type_text':
				case 'hotkey':
				case 'press_key':
				case 'click':
					return onInput(call, page) as never
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
		settle: async (ms) => options.onWait?.(ms, page),
		...(options.now ? { now: options.now } : {}),
	})
	const calls = () => spawner.processes.flatMap((p) => p.toolCalls)
	return { adapter, calls, page }
}

const unverified = () => toolResult({ effect: 'unverifiable', route: 'synthetic_events' })
const confirmed = () => toolResult({ effect: 'confirmed', route: 'synthetic_events' })

/** The driver calls made while `act` ran, by tool (a tree read and a screenshot told apart). */
async function counted<T>(
	calls: () => ToolCall[],
	act: () => Promise<T>,
): Promise<{ counts: Record<string, number>; result: T }> {
	const from = calls().length
	const result = await act()
	const counts: Record<string, number> = {}
	for (const call of calls().slice(from)) {
		const name =
			call.name === 'get_window_state'
				? call.arguments.include_screenshot === true
					? 'get_window_state(shot)'
					: 'get_window_state(tree)'
				: call.name
		counts[name] = (counts[name] ?? 0) + 1
	}
	return { counts, result }
}

const CLICK = { type: 'mouse_click', at: { x: 10, y: 10 }, button: 'left' } as const

describe('driver calls per window action', () => {
	it('a capture lists the windows once to check the window held still, and once more only when it did not know the window', async () => {
		const known = rig(() => confirmed())
		await known.adapter.listWindows()
		const warm = await counted(known.calls, () => known.adapter.captureWindow('0x111'))
		expect(warm.counts).toEqual({ list_windows: 1, 'get_window_state(shot)': 1 })
		await known.adapter.dispose()
		const cold = rig(() => confirmed())
		const first = await counted(cold.calls, () => cold.adapter.captureWindow('0x111'))
		expect(first.counts.list_windows).toBe(2)
		await cold.adapter.dispose()
	})

	it('a click the driver confirms lists the windows once, for the check that the window did not move', async () => {
		const { adapter, calls } = rig(() => confirmed())
		const shot = await adapter.captureWindow('0x111')
		const { counts, result } = await counted(calls, () =>
			adapter.executeWindow(shot.captureId, CLICK),
		)
		expect(result).toMatchObject({ delivery: 'delivered_verified' })
		expect(counts).toEqual({ list_windows: 1, 'get_window_state(tree)': 2, click: 1 })
		await adapter.dispose()
	})

	it('a click the driver cannot confirm, in a window that shows nothing, lists the windows three times, not six', async () => {
		const { adapter, calls } = rig(() => unverified())
		const shot = await adapter.captureWindow('0x111')
		const { counts, result } = await counted(calls, () =>
			adapter.executeWindow(shot.captureId, CLICK),
		)
		// A click is never judged by the window holding still: unconfirmed stays unconfirmed.
		expect(result).toMatchObject({ delivery: 'delivered_unverified', retrySafety: 'unsafe' })
		// Before the send (also the check the window did not move), at the first wait and at the last.
		expect(counts.list_windows).toBe(3)
		// Two reads before the send, one per wait after it: the tree is how a missing effect is told.
		expect(counts['get_window_state(tree)']).toBe(6)
		expect(counts.click).toBe(1)
		await adapter.dispose()
	})

	it('a click that changes the window is verified from the first read that shows it', async () => {
		const { adapter, calls } = rig((_call, page) => {
			page.push({ role: 'Text', label: 'Saved' })
			return unverified()
		})
		const shot = await adapter.captureWindow('0x111')
		const { counts, result } = await counted(calls, () =>
			adapter.executeWindow(shot.captureId, CLICK),
		)
		expect(result).toMatchObject({
			delivery: 'delivered_verified',
			readBack: { observed: 'Saved' },
		})
		expect(counts.list_windows).toBe(2)
		expect(counts['get_window_state(tree)']).toBe(4)
		await adapter.dispose()
	})

	it('typed text that shows is verified after one list before the send and one at the first wait', async () => {
		const { adapter, calls } = rig((_call, page) => {
			page.push({ role: 'Text', label: 'hello' })
			return unverified()
		})
		const shot = await adapter.captureWindow('0x111')
		const { counts, result } = await counted(calls, () =>
			adapter.executeWindow(shot.captureId, { type: 'type_text', text: 'hello' }),
		)
		expect(result).toMatchObject({
			delivery: 'delivered_verified',
			readBack: { observed: 'hello' },
		})
		expect(counts.list_windows).toBe(2)
		expect(counts['get_window_state(tree)']).toBe(2)
		await adapter.dispose()
	})

	it('typed text or a key that changes nothing is still told as no effect, safe to send again', async () => {
		for (const action of [
			{ type: 'type_text', text: 'hello' } as const,
			{ type: 'key', keys: 'ctrl+o' } as const,
		]) {
			const { adapter, calls } = rig(() => unverified())
			const shot = await adapter.captureWindow('0x111')
			const { counts, result } = await counted(calls, () =>
				adapter.executeWindow(shot.captureId, action),
			)
			expect(result).toMatchObject({ delivery: 'delivered_unverified', retrySafety: 'safe' })
			expect(result?.detail).toMatch(/did not change after the input/)
			expect(counts.list_windows).toBe(3)
			// All four reads after the input are kept: they are what shows that nothing happened.
			expect(counts['get_window_state(tree)']).toBe(action.type === 'key' ? 6 : 5)
			await adapter.dispose()
		}
	})
})

describe('a new window of the program after an input', () => {
	/** A dialog of the same program that is listed once `open` has been set. */
	function withDialog() {
		const state = { open: false }
		const windows = () => [
			theWindow(),
			...(state.open ? [theWindow({ window_id: 0x222, title: 'Save as', z_index: 2 })] : []),
		]
		return { state, windows }
	}

	it('is found at the first wait when it is there at once', async () => {
		const { state, windows } = withDialog()
		const { adapter, calls } = rig(
			() => {
				state.open = true
				return unverified()
			},
			{ windows },
		)
		const shot = await adapter.captureWindow('0x111')
		const { counts, result } = await counted(calls, () =>
			adapter.executeWindow(shot.captureId, CLICK),
		)
		expect(result).toMatchObject({
			delivery: 'delivered_verified',
			readBack: { observed: 'Save as' },
		})
		expect(counts.list_windows).toBe(2)
		await adapter.dispose()
	})

	it('is found at the last wait when it comes late and the window itself shows nothing', async () => {
		const { state, windows } = withDialog()
		const { adapter } = rig(() => unverified(), {
			windows,
			onWait: (ms) => {
				if (ms === 450) state.open = true
			},
		})
		const shot = await adapter.captureWindow('0x111')
		await expect(adapter.executeWindow(shot.captureId, CLICK)).resolves.toMatchObject({
			delivery: 'delivered_verified',
			readBack: { observed: 'Save as' },
		})
		await adapter.dispose()
	})

	it('is found at once when the window itself changes with it, without waiting for the last wait', async () => {
		const { state, windows } = withDialog()
		const { adapter, calls } = rig(() => unverified(), {
			windows,
			onWait: (ms, page) => {
				if (ms !== 80) return
				state.open = true
				page.push({ role: 'Text', label: 'Busy' })
			},
		})
		const shot = await adapter.captureWindow('0x111')
		const { counts, result } = await counted(calls, () =>
			adapter.executeWindow(shot.captureId, CLICK),
		)
		expect(result).toMatchObject({
			delivery: 'delivered_verified',
			readBack: { observed: 'Save as' },
		})
		// Before the send, the first wait, and the wait at which the tree changed.
		expect(counts.list_windows).toBe(3)
		await adapter.dispose()
	})
})

describe('the check that the captured window is still where it was', () => {
	it('refuses an input when the window moved after the capture, and sends nothing', async () => {
		let moved = false
		const { adapter, calls } = rig(() => confirmed(), {
			windows: () => [theWindow({ bounds: moved ? { ...BOUNDS, x: 160 } : BOUNDS })],
			// The window moves while the adapter reads it before the input.
			onTree: (n) => {
				if (n === 2) moved = true
			},
		})
		const shot = await adapter.captureWindow('0x111')
		await expect(adapter.executeWindow(shot.captureId, CLICK)).rejects.toThrow(
			/the captured window changed or its driver restarted; take a new window screenshot/,
		)
		expect(calls().some((call) => call.name === 'click')).toBe(false)
		await adapter.dispose()
	})

	it('refuses an input when the window now belongs to another program, or is minimized', async () => {
		for (const change of [{ pid: 99 }, { minimized: true }]) {
			let changed = false
			const { adapter, calls } = rig(() => confirmed(), {
				windows: () => [theWindow(changed ? change : {})],
				onTree: (n) => {
					if (n === 2) changed = true
				},
			})
			const shot = await adapter.captureWindow('0x111')
			await expect(adapter.executeWindow(shot.captureId, CLICK)).rejects.toThrow(
				/the captured window changed/,
			)
			expect(calls().some((call) => call.name === 'click')).toBe(false)
			await adapter.dispose()
		}
	})

	it('refuses an input when the window is gone from the list', async () => {
		let gone = false
		const { adapter, calls } = rig(() => confirmed(), {
			windows: () => (gone ? [] : [theWindow()]),
			onTree: (n) => {
				if (n === 2) gone = true
			},
		})
		const shot = await adapter.captureWindow('0x111')
		await expect(adapter.executeWindow(shot.captureId, CLICK)).rejects.toThrow(
			/the captured window changed/,
		)
		expect(calls().some((call) => call.name === 'click')).toBe(false)
		await adapter.dispose()
	})

	it('reads the list again for a send when the one read before it has grown old', async () => {
		let clock = 0
		const { adapter, calls } = rig(() => confirmed(), {
			// Each look at the clock is two seconds later than the last.
			now: () => {
				clock += 2_000
				return clock
			},
		})
		const shot = await adapter.captureWindow('0x111')
		const { counts } = await counted(calls, () => adapter.executeWindow(shot.captureId, CLICK))
		expect(counts.list_windows).toBe(2)
		await adapter.dispose()
	})

	it('reads the list for an input nothing watches (a drag), since no list was read before it', async () => {
		const { adapter, calls } = rig(() => confirmed())
		const shot = await adapter.captureWindow('0x111')
		const { counts } = await counted(calls, () =>
			adapter.executeWindow(shot.captureId, {
				type: 'mouse_drag',
				from: { x: 10, y: 10 },
				to: { x: 40, y: 40 },
				button: 'left',
			}),
		)
		expect(counts.list_windows).toBe(1)
		await adapter.dispose()
	})
})
