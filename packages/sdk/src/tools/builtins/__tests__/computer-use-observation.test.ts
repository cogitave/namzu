import { encode } from 'fast-png'
import { describe, expect, it } from 'vitest'
import type {
	ComputerUseAction,
	ComputerUseHost,
	ComputerUseResult,
	UiSnapshot,
	WindowInfo,
} from '../../../types/computer-use/index.js'
import type { ToolContext, ToolResult } from '../../../types/tool/index.js'
import { type ComputerUseObservation, createComputerUseTool } from '../computer-use.js'

/**
 * What a host that shows a person the computer work needs from the tool: which application a call
 * works on, which calls close or delete, the picture the model received, and the first use of each
 * application.
 */

const png = Buffer.from(
	encode({
		width: 1600,
		height: 1000,
		data: new Uint8Array(1600 * 1000 * 3).fill(120),
		channels: 3,
		depth: 8,
	}),
)

const win = (id: string, app: string, x: number, focused: boolean): WindowInfo => ({
	id,
	title: `${app} window`,
	app,
	pid: 100 + Number(id),
	bounds: { x, y: 0, width: 800, height: 1000 },
	focused,
	minimized: false,
})

function makeHost(): ComputerUseHost {
	const windows = [win('1', 'Notepad', 0, true), win('2', 'Edge', 800, false)]
	return {
		id: 'obs-host',
		capabilities: {
			displayServer: 'win32',
			screenshot: true,
			mouse: true,
			keyboard: true,
			cursorPosition: true,
			clipboard: false,
			windows: true,
			uiTree: true,
		},
		async getDisplayGeometry() {
			return { width: 1600, height: 1000, scaleFactor: 1 }
		},
		async execute(action: ComputerUseAction): Promise<ComputerUseResult> {
			return action.type === 'screenshot'
				? {
						type: 'screenshot',
						result: {
							data: png,
							mimeType: 'image/png',
							width: 1600,
							height: 1000,
							display: { id: 'p', x: 0, y: 0, width: 1600, height: 1000, scaleFactor: 1 },
						},
					}
				: { type: 'ok' }
		},
		listWindows: async () => windows,
		focusWindow: async (id) => ({ ok: true, focusedId: id }),
		async uiSnapshot(): Promise<UiSnapshot> {
			return {
				windowId: '1',
				title: 'Save',
				app: 'Notepad',
				root: {
					ref: '',
					role: 'Window',
					name: 'Save',
					children: [
						{ ref: 'h:five', role: 'Button', name: 'Beş', actions: ['invoke'] },
						{ ref: 'h:dont', role: 'Button', name: 'Kaydetme', actions: ['invoke'] },
					],
				},
			}
		},
		async uiAct() {
			return { ok: true }
		},
	}
}

const context = (id = 'call-1'): ToolContext => ({
	sessionId: '0190a5b2-7c3d-7e4f-8a9b-0c1d2e3f4a5b' as never,
	turnId: '4adf3fdd-2823-4640-be0a-5d21fe28b6d2' as never,
	workingDirectory: '/tmp',
	abortSignal: new AbortController().signal,
	env: {},
	log: () => {},
	toolUseId: id,
})

async function run(
	tool: ReturnType<typeof createComputerUseTool>,
	input: unknown,
	id?: string,
): Promise<ToolResult> {
	return tool.execute(tool.inputSchema.parse(input), context(id))
}

describe('the application a computer call works on', () => {
	it('is the window under a click on the display, and the window in front for keys', async () => {
		const tool = createComputerUseTool(makeHost(), { settleMs: 0 })
		await run(tool, { type: 'screenshot' })
		expect(await tool.appOf({ type: 'mouse_click', at: { x: 100, y: 100 } })).toBe('Notepad')
		expect(await tool.appOf({ type: 'mouse_click', at: { x: 1000, y: 100 } })).toBe('Edge')
		expect(await tool.appOf({ type: 'key', keys: 'CTRL+S' })).toBe('Notepad')
	})

	it('is the window a call names', async () => {
		const tool = createComputerUseTool(makeHost(), { settleMs: 0 })
		expect(await tool.appOf({ type: 'screenshot', window_id: '2' })).toBe('Edge')
		expect(await tool.appOf({ type: 'focus_window', window_id: '9' })).toBeUndefined()
	})

	it('lists every application a batch reaches, not only the first', async () => {
		const tool = createComputerUseTool(makeHost(), { settleMs: 0 })
		await run(tool, { type: 'screenshot' })
		const batch = {
			type: 'batch',
			actions: [
				{ type: 'mouse_click', at: { x: 100, y: 100 } },
				{ type: 'mouse_click', at: { x: 1000, y: 100 } },
				{ type: 'mouse_click', at: { x: 110, y: 110 } },
			],
		}
		expect(await tool.appsOf(batch)).toEqual(['Notepad', 'Edge'])
		expect(await tool.appOf(batch)).toBe('Notepad')
	})

	it('is not guessed when the host cannot list windows', async () => {
		const host = makeHost()
		const { listWindows: _gone, ...bare } = host
		const tool = createComputerUseTool(bare as ComputerUseHost, { settleMs: 0 })
		await run(tool, { type: 'screenshot' })
		expect(await tool.appOf({ type: 'mouse_click', at: { x: 5, y: 5 } })).toBeUndefined()
	})
})

