import { encode } from 'fast-png'
import { describe, expect, it } from 'vitest'
import type { ComputerUseHost, UiSnapshot, WindowInfo } from '../../../types/computer-use/index.js'
import type { ToolContext, ToolResult } from '../../../types/tool/index.js'
import { createComputerUseTool } from '../computer-use.js'

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
	id: '0x2b040a',
	title: 'Form',
	app: 'FormApp',
	pid: 5,
	bounds: { x: 0, y: 0, width: 640, height: 400 },
	focused: true,
	minimized: false,
}

function makeHost() {
	const captured: string[] = []
	const touched: string[] = []
	const snapshotOf: (windowId?: string) => UiSnapshot = () => ({
		// A host that does not say which window it read.
		title: 'Form',
		root: {
			ref: '',
			role: 'Window',
			name: 'Form',
			children: [{ ref: 'h:0', role: 'Button', name: 'OK', actions: ['invoke'] }],
		},
	})
	const host: ComputerUseHost = {
		id: 'ids-host',
		capabilities: {
			displayServer: 'win32',
			screenshot: true,
			mouse: true,
			keyboard: true,
			cursorPosition: true,
			clipboard: false,
			windows: true,
			windowCapture: true,
			windowScroll: true,
			uiTree: true,
		},
		getDisplayGeometry: async () => ({ width: 640, height: 400, scaleFactor: 1 }),
		execute: async () => {
			touched.push('execute')
			return { type: 'ok' }
		},
		listWindows: async () => [WINDOW],
		captureWindow: async (id) => {
			captured.push(id)
			return {
				data: png,
				mimeType: 'image/png',
				width: 640,
				height: 400,
				window: WINDOW,
				captureId: 'w1',
			}
		},
		executeWindow: async () => {
			touched.push('executeWindow')
			return { delivery: 'delivered_unverified', retrySafety: 'unsafe' }
		},
		uiSnapshot: async (windowId) => snapshotOf(windowId),
		uiAct: async () => ({ ok: true }),
	}
	return { host, captured, touched }
}

function context(): ToolContext {
	return {
		sessionId: '0190a5b2-7c3d-7e4f-8a9b-0c1d2e3f4a5b' as never,
		turnId: '4adf3fdd-2823-4640-be0a-5d21fe28b6d2' as never,
		workingDirectory: '/tmp',
		abortSignal: new AbortController().signal,
		env: {},
		log: () => {},
	}
}

async function run(
	tool: ReturnType<typeof createComputerUseTool>,
	input: unknown,
): Promise<ToolResult> {
	return tool.execute(tool.inputSchema.parse(input), context())
}

/**
 * A list of applications the tool never acts in, checked before the host is touched: the
 * refusal comes from the tool itself, so it holds in every host and not only where a prompt
 * is followed.
 */

describe('computer_use and the applications put off limits', () => {
	it('refuses a window screenshot, a click and a key in a listed application, touching nothing', async () => {
		const { host, captured, touched } = makeHost()
		const tool = createComputerUseTool(host, { settleMs: 0, deniedApps: ['formapp'] })
		for (const input of [
			{ type: 'screenshot', window_id: '0x2b040a' },
			{ type: 'ui_snapshot', window_id: '0x2b040a' },
			{ type: 'focus_window', window_id: '0x2b040a' },
			{ type: 'key', keys: 'ENTER' },
			{ type: 'type_text', text: 'hello' },
			{ type: 'mouse_click', at: { x: 10, y: 10 }, button: 'left' },
			{ type: 'batch', actions: [{ type: 'key', keys: 'ENTER' }] },
		]) {
			const result = await run(tool, input)
			expect(result.success, JSON.stringify(input)).toBe(false)
			expect(result.error).toContain('off limits')
			expect(result.error).toContain('FormApp')
		}
		expect(captured).toEqual([])
		expect(touched).toEqual([])
	})

	it('matches without regard to case, spaces around the name or a trailing .exe', async () => {
		const { host } = makeHost()
		const tool = createComputerUseTool(host, { settleMs: 0, deniedApps: ['  FORMAPP.EXE '] })
		expect((await run(tool, { type: 'screenshot', window_id: '0x2b040a' })).success).toBe(false)
	})

	it('leaves other applications, a look at the whole display alone', async () => {
		const { host, captured } = makeHost()
		const tool = createComputerUseTool(host, { settleMs: 0, deniedApps: ['Other'] })
		expect((await run(tool, { type: 'screenshot', window_id: '0x2b040a' })).success).toBe(true)
		expect(captured).toEqual(['0x2b040a'])
		const listed = createComputerUseTool(host, { settleMs: 0, deniedApps: ['FormApp'] })
		// This fake host has no display to capture; what matters is that the refusal is not the list's.
		expect((await run(listed, { type: 'screenshot' })).error ?? '').not.toContain('off limits')
	})

	it('changes nothing when the list is absent or empty', async () => {
		const { host } = makeHost()
		for (const options of [{}, { deniedApps: [] }]) {
			const tool = createComputerUseTool(host, { settleMs: 0, ...options })
			expect((await run(tool, { type: 'screenshot', window_id: '0x2b040a' })).success).toBe(true)
		}
	})

	it('refuses an action it cannot place when the host cannot list windows', async () => {
		const { host, touched } = makeHost()
		const blind: ComputerUseHost = { ...host, listWindows: undefined }
		const tool = createComputerUseTool(blind, { settleMs: 0, deniedApps: ['Other'] })
		const result = await run(tool, { type: 'key', keys: 'ENTER' })
		expect(result.success).toBe(false)
		expect(result.error).toContain('cannot tell which application')
		expect(touched).toEqual([])
	})
})
