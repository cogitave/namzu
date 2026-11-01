/**
 * A window action the driver cannot deliver in the background is retried in
 * the foreground, but only through the ladder, and the model is told.
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
import { FakeMonitor, baseState, makeLadder } from './foreground-fakes.js'

const refusal = (code: string, text: string) => ({
	result: {
		isError: true,
		structuredContent: { code },
		content: [{ type: 'text', text }],
	},
})

function driver(
	click: (call: ToolCall) => unknown,
	ladderOptions: Parameters<typeof makeLadder>[0] = {},
) {
	const made = makeLadder(ladderOptions)
	const script: FakeServerScript = {
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
							elements: [
								{
									element_index: 0,
									element_token: 'e0',
									role: 'Button',
									label: 'Save',
									enabled: true,
									actions: ['invoke'],
								},
							],
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
					return click(call) as never
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
		foreground: made.ladder,
	})
	const calls = () => spawner.processes.flatMap((p) => p.toolCalls)
	return { adapter, calls, ...made }
}

const CLICK = {
	type: 'mouse_click',
	at: { x: 10, y: 10 },
	button: 'left',
} as const

describe('foreground fallback for window input', () => {
	it('retries a background refusal in the foreground through the ladder, and says so', async () => {
		const { adapter, calls, monitor } = driver((call) =>
			call.arguments.delivery_mode === 'foreground'
				? toolResult({
						effect: 'unverifiable',
						delivery: { mode: 'foreground' },
					})
				: refusal('background_unavailable', 'needs real focus'),
		)
		const shot = await adapter.captureWindow('0x111')
		const result = await adapter.executeWindow(shot.captureId, CLICK)
		expect(result).toMatchObject({
			delivery: 'delivered_unverified',
			retrySafety: 'unsafe',
		})
		expect(result?.detail).toMatch(
			/Background input was not possible here, so this used the screen/,
		)
		expect(monitor.calls).toEqual(['state', 'begin', 'state', 'end'])
		const clicks = calls().filter((call) => call.name === 'click')
		expect(clicks.map((call) => call.arguments.delivery_mode)).toEqual([undefined, 'foreground'])
		await adapter.dispose()
	})

	it('does not fall back when the user will not give up the screen: nothing is sent, and the blocker is named', async () => {
		const monitor = new FakeMonitor()
		monitor.state_ = () => ({ ...baseState, userIdleMs: 0 })
		const { adapter, calls } = driver(() => refusal('background_occluded', 'covered'), {
			monitor,
			approve: async () => 'deny',
		})
		const shot = await adapter.captureWindow('0x111')
		const result = await adapter.executeWindow(shot.captureId, CLICK)
		expect(result).toMatchObject({
			delivery: 'not_delivered',
			retrySafety: 'safe',
		})
		expect(result?.detail).toMatch(/did not allow editor to use the screen/i)
		expect(calls().filter((call) => call.name === 'click')).toHaveLength(1)
		await adapter.dispose()
	})

	it('never goes to the foreground for a program with higher rights', async () => {
		const { adapter, calls, monitor } = driver(() => refusal('background_uipi_blocked', 'uipi'))
		const shot = await adapter.captureWindow('0x111')
		const result = await adapter.executeWindow(shot.captureId, CLICK)
		expect(result).toMatchObject({
			delivery: 'not_delivered',
			retrySafety: 'safe',
		})
		expect(result?.detail).toMatch(/higher rights/)
		expect(calls().filter((call) => call.name === 'click')).toHaveLength(1)
		expect(monitor.calls).toEqual([])
		await adapter.dispose()
	})

	it('sends a model-requested foreground typing through the ladder as well', async () => {
		const { adapter, monitor, calls } = driver(() => toolResult({ effect: 'unverifiable' }))
		const shot = await adapter.captureWindow('0x111')
		await adapter.executeWindow(shot.captureId, {
			type: 'type_text',
			text: 'hi',
			delivery_mode: 'foreground',
		})
		expect(monitor.calls).toContain('begin')
		expect(calls().find((call) => call.name === 'type_text')?.arguments).toMatchObject({
			delivery_mode: 'foreground',
		})
		await adapter.dispose()
	})

	it('reports a burst the user interrupted as unconfirmed and unsafe to repeat', async () => {
		const monitor = new FakeMonitor()
		monitor.during = { inputs: 1, escapes: 0 }
		const { adapter } = driver(() => toolResult({ effect: 'unverifiable' }), {
			monitor,
		})
		const shot = await adapter.captureWindow('0x111')
		const result = await adapter.executeWindow(shot.captureId, {
			type: 'key',
			keys: 'ENTER',
			delivery_mode: 'foreground',
		})
		expect(result).toMatchObject({
			delivery: 'delivered_unverified',
			retrySafety: 'unsafe',
		})
		expect(result?.detail).toMatch(/used the keyboard or mouse/)
		await adapter.dispose()
	})

	it('retries a control click in the foreground when the driver says the window cannot take background input', async () => {
		const { adapter, calls, monitor } = driver((call) =>
			call.arguments.delivery_mode === 'foreground'
				? toolResult({ effect: 'unverifiable' })
				: refusal('background_unavailable', 'needs real focus'),
		)
		const snapshot = await adapter.uiSnapshot('0x111')
		const ref = snapshot.root.children?.[0]?.ref ?? snapshot.root.ref
		if (!ref) throw new Error('no ref')
		const result = await adapter.uiAct(ref, 'invoke')
		expect(result).toMatchObject({
			ok: true,
			delivery: 'delivered_unverified',
		})
		expect(result.detail).toMatch(/used the screen/)
		expect(monitor.calls).toContain('begin')
		expect(
			calls()
				.filter((call) => call.name === 'click')
				.at(-1)?.arguments,
		).toMatchObject({
			element_token: 'e0',
			delivery_mode: 'foreground',
		})
		await adapter.dispose()
	})
})
