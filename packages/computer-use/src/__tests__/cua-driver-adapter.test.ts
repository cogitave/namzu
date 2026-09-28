import { describe, expect, it } from 'vitest'
import { SubprocessComputerUseHost } from '../SubprocessComputerUseHost.js'
import {
	CuaDriverAdapter,
	parseWindowId,
	toWindowInfos,
	windowIdOf,
} from '../adapters/cua-driver/adapter.js'
import { translateKeyForCuaDriver } from '../adapters/cua-driver/keys.js'
import { ComputerUseOutcomeUnknownError } from '../errors.js'
import {
	type FakeMcpProcess,
	type FakeServerScript,
	type ToolCall,
	fakeSpawner,
	pngHeader,
	toolResult,
} from './fake-mcp-process.js'

const SCREEN = { width: 3440, height: 1440, scale_factor: 1.5 }

function endedSessionRefusal() {
	return {
		result: {
			isError: true,
			content: [{ type: 'text', text: 'this session has ended; call start_session explicitly' }],
			structuredContent: {
				status: 'refused',
				refusal: {
					code: 'session_ended',
					message: 'this session has ended; call start_session explicitly',
				},
			},
		},
	}
}

/** A cua-driver stand-in that answers the tools the adapter uses. */
function cuaDriver(
	overrides: Partial<Record<string, (call: ToolCall, p: FakeMcpProcess) => unknown>> = {},
) {
	const script: FakeServerScript = {
		tool: (call, process) => {
			const override = overrides[call.name]
			if (override) return override(call, process) as never
			switch (call.name) {
				case 'get_screen_size':
					return toolResult(SCREEN)
				case 'get_desktop_state':
					return {
						result: {
							content: [
								{
									type: 'image',
									data: pngHeader(3440, 1440).toString('base64'),
									mimeType: 'image/png',
								},
								{ type: 'text', text: 'desktop screenshot 3440x1440 px' },
							],
							structuredContent: {
								display: 'primary',
								scale_factor: 1.5,
								screen_width: 3440,
								screen_height: 1440,
								screenshot_width: 3440,
								screenshot_height: 1440,
							},
						},
					}
				case 'get_cursor_position':
					return toolResult({ x: 2600, y: 700 })
				default:
					return toolResult({ route: 'global_input' })
			}
		},
	}
	const spawner = fakeSpawner(script)
	const adapter = new CuaDriverAdapter({
		executable: '/cache/cua-driver.exe',
		env: {},
		version: '0.28.2',
		spawnProcess: spawner.spawnProcess,
		requestTimeoutMs: 1_000,
		startTimeoutMs: 1_000,
	})
	const calls = () => spawner.processes.flatMap((p) => p.toolCalls)
	return { adapter, processes: spawner.processes, calls }
}

