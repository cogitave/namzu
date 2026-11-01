import { encode } from 'fast-png'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
	ComputerUseHost,
	ComputerUseResult,
	UiActResult,
	UiElement,
	UiSnapshot,
	WindowInfo,
	WindowInputResult,
} from '../../../types/computer-use/index.js'
import type { ToolContext, ToolResult } from '../../../types/tool/index.js'
import { createComputerUseTool } from '../computer-use.js'

/**
 * What the tool tells the model about an action's effect: "done" only for a
 * verified delivery, "sent, not confirmed" for the rest of what was sent, a
 * failure that says it is safe to try again for what never arrived; and
 * wait_for instead of fixed sleeps.
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

function tree(...names: string[]): UiSnapshot {
	return {
		windowId: '0x10',
		title: 'Form',
		root: {
			ref: '',
			role: 'Window',
			name: 'Form',
			children: names.map(
				(name, i): UiElement => ({
					ref: `h:${i}`,
					role: 'Button',
					name,
					actions: ['invoke'],
				}),
			),
		},
	}
}

interface Options {
	act?: (ref: string) => UiActResult
	snapshots?: () => UiSnapshot
	windows?: () => readonly WindowInfo[]
	display?: () => ComputerUseResult
	window?: () => WindowInputResult | undefined
	maxWaitMs?: number
}

function makeHost(options: Options = {}) {
	const reads: (string | undefined)[] = []
	const host: ComputerUseHost = {
		id: 'delivery-host',
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
		getDisplayGeometry: async () => ({ width: 640, height: 400, scaleFactor: 1 }),
		async execute(action) {
			if (action.type === 'screenshot')
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
			return options.display?.() ?? { type: 'ok' }
		},
		listWindows: async () => options.windows?.() ?? [WINDOW],
		focusWindow: async (id) => ({ ok: true, focusedId: id }),
		captureWindow: async () => ({
			data: png,
			mimeType: 'image/png',
			width: 640,
			height: 400,
			window: WINDOW,
			captureId: 'w1',
		}),
		executeWindow: async () => options.window?.(),
		async uiSnapshot(windowId) {
			reads.push(windowId)
			return options.snapshots?.() ?? tree('OK', 'Cancel')
		},
		async uiAct(ref) {
			return options.act?.(ref) ?? { ok: true }
		},
	}
	return { host, reads }
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

async function run(
	tool: ReturnType<typeof createComputerUseTool>,
	input: unknown,
	signal?: AbortSignal,
): Promise<ToolResult> {
	return tool.execute(tool.inputSchema.parse(input), context(signal))
}

function text(result: ToolResult): string {
	const content = Array.isArray(result.content) ? result.content : []
	return content
		.filter((block): block is { type: 'text'; text: string } => block.type === 'text')
		.map((block) => block.text)
		.join('\n')
}

const FAST = { settleMs: 0 }

async function withRefs(tool: ReturnType<typeof createComputerUseTool>) {
	await run(tool, { type: 'ui_snapshot', window_id: '0x10' })
}

afterEach(() => {
	vi.useRealTimers()
})

describe('ui_act delivery', () => {
	it('says done, verified only for a read-back delivery, and shows what it read', async () => {
		const { host } = makeHost({
			act: () => ({
				ok: true,
				delivery: 'delivered_verified',
				retrySafety: 'safe',
				readBack: { expected: 'Ada', observed: 'Ada' },
			}),
		})
		const tool = createComputerUseTool(host, FAST)
		await withRefs(tool)
		const result = await run(tool, { type: 'ui_act', ref: 'e1', action: 'invoke' })
		expect(result.success).toBe(true)
		expect(text(result)).toContain('done, verified (reads "Ada")')
		expect(result.data).toMatchObject({
			steps: [{ status: 'done', delivery: 'delivered_verified', retrySafety: 'safe' }],
		})
	})

	it('says sent, not confirmed when nothing could check, and tells the model not to repeat it', async () => {
		const { host } = makeHost({
			act: () => ({
				ok: true,
				delivery: 'delivered_unverified',
				retrySafety: 'unsafe',
				detail: 'the toggle was sent, but the control still reads the same.',
			}),
		})
		const tool = createComputerUseTool(host, FAST)
		await withRefs(tool)
		const result = await run(tool, { type: 'ui_act', ref: 'e1', action: 'invoke' })
		expect(result.success).toBe(true)
		const shown = text(result)
		expect(shown).toContain('sent, not confirmed')
		expect(shown).toContain('Do not repeat it before checking.')
		expect(shown).not.toMatch(/: done/)
		expect(result.data).toMatchObject({
			steps: [{ delivery: 'delivered_unverified', retrySafety: 'unsafe' }],
		})
	})

	it('fails a control that was not delivered, as safe to try again', async () => {
		const { host } = makeHost({
			act: () => ({
				ok: false,
				delivery: 'not_delivered',
				retrySafety: 'safe',
				detail: 'the control still holds "red".',
			}),
		})
		const tool = createComputerUseTool(host, FAST)
		await withRefs(tool)
		const result = await run(tool, { type: 'ui_act', ref: 'e2', action: 'invoke' })
		expect(result.success).toBe(false)
		expect(result.error).toContain('still holds "red"')
		expect(result.error).toContain('Not delivered')
		expect(result.data).toMatchObject({
			steps: [{ status: 'failed', delivery: 'not_delivered', retrySafety: 'safe' }],
		})
	})

	it('keeps a failure that may have acted marked as unsafe to repeat', async () => {
		const { host } = makeHost({
			act: () => ({
				ok: false,
				delivery: 'delivered_unverified',
				retrySafety: 'unsafe',
				detail: 'the driver suspects the input changed nothing.',
			}),
		})
		const tool = createComputerUseTool(host, FAST)
		await withRefs(tool)
		const result = await run(tool, { type: 'ui_act', ref: 'e1', action: 'invoke' })
		expect(result.success).toBe(false)
		expect(result.error).toContain('It may have taken effect')
		expect(result.data).toMatchObject({ steps: [{ delivery: 'delivered_unverified' }] })
	})

	it('still says plain done for a host that does not classify', async () => {
		const { host } = makeHost()
		const tool = createComputerUseTool(host, FAST)
		await withRefs(tool)
		const result = await run(tool, { type: 'ui_act', ref: 'e1', action: 'invoke' })
		expect(text(result)).toMatch(/: done/)
	})
})

describe('window and display input delivery', () => {
	it('reports a window keystroke the host could not confirm as sent, not done', async () => {
		const { host } = makeHost({
			window: () => ({
				delivery: 'delivered_unverified',
				retrySafety: 'unsafe',
				detail: 'the driver could not confirm that the input arrived.',
			}),
		})
		const tool = createComputerUseTool(host, FAST)
		await run(tool, { type: 'screenshot', window_id: '0x10' })
		const result = await run(tool, { type: 'type_text', text: 'abc' })
		expect(result.success).toBe(true)
		expect(text(result)).toContain('sent, not confirmed')
		expect(text(result)).not.toMatch(/Type "abc": done/)
	})

	it('fails a window input the host refused, as not delivered', async () => {
		const { host } = makeHost({
			window: () => ({
				delivery: 'not_delivered',
				retrySafety: 'safe',
				detail: 'this window cannot take background input here.',
			}),
		})
		const tool = createComputerUseTool(host, FAST)
		await run(tool, { type: 'screenshot', window_id: '0x10' })
		const result = await run(tool, { type: 'type_text', text: 'abc' })
		expect(result.success).toBe(false)
		expect(result.error).toContain('cannot take background input')
		expect(result.data).toMatchObject({
			steps: [{ delivery: 'not_delivered', retrySafety: 'safe' }],
		})
	})

	it('reports a display click that ended with another window in front as unverified', async () => {
		const { host } = makeHost({
			display: () => ({
				type: 'ok',
				delivery: 'delivered_unverified',
				retrySafety: 'unsafe',
				detail: 'the click was sent, but another window was in front afterwards.',
			}),
		})
		const tool = createComputerUseTool(host, FAST)
		await run(tool, { type: 'screenshot' })
		const result = await run(tool, { type: 'mouse_click', at: { x: 5, y: 5 } })
		expect(result.success).toBe(true)
		expect(text(result)).toContain('sent, not confirmed')
		expect(text(result)).toContain('another window was in front afterwards')
	})
})

describe('first coordinate click in a window', () => {
	it('gets a reminder, once, and is never refused', async () => {
		const { host } = makeHost()
		const tool = createComputerUseTool(host, FAST)
		await run(tool, { type: 'ui_snapshot', window_id: '0x10' })
		await run(tool, { type: 'screenshot', window_id: '0x10' })
		const first = await run(tool, { type: 'mouse_click', at: { x: 10, y: 10 } })
		expect(first.success).toBe(true)
		expect(text(first)).toContain('use ui_act on a ref')
		const second = await run(tool, { type: 'mouse_click', at: { x: 10, y: 10 } })
		expect(second.success).toBe(true)
		expect(text(second)).not.toContain('use ui_act on a ref')
	})

	it('points a window nobody has read at ui_snapshot, and stays quiet for a window with no controls', async () => {
		const unread = makeHost()
		const tool = createComputerUseTool(unread.host, FAST)
		await run(tool, { type: 'screenshot', window_id: '0x10' })
		expect(text(await run(tool, { type: 'mouse_click', at: { x: 1, y: 1 } }))).toContain(
			'Read this window with ui_snapshot',
		)
		const bare = makeHost({ snapshots: () => tree() })
		const second = createComputerUseTool(bare.host, FAST)
		await run(second, { type: 'ui_snapshot', window_id: '0x10' })
		await run(second, { type: 'screenshot', window_id: '0x10' })
		const result = await run(second, { type: 'mouse_click', at: { x: 1, y: 1 } })
		expect(result.success).toBe(true)
		expect(text(result)).not.toContain('ui_snapshot')
	})
})

describe('wait_for', () => {
	it('is its own call: offered at the top level and not inside a batch', () => {
		const tool = createComputerUseTool(makeHost().host, FAST)
		const schema = tool.modelInputSchema as {
			properties: Record<
				string,
				{ enum?: string[]; items?: { properties: Record<string, { enum?: string[] }> } }
			>
		}
		expect(schema.properties.type?.enum).toContain('wait_for')
		expect(schema.properties.actions?.items?.properties.type?.enum).not.toContain('wait_for')
		expect(schema.properties).toHaveProperty('until')
		expect(tool.isReadOnly?.({ type: 'wait_for', until: 'element_appears', match: 'x' })).toBe(true)
	})

	it('returns the controls as soon as an element appears, with fresh refs', async () => {
		vi.useFakeTimers()
		let reads = 0
		const { host } = makeHost({
			snapshots: () => (++reads < 3 ? tree('Wait') : tree('Wait', 'Save as')),
		})
		const tool = createComputerUseTool(host, FAST)
		const pending = run(tool, {
			type: 'wait_for',
			until: 'element_appears',
			match: 'save',
			role: 'button',
			window_id: '0x10',
		})
		await vi.advanceTimersByTimeAsync(5_000)
		const result = await pending
		expect(result.success).toBe(true)
		expect(reads).toBe(3)
		const shown = text(result)
		expect(shown).toContain('wait_for element appears "save": satisfied')
		expect(shown).toContain('Button "Save as"')
		expect(shown).toContain('UI snapshot u1')
		// The refs it shows are usable straight away.
		expect((await run(tool, { type: 'ui_act', ref: 'e2', action: 'invoke' })).success).toBe(true)
	})

	it('waits for an element to go and for text to appear', async () => {
		vi.useFakeTimers()
		let reads = 0
		const { host } = makeHost({ snapshots: () => (++reads < 2 ? tree('Busy') : tree('Done')) })
		const tool = createComputerUseTool(host, FAST)
		const gone = run(tool, {
			type: 'wait_for',
			until: 'element_gone',
			match: 'busy',
			window_id: '0x10',
		})
		await vi.advanceTimersByTimeAsync(2_000)
		expect((await gone).success).toBe(true)
		const text2 = run(tool, { type: 'wait_for', until: 'text_appears', match: 'DONE' })
		await vi.advanceTimersByTimeAsync(2_000)
		expect((await text2).success).toBe(true)
	})

	it('does not take a cut-off or empty tree as proof that something is gone', async () => {
		vi.useFakeTimers()
		let reads = 0
		const { host } = makeHost({
			snapshots: () => {
				reads++
				if (reads === 1) return { ...tree('Other'), truncated: true }
				if (reads === 2) return tree()
				return tree('Other')
			},
		})
		const tool = createComputerUseTool(host, FAST)
		const pending = run(tool, {
			type: 'wait_for',
			until: 'element_gone',
			match: 'busy',
			window_id: '0x10',
		})
		await vi.advanceTimersByTimeAsync(5_000)
		const result = await pending
		expect(result.success).toBe(true)
		expect(reads).toBe(3)
	})

	it('times out as a failure that shows where the window stands, and changes nothing', async () => {
		vi.useFakeTimers()
		const { host } = makeHost()
		const tool = createComputerUseTool(host, FAST)
		const pending = run(tool, {
			type: 'wait_for',
			until: 'element_appears',
			match: 'never',
			window_id: '0x10',
			timeout_ms: 2_000,
		})
		await vi.advanceTimersByTimeAsync(5_000)
		const result = await pending
		expect(result.success).toBe(false)
		expect(result.error).toContain('not satisfied within 2 s')
		expect(result.error).toContain('Nothing was changed')
		expect(text(result)).toContain('Button "OK"')
	})

	it('caps the timeout at the tool wait limit', async () => {
		vi.useFakeTimers()
		const { host, reads } = makeHost()
		const tool = createComputerUseTool(host, { ...FAST, maxWaitMs: 1_000 })
		const pending = run(tool, {
			type: 'wait_for',
			until: 'text_appears',
			match: 'never',
			window_id: '0x10',
			timeout_ms: 600_000,
		})
		await vi.advanceTimersByTimeAsync(5_000)
		expect((await pending).error).toContain('within 1 s')
		expect(reads.length).toBeLessThanOrEqual(4)
	})

	it('retries a read that failed instead of treating it as an answer', async () => {
		vi.useFakeTimers()
		let reads = 0
		const { host } = makeHost({
			snapshots: () => {
				if (++reads === 1) throw new Error('the window is busy')
				return tree('Ready')
			},
		})
		const tool = createComputerUseTool(host, FAST)
		const pending = run(tool, {
			type: 'wait_for',
			until: 'element_appears',
			match: 'ready',
			window_id: '0x10',
		})
		await vi.advanceTimersByTimeAsync(2_000)
		expect((await pending).success).toBe(true)
	})

	it('reports the last failed read when time runs out', async () => {
		vi.useFakeTimers()
		const { host } = makeHost({
			snapshots: () => {
				throw new Error('the window is busy')
			},
		})
		const tool = createComputerUseTool(host, FAST)
		const pending = run(tool, {
			type: 'wait_for',
			until: 'element_appears',
			match: 'x',
			window_id: '0x10',
			timeout_ms: 1_000,
		})
		await vi.advanceTimersByTimeAsync(3_000)
		expect((await pending).error).toContain('the last read failed: the window is busy')
	})

	it('waits for a window to open and to close from the window list', async () => {
		vi.useFakeTimers()
		let listed = 0
		const { host } = makeHost({
			windows: () => (++listed < 2 ? [] : [{ ...WINDOW, title: 'Save As' }]),
		})
		const tool = createComputerUseTool(host, FAST)
		const open = run(tool, { type: 'wait_for', until: 'window_appears', match: 'save as' })
		await vi.advanceTimersByTimeAsync(2_000)
		expect(text(await open)).toContain('satisfied')
		const closed = run(tool, { type: 'wait_for', until: 'window_closed', match: 'zzz' })
		await vi.advanceTimersByTimeAsync(2_000)
		expect((await closed).success).toBe(true)
	})

	it('needs a window for a control or text condition', async () => {
		const tool = createComputerUseTool(makeHost().host, FAST)
		const result = await run(tool, { type: 'wait_for', until: 'text_appears', match: 'x' })
		expect(result.success).toBe(false)
		expect(result.error).toContain('needs window_id')
	})

	it('stops when the turn is cancelled', async () => {
		const controller = new AbortController()
		controller.abort()
		const tool = createComputerUseTool(makeHost().host, FAST)
		const result = await run(
			tool,
			{ type: 'wait_for', until: 'text_appears', match: 'x', window_id: '0x10' },
			controller.signal,
		)
		expect(result.success).toBe(false)
		expect(result.error).toContain('cancelled')
	})
})

describe('the screen and the turn', () => {
	it('tells the host which turn each call belongs to, and releases it when the turn is cut short', async () => {
		const begun: string[] = []
		const ended: number[] = []
		const base = makeHost().host
		const host: ComputerUseHost = {
			...base,
			beginTurn: (id) => void begun.push(id),
			endTurn: () => void ended.push(1),
		}
		const tool = createComputerUseTool(host, FAST)
		const controller = new AbortController()
		await run(tool, { type: 'list_windows' }, controller.signal)
		expect(begun).toEqual(['4adf3fdd-2823-4640-be0a-5d21fe28b6d2'])
		expect(ended).toEqual([])
		controller.abort()
		await Promise.resolve()
		expect(ended).toEqual([1])
	})

	it('says nothing reached the window, and that trying again is safe, when the screen could not be had', async () => {
		const base = makeHost().host
		const host: ComputerUseHost = {
			...base,
			focusWindow: async () => ({
				ok: false,
				focusedId: null,
				delivery: 'not_delivered',
				retrySafety: 'safe',
				detail:
					'The user kept using the keyboard or mouse for 45 s, so the screen was not taken and nothing was sent.',
			}),
		}
		const tool = createComputerUseTool(host, FAST)
		const result = await run(tool, { type: 'focus_window', window_id: '0x10' })
		expect(result.success).toBe(false)
		expect(result.error).toContain('nothing was sent')
		expect(result.error).toContain('Not delivered')
	})

	it('adds what a focus did to the screen to the step when the host says so', async () => {
		const base = makeHost().host
		const host: ComputerUseHost = {
			...base,
			focusWindow: async (id) => ({
				ok: true,
				focusedId: id,
				detail: 'The user used the keyboard while the screen was in use.',
			}),
		}
		const tool = createComputerUseTool(host, FAST)
		const result = await run(tool, { type: 'focus_window', window_id: '0x10' })
		expect(result.success).toBe(true)
		expect(text(result)).toContain('while the screen was in use')
	})
})
