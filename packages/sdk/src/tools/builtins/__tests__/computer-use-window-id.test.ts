import { encode } from 'fast-png'
import { describe, expect, it } from 'vitest'
import type { ComputerUseHost, UiSnapshot, WindowInfo } from '../../../types/computer-use/index.js'
import type { ToolContext, ToolResult } from '../../../types/tool/index.js'
import { coerceWindowId, windowKey, windowNumber } from '../computer-use-window-id.js'
import { createComputerUseTool } from '../computer-use.js'

/**
 * A window has one number and several spellings. A list prints it `0x2b040a`, a driver message
 * `2819082`, and a model may send either, a bare number, or a handle object: everything the tool
 * remembers about the window must agree whichever spelling each step used.
 */

describe('the spellings of a window id', () => {
	it('reads decimal, hex, a number and a handle object as the same window', () => {
		expect(windowNumber('2819082')).toBe(0x2b040a)
		expect(windowNumber('0x2b040a')).toBe(0x2b040a)
		expect(windowNumber('0X2B040A')).toBe(0x2b040a)
		expect(windowNumber(2819082)).toBe(0x2b040a)
		expect(windowNumber({ hwnd: 2819082 })).toBe(0x2b040a)
		expect(windowNumber({ window_id: '0x2b040a' })).toBe(0x2b040a)
		expect(windowNumber({ id: { nested: 1 } })).toBeUndefined()
		expect(windowNumber('0')).toBeUndefined()
		expect(windowNumber('main window')).toBeUndefined()
		expect(windowNumber(-5)).toBeUndefined()
	})

	it('keys every spelling alike, and leaves a name that is not a number as it is', () => {
		const keys = new Set(['2819082', '0x2b040a', ' 0x2B040A '].map(windowKey))
		expect(keys.size).toBe(1)
		expect(windowKey('main window')).toBe('main window')
		expect(windowKey(undefined)).toBe('')
	})

	it('turns a number or a handle object into the list spelling and keeps a string as sent', () => {
		expect(coerceWindowId(2819082)).toBe('0x2b040a')
		expect(coerceWindowId({ hwnd: 2819082 })).toBe('0x2b040a')
		expect(coerceWindowId('2819082')).toBe('2819082')
		expect(coerceWindowId(undefined)).toBeUndefined()
	})
})

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
		execute: async () => ({ type: 'ok' }),
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
		executeWindow: async () => ({ delivery: 'delivered_unverified', retrySafety: 'unsafe' }),
		uiSnapshot: async (windowId) => snapshotOf(windowId),
		uiAct: async () => ({ ok: true }),
	}
	return { host, captured }
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

const text = (result: ToolResult): string =>
	(Array.isArray(result.content) ? result.content : [])
		.filter((block): block is { type: 'text'; text: string } => block.type === 'text')
		.map((block) => block.text)
		.join('\n')

describe('the tool across spellings of one window id', () => {
	it('takes a number or a handle object where a window id goes', async () => {
		const { host, captured } = makeHost()
		const tool = createComputerUseTool(host, { settleMs: 0 })
		expect((await run(tool, { type: 'screenshot', window_id: 2819082 })).success).toBe(true)
		expect((await run(tool, { type: 'screenshot', window_id: { hwnd: 2819082 } })).success).toBe(
			true,
		)
		expect(captured).toEqual(['0x2b040a', '0x2b040a'])
	})

	it('knows a window it read by its decimal id is the one a later screenshot shows by its hex id', async () => {
		const { host } = makeHost()
		const tool = createComputerUseTool(host, { settleMs: 0 })
		// The tree was read under the spelling a driver message uses ...
		await run(tool, { type: 'ui_snapshot', window_id: '2819082' })
		// ... and the screenshot, and the click on it, carry the spelling a list prints.
		await run(tool, { type: 'screenshot', window_id: '0x2b040a' })
		const click = await run(tool, { type: 'mouse_click', at: { x: 10, y: 10 }, button: 'left' })
		expect(text(click)).toContain('This window has controls with refs')
		expect(text(click)).not.toContain('Read this window with ui_snapshot before clicking')
	})
})
