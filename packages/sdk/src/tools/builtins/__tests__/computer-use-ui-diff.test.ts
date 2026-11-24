import { encode } from 'fast-png'
import { describe, expect, it } from 'vitest'
import type {
	ComputerUseHost,
	UiElement,
	UiSnapshot,
	WindowInfo,
} from '../../../types/computer-use/index.js'
import type { ToolContext, ToolResult } from '../../../types/tool/index.js'
import { createComputerUseTool } from '../computer-use.js'

/**
 * `ui_snapshot` after the first read of a window: what changed, a clear
 * no-change line, the whole tree on request, the focused control and
 * selected text, and the controls that come with a window's first look.
 */

const png = Buffer.from(
	encode({
		width: 64,
		height: 64,
		data: new Uint8Array(64 * 64 * 3).fill(90),
		channels: 3,
		depth: 8,
	}),
)

const WINDOW: WindowInfo = {
	id: '0x10',
	title: 'Form',
	app: 'Forms',
	pid: 7,
	bounds: { x: 0, y: 0, width: 64, height: 64 },
	focused: true,
	minimized: false,
}

function button(name: string, extra: Partial<UiElement> = {}): UiElement {
	return {
		ref: `h:${name}`,
		role: 'Button',
		name,
		actions: ['invoke'],
		...extra,
	}
}

function form(children: UiElement[], extra: Partial<UiSnapshot> = {}): UiSnapshot {
	return {
		windowId: '0x10',
		root: { ref: '', role: 'Window', name: 'Form', children },
		total: children.length + 1,
		...extra,
	}
}