describe('the cua-driver adapter', () => {
	it('turns the agent cursor off before anything else, and says what it is', async () => {
		const { adapter, calls } = cuaDriver()
		await adapter.getDisplayGeometry()
		expect(calls()[0]).toEqual({ name: 'set_agent_cursor_enabled', arguments: { enabled: false } })
		expect(adapter.backend).toBe('cua-driver 0.28.2')
		expect(adapter.capabilities.windows).toBe(true)
		expect(adapter.capabilities.windowScroll).toBe(false)
		expect(adapter.capabilities.regionCapture).toBe(false)
		await adapter.dispose()
	})

	it('reports the display in physical pixels with its real scale factor', async () => {
		const { adapter } = cuaDriver()
		await expect(adapter.getDisplayGeometry()).resolves.toEqual({
			width: 3440,
			height: 1440,
			scaleFactor: 1.5,
		})
		const shot = await adapter.execute({ type: 'screenshot' })
		expect(shot.type).toBe('screenshot')
		if (shot.type !== 'screenshot') return
		expect(shot.result.width).toBe(3440)
		expect(shot.result.height).toBe(1440)
		expect(shot.result.display).toEqual({
			id: 'primary',
			x: 0,
			y: 0,
			width: 3440,
			height: 1440,
			scaleFactor: 1.5,
			primary: true,
		})
		await adapter.dispose()
	})

	it('binds window PNG input to the captured PID and HWND, and refuses a moved or stale window', async () => {
		let moved = false
		const windows = () => [
			{
				window_id: 0x111,
				pid: 42,
				title: 'Brave',
				app_name: 'brave.exe',
				bounds: { x: moved ? 120 : 100, y: 80, width: 1200, height: 700 },
				z_index: 1,
			},
			{
				window_id: 0x222,
				pid: 42,
				title: 'Brave second',
				app_name: 'brave.exe',
				bounds: { x: 1300, y: 80, width: 1200, height: 700 },
				z_index: 0,
			},
		]
		const { adapter, calls } = cuaDriver({
			list_windows: () => toolResult({ windows: windows() }),
			get_window_state: (call) => {
				const hwnd = call.arguments.window_id as number
				const bounds = windows().find((window) => window.window_id === hwnd)?.bounds
				return toolResult(
					{
						pid: 42,
						window_id: hwnd,
						window_bounds: bounds,
						screenshot_width: 1200,
						screenshot_height: 700,
					},
					[{ type: 'image', data: pngHeader(1200, 700).toString('base64'), mimeType: 'image/png' }],
				)
			},
		})
		const first = await adapter.captureWindow('0x111')
		expect(first.window.id).toBe('0x111')
		expect(first.width).toBe(1200)
		expect(calls().find((call) => call.name === 'get_window_state')?.arguments).toEqual({
			pid: 42,
			window_id: 0x111,
			include_accessibility_tree: false,
			include_screenshot: true,
		})
		await adapter.executeWindow(first.captureId, {
			type: 'mouse_click',
			at: { x: 340, y: 260 },
			button: 'left',
		})
		expect(calls().find((call) => call.name === 'click')?.arguments).toEqual({
			scope: 'window',
			pid: 42,
			window_id: 0x111,
			x: 340,
			y: 260,
			button: 'left',
		})
		moved = true
		await expect(
			adapter.executeWindow(first.captureId, {
				type: 'mouse_click',
				at: { x: 340, y: 260 },
				button: 'left',
			}),
		).rejects.toThrow(/captured window changed/)
		expect(calls().filter((call) => call.name === 'click')).toHaveLength(1)
		moved = false
		const second = await adapter.captureWindow('0x222')
		await expect(
			adapter.executeWindow(first.captureId, {
				type: 'mouse_click',
				at: { x: 340, y: 260 },
				button: 'left',
			}),
		).rejects.toThrow(/stale/)
		await adapter.executeWindow(second.captureId, { type: 'key', keys: 'CTRL+R' })
		expect(calls().find((call) => call.name === 'hotkey')?.arguments).toEqual({
			scope: 'window',
			pid: 42,
			window_id: 0x222,
			keys: ['ctrl', 'r'],
		})
		await adapter.executeWindow(second.captureId, {
			type: 'key',
			keys: 'CTRL+L',
			delivery_mode: 'foreground',
		})
		expect(
			calls()
				.filter((call) => call.name === 'hotkey')
				.at(-1)?.arguments,
		).toEqual({
			scope: 'window',
			pid: 42,
			window_id: 0x222,
			keys: ['ctrl', 'l'],
			delivery_mode: 'foreground',
		})
		await adapter.executeWindow(second.captureId, {
			type: 'type_text',
			text: 'hello',
			delivery_mode: 'foreground',
		})
		expect(calls().find((call) => call.name === 'type_text')?.arguments).toEqual({
			scope: 'window',
			pid: 42,
			window_id: 0x222,
			text: 'hello',
			delivery_mode: 'foreground',
		})
		await adapter.executeWindow(second.captureId, {
			type: 'key',
			keys: 'CTRL+A',
			delivery_mode: 'foreground',
		})
		expect(
			calls()
				.filter((call) => call.name === 'hotkey')
				.at(-1)?.arguments,
		).toEqual({
			scope: 'window',
			pid: 42,
			window_id: 0x222,
			keys: ['ctrl', 'a'],
			delivery_mode: 'foreground',
		})
		await expect(
			adapter.executeWindow(second.captureId, {
				type: 'scroll',
				at: { x: 220, y: 130 },
				direction: 'down',
				amount: 3,
			}),
		).rejects.toThrow(/window pixel scrolling is unavailable/)
		expect(calls().some((call) => call.name === 'scroll')).toBe(false)
		expect(calls().some((call) => call.name === 'get_desktop_state')).toBe(false)
		await adapter.dispose()
	})

	it('counts a window click already sent as done and never suggests an unsafe foreground pointer retry', async () => {
		let clicks = 0
		const { adapter, calls } = cuaDriver({
			list_windows: () =>
				toolResult({
					windows: [
						{
							window_id: 0x111,
							pid: 42,
							title: 'Brave',
							app_name: 'brave.exe',
							bounds: { x: 100, y: 80, width: 1200, height: 700 },
							z_index: 1,
						},
					],
				}),
			get_window_state: () =>
				toolResult(
					{
						pid: 42,
						window_id: 0x111,
						window_bounds: { x: 100, y: 80, width: 1200, height: 700 },
						screenshot_width: 1200,
						screenshot_height: 700,
					},
					[{ type: 'image', data: pngHeader(1200, 700).toString('base64'), mimeType: 'image/png' }],
				),
			click: () => {
				clicks++
				return clicks === 1
					? {
							result: {
								isError: true,
								structuredContent: { code: 'foreground_unavailable' },
								content: [
									{
										type: 'text',
										text: 'foreground_unavailable: target was not foreground after the click',
									},
								],
							},
						}
					: {
							result: {
								isError: true,
								structuredContent: {
									code: 'background_unavailable',
									suggestion: 'retry in foreground',
								},
								content: [
									{ type: 'text', text: 'Retry this action with delivery_mode:"foreground"' },
								],
							},
						}
			},
		})
		const shot = await adapter.captureWindow('0x111')
		const action = { type: 'mouse_click', at: { x: 220, y: 130 }, button: 'left' } as const
		await expect(adapter.executeWindow(shot.captureId, action)).resolves.toBeUndefined()
		await expect(adapter.executeWindow(shot.captureId, action)).rejects.toThrow(
			/window pointer action could not be delivered safely in background/,
		)
		expect(calls().filter((call) => call.name === 'click')).toHaveLength(2)
		expect(
			calls()
				.filter((call) => call.name === 'click')
				.every((call) => !('delivery_mode' in call.arguments)),
		).toBe(true)
		await adapter.dispose()
	})

	it('serializes a new capture before an old-frame action, refusing it without input', async () => {
		let captured = 0
		let captureStarted!: () => void
		let releaseCapture!: () => void
		const started = new Promise<void>((resolve) => {
			captureStarted = resolve
		})
		const held = new Promise<void>((resolve) => {
			releaseCapture = resolve
		})
		const { adapter, calls } = cuaDriver({
			list_windows: () =>
				toolResult({
					windows: [
						{
							window_id: 0x111,
							pid: 42,
							title: 'Brave',
							app_name: 'brave.exe',
							bounds: { x: 100, y: 80, width: 1200, height: 700 },
							z_index: 1,
						},
					],
				}),
			get_window_state: async () => {
				captured++
				if (captured === 2) {
					captureStarted()
					await held
				}
				return toolResult(
					{
						pid: 42,
						window_id: 0x111,
						window_bounds: { x: 100, y: 80, width: 1200, height: 700 },
						screenshot_width: 1200,
						screenshot_height: 700,
					},
					[{ type: 'image', data: pngHeader(1200, 700).toString('base64'), mimeType: 'image/png' }],
				)
			},
		})
		const first = await adapter.captureWindow('0x111')
		const next = adapter.captureWindow('0x111')
		await started
		const staleAction = adapter.executeWindow(first.captureId, {
			type: 'mouse_click',
			at: { x: 220, y: 130 },
			button: 'left',
		})
		expect(calls().some((call) => call.name === 'click')).toBe(false)
		releaseCapture()
		await next
		await expect(staleAction).rejects.toThrow(/stale/)
		expect(calls().some((call) => call.name === 'click')).toBe(false)
		await adapter.dispose()
	})

	it('invalidates a window capture on driver session revival instead of replaying its pixel action', async () => {
		const { adapter, calls } = cuaDriver({
			list_windows: () =>
				toolResult({
					windows: [
						{
							window_id: 0x111,
							pid: 42,
							title: 'Brave',
							app_name: 'brave.exe',
							bounds: { x: 100, y: 80, width: 1200, height: 700 },
							z_index: 1,
						},
					],
				}),
			get_window_state: () =>
				toolResult(
					{
						pid: 42,
						window_id: 0x111,
						window_bounds: { x: 100, y: 80, width: 1200, height: 700 },
						screenshot_width: 1200,
						screenshot_height: 700,
					},
					[{ type: 'image', data: pngHeader(1200, 700).toString('base64'), mimeType: 'image/png' }],
				),
			click: () => endedSessionRefusal(),
		})
		const shot = await adapter.captureWindow('0x111')
		await expect(
			adapter.executeWindow(shot.captureId, {
				type: 'mouse_click',
				at: { x: 5, y: 5 },
				button: 'left',
			}),
		).rejects.toThrow(/stale window screenshot/)
		expect(calls().filter((call) => call.name === 'click')).toHaveLength(1)
		expect(calls().filter((call) => call.name === 'start_session')).toHaveLength(1)
		await adapter.dispose()
	})

	it('refuses a capture that is not the display’s physical size', async () => {
		const { adapter } = cuaDriver({
			get_desktop_state: () => ({
				result: {
					content: [
						{ type: 'image', data: pngHeader(1568, 656).toString('base64'), mimeType: 'image/png' },
					],
					structuredContent: { screen_width: 3440, screen_height: 1440 },
				},
			}),
		})
		await expect(adapter.execute({ type: 'screenshot' })).rejects.toThrow(
			/refusing a scaled screenshot/,
		)
		await adapter.dispose()
	})

	it('sends every input to the desktop scope at the coordinates it was given', async () => {
		const { adapter, calls } = cuaDriver()
		await adapter.execute({ type: 'mouse_move', to: { x: 10, y: 20 } })
		await adapter.execute({ type: 'mouse_click', at: { x: 2987, y: 166 }, button: 'right' })
		await adapter.execute({
			type: 'mouse_drag',
			from: { x: 1, y: 2 },
			to: { x: 300, y: 400 },
			button: 'left',
		})
		await adapter.execute({ type: 'scroll', at: { x: 5, y: 6 }, direction: 'down', amount: 3 })
		await adapter.execute({ type: 'type_text', text: 'Merhaba dünya ığüşöçİ' })
		const sent = calls().slice(1)
		expect(sent).toEqual([
			{ name: 'move_cursor', arguments: { scope: 'desktop', x: 10, y: 20 } },
			{ name: 'click', arguments: { scope: 'desktop', x: 2987, y: 166, button: 'right' } },
			{
				name: 'drag',
				arguments: {
					scope: 'desktop',
					from_x: 1,
					from_y: 2,
					to_x: 300,
					to_y: 400,
					button: 'left',
					duration_ms: 250,
					steps: 12,
				},
			},
			{ name: 'scroll', arguments: { scope: 'desktop', x: 5, y: 6, direction: 'down', amount: 3 } },
			{ name: 'type_text', arguments: { scope: 'desktop', text: 'Merhaba dünya ığüşöçİ' } },
		])
		await adapter.dispose()
	})

	it('splits a long scroll into the 50-tick calls cua-driver accepts', async () => {
		const { adapter, calls } = cuaDriver()
		await adapter.execute({ type: 'scroll', at: { x: 1, y: 1 }, direction: 'up', amount: 120 })
		expect(
			calls()
				.slice(1)
				.map((call) => call.arguments.amount),
		).toEqual([50, 50, 20])
		await adapter.dispose()
	})

	it('presses keys through press_key, hotkey or text as the plan says', async () => {
		const { adapter, calls } = cuaDriver()
		await adapter.execute({ type: 'key', keys: 'ENTER' })
		await adapter.execute({ type: 'key', keys: 'ctrl+shift+t' })
		await adapter.execute({ type: 'key', keys: '/' })
		expect(calls().slice(1)).toEqual([
			{ name: 'press_key', arguments: { scope: 'desktop', key: 'return' } },
			{ name: 'hotkey', arguments: { scope: 'desktop', keys: ['ctrl', 'shift', 't'] } },
			{ name: 'type_text', arguments: { scope: 'desktop', text: '/' } },
		])
		await adapter.dispose()
	})

	it('reads the cursor position', async () => {
		const { adapter } = cuaDriver()
		await expect(adapter.execute({ type: 'cursor_position' })).resolves.toEqual({
			type: 'cursor_position',
			point: { x: 2600, y: 700 },
		})
		await adapter.dispose()
	})

	it('surfaces a tool failure as an error with cua-driver’s words', async () => {
		const { adapter } = cuaDriver({
			click: () => ({
				result: { isError: true, content: [{ type: 'text', text: 'no window at point' }] },
			}),
		})
		await expect(
			adapter.execute({ type: 'mouse_click', at: { x: 1, y: 1 }, button: 'left' }),
		).rejects.toThrow('no window at point')
		await adapter.dispose()
	})

	it('revives the expired implicit session, restores its cursor setting, and retries a refused click once', async () => {
		let expired = false
		const { adapter, calls, processes } = cuaDriver({
			click: () => (expired ? endedSessionRefusal() : toolResult({ route: 'global_input' })),
			start_session: () => {
				expired = false
				return toolResult({ active: true, revived: true })
			},
		})
		await adapter.getDisplayGeometry()
		expired = true
		await expect(
			adapter.execute({ type: 'mouse_click', at: { x: 15, y: 20 }, button: 'left' }),
		).resolves.toEqual({ type: 'ok' })
		expect(calls()).toEqual([
			{ name: 'set_agent_cursor_enabled', arguments: { enabled: false } },
			{ name: 'get_screen_size', arguments: {} },
			{ name: 'click', arguments: { scope: 'desktop', x: 15, y: 20, button: 'left' } },
			{ name: 'start_session', arguments: {} },
			{ name: 'set_agent_cursor_enabled', arguments: { enabled: false } },
			{ name: 'click', arguments: { scope: 'desktop', x: 15, y: 20, button: 'left' } },
		])
		expect(processes).toHaveLength(1)
		await adapter.dispose()
	})

	it('shares one revival among simultaneous refusals from the expired session', async () => {
		let expired = false
		let refusals = 0
		let markTwoRefusals: () => void = () => undefined
		const twoRefusals = new Promise<void>((resolve) => {
			markTwoRefusals = resolve
		})
		let releaseStart: () => void = () => undefined
		let markStartCalled: () => void = () => undefined
		const startCalled = new Promise<void>((resolve) => {
			markStartCalled = resolve
		})
		const startMayFinish = new Promise<void>((resolve) => {
			releaseStart = resolve
		})
		const { adapter, calls } = cuaDriver({
			click: () => {
				if (!expired) return toolResult({ route: 'global_input' })
				if (++refusals === 2) markTwoRefusals()
				return endedSessionRefusal()
			},
			start_session: async () => {
				markStartCalled()
				await startMayFinish
				expired = false
				return toolResult({ active: true, revived: true })
			},
		})
		await adapter.getDisplayGeometry()
		expired = true
		const first = adapter.execute({ type: 'mouse_click', at: { x: 1, y: 1 }, button: 'left' })
		const second = adapter.execute({ type: 'mouse_click', at: { x: 2, y: 2 }, button: 'left' })
		await twoRefusals
		await startCalled
		releaseStart()
		await expect(Promise.all([first, second])).resolves.toEqual([{ type: 'ok' }, { type: 'ok' }])
		expect(calls().filter((call) => call.name === 'start_session')).toHaveLength(1)
		expect(calls().filter((call) => call.name === 'click')).toHaveLength(4)
		await adapter.dispose()
	})

	it('does not replay a refusal inferred from text or a code without the pre-dispatch shape', async () => {
		for (const refusal of [
			{ isError: true, content: [{ type: 'text', text: 'session_ended' }] },
			{
				isError: true,
				content: [{ type: 'text', text: 'session_ended' }],
				structuredContent: { code: 'session_ended' },
			},
		]) {
			const { adapter, calls } = cuaDriver({ click: () => ({ result: refusal }) })
			await expect(
				adapter.execute({ type: 'mouse_click', at: { x: 1, y: 1 }, button: 'left' }),
			).rejects.toThrow('session_ended')
			expect(calls().map((call) => call.name)).toEqual(['set_agent_cursor_enabled', 'click'])
			await adapter.dispose()
		}
	})

	it('stops after one retry if the driver still refuses the session', async () => {
		const { adapter, calls } = cuaDriver({
			click: () => endedSessionRefusal(),
			start_session: () => toolResult({ active: true, revived: true }),
		})
		await expect(
			adapter.execute({ type: 'mouse_click', at: { x: 1, y: 1 }, button: 'left' }),
		).rejects.toThrow(/session has ended/)
		expect(calls().map((call) => call.name)).toEqual([
			'set_agent_cursor_enabled',
			'click',
			'start_session',
			'set_agent_cursor_enabled',
			'click',
		])
		await adapter.dispose()
	})

	it('does not replay the refused action when session revival fails', async () => {
		const { adapter, calls } = cuaDriver({
			click: () => endedSessionRefusal(),
			start_session: () => ({
				result: {
					isError: true,
					content: [{ type: 'text', text: 'session is not available to this transport' }],
					structuredContent: { code: 'session_unavailable' },
				},
			}),
		})
		await expect(
			adapter.execute({ type: 'mouse_click', at: { x: 1, y: 1 }, button: 'left' }),
		).rejects.toThrow('session is not available to this transport')
		expect(calls().map((call) => call.name)).toEqual([
			'set_agent_cursor_enabled',
			'click',
			'start_session',
		])
		await adapter.dispose()
	})

	it('counts a click that closed its own window as done, and a refused one as failed', async () => {
		const { adapter } = cuaDriver({
			click: (call) =>
				call.arguments.x === 1752
					? {
							result: {
								isError: true,
								content: [
									{
										type: 'text',
										text: 'foreground_unavailable: exact target HWND 0x1160e2e or a verified same-process post-action window was not foreground after the click (actual foreground HWND 0x6e00ec8)',
									},
								],
							},
						}
					: {
							result: {
								isError: true,
								content: [
									{
										type: 'text',
										text: 'foreground_unavailable: Windows did not activate exact target HWND 0x9 (actual foreground HWND 0x7); no mouse input was sent',
									},
								],
							},
						},
		})
		await expect(
			adapter.execute({ type: 'mouse_click', at: { x: 1752, y: 709 }, button: 'left' }),
		).resolves.toEqual({ type: 'ok' })
		await expect(
			adapter.execute({ type: 'mouse_click', at: { x: 5, y: 5 }, button: 'left' }),
		).rejects.toThrow(/no mouse input was sent/)
		await adapter.dispose()
	})

	it('lists windows front to back and focuses one by the id it listed', async () => {
		const { adapter, calls } = cuaDriver({
			list_windows: () =>
				toolResult({
					windows: [
						{
							window_id: 7,
							pid: 70,
							app_name: 'Terminal.exe',
							title: 'shell',
							bounds: { x: 0, y: 0, width: 800, height: 600 },
							minimized: false,
							z_index: 5,
						},
						{
							window_id: 115347144,
							pid: 58236,
							app_name: 'notepad.exe',
							title: 'Untitled - Notepad',
							bounds: { x: 2600, y: 150, width: 820, height: 900 },
							minimized: false,
							z_index: 4,
						},
					],
				}),
			bring_to_front: (call) =>
				toolResult({
					landed_on_target: true,
					previous_fg_hwnd: '0x7',
					now_fg_hwnd: `0x${(call.arguments.window_id as number).toString(16)}`,
				}),
		})
		const windows = await adapter.listWindows()
		expect(windows.map((w) => [w.id, w.app, w.focused])).toEqual([
			['0x7', 'Terminal', true],
			['0x6e00ec8', 'notepad', false],
		])
		await expect(adapter.focusWindow('0x6e00ec8')).resolves.toEqual({
			ok: true,
			focusedId: '0x6e00ec8',
		})
		expect(calls().at(-1)).toEqual({
			name: 'bring_to_front',
			arguments: { pid: 58236, window_id: 115347144 },
		})
		await adapter.dispose()
	})

	it('reports a focus the operating system refused as not ok, naming what is in front', async () => {
		const { adapter } = cuaDriver({
			list_windows: () =>
				toolResult({
					windows: [
						{
							window_id: 9,
							pid: 90,
							app_name: 'a.exe',
							title: 'A',
							bounds: { x: 0, y: 0, width: 10, height: 10 },
							z_index: 1,
						},
					],
				}),
			bring_to_front: () => toolResult({ landed_on_target: false, now_fg_hwnd: '0x40864' }),
		})
		// Not listed yet: the adapter lists once to learn the pid.
		await expect(adapter.focusWindow('0x9')).resolves.toEqual({ ok: false, focusedId: '0x40864' })
		await expect(adapter.focusWindow('0x123')).rejects.toThrow(/no window 0x123/)
		await expect(adapter.focusWindow('notepad')).rejects.toThrow(/not a window id/)
		await adapter.dispose()
	})

	it('restarts the driver after a crash, and the host calls a click lost to it an unknown outcome', async () => {
		let crashed = false
		const { adapter, processes } = cuaDriver({
			click: (_call, process) => {
				if (!crashed) {
					crashed = true
					process.crash(1)
					return { hang: true }
				}
				return toolResult({})
			},
		})
		const host = new SubprocessComputerUseHost({ adapter })
		const error = await host
			.execute({ type: 'mouse_click', at: { x: 1, y: 1 }, button: 'left' })
			.catch((e: unknown) => e)
		expect(error).toBeInstanceOf(ComputerUseOutcomeUnknownError)
		await host.execute({ type: 'mouse_click', at: { x: 1, y: 1 }, button: 'left' })
		expect(processes).toHaveLength(2)
		expect(adapter.processStarts).toBe(2)
		await host.dispose()
		expect(processes[1]?.exitCode).toBe(0)
	})
})

