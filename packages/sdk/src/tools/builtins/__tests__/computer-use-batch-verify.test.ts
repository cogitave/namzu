import { encode } from 'fast-png'
import { describe, expect, it } from 'vitest'
import type {
	ComputerUseHost,
	UiActResult,
	UiElement,
	UiSnapshot,
	WindowInfo,
} from '../../../types/computer-use/index.js'
import type { ToolContext, ToolResult } from '../../../types/tool/index.js'
import { createComputerUseTool } from '../computer-use.js'

/**
 * How a batch ends and what a pixel action says about itself: the window's
 * controls when they were read, the picture when not; a click refused when
 * its window moved; "no visible change"; and a window the action closed.
 */

const picture = (shade: number): Buffer =>
	Buffer.from(
		encode({
			width: 64,
			height: 64,
			data: new Uint8Array(64 * 64 * 3).fill(shade),
			channels: 3,
			depth: 8,
		}),
	)

const BASE: WindowInfo = {
	id: '0x10',
	title: 'Form',
	app: 'Forms',
	pid: 7,
	bounds: { x: 10, y: 20, width: 64, height: 64 },
	focused: true,
	minimized: false,
}

function button(name: string): UiElement {
	return {
		ref: `h:${name}`,
		role: 'Button',
		name,
		actions: ['invoke'],
	}
}

interface Fixture {
	listed: WindowInfo[]
	shade: number
	captureFails: boolean
	tree: UiElement[]
	actResult: (ref: string) => UiActResult
	sent: string[]
	events: string[]
}

function makeHost(overrides: Partial<Fixture> = {}) {
	const fixture: Fixture = {
		listed: [BASE],
		shade: 90,
		captureFails: false,
		tree: [button('Save'), button('Close')],
		actResult: () => ({ ok: true }),
		sent: [],
		events: [],
		...overrides,
	}
	const host: ComputerUseHost = {
		id: 'verify-host',
		capabilities: {
			displayServer: 'win32',
			screenshot: true,
			mouse: true,
			keyboard: true,
			cursorPosition: true,
			clipboard: false,
			windows: true,
			windowCapture: true,
			uiTree: true,
		},
		getDisplayGeometry: async () => ({ width: 64, height: 64, scaleFactor: 1 }),
		async execute(action) {
			fixture.events.push(`display:${action.type}`)
			return {
				type: 'screenshot',
				result: {
					data: picture(200),
					mimeType: 'image/png',
					width: 64,
					height: 64,
					display: {
						id: 'p',
						x: 0,
						y: 0,
						width: 64,
						height: 64,
						scaleFactor: 1,
					},
				},
			}
		},
		listWindows: async () => fixture.listed,
		focusWindow: async (id) => ({ ok: true, focusedId: id }),
		captureWindow: async (id) => {
			fixture.events.push('capture')
			if (fixture.captureFails) throw new Error('window not found')
			return {
				data: picture(fixture.shade),
				mimeType: 'image/png',
				width: 64,
				height: 64,
				window: fixture.listed.find((w) => w.id === id) ?? BASE,
				captureId: 'w1',
			}
		},
		executeWindow: async (_captureId, action) => {
			fixture.sent.push(action.type)
			return undefined
		},
		async uiSnapshot(): Promise<UiSnapshot> {
			fixture.events.push('tree')
			return {
				windowId: '0x10',
				root: {
					ref: '',
					role: 'Window',
					name: 'Form',
					children: fixture.tree,
				},
				total: fixture.tree.length + 1,
			}
		},
		async uiAct(ref) {
			fixture.sent.push(`act:${ref}`)
			return fixture.actResult(ref)
		},
	}
	return { host, fixture }
}

const context = (): ToolContext => ({
	sessionId: '0190a5b2-7c3d-7e4f-8a9b-0c1d2e3f4a5b' as never,
	turnId: '4adf3fdd-2823-4640-be0a-5d21fe28b6d2' as never,
	workingDirectory: '/tmp',
	abortSignal: new AbortController().signal,
	env: {},
	log: () => {},
})

async function run(
	tool: ReturnType<typeof createComputerUseTool>,
	input: unknown,
): Promise<ToolResult> {
	return tool.execute(tool.inputSchema.parse(input), context())
}

function text(result: ToolResult): string {
	const content = Array.isArray(result.content) ? result.content : []
	return content
		.filter((block): block is { type: 'text'; text: string } => block.type === 'text')
		.map((block) => block.text)
		.join('\n')
}