describe('a call that is still put to a person in an allowed application', () => {
	it('is a key that closes or deletes, never an ordinary one', () => {
		const tool = createComputerUseTool(makeHost(), { settleMs: 0 })
		expect(tool.consequence({ type: 'key', keys: 'ALT+F4' })).toBe('presses ALT+F4')
		expect(tool.consequence({ type: 'key', keys: 'ctrl+q' })).toBeDefined()
		expect(tool.consequence({ type: 'key', keys: 'DELETE' })).toBeDefined()
		expect(tool.consequence({ type: 'key', keys: 'CTRL+L' })).toBeUndefined()
		expect(tool.consequence({ type: 'type_text', text: 'delete everything' })).toBeUndefined()
	})

	it('is a control whose name says it discards, sends or closes, in Turkish too', async () => {
		const tool = createComputerUseTool(makeHost(), { settleMs: 0 })
		await run(tool, { type: 'screenshot' })
		await run(tool, { type: 'ui_snapshot', window_id: '1' })
		const dont = [...Array(8).keys()]
			.map((n) => `e${n + 1}`)
			.find((ref) => tool.describeUiRef(ref)?.includes('Kaydetme'))
		const five = [...Array(8).keys()]
			.map((n) => `e${n + 1}`)
			.find((ref) => tool.describeUiRef(ref)?.includes('Beş'))
		expect(dont && tool.consequence({ type: 'ui_act', ref: dont, action: 'invoke' })).toContain(
			'Kaydetme',
		)
		expect(
			five && tool.consequence({ type: 'ui_act', ref: five, action: 'invoke' }),
		).toBeUndefined()
		expect(
			tool.consequence({ type: 'ui_act', ref: 'e1', action: 'invoke', intent: 'delete the file' }),
		).toBeDefined()
	})

	it('is found inside a batch', () => {
		const tool = createComputerUseTool(makeHost(), { settleMs: 0 })
		expect(
			tool.consequence({
				type: 'batch',
				actions: [
					{ type: 'key', keys: 'CTRL+A' },
					{ type: 'key', keys: 'ALT+F4' },
				],
			}),
		).toBe('presses ALT+F4')
	})
})

// Each call here decodes, scales and re-encodes a 1600x1000 PNG in plain
// JavaScript. Locally a test takes well under a second; under the coverage
// run on a shared CI runner the same CPU work has taken more than five, so the
// limit is raised for this group only. Nothing here waits on a clock.
describe('what the person is shown of a call', { timeout: 30_000 }, () => {
	it('is the picture the model got, made small, with the click point as fractions', async () => {
		const seen: ComputerUseObservation[] = []
		const tool = createComputerUseTool(makeHost(), {
			settleMs: 0,
			onObservation: (observation) => seen.push(observation),
		})
		// The model looked at the windows before acting, as it is told to.
		await run(tool, { type: 'list_windows' }, 'call-w')
		const look = await run(tool, { type: 'screenshot' }, 'call-0')
		const shot = (look.data as { screenshot: { width: number; height: number } }).screenshot
		await run(tool, { type: 'mouse_click', at: { x: 400, y: 250 } }, 'call-1')
		const click = seen.at(-1) as ComputerUseObservation
		expect(click).toMatchObject({
			toolUseId: 'call-1',
			app: 'Notepad',
			mimeType: 'image/png',
		})
		expect(Math.max(click.width, click.height)).toBeLessThanOrEqual(720)
		expect(Buffer.from(click.data, 'base64').subarray(1, 4).toString()).toBe('PNG')
		// Where the model clicked, as a share of the screenshot it clicked on.
		expect(click.point?.x).toBeCloseTo(400 / shot.width, 3)
		expect(click.point?.y).toBeCloseTo(250 / shot.height, 3)
		expect(click.action.toLowerCase()).toContain('click')
		// A look at the screen has no click point.
		expect(seen[0]?.point).toBeUndefined()
	})

	it('costs the host one window read to place a display call, none to name its application', async () => {
		const host = makeHost()
		let lists = 0
		const listed = host.listWindows as NonNullable<ComputerUseHost['listWindows']>
		host.listWindows = async (signal) => {
			lists++
			return listed(signal)
		}
		const tool = createComputerUseTool(host, { settleMs: 0 })
		await run(tool, { type: 'screenshot' })
		await run(tool, { type: 'mouse_click', at: { x: 100, y: 100 } })
		// One read places the call for the app-kind check; naming the app adds none.
		expect(lists).toBe(1)
		// A review screen asking for it before the call does read the windows.
		await tool.appOf({ type: 'mouse_click', at: { x: 100, y: 100 } })
		expect(lists).toBe(2)
	})

	it('never changes the call when the host observer throws', async () => {
		const tool = createComputerUseTool(makeHost(), {
			settleMs: 0,
			onObservation: () => {
				throw new Error('view closed')
			},
		})
		const result = await run(tool, { type: 'screenshot' })
		expect(result.success).toBe(true)
	})

	it('says "Using <app>" once, on the first call that works in it', async () => {
		const tool = createComputerUseTool(makeHost(), { settleMs: 0 })
		await run(tool, { type: 'list_windows' })
		await run(tool, { type: 'screenshot' })
		const first = await run(tool, { type: 'mouse_click', at: { x: 100, y: 100 } })
		expect(first.data).toMatchObject({ firstUseOf: 'Notepad' })
		expect(tool.presentResult?.({ type: 'mouse_click' } as never, first)).toMatchObject({
			label: 'Using Notepad',
		})
		// A lowercase process name reads as a name.
		expect(
			tool.presentResult?.({ type: 'mouse_click' } as never, {
				...first,
				data: { firstUseOf: 'msedge.exe' },
			}),
		).toMatchObject({ label: 'Using Microsoft Edge' })
		const second = await run(tool, { type: 'mouse_click', at: { x: 120, y: 120 } })
		expect(second.data).not.toHaveProperty('firstUseOf')
		const other = await run(tool, { type: 'mouse_click', at: { x: 1000, y: 100 } })
		expect(other.data).toMatchObject({ firstUseOf: 'Edge' })
	})
})
