import { encode } from 'fast-png'
import { describe, expect, it } from 'vitest'
import type {
	ComputerUseHost,
	WindowInfo,
	WindowInputResult,
} from '../../../types/computer-use/index.js'
import type { ToolContext } from '../../../types/tool/index.js'
import { createComputerUseTool } from '../computer-use.js'

/** The tool hands the call's cancellation to every host call, and reports a cancelled action as the host answers it. */

const png = Buffer.from(
	encode({
		width: 64,
		height: 40,
		data: new Uint8Array(64 * 40 * 3).fill(90),
		channels: 3,
		depth: 8,
	}),
)
const WINDOW: WindowInfo = {
	id: '0x10',
	title: 'Form',
	app: 'FormApp',
	pid: 5,
	bounds: { x: 0, y: 0, width: 64, height: 40 },
	focused: true,
	minimized: false,
}

function host(
	seen: Array<{ call: string; signal: AbortSignal | undefined }>,
	verdict: WindowInputResult,
) {
	const value: ComputerUseHost = {
		id: 'cancel-host',
		capabilities: {
			displayServer: 'win32',
			screenshot: false,
			mouse: true,
			keyboard: true,
			cursorPosition: false,
			clipboard: false,
			windows: true,
			windowCapture: true,
		},
		getDisplayGeometry: async () => ({ width: 64, height: 40, scaleFactor: 1 }),
		async execute(_action, signal) {
			seen.push({ call: 'execute', signal })
			return { type: 'ok' }
		},
		async listWindows(signal) {
			seen.push({ call: 'listWindows', signal })
			return [WINDOW]
		},
		focusWindow: async (id) => ({ ok: true, focusedId: id }),
		async captureWindow(_id, signal) {
			seen.push({ call: 'captureWindow', signal })
			return {
				data: png,
				mimeType: 'image/png',
				width: 64,
				height: 40,
				window: WINDOW,
				captureId: 'w1',
			}
		},
		async executeWindow(_id, _action, signal) {
			seen.push({ call: 'executeWindow', signal })
			return verdict
		},
	}
	return value
}

const context = (signal: AbortSignal): ToolContext => ({
	sessionId: '0190a5b2-7c3d-7e4f-8a9b-0c1d2e3f4a5b' as never,
	turnId: '4adf3fdd-2823-4640-be0a-5d21fe28b6d2' as never,
	workingDirectory: '/tmp',
	abortSignal: signal,
	env: {},
	log: () => {},
})

describe('computer_use cancellation', () => {
	it('passes the call signal to the host for a capture and for the input after it', async () => {
		const seen: Array<{ call: string; signal: AbortSignal | undefined }> = []
		const tool = createComputerUseTool(
			host(seen, { delivery: 'delivered_verified', retrySafety: 'safe' }),
			{
				settleMs: 0,
			},
		)
		const controller = new AbortController()
		const ctx = context(controller.signal)
		await tool.execute(tool.inputSchema.parse({ type: 'screenshot', window_id: '0x10' }), ctx)
		await tool.execute(tool.inputSchema.parse({ type: 'mouse_click', at: { x: 5, y: 5 } }), ctx)
		const calls = seen.filter((s) => s.call === 'captureWindow' || s.call === 'executeWindow')
		expect(calls.length).toBeGreaterThanOrEqual(2)
		for (const call of calls) expect(call.signal).toBe(controller.signal)
	})

	it('tells the model a cancelled click may have been sent and is not safe to repeat', async () => {
		const seen: Array<{ call: string; signal: AbortSignal | undefined }> = []
		const tool = createComputerUseTool(
			host(seen, {
				delivery: 'delivered_unverified',
				retrySafety: 'unsafe',
				detail: 'The turn was cancelled while this was being sent, so it may have gone through.',
			}),
			{ settleMs: 0 },
		)
		const ctx = context(new AbortController().signal)
		await tool.execute(tool.inputSchema.parse({ type: 'screenshot', window_id: '0x10' }), ctx)
		const result = await tool.execute(
			tool.inputSchema.parse({ type: 'mouse_click', at: { x: 5, y: 5 } }),
			ctx,
		)
		const out = JSON.stringify(result.content) + result.output
		expect(out).toMatch(/sent, not confirmed|may have gone through/)
	})
})