const hasImage = (result: ToolResult): boolean =>
	Array.isArray(result.content) && result.content.some((block) => block.type === 'image')

const click = { type: 'mouse_click', at: { x: 5, y: 5 }, button: 'left' }

describe("a batch ends with the window's controls", () => {
	it('shows what changed in the window instead of a picture, once the window was read', async () => {
		const { host, fixture } = makeHost()
		const tool = createComputerUseTool(host, { settleMs: 0 })
		await run(tool, { type: 'ui_snapshot', window_id: '0x10' })
		fixture.tree = [button('Save'), button('Close'), button('Undo')]
		fixture.events.length = 0
		const result = await run(tool, {
			type: 'batch',
			actions: [
				{ type: 'ui_act', ref: 'e1', action: 'invoke' },
				{ type: 'ui_act', ref: 'e2', action: 'invoke' },
			],
		})
		expect(result.success).toBe(true)
		expect(text(result)).toContain('Batch: all 2 actions done.')
		expect(text(result)).toContain('+ [e3] Button "Undo"')
		expect(text(result)).toContain('Undo')
		expect(hasImage(result)).toBe(false)
		expect(fixture.events).not.toContain('capture')
		expect(result.data).toHaveProperty('uiSnapshot.diff', 'changes')
	})

	it('says nothing changed when the window did not', async () => {
		const { host } = makeHost()
		const tool = createComputerUseTool(host, { settleMs: 0 })
		await run(tool, { type: 'ui_snapshot', window_id: '0x10' })
		const result = await run(tool, {
			type: 'batch',
			actions: [{ type: 'ui_act', ref: 'e1', action: 'invoke' }],
		})
		expect(text(result)).toContain('no change since')
		expect(hasImage(result)).toBe(false)
	})

	it("ends with a picture when the window's controls were never read", async () => {
		const { host } = makeHost({ tree: [] })
		const tool = createComputerUseTool(host, { settleMs: 0 })
		await run(tool, { type: 'screenshot', window_id: '0x10' })
		const result = await run(tool, {
			type: 'batch',
			actions: [{ type: 'key', keys: 'ENTER' }],
		})
		expect(hasImage(result)).toBe(true)
	})

	it('keeps the picture after a pixel step, which needs coordinates for the next one', async () => {
		const { host } = makeHost()
		const tool = createComputerUseTool(host, { settleMs: 0 })
		await run(tool, { type: 'ui_snapshot', window_id: '0x10' })
		await run(tool, { type: 'screenshot', window_id: '0x10' })
		const result = await run(tool, { type: 'batch', actions: [click] })
		expect(hasImage(result)).toBe(true)
	})

	it('stops at the first element check that fails and runs nothing after it', async () => {
		const { host, fixture } = makeHost({
			actResult: (ref) =>
				ref === 'h:Close'
					? { ok: false, code: 'STALE_REF', detail: 'the control is gone' }
					: { ok: true },
		})
		const tool = createComputerUseTool(host, { settleMs: 0 })
		await run(tool, { type: 'ui_snapshot', window_id: '0x10' })
		fixture.sent.length = 0
		const result = await run(tool, {
			type: 'batch',
			actions: [
				{ type: 'ui_act', ref: 'e1', action: 'invoke' },
				{ type: 'ui_act', ref: 'e2', action: 'invoke' },
				{ type: 'key', keys: 'ENTER' },
			],
		})
		expect(result.success).toBe(false)
		expect(text(result)).toContain('Batch stopped at action 2 of 3')
		expect(text(result)).toContain('3. ')
		expect(text(result)).toContain('not run')
		expect(fixture.sent).toEqual(['act:h:Save', 'act:h:Close'])
	})

	it('tells the model the host settles, so it adds no waits', () => {
		const { host } = makeHost()
		const tool = createComputerUseTool(host, { settleMs: 400 })
		expect(tool.description).toContain('waits for the window to stop changing')
		expect(tool.description).toContain('do not add a wait')
		expect(tool.description).toContain('needs no wait between steps')
	})
})