function makeHost(read: () => UiSnapshot) {
	const reads: (string | undefined)[] = []
	const host: ComputerUseHost = {
		id: 'diff-host',
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
		async execute() {
			return {
				type: 'screenshot',
				result: {
					data: png,
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
		listWindows: async () => [WINDOW],
		focusWindow: async (id) => ({ ok: true, focusedId: id }),
		captureWindow: async () => ({
			data: png,
			mimeType: 'image/png',
			width: 64,
			height: 64,
			window: WINDOW,
			captureId: 'w1',
		}),
		executeWindow: async () => undefined,
		async uiSnapshot(windowId) {
			reads.push(windowId)
			return read()
		},
		async uiAct() {
			return { ok: true }
		},
	}
	return { host, reads }
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

describe('ui_snapshot changes', () => {
	it('shows the whole tree the first time, then only what changed', async () => {
		let step = 0
		const { host } = makeHost(() =>
			step === 0
				? form([button('Save'), button('Cancel'), button('Help')])
				: form([button('Save', { states: ['disabled'] }), button('Cancel'), button('Close')]),
		)
		const tool = createComputerUseTool(host, { settleMs: 0 })
		const first = text(await run(tool, { type: 'ui_snapshot', window_id: '0x10' }))
		expect(first).toContain('4 controls shown of the 4 the window holds')
		expect(first).toContain('Button "Help"')
		step = 1
		const second = await run(tool, { type: 'ui_snapshot', window_id: '0x10' })
		const shown = text(second)
		expect(shown).toContain('1 added (+), 1 changed (~), 1 gone (-) since u1')
		expect(shown).toMatch(/\+ \[e\d+\] Button "Close"/)
		expect(shown).toMatch(/~ \[e1\] Button "Save" \(disabled\)/)
		expect(shown).toMatch(/- \[e3\] Button "Help"/)
		// What did not change is not repeated.
		expect(shown).not.toContain('Cancel')
		expect(second.data).toMatchObject({ uiSnapshot: { diff: 'changes' } })
	})

	it('says plainly when nothing changed, and every ref still works', async () => {
		const { host } = makeHost(() => form([button('Save'), button('Cancel')]))
		const tool = createComputerUseTool(host, { settleMs: 0 })
		await run(tool, { type: 'ui_snapshot', window_id: '0x10' })
		const again = await run(tool, { type: 'ui_snapshot', window_id: '0x10' })
		expect(text(again)).toContain('no change since u1')
		expect(text(again)).not.toContain('Button "Save"')
		expect(again.data).toMatchObject({ uiSnapshot: { diff: 'none' } })
		const act = await run(tool, {
			type: 'ui_act',
			ref: 'e1',
			action: 'invoke',
		})
		expect(act.success).toBe(true)
	})

	it('shows the whole tree again when asked, for a region or a filter, and when most of it changed', async () => {
		let step = 0
		const { host } = makeHost(() =>
			step === 0
				? form([button('A'), button('B'), button('C')])
				: form([button('X'), button('Y'), button('Z')]),
		)
		const tool = createComputerUseTool(host, { settleMs: 0 })
		await run(tool, { type: 'ui_snapshot', window_id: '0x10' })
		const full = text(await run(tool, { type: 'ui_snapshot', window_id: '0x10', full: true }))
		expect(full).toContain('Button "A"')
		expect(full).not.toContain('no change')
		const filtered = text(
			await run(tool, {
				type: 'ui_snapshot',
				window_id: '0x10',
				query: 'A',
				role: 'Button',
			}),
		)
		expect(filtered).toContain('only role "Button" and text "A"')
		expect(filtered).toContain('Button "A"')
		// Everything changed: the diff would be longer than the tree.
		step = 1
		const wholly = text(await run(tool, { type: 'ui_snapshot', window_id: '0x10' }))
		expect(wholly).toContain('Button "X"')
		expect(wholly).toContain('Button "Y"')
		expect(wholly).not.toContain('since u')
	})

	it('keeps a diff per window', async () => {
		let windowId = '0x10'
		const { host } = makeHost(() => ({ ...form([button('Save')]), windowId }))
		const tool = createComputerUseTool(host, { settleMs: 0 })
		await run(tool, { type: 'ui_snapshot', window_id: '0x10' })
		windowId = '0x20'
		const other = text(await run(tool, { type: 'ui_snapshot', window_id: '0x20' }))
		expect(other).toContain('Button "Save"')
		expect(other).not.toContain('no change')
	})

	it('ends with the focused control and the selected text, in a diff as well', async () => {
		let step = 0
		const { host } = makeHost(() =>
			step === 0
				? form([
						button('Save'),
						{
							ref: 'h:q',
							role: 'Edit',
							name: 'Search',
							actions: ['set_value'],
						},
					])
				: form(
						[
							button('Save'),
							{
								ref: 'h:q',
								role: 'Edit',
								name: 'Search',
								value: 'inv',
								states: ['focused'],
								actions: ['set_value'],
							},
						],
						{ selectedText: 'inv' },
					),
		)
		const tool = createComputerUseTool(host, { settleMs: 0 })
		const first = text(await run(tool, { type: 'ui_snapshot', window_id: '0x10' }))
		expect(first).not.toContain('Focused:')
		step = 1
		const second = text(await run(tool, { type: 'ui_snapshot', window_id: '0x10' }))
		expect(second).toMatch(/~ \[e2\] Edit "Search" value="inv" \(focused\)/)
		expect(second).toMatch(/Focused: \[e2\] Edit "Search"/)
		expect(second).toContain('Selected text: "inv"')
	})
})

describe('the first look at a window', () => {
	it('comes with the window controls, once', async () => {
		const { host, reads } = makeHost(() => form([button('Save')]))
		const tool = createComputerUseTool(host, { settleMs: 0 })
		const first = await run(tool, { type: 'screenshot', window_id: '0x10' })
		const shown = text(first)
		expect(shown).toContain('UI snapshot u1 of window 0x10')
		expect(shown).toContain('Button "Save"')
		expect(reads).toEqual(['0x10'])
		const content = Array.isArray(first.content) ? first.content : []
		expect(content.at(-1)?.type).toBe('image')
		const later = text(await run(tool, { type: 'screenshot', window_id: '0x10' }))
		expect(later).not.toContain('UI snapshot')
		expect(reads).toEqual(['0x10'])
	})

	it('is the screenshot alone when the controls cannot be read', async () => {
		const { host } = makeHost(() => {
			throw new Error('no answer')
		})
		const tool = createComputerUseTool(host, { settleMs: 0 })
		const first = await run(tool, { type: 'screenshot', window_id: '0x10' })
		expect(first.success).toBe(true)
		expect(text(first)).not.toContain('UI snapshot')
	})
})