describe('cua-driver window records', () => {
	it('drops the driver’s overlay, the shell desktop, untitled and one-pixel windows', () => {
		const windows = toWindowInfos([
			{
				window_id: 1,
				pid: 1,
				app_name: 'cua-driver.exe',
				title: 'Cua.AgentCursorOverlay.default',
				bounds: { x: 0, y: 0, width: 3440, height: 1440 },
				z_index: 9,
			},
			{
				window_id: 2,
				pid: 2,
				app_name: 'explorer.exe',
				title: 'Program Manager',
				bounds: { x: 0, y: 0, width: 3440, height: 1440 },
				z_index: 0,
			},
			{
				window_id: 3,
				pid: 3,
				app_name: 'XboxPcTray.exe',
				title: 'DesktopWindowXamlSource',
				bounds: { x: 0, y: 0, width: 1, height: 1 },
				z_index: 3,
			},
			{
				window_id: 4,
				pid: 4,
				app_name: 'x.exe',
				title: '   ',
				bounds: { x: 0, y: 0, width: 50, height: 50 },
				z_index: 4,
			},
			{
				window_id: 5,
				pid: 5,
				app_name: 'Code.exe',
				title: 'editor',
				bounds: { x: 1, y: 2, width: 300, height: 200 },
				z_index: 5,
			},
		])
		expect(windows).toEqual([
			{
				id: '0x5',
				title: 'editor',
				app: 'Code',
				pid: 5,
				bounds: { x: 1, y: 2, width: 300, height: 200 },
				focused: true,
				minimized: false,
			},
		])
	})

	it('never calls a minimized window focused', () => {
		const windows = toWindowInfos([
			{
				window_id: 1,
				pid: 1,
				app_name: 'a.exe',
				title: 'minimized',
				bounds: { x: -32000, y: -32000, width: 160, height: 28 },
				minimized: true,
				z_index: 9,
			},
			{
				window_id: 2,
				pid: 2,
				app_name: 'b.exe',
				title: 'behind',
				bounds: { x: 0, y: 0, width: 100, height: 100 },
				minimized: false,
				z_index: 1,
			},
		])
		expect(windows.map((w) => [w.title, w.focused, w.minimized])).toEqual([
			['minimized', false, true],
			['behind', true, false],
		])
	})

	it('reads window ids as cua-driver writes them', () => {
		expect(parseWindowId('0x6e00ec8')).toBe(115347144)
		expect(parseWindowId(115347144)).toBe(115347144)
		expect(parseWindowId('115347144')).toBe(115347144)
		expect(parseWindowId('0x')).toBeUndefined()
		expect(parseWindowId('notepad')).toBeUndefined()
		expect(parseWindowId(-1)).toBeUndefined()
		expect(windowIdOf(264292)).toBe('0x40864')
	})
})