describe('a click on a window that moved', () => {
	it('is refused, and nothing is sent', async () => {
		const { host, fixture } = makeHost()
		const tool = createComputerUseTool(host, { settleMs: 0 })
		await run(tool, { type: 'screenshot', window_id: '0x10' })
		fixture.listed = [{ ...BASE, bounds: { x: 300, y: 20, width: 64, height: 64 } }]
		const result = await run(tool, click)
		expect(result.success).toBe(false)
		expect(result.error).toContain('moved or was resized since s1 was taken')
		expect(result.error).toContain('Take a new window screenshot')
		expect(fixture.sent).toEqual([])
	})

	it('is refused when the window was resized', async () => {
		const { host, fixture } = makeHost()
		const tool = createComputerUseTool(host, { settleMs: 0 })
		await run(tool, { type: 'screenshot', window_id: '0x10' })
		fixture.listed = [{ ...BASE, bounds: { x: 10, y: 20, width: 80, height: 64 } }]
		const result = await run(tool, {
			type: 'scroll',
			at: { x: 5, y: 5 },
			direction: 'down',
			amount: 2,
		})
		expect(result.success).toBe(false)
		expect(result.error).toContain('resized')
		expect(fixture.sent).toEqual([])
	})

	it('is refused when the window is gone, and goes ahead when it did not move', async () => {
		const { host, fixture } = makeHost()
		const tool = createComputerUseTool(host, { settleMs: 0 })
		await run(tool, { type: 'screenshot', window_id: '0x10' })
		const fine = await run(tool, click)
		expect(fine.success).toBe(true)
		expect(fixture.sent).toEqual(['mouse_click'])
		fixture.listed = []
		const gone = await run(tool, click)
		expect(gone.success).toBe(false)
		expect(gone.error).toContain('no longer open')
		expect(fixture.sent).toEqual(['mouse_click'])
	})
})

describe('a pixel click that shows nothing', () => {
	it('says there was no visible change when the picture is the same', async () => {
		const { host } = makeHost()
		const tool = createComputerUseTool(host, { settleMs: 0 })
		await run(tool, { type: 'screenshot', window_id: '0x10' })
		const result = await run(tool, click)
		expect(result.success).toBe(true)
		expect(text(result)).toContain('No visible change')
		expect(result.data).toHaveProperty('noVisibleChange', true)
	})

	it('stays quiet when the picture changed', async () => {
		const { host, fixture } = makeHost()
		const tool = createComputerUseTool(host, { settleMs: 0 })
		await run(tool, { type: 'screenshot', window_id: '0x10' })
		fixture.shade = 120
		const result = await run(tool, click)
		expect(text(result)).not.toContain('No visible change')
		expect(result.data).not.toHaveProperty('noVisibleChange')
	})
})

describe('an action that closed its window', () => {
	it('says so, and shows what is left of the screen', async () => {
		const { host, fixture } = makeHost()
		const tool = createComputerUseTool(host, { settleMs: 0 })
		await run(tool, { type: 'ui_snapshot', window_id: '0x10' })
		const real = host.uiSnapshot as NonNullable<ComputerUseHost['uiSnapshot']>
		host.uiAct = async (ref) => {
			fixture.sent.push(`act:${ref}`)
			// The window goes away with the press.
			fixture.listed = []
			fixture.captureFails = true
			return { ok: true }
		}
		host.uiSnapshot = async (...args) => {
			if (fixture.captureFails) throw new Error('window not found')
			return real.apply(host, args)
		}
		const result = await run(tool, {
			type: 'batch',
			actions: [{ type: 'ui_act', ref: 'e2', action: 'invoke' }],
		})
		expect(result.success).toBe(true)
		expect(text(result)).toContain('is no longer open: the action closed it')
		expect(result.data).toHaveProperty('windowClosed', '0x10')
		expect(result.data).toHaveProperty('screenshot.display.id', 'p')
	})
})

describe('a window that opened during a batch', () => {
	it('is named after the controls of the window that was acted on', async () => {
		const { host, fixture } = makeHost()
		const tool = createComputerUseTool(host, { settleMs: 0 })
		await run(tool, { type: 'ui_snapshot', window_id: '0x10' })
		await run(tool, { type: 'screenshot', window_id: '0x10' })
		await run(tool, { type: 'ui_snapshot', window_id: '0x10' })
		await tool.execute(tool.inputSchema.parse({ type: 'list_windows' }), context())
		host.uiAct = async () => {
			fixture.listed = [{ ...BASE, id: '0x99', title: 'Really delete?', app: 'Forms' }, BASE]
			return { ok: true }
		}
		const result = await run(tool, {
			type: 'batch',
			actions: [{ type: 'ui_act', ref: 'e2', action: 'invoke' }],
		})
		expect(text(result)).toContain('A new window opened during the batch')
		expect(text(result)).toContain('0x99')
		expect(text(result)).toContain('Really delete?')
	})
})
