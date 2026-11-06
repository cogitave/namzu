import { encode } from 'fast-png'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
	ComputerUseHost,
	ComputerUseSettleRequest,
	ComputerUseSettleResult,
	WindowInfo,
} from '../../../types/computer-use/index.js'
import type { ToolContext, ToolResult } from '../../../types/tool/index.js'
import { createComputerUseTool } from '../computer-use.js'

/**
 * The pause between an action and the screenshot that follows it. A host that
 * can tell when the window stopped changing ends it early (`settle`); every
 * other case keeps the fixed `settleMs`.
 */

const png = Buffer.from(
	encode({
		width: 640,
		height: 400,
		data: new Uint8Array(640 * 400 * 3).fill(90),
		channels: 3,
		depth: 8,
	}),
)

const WINDOW: WindowInfo = {
	id: '0x10',
	title: 'Form',
	app: 'FormApp',
	pid: 5,
	bounds: { x: 0, y: 0, width: 640, height: 400 },
	focused: true,
	minimized: false,
}

function makeHost(settle?: ComputerUseHost['settle']) {
	const order: string[] = []
	const host: ComputerUseHost = {
		id: 'settle-host',
		capabilities: {
			displayServer: 'win32',
			screenshot: true,
			mouse: true,
			keyboard: true,
			cursorPosition: true,
			clipboard: false,
			windows: true,
			windowCapture: true,
		},
		getDisplayGeometry: async () => ({ width: 640, height: 400, scaleFactor: 1 }),
		async execute(action) {
			order.push(action.type)
			return {
				type: 'screenshot',
				result: {
					data: png,
					mimeType: 'image/png',
					width: 640,
					height: 400,
					display: { id: 'p', x: 0, y: 0, width: 640, height: 400, scaleFactor: 1 },
				},
			}
		},
		listWindows: async () => [WINDOW],
		focusWindow: async (id) => {
			order.push('focus')
			return { ok: true, focusedId: id }
		},
		captureWindow: async () => {
			order.push('capture')
			return {
				data: png,
				mimeType: 'image/png',
				width: 640,
				height: 400,
				window: WINDOW,
				captureId: 'w1',
			}
		},
		executeWindow: async () => undefined,
		...(settle ? { settle } : {}),
	}
	return { host, order }
}

function context(signal?: AbortSignal): ToolContext {
	return {
		sessionId: '0190a5b2-7c3d-7e4f-8a9b-0c1d2e3f4a5b' as never,
		turnId: '4adf3fdd-2823-4640-be0a-5d21fe28b6d2' as never,
		workingDirectory: '/tmp',
		abortSignal: signal ?? new AbortController().signal,
		env: {},
		log: () => {},
	}
}

async function focus(
	tool: ReturnType<typeof createComputerUseTool>,
	signal?: AbortSignal,
): Promise<ToolResult> {
	return tool.execute(
		tool.inputSchema.parse({ type: 'focus_window', window_id: '0x10' }),
		context(signal),
	)
}

afterEach(() => {
	vi.useRealTimers()
})

describe('settling after an action', () => {
	it('asks the host, naming the window and the budget, and takes the screenshot as soon as it answers', async () => {
		vi.useFakeTimers()
		const asked: ComputerUseSettleRequest[] = []
		const { host, order } = makeHost(async (request) => {
			asked.push(request)
			return { waitedMs: 130, changed: true }
		})
		// A budget no fake clock is advanced past: the fixed pause would never end.
		const tool = createComputerUseTool(host, { settleMs: 60_000 })
		const result = await focus(tool)
		expect(result.success).toBe(true)
		expect(asked).toEqual([{ windowId: '0x10', budgetMs: 60_000 }])
		expect(order).toEqual(['focus', 'capture'])
	})

	it('keeps the fixed pause when the host cannot say, fails, or has no such method', async () => {
		for (const settle of [
			undefined,
			async (): Promise<ComputerUseSettleResult | undefined> => undefined,
			async (): Promise<ComputerUseSettleResult | undefined> => {
				throw new Error('helper gone')
			},
		]) {
			vi.useFakeTimers()
			const { host, order } = makeHost(settle)
			const tool = createComputerUseTool(host, { settleMs: 400 })
			const pending = focus(tool)
			await vi.advanceTimersByTimeAsync(399)
			expect(order).not.toContain('capture')
			await vi.advanceTimersByTimeAsync(1)
			expect((await pending).success).toBe(true)
			expect(order).toEqual(['focus', 'capture'])
			vi.useRealTimers()
		}
	})

	it('does not ask the host when the pause is zero', async () => {
		let asked = 0
		const { host } = makeHost(async () => {
			asked++
			return { waitedMs: 0, changed: false }
		})
		await focus(createComputerUseTool(host, { settleMs: 0 }))
		expect(asked).toBe(0)
	})

	it('never turns a host that settles into a failed call, and honours a cancelled call', async () => {
		const controller = new AbortController()
		const { host } = makeHost(async (_request, signal) => {
			expect(signal).toBe(controller.signal)
			return { waitedMs: 1, changed: false }
		})
		const result = await focus(createComputerUseTool(host, { settleMs: 500 }), controller.signal)
		expect(result.success).toBe(true)
	})
})