describe('key plans for cua-driver', () => {
	it('presses named keys, case-insensitively', () => {
		expect(translateKeyForCuaDriver('ENTER')).toEqual({ tool: 'press_key', key: 'return' })
		expect(translateKeyForCuaDriver('Escape')).toEqual({ tool: 'press_key', key: 'escape' })
		expect(translateKeyForCuaDriver('page_down')).toEqual({ tool: 'press_key', key: 'pagedown' })
		expect(translateKeyForCuaDriver('BackSpace')).toEqual({ tool: 'press_key', key: 'backspace' })
		expect(translateKeyForCuaDriver('F5')).toEqual({ tool: 'press_key', key: 'f5' })
	})

	it('sends a lone printable character as text, so the layout cannot change it', () => {
		expect(translateKeyForCuaDriver('/')).toEqual({ tool: 'type_text', text: '/' })
		expect(translateKeyForCuaDriver('A')).toEqual({ tool: 'type_text', text: 'A' })
		expect(translateKeyForCuaDriver('ş')).toEqual({ tool: 'type_text', text: 'ş' })
		expect(translateKeyForCuaDriver('+')).toEqual({ tool: 'type_text', text: '+' })
		expect(translateKeyForCuaDriver('plus')).toEqual({ tool: 'type_text', text: '+' })
	})

	it('holds modifiers through hotkey, mapping cmd to ctrl and super to the Windows key', () => {
		expect(translateKeyForCuaDriver('CTRL+R')).toEqual({ tool: 'hotkey', keys: ['ctrl', 'r'] })
		expect(translateKeyForCuaDriver('cmd+c')).toEqual({ tool: 'hotkey', keys: ['ctrl', 'c'] })
		expect(translateKeyForCuaDriver('super+r')).toEqual({ tool: 'hotkey', keys: ['win', 'r'] })
		expect(translateKeyForCuaDriver('alt+F4')).toEqual({ tool: 'hotkey', keys: ['alt', 'f4'] })
		expect(translateKeyForCuaDriver('ctrl++')).toEqual({ tool: 'hotkey', keys: ['ctrl', '+'] })
		expect(translateKeyForCuaDriver('shift+Tab')).toEqual({
			tool: 'hotkey',
			keys: ['shift', 'tab'],
		})
		expect(translateKeyForCuaDriver('ctrl+cmd+v')).toEqual({ tool: 'hotkey', keys: ['ctrl', 'v'] })
	})

	it('refuses an unknown modifier and an empty combo', () => {
		expect(() => translateKeyForCuaDriver('hyper+c')).toThrow(/unknown modifier "hyper"/)
		expect(() => translateKeyForCuaDriver('')).toThrow(/empty/)
	})
})
