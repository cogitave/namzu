import { decode, encode } from 'fast-png'
import { Validator } from 'jsonschema'
import { describe, expect, it } from 'vitest'
import { testToolset } from '../../../test-support/toolset.js'
import { ToolManager } from '../../../toolsets/manager.js'
import type {
	ComputerUseAction,
	ComputerUseCapabilities,
	ComputerUseHost,
	ComputerUseResult,
	DisplayGeometry,
	DisplayInfo,
	Rect,
	ScreenshotResult,
	WindowInfo,
} from '../../../types/computer-use/index.js'
import type { ToolResultBlock } from '../../../types/message/index.js'
import type { ToolContext, ToolResult } from '../../../types/tool/index.js'
import {
	type ActionInput,
	COMPUTER_USE_TOOL_NAME,
	type ComputerUseToolOptions,
	HIGH_RES_SCREENSHOT_LIMITS,
	computerUseUnavailableReason,
	createComputerUseTool,
} from '../computer-use.js'

/** A solid PNG of the given size. */
function png(width: number, height: number): Buffer {
	return Buffer.from(
		encode({
			width,
			height,
			data: new Uint8Array(width * height * 3).fill(90),
			channels: 3,
			depth: 8,
		}),
	)
}

const pngCache = new Map<string, Buffer>()
function cachedPng(width: number, height: number): Buffer {
	const key = `${width}x${height}`
	let data = pngCache.get(key)
	if (!data) {
		data = png(width, height)
		pngCache.set(key, data)
	}
	return data
}

interface HostCall {
	readonly action: ComputerUseAction | { readonly type: string; readonly [key: string]: unknown }
	readonly at: number
}

interface HostOptions {
	readonly capabilities?: Partial<ComputerUseCapabilities>
	/** Physical capture size. */
	readonly width?: number
	readonly height?: number
	/** Display reported with each capture; null for a host that predates it. */
	readonly display?: DisplayInfo | null
	readonly windows?: readonly WindowInfo[]
	readonly focus?: (id: string) => { ok: boolean; focusedId: string | null }
	readonly regionCapture?: boolean
	readonly fail?: (action: ComputerUseAction) => unknown
}

function makeHost(options: HostOptions = {}): {
	host: ComputerUseHost
	calls: HostCall[]
	actions: () => ComputerUseAction[]
} {
	// Fits the limits, so a capture is passed through without being decoded.
	const width = options.width ?? 1280
	const height = options.height ?? 800
	const calls: HostCall[] = []
	const capabilities: ComputerUseCapabilities = {
		displayServer: 'win32',
		screenshot: true,
		mouse: true,
		keyboard: true,
		cursorPosition: true,
		clipboard: true,
		...options.capabilities,
	}
	const display: DisplayInfo | undefined =
		options.display === null
			? undefined
			: (options.display ?? { id: '0', x: 0, y: 0, width, height, scaleFactor: 1, primary: true })
	const shot = (w: number, h: number): ScreenshotResult => ({
		data: cachedPng(w, h),
		mimeType: 'image/png',
		width: w,
		height: h,
		...(display ? { display } : {}),
	})
	const host: ComputerUseHost = {
		id: 'mock-host',
		capabilities,
		async getDisplayGeometry(): Promise<DisplayGeometry> {
			return { width, height, scaleFactor: 1 }
		},
		async execute(action: ComputerUseAction): Promise<ComputerUseResult> {
			calls.push({ action, at: performance.now() })
			const failure = options.fail?.(action)
			if (failure) throw failure
			switch (action.type) {
				case 'screenshot':
					return { type: 'screenshot', result: shot(width, height) }
				case 'cursor_position':
					return { type: 'cursor_position', point: { x: 1720, y: 720 } }
				default:
					return { type: 'ok' }
			}
		},
		...(options.windows
			? {
					listWindows: async () => {
						calls.push({ action: { type: 'list_windows' }, at: performance.now() })
						return options.windows as readonly WindowInfo[]
					},
					focusWindow: async (id: string) => {
						calls.push({ action: { type: 'focus_window', id }, at: performance.now() })
						return options.focus?.(id) ?? { ok: true, focusedId: id }
					},
				}
			: {}),
		...(options.regionCapture
			? {
					captureRegion: async (rect: Rect) => {
						calls.push({ action: { type: 'capture_region', rect }, at: performance.now() })
						return shot(rect.width, rect.height)
					},
				}
			: {}),
	}
	return {
		host,
		calls,
		actions: () =>
			calls
				.map((call) => call.action)
				.filter((action): action is ComputerUseAction => typeof action.type === 'string'),
	}
}

function makeContext(signal = new AbortController().signal): ToolContext {
	return {
		sessionId: '0190a5b2-7c3d-7e4f-8a9b-0c1d2e3f4a5b' as never,
		turnId: '4adf3fdd-2823-4640-be0a-5d21fe28b6d2' as never,
		workingDirectory: '/tmp',
		abortSignal: signal,
		env: {},
		log: () => {},
	}
}

const FAST: ComputerUseToolOptions = { settleMs: 0 }

async function run(
	tool: ReturnType<typeof createComputerUseTool>,
	input: unknown,
	context = makeContext(),
): Promise<ToolResult> {
	return tool.execute(tool.inputSchema.parse(input), context)
}

function blocks(result: ToolResult): readonly ToolResultBlock[] {
	expect(Array.isArray(result.content)).toBe(true)
	return result.content as readonly ToolResultBlock[]
}

function textOf(result: ToolResult): string {
	return blocks(result)
		.filter((block): block is { type: 'text'; text: string } => block.type === 'text')
		.map((block) => block.text)
		.join('\n')
}

function imageOf(result: ToolResult): { width: number; height: number } | undefined {
	const image = blocks(result).find((block) => block.type === 'image')
	if (!image || image.type !== 'image') return undefined
	expect(image.mediaType).toBe('image/png')
	const decoded = decode(Buffer.from(image.data, 'base64'))
	return { width: decoded.width, height: decoded.height }
}

// Captures here are whole displays (3440x1440 and up) resized in pure
// JavaScript; under coverage instrumentation that is several times slower.
describe('createComputerUseTool', { timeout: 30_000 }, () => {
	it('exposes the canonical tool name', () => {
		expect(COMPUTER_USE_TOOL_NAME).toBe('computer_use')
		expect(createComputerUseTool(makeHost().host).name).toBe('computer_use')
	})

	describe('screenshots', () => {
		it('fits the capture, numbers it and states the coordinate contract', async () => {
			const { host } = makeHost({ width: 3440, height: 1440 })
			const tool = createComputerUseTool(host, FAST)
			const result = await run(tool, { type: 'screenshot' })

			expect(result.success).toBe(true)
			expect(imageOf(result)).toEqual({ width: 1568, height: 656 })
			const text = textOf(result)
			expect(text).toContain('Screenshot s1: 1568x656 pixels')
			expect(text).toContain('3440x1440 display')
			expect(text).toContain('x 0–1567, y 0–655')
			// Text first, so the model reads the contract with the image.
			expect(blocks(result)[0]?.type).toBe('text')
			expect(result.output).toBe('Screenshot s1 captured (1568x656 of the 3440x1440 display).')
			expect(result.data).toMatchObject({
				screenshot: {
					id: 's1',
					width: 1568,
					height: 656,
					display: { width: 3440, height: 1440 },
					mimeType: 'image/png',
					encoding: 'base64',
				},
			})
			expect(result.workingState).toEqual([
				{
					key: 'computer_use.screenshot',
					text: 'computer_use coordinates are pixels of screenshot s1 (1568x656), origin top-left.',
				},
			])
		})

		it('says so when the screenshot is the display at full size', async () => {
			const { host } = makeHost({ width: 1280, height: 800 })
			const result = await run(createComputerUseTool(host, FAST), { type: 'screenshot' })
			expect(imageOf(result)).toEqual({ width: 1280, height: 800 })
			expect(textOf(result)).toContain('1280x800 pixels, the display at full size')
		})

		it('honours the high-resolution tier when asked', async () => {
			// The standard limits shrink 2000x1000 to 1568x784; the high tier keeps it.
			const { host } = makeHost({ width: 2000, height: 1000 })
			const tool = createComputerUseTool(host, {
				...FAST,
				screenshotLimits: HIGH_RES_SCREENSHOT_LIMITS,
			})
			const result = await run(tool, { type: 'screenshot' })
			expect(imageOf(result)).toEqual({ width: 2000, height: 1000 })
			expect(textOf(result)).toContain('2000x1000 pixels, the display at full size')
		})

		it('assumes one display at the origin for a host that reports none', async () => {
			const { host, actions } = makeHost({ width: 1600, height: 900, display: null })
			const tool = createComputerUseTool(host, { ...FAST, screenshotAfterActions: false })
			const shot = await run(tool, { type: 'screenshot' })
			expect(textOf(shot)).toContain('Screenshot s1: 1456x819 pixels, showing the 1600x900 display')
			expect(shot.data).toMatchObject({
				screenshot: {
					display: { id: 'default', x: 0, y: 0, width: 1600, height: 900, scaleFactor: 1 },
				},
			})
			await run(tool, { type: 'mouse_click', at: { x: 728, y: 409 }, button: 'left' })
			expect(actions()[1]).toEqual({ type: 'mouse_click', at: { x: 800, y: 450 }, button: 'left' })
		})

		it('reports a high-DPI display in physical pixels and maps without its scale factor', async () => {
			const display: DisplayInfo = {
				id: '\\\\.\\DISPLAY2',
				x: 2560,
				y: -200,
				width: 1600,
				height: 900,
				scaleFactor: 1.5,
			}
			const { host, actions } = makeHost({ width: 1600, height: 900, display })
			const tool = createComputerUseTool(host, { ...FAST, screenshotAfterActions: false })
			const shot = await run(tool, { type: 'screenshot' })
			expect(imageOf(shot)).toEqual({ width: 1456, height: 819 })
			expect(shot.data).toMatchObject({ screenshot: { display } })
			await run(tool, { type: 'mouse_click', at: { x: 0, y: 0 }, button: 'left' })
			await run(tool, { type: 'mouse_click', at: { x: 1455, y: 818 }, button: 'left' })
			// Display-relative physical pixels: the origin and the scale factor
			// are the host's; the tool applies neither.
			expect(actions()[1]).toMatchObject({ at: { x: 0, y: 0 } })
			expect(actions()[2]).toMatchObject({ at: { x: 1599, y: 899 } })
		})
	})

	describe('coordinates', () => {
		it('maps a click on the 3440x1440 screenshot back within one screenshot pixel', async () => {
			const { host, actions } = makeHost({ width: 3440, height: 1440 })
			const tool = createComputerUseTool(host, { ...FAST, screenshotAfterActions: false })
			await run(tool, { type: 'screenshot' })
			// A button whose centre is at (2900, 1200) on the real display.
			const target = { x: 2900, y: 1200 }
			const seen = {
				x: Math.floor(((target.x + 0.5) * 1568) / 3440),
				y: Math.floor(((target.y + 0.5) * 656) / 1440),
			}
			await run(tool, { type: 'mouse_click', at: seen, button: 'left' })
			const click = actions()[1] as Extract<ComputerUseAction, { type: 'mouse_click' }>
			expect(Math.abs(click.at.x - target.x)).toBeLessThanOrEqual(3440 / 1568)
			expect(Math.abs(click.at.y - target.y)).toBeLessThanOrEqual(1440 / 656)
		})

		it('refuses a coordinate outside the screenshot without touching the host', async () => {
			const { host, actions } = makeHost({ width: 1600, height: 900 })
			const tool = createComputerUseTool(host, FAST)
			await run(tool, { type: 'screenshot' })
			// Native display pixels — the coordinate space the model never saw.
			const result = await run(tool, {
				type: 'mouse_click',
				at: { x: 1500, y: 850 },
				button: 'left',
			})
			expect(result.success).toBe(false)
			expect(result.error).toContain('outside screenshot s1, which is 1456x819')
			expect(actions()).toHaveLength(1)
		})

		it('refuses clicks and keys before any screenshot', async () => {
			const { host, calls } = makeHost()
			const tool = createComputerUseTool(host, FAST)
			const click = await run(tool, { type: 'mouse_click', at: { x: 1, y: 1 }, button: 'left' })
			expect(click.success).toBe(false)
			expect(click.error).toContain('take a screenshot first')
			const typed = await run(tool, { type: 'type_text', text: 'Bahadır Arda' })
			expect(typed.success).toBe(false)
			expect(typed.error).toContain('which window has focus')
			expect(calls).toHaveLength(0)
		})

		it('maps through the screenshot the model names, even after the display changed', async () => {
			let width = 1600
			const { host, actions } = makeHost({ width: 1600, height: 900 })
			const execute = host.execute.bind(host)
			host.execute = async (action) => {
				const result = await execute(action)
				if (result.type !== 'screenshot') return result
				return {
					type: 'screenshot',
					result: {
						...result.result,
						data: cachedPng(width, 900),
						width,
						display: { id: '0', x: 0, y: 0, width, height: 900, scaleFactor: 1 },
					},
				}
			}
			const tool = createComputerUseTool(host, { ...FAST, screenshotAfterActions: false })
			await run(tool, { type: 'screenshot' })
			width = 1280
			await run(tool, { type: 'screenshot' })
			// Through s1 (1456x819 of 1600x900), not s2 (1280x900 unscaled).
			await run(tool, {
				type: 'mouse_click',
				at: { x: 728, y: 409 },
				button: 'left',
				screenshot_id: 's1',
			})
			expect(actions()[2]).toMatchObject({ at: { x: 800, y: 450 } })
			await run(tool, { type: 'mouse_click', at: { x: 728, y: 409 }, button: 'left' })
			expect(actions()[3]).toMatchObject({ at: { x: 728, y: 409 } })
			const unknown = await run(tool, {
				type: 'mouse_click',
				at: { x: 1, y: 1 },
				button: 'left',
				screenshot_id: 's9',
			})
			expect(unknown.error).toContain('there is no screenshot s9 (the latest is s2)')
		})

		it('reports the cursor in screenshot pixels', async () => {
			const { host } = makeHost({ width: 3440, height: 1440 })
			const tool = createComputerUseTool(host, FAST)
			expect((await run(tool, { type: 'cursor_position' })).error).toContain(
				'take a screenshot first',
			)
			await run(tool, { type: 'screenshot' })
			const result = await run(tool, { type: 'cursor_position' })
			expect(result.success).toBe(true)
			expect(result.output).toBe('Read cursor position: at (784, 328) in s1')
			expect(imageOf(result)).toBeUndefined()
		})
	})

	describe('screenshots after acting', () => {
		it('returns a new screenshot after the settle delay', async () => {
			const { host, calls } = makeHost()
			const tool = createComputerUseTool(host, { settleMs: 40 })
			await run(tool, { type: 'screenshot' })
			const result = await run(tool, { type: 'mouse_click', at: { x: 10, y: 10 }, button: 'left' })

			expect(result.success).toBe(true)
			expect(calls.map((call) => call.action.type)).toEqual([
				'screenshot',
				'mouse_click',
				'screenshot',
			])
			const [, click, after] = calls
			expect((after?.at ?? 0) - (click?.at ?? 0)).toBeGreaterThanOrEqual(35)
			expect(imageOf(result)).toEqual({ width: 1280, height: 800 })
			expect(textOf(result)).toContain('Click left at (10, 10): done')
			expect(textOf(result)).toContain('Screenshot s2: 1280x800 pixels')
			expect(result.output).toBe('Click left at (10, 10): done\nScreenshot s2 (1280x800).')
			expect(result.workingState?.[0]?.text).toContain('screenshot s2')
		})

		it('can be turned off', async () => {
			const { host, calls } = makeHost()
			const tool = createComputerUseTool(host, { ...FAST, screenshotAfterActions: false })
			await run(tool, { type: 'screenshot' })
			const result = await run(tool, { type: 'key', keys: 'ENTER' })
			expect(result.success).toBe(true)
			expect(imageOf(result)).toBeUndefined()
			expect(calls).toHaveLength(2)
			expect(tool.description).not.toContain('returns a new screenshot')
		})

		it('does not take one after a read-only action', async () => {
			const { host, calls } = makeHost()
			const tool = createComputerUseTool(host, FAST)
			await run(tool, { type: 'screenshot' })
			await run(tool, { type: 'cursor_position' })
			expect(calls.map((call) => call.action.type)).toEqual(['screenshot', 'cursor_position'])
		})

		it('keeps the action a success when only the screenshot after it fails', async () => {
			let shots = 0
			const { host } = makeHost({
				fail: (action) =>
					action.type === 'screenshot' && ++shots > 1 ? new Error('GDI+') : undefined,
			})
			const tool = createComputerUseTool(host, FAST)
			await run(tool, { type: 'screenshot' })
			const result = await run(tool, { type: 'key', keys: 'ENTER' })
			expect(result.success).toBe(true)
			expect(textOf(result)).toContain('The screenshot after acting failed: GDI+')
		})
	})

	describe('batch', () => {
		it('runs actions in order and returns one screenshot at the end', async () => {
			const { host, calls } = makeHost()
			const tool = createComputerUseTool(host, FAST)
			await run(tool, { type: 'screenshot' })
			const result = await run(tool, {
				type: 'batch',
				actions: [
					{ type: 'mouse_click', at: { x: 700, y: 300 }, button: 'left' },
					{ type: 'type_text', text: 'merhaba' },
					{ type: 'key', keys: 'ENTER' },
				],
			})
			expect(result.success).toBe(true)
			expect(calls.map((call) => call.action.type)).toEqual([
				'screenshot',
				'mouse_click',
				'type_text',
				'key',
				'screenshot',
			])
			expect(textOf(result)).toContain('Batch: all 3 actions done.')
			expect(textOf(result)).toContain('3. Press ENTER: done')
			expect(imageOf(result)).toEqual({ width: 1280, height: 800 })
			expect(result.data).toMatchObject({
				steps: [
					{ label: 'Click left at (700, 300)', status: 'done' },
					{ label: 'Type "merhaba"', status: 'done' },
					{ label: 'Press ENTER', status: 'done' },
				],
				screenshot: { id: 's2' },
			})
		})

		it('stops at the first failure, says which, and still shows the screen', async () => {
			const { host, calls } = makeHost({
				fail: (action) =>
					action.type === 'type_text' ? new Error('SendInput returned 0') : undefined,
			})
			const tool = createComputerUseTool(host, FAST)
			await run(tool, { type: 'screenshot' })
			const result = await run(tool, {
				type: 'batch',
				actions: [
					{ type: 'mouse_click', at: { x: 5, y: 5 }, button: 'left' },
					{ type: 'type_text', text: 'hello' },
					{ type: 'key', keys: 'ENTER' },
				],
			})
			expect(result.success).toBe(false)
			expect(result.error).toBe(
				'Batch stopped at action 2 of 3 (Type "hello"): SendInput returned 0',
			)
			expect(calls.map((call) => call.action.type)).toEqual([
				'screenshot',
				'mouse_click',
				'type_text',
				'screenshot',
			])
			const text = textOf(result)
			expect(text).toContain('Batch stopped at action 2 of 3; 1 not run.')
			expect(text).toContain('2. Type "hello": failed — SendInput returned 0')
			expect(text).toContain('3. Press ENTER: not run')
			// The model sees the failure and the screen it left behind.
			expect(imageOf(result)).toBeDefined()
		})

		it('checks every action before running any', async () => {
			const { host, calls } = makeHost()
			const tool = createComputerUseTool(host, FAST)
			await run(tool, { type: 'screenshot' })
			const result = await run(tool, {
				type: 'batch',
				actions: [
					{ type: 'mouse_click', at: { x: 5, y: 5 }, button: 'left' },
					{ type: 'type_text', text: 'x' },
					{ type: 'mouse_click', at: { x: 5000, y: 5 }, button: 'left' },
				],
			})
			expect(result.success).toBe(false)
			expect(result.error).toMatch(
				/^computer_use: action 3 of 3 \(Click left at \(5000, 5\)\) cannot run: .*outside screenshot s1.*Nothing was run\.$/,
			)
			expect(calls).toHaveLength(1)
		})

		it('bounds the batch and keeps images out of it', async () => {
			const { host, calls } = makeHost()
			const tool = createComputerUseTool(host, { ...FAST, maxBatchActions: 2 })
			await run(tool, { type: 'screenshot' })
			const tooMany = await run(tool, {
				type: 'batch',
				actions: [
					{ type: 'key', keys: 'A' },
					{ type: 'key', keys: 'B' },
					{ type: 'key', keys: 'C' },
				],
			})
			expect(tooMany.error).toContain('at most 2 actions; got 3')
			expect(calls).toHaveLength(1)
			expect(
				tool.inputSchema.safeParse({ type: 'batch', actions: [{ type: 'screenshot' }] }).success,
			).toBe(false)
			expect(
				tool.inputSchema.safeParse({
					type: 'batch',
					actions: [{ type: 'zoom', region: { x: 0, y: 0, width: 1, height: 1 } }],
				}).success,
			).toBe(false)
			expect(tool.inputSchema.safeParse({ type: 'batch', actions: [] }).success).toBe(false)
		})

		it('stops when the turn is cancelled between actions', async () => {
			const controller = new AbortController()
			const { host, calls } = makeHost({
				fail: (action) => {
					if (action.type === 'key') controller.abort()
					return undefined
				},
			})
			const tool = createComputerUseTool(host, FAST)
			await run(tool, { type: 'screenshot' })
			const result = await run(
				tool,
				{
					type: 'batch',
					actions: [
						{ type: 'key', keys: 'A' },
						{ type: 'key', keys: 'B' },
					],
				},
				makeContext(controller.signal),
			)
			expect(result.success).toBe(false)
			expect(textOf(result)).toContain('2. Press B: failed — cancelled before it started')
			expect(calls.map((call) => call.action.type)).toEqual(['screenshot', 'key'])
		})

		it('treats a wait-only batch as a look', async () => {
			const { host, calls } = makeHost()
			const tool = createComputerUseTool(host, FAST)
			await run(tool, { type: 'screenshot' })
			const result = await run(tool, { type: 'batch', actions: [{ type: 'wait', ms: 1 }] })
			expect(result.success).toBe(true)
			expect(calls.map((call) => call.action.type)).toEqual(['screenshot', 'screenshot'])
		})
	})

	describe('zoom', () => {
		it('shows a region at more detail and keeps coordinates on the screenshot', async () => {
			const { host, actions } = makeHost({ width: 3440, height: 1440 })
			const tool = createComputerUseTool(host, { ...FAST, screenshotAfterActions: false })
			await run(tool, { type: 'screenshot' })
			const zoomed = await run(tool, {
				type: 'zoom',
				region: { x: 100, y: 100, width: 200, height: 100 },
			})
			expect(zoomed.success).toBe(true)
			const image = imageOf(zoomed)
			expect(image?.width).toBeGreaterThan(400)
			expect(zoomed.data).toMatchObject({
				zoom: { screenshot: 's1', region: { x: 100, y: 100, width: 200, height: 100 } },
			})
			expect(textOf(zoomed)).toContain(
				'Coordinates for actions still refer to s1 (1568x656), not to this image.',
			)
			// Not numbered, not pinned: a zoom is never a coordinate space.
			expect(zoomed.data).not.toHaveProperty('screenshot')
			expect(zoomed.workingState).toBeUndefined()
			// Zoom does not start a new coordinate space: s1 is still the latest.
			await run(tool, { type: 'mouse_click', at: { x: 784, y: 328 }, button: 'left' })
			expect(actions().find((action) => action.type === 'mouse_click')).toEqual({
				type: 'mouse_click',
				at: { x: 1721, y: 721 },
				button: 'left',
			})
		})

		it('asks the host for just the region when it declares it can capture one', async () => {
			const { host, calls } = makeHost({
				width: 3440,
				height: 1440,
				regionCapture: true,
				capabilities: { regionCapture: true },
			})
			const tool = createComputerUseTool(host, FAST)
			await run(tool, { type: 'screenshot' })
			const zoomed = await run(tool, {
				type: 'zoom',
				region: { x: 1500, y: 600, width: 500, height: 500 },
			})
			expect(zoomed.success).toBe(true)
			// Clamped to the screenshot, then covered outward on the display.
			expect(calls.map((call) => call.action)).toEqual([
				{ type: 'screenshot' },
				{ type: 'capture_region', rect: { x: 3290, y: 1317, width: 150, height: 123 } },
			])
			expect(imageOf(zoomed)).toEqual({ width: 150, height: 123 })
			expect(zoomed.data).toMatchObject({
				zoom: { region: { x: 1500, y: 600, width: 68, height: 56 } },
			})
		})

		it('crops a full capture when the method exists but the flag is not set', async () => {
			const { host, calls } = makeHost({ width: 3440, height: 1440, regionCapture: true })
			const tool = createComputerUseTool(host, FAST)
			await run(tool, { type: 'screenshot' })
			const zoomed = await run(tool, {
				type: 'zoom',
				region: { x: 1500, y: 600, width: 500, height: 500 },
			})
			expect(calls.map((call) => call.action.type)).toEqual(['screenshot', 'screenshot'])
			expect(imageOf(zoomed)).toEqual({ width: 150, height: 123 })
		})

		it('refuses a region wholly off the screenshot', async () => {
			const { host } = makeHost()
			const tool = createComputerUseTool(host, FAST)
			await run(tool, { type: 'screenshot' })
			const result = await run(tool, {
				type: 'zoom',
				region: { x: 5000, y: 0, width: 10, height: 10 },
			})
			expect(result.success).toBe(false)
			expect(result.error).toContain('is outside screenshot s1')
		})

		it('refuses when the display changed since the screenshot', async () => {
			let width = 1600
			const { host } = makeHost({ width: 1600, height: 900 })
			const execute = host.execute.bind(host)
			host.execute = async (action) => {
				const result = await execute(action)
				if (result.type !== 'screenshot') return result
				return {
					type: 'screenshot',
					result: {
						...result.result,
						data: cachedPng(width, 900),
						width,
						display: { id: '0', x: 0, y: 0, width, height: 900, scaleFactor: 1 },
					},
				}
			}
			const tool = createComputerUseTool(host, FAST)
			await run(tool, { type: 'screenshot' })
			width = 1280
			const result = await run(tool, {
				type: 'zoom',
				region: { x: 0, y: 0, width: 10, height: 10 },
			})
			expect(result.error).toContain('the display is now 1280x900')
		})
	})

	describe('wait', () => {
		it('waits and then shows the screen', async () => {
			const { host, calls } = makeHost()
			const tool = createComputerUseTool(host, FAST)
			await run(tool, { type: 'screenshot' })
			const started = performance.now()
			const result = await run(tool, { type: 'wait', ms: 30 })
			expect(performance.now() - started).toBeGreaterThanOrEqual(25)
			expect(result.success).toBe(true)
			expect(result.output).toContain('Wait 30 ms: done')
			expect(calls.map((call) => call.action.type)).toEqual(['screenshot', 'screenshot'])
		})

		it('is capped', async () => {
			const { host } = makeHost()
			const tool = createComputerUseTool(host, { ...FAST, maxWaitMs: 100 })
			const result = await run(tool, { type: 'wait', ms: 101 })
			expect(result.error).toContain('wait is at most 100 ms; got 101. Nothing was run.')
			const batch = await run(tool, {
				type: 'batch',
				actions: [
					{ type: 'wait', ms: 60 },
					{ type: 'wait', ms: 60 },
				],
			})
			expect(batch.error).toContain("a batch's waits add up to at most 100 ms; got 120")
			expect(tool.presentCall?.({ type: 'wait', ms: 1500 })).toMatchObject({ label: 'Wait 1.5 s' })
		})
	})

	describe('windows', () => {
		const windows: WindowInfo[] = [
			{
				id: '0x1a2b',
				title: 'Chat | Microsoft Teams',
				app: 'ms-teams',
				pid: 4242,
				bounds: { x: 1000, y: 100, width: 1600, height: 1000 },
				focused: false,
				minimized: false,
			},
			{
				id: '0x3c4d',
				title: 'namzu',
				app: 'WindowsTerminal',
				pid: 99,
				bounds: { x: 0, y: 0, width: 1200, height: 800 },
				focused: true,
				minimized: false,
			},
			{
				id: '0x5e6f',
				title: 'Notes',
				app: 'notepad',
				pid: 7,
				bounds: { x: -32000, y: -32000, width: 160, height: 28 },
				focused: false,
				minimized: true,
			},
		]

		it('are offered only when the host declares them and implements them', () => {
			const plain = createComputerUseTool(makeHost({ windows }).host, FAST)
			const flaggedWithout = createComputerUseTool(
				makeHost({ capabilities: { windows: true } }).host,
				FAST,
			)
			for (const tool of [plain, flaggedWithout]) {
				const schema = tool.modelInputSchema as { properties: Record<string, { enum?: string[] }> }
				expect(schema.properties.type?.enum).not.toContain('list_windows')
				expect(schema.properties).not.toHaveProperty('window_id')
				expect(tool.description).not.toContain('list_windows')
			}
			const offered = createComputerUseTool(
				makeHost({ windows, capabilities: { windows: true } }).host,
				FAST,
			)
			const schema = offered.modelInputSchema as {
				properties: Record<string, { enum?: string[] }>
			}
			expect(schema.properties.type?.enum).toEqual(
				expect.arrayContaining(['list_windows', 'focus_window']),
			)
			expect(schema.properties).toHaveProperty('window_id')
		})

		it('lists windows with their place on the latest screenshot', async () => {
			const { host } = makeHost({
				width: 3440,
				height: 1440,
				windows,
				capabilities: { windows: true },
			})
			const tool = createComputerUseTool(host, FAST)
			await run(tool, { type: 'screenshot' })
			const result = await run(tool, { type: 'list_windows' })
			expect(result.success).toBe(true)
			expect(result.output).toContain('3 windows, front to back:')
			expect(result.output).toContain(
				'- 0x1a2b · "Chat | Microsoft Teams" · ms-teams (pid 4242) · at (455, 45) 731x457 in s1',
			)
			expect(result.output).toContain('- 0x3c4d · "namzu" · WindowsTerminal (pid 99) · focused')
			expect(result.output).toContain('- 0x5e6f · "Notes" · notepad (pid 7) · minimized')
		})

		it('focuses a window and shows the screen, or says what is in front instead', async () => {
			const { host, calls } = makeHost({
				windows,
				capabilities: { windows: true },
				focus: (id) =>
					id === '0x1a2b' ? { ok: true, focusedId: id } : { ok: false, focusedId: '0x3c4d' },
			})
			const tool = createComputerUseTool(host, FAST)
			await run(tool, { type: 'screenshot' })
			const focused = await run(tool, { type: 'focus_window', window_id: '0x1a2b' })
			expect(focused.success).toBe(true)
			expect(imageOf(focused)).toBeDefined()
			const refused = await run(tool, { type: 'focus_window', window_id: '0x5e6f' })
			expect(refused.success).toBe(false)
			expect(refused.error).toContain(
				'window 0x5e6f could not be brought to the front; window 0x3c4d is in front',
			)
			expect(calls.map((call) => call.action.type)).toEqual([
				'screenshot',
				'focus_window',
				'screenshot',
				'focus_window',
			])
		})
	})

	describe('classification', () => {
		const { host } = makeHost({ windows: [], capabilities: { windows: true } })
		const tool = createComputerUseTool(host, FAST)
		const click = { type: 'mouse_click', at: { x: 0, y: 0 }, button: 'left' } as const

		it('reads only for observations', () => {
			for (const input of [
				{ type: 'screenshot' },
				{ type: 'zoom', region: { x: 0, y: 0, width: 1, height: 1 } },
				{ type: 'wait', ms: 10 },
				{ type: 'list_windows' },
				{ type: 'cursor_position' },
				{ type: 'batch', actions: [{ type: 'wait', ms: 1 }, { type: 'list_windows' }] },
			] as ActionInput[]) {
				expect(tool.isReadOnly?.(input), input.type).toBe(true)
				expect(tool.isDestructive?.(input), input.type).toBe(false)
			}
			for (const input of [
				click,
				{ type: 'mouse_move', to: { x: 0, y: 0 } },
				{ type: 'focus_window', window_id: 'w' },
				{ type: 'batch', actions: [{ type: 'wait', ms: 1 }, click] },
			] as ActionInput[])
				expect(tool.isReadOnly?.(input), input.type).toBe(false)
			// Unknown shapes are never read-only.
			expect(tool.isReadOnly?.({} as never)).toBe(false)
			expect(tool.isReadOnly?.({ type: 'batch', actions: [] } as never)).toBe(false)
		})

		it('is destructive when any action is', () => {
			expect(tool.isDestructive?.({ type: 'mouse_move', to: { x: 0, y: 0 } })).toBe(false)
			expect(tool.isDestructive?.({ type: 'focus_window', window_id: 'w' })).toBe(false)
			for (const input of [
				click,
				{ type: 'mouse_drag', from: { x: 0, y: 0 }, to: { x: 1, y: 1 }, button: 'left' },
				{ type: 'scroll', at: { x: 0, y: 0 }, direction: 'down', amount: 3 },
				{ type: 'type_text', text: 'hi' },
				{ type: 'key', keys: 'ctrl+c' },
				{ type: 'batch', actions: [{ type: 'mouse_move', to: { x: 0, y: 0 } }, click] },
			] as ActionInput[])
				expect(tool.isDestructive?.(input), input.type).toBe(true)
			expect(tool.isDestructive?.({ type: 'batch', actions: ['not an action'] } as never)).toBe(
				true,
			)
		})
	})

	describe('presentation', () => {
		const tool = createComputerUseTool(makeHost().host, FAST)

		it('authors activity labels, one per action in a batch', () => {
			expect(tool.presentCall?.({ type: 'screenshot' })).toEqual({
				kind: 'generic',
				label: 'Capture screenshot',
				presentation: 'activity',
			})
			expect(
				tool.presentCall?.({ type: 'mouse_click', at: { x: 50, y: 60 }, button: 'left' }),
			).toMatchObject({ label: 'Click left at (50, 60)' })
			expect(
				tool.presentCall?.({
					type: 'batch',
					actions: [
						{ type: 'mouse_click', at: { x: 50, y: 60 }, button: 'left' },
						{ type: 'type_text', text: 'Bahadır Arda' },
						{ type: 'key', keys: 'ENTER' },
					],
				}),
			).toEqual({
				kind: 'generic',
				label: '3 desktop actions: Click left at (50, 60) · Type "Bahadır Arda" · Press ENTER',
				presentation: 'activity',
			})
			expect(
				tool.presentCall?.({ type: 'zoom', region: { x: 1, y: 2, width: 30, height: 40 } }),
			).toMatchObject({ label: 'Zoom into 30x40 at (1, 2)' })
		})

		it('hides a successful action result and keeps observations and failures visible', () => {
			const click = { type: 'mouse_click', at: { x: 0, y: 0 }, button: 'left' } as const
			const acted = 'Click left at (0, 0): done\nScreenshot s2 (1568x656).'
			expect(tool.presentResult?.(click, { success: true, output: acted })).toEqual({
				kind: 'generic',
				label: acted,
				visibility: 'hidden',
			})
			// A host that presents a finished call without its input gets the same answer.
			expect(tool.presentResult?.({} as never, { success: true, output: acted })).toMatchObject({
				visibility: 'hidden',
			})
			expect(
				tool.presentResult?.({} as never, { success: true, output: 'Press ENTER: done' }),
			).toMatchObject({ visibility: 'hidden' })
			expect(
				tool.presentResult?.(click, { success: false, output: acted, error: 'failed' }),
			).toBeUndefined()
			for (const output of [
				'Screenshot s1 captured (1568x656 of the 3440x1440 display).',
				'Zoomed into 200x100 at (100, 100) of s1 (shown at 438x219).',
				'Read cursor position: at (784, 328) in s1',
				'List windows: 2 windows, front to back:\n- 0x1 · "a" · b (pid 1)',
				'Batch: all 2 actions done.\n1. Press A: done\n2. Press B: done\nScreenshot s3 (1568x656).',
			])
				expect(tool.presentResult?.({} as never, { success: true, output }), output).toBeUndefined()
		})
	})

	describe('capabilities', () => {
		it('uses exact action support for both model schema and execution admission', async () => {
			const { host, calls } = makeHost({
				capabilities: {
					supportedActions: ['screenshot', 'mouse_click'],
					mouseClickButtons: ['left'],
				},
			})
			const tool = createComputerUseTool(host, FAST)
			expect(tool.modelInputSchema).toMatchObject({
				properties: {
					type: { enum: ['screenshot', 'zoom', 'mouse_click', 'wait', 'batch'] },
					button: { enum: ['left'] },
					actions: { items: { properties: { type: { enum: ['mouse_click', 'wait'] } } } },
				},
			})
			expect(tool.description).toContain(
				'Available actions: screenshot; zoom; mouse_click; wait; batch.',
			)
			await run(tool, { type: 'screenshot' })
			const refused = await run(tool, {
				type: 'scroll',
				at: { x: 1, y: 2 },
				direction: 'down',
				amount: 1,
			})
			expect(refused.success).toBe(false)
			const refusedInBatch = await run(tool, {
				type: 'batch',
				actions: [{ type: 'key', keys: 'A' }],
			})
			expect(refusedInBatch.error).toContain('action 1 of 1 (Press A) cannot run')
			expect(calls).toHaveLength(1)
			expect(
				(await run(tool, { type: 'mouse_click', at: { x: 1, y: 2 }, button: 'left' })).success,
			).toBe(true)
		})

		it('checks button support per action before invoking the host', async () => {
			const { host, calls } = makeHost({
				capabilities: { mouseClickButtons: ['left', 'right'], mouseDragButtons: ['left'] },
			})
			const tool = createComputerUseTool(host, FAST)
			await run(tool, { type: 'screenshot' })
			expect(
				(await run(tool, { type: 'mouse_click', at: { x: 0, y: 0 }, button: 'middle' })).success,
			).toBe(false)
			expect(
				(
					await run(tool, {
						type: 'mouse_drag',
						from: { x: 0, y: 0 },
						to: { x: 1, y: 1 },
						button: 'right',
					})
				).success,
			).toBe(false)
			expect(calls).toHaveLength(1)
		})

		it('exact declarations cannot enable a disabled broad capability', async () => {
			const { host, calls } = makeHost({
				capabilities: { mouse: false, supportedActions: ['screenshot', 'mouse_click'] },
			})
			const tool = createComputerUseTool(host, FAST)
			expect(tool.modelInputSchema).toMatchObject({
				properties: { type: { enum: ['screenshot', 'zoom', 'wait', 'batch'] } },
			})
			await run(tool, { type: 'screenshot' })
			const result = await run(tool, {
				type: 'mouse_click',
				at: { x: 0, y: 0 },
				button: 'left',
			})
			expect(result.success).toBe(false)
			expect(result.error).toContain('requires capability "mouse"')
			expect(calls).toHaveLength(1)
		})

		it('an explicitly empty action menu refuses all host access', async () => {
			const { host, calls } = makeHost({ capabilities: { supportedActions: [] } })
			const tool = createComputerUseTool(host, FAST)
			expect(tool.description).toContain('Available actions: none.')
			expect((await run(tool, { type: 'screenshot' })).success).toBe(false)
			expect(calls).toEqual([])
		})

		it('surfaces host capabilities in the description', () => {
			const { host } = makeHost({
				capabilities: {
					displayServer: 'darwin',
					keyboard: false,
					mouse: false,
					cursorPosition: false,
				},
			})
			const tool = createComputerUseTool(host, FAST)
			expect(tool.description).toContain('darwin')
			expect(tool.description.toLowerCase()).toContain('unavailable')
			expect(tool.description).toContain('keyboard')
		})

		it('describes the coordinate contract and nothing the model cannot call', () => {
			const tool = createComputerUseTool(makeHost().host, FAST)
			expect(tool.description).toContain(
				'every x/y you send is a pixel of the most recent screenshot this tool returned',
			)
			expect(tool.description).toContain('waits 0 ms and returns a new screenshot')
			expect(tool.description).toContain('runs up to 20 actions in order')
			expect(tool.description).not.toContain('getDisplayGeometry')
		})
	})

	describe('model schema', () => {
		const validActions = [
			{ type: 'screenshot' },
			{ type: 'zoom', region: { x: 1, y: 2, width: 3, height: 4 } },
			{ type: 'cursor_position' },
			{ type: 'mouse_move', to: { x: 10, y: 20 } },
			{ type: 'mouse_click', at: { x: 10, y: 20 }, button: 'left' },
			{ type: 'mouse_drag', from: { x: 10, y: 20 }, to: { x: 30, y: 40 }, button: 'right' },
			{ type: 'scroll', at: { x: 10, y: 20 }, direction: 'down', amount: 3 },
			{ type: 'type_text', text: 'hello' },
			{ type: 'key', keys: 'CTRL+R' },
			{ type: 'wait', ms: 500 },
			{ type: 'list_windows' },
			{ type: 'focus_window', window_id: '0x1' },
			{
				type: 'batch',
				actions: [
					{ type: 'mouse_click', at: { x: 1, y: 2 }, button: 'left' },
					{ type: 'type_text', text: 'x' },
				],
				screenshot_id: 's1',
			},
		] as const

		it('offers every action through one flat provider-safe schema', () => {
			const { host } = makeHost({ windows: [], capabilities: { windows: true } })
			const tool = createComputerUseTool(host, FAST)
			const schema = tool.modelInputSchema ?? {}
			expect(schema).toMatchObject({
				type: 'object',
				required: ['type'],
				additionalProperties: false,
			})
			expect(schema).not.toHaveProperty('anyOf')
			expect(schema).not.toHaveProperty('oneOf')
			expect(schema).not.toHaveProperty('allOf')
			expect(tool.enforceModelInput).not.toBe(true)
			const validator = new Validator()
			for (const action of validActions) {
				expect(validator.validate(action, schema).valid, action.type).toBe(true)
				expect(tool.inputSchema.safeParse(action).success, action.type).toBe(true)
			}
			expect(
				validator.validate({ type: 'batch', actions: [{ type: 'screenshot' }] }, schema).valid,
			).toBe(false)
		})

		it('rejects incomplete actions before the host is called', () => {
			const { host, calls } = makeHost()
			const tool = createComputerUseTool(host, FAST)
			const registry = new ToolManager({ toolsets: [testToolset(tool)], messages: () => [] })
			expect(tool.validationErrorHint).toMatch(/mouse_move needs to/)
			expect(tool.validationErrorHint).toMatch(/scroll needs at, direction, and amount/)
			expect(tool.validationErrorHint).toMatch(/"type":"batch"/)
			for (const action of [
				{ type: 'mouse_move' },
				{ type: 'mouse_click' },
				{ type: 'mouse_click', at: { x: 1, y: 2 }, button: 'thumb' },
				{ type: 'mouse_drag', from: { x: 1, y: 2 } },
				{ type: 'scroll', at: { x: 1, y: 2 }, direction: 'down' },
				{ type: 'type_text' },
				{ type: 'key' },
				{ type: 'zoom' },
				{ type: 'zoom', region: { x: 0, y: 0, width: 0, height: 1 } },
				{ type: 'wait' },
				{ type: 'wait', ms: -1 },
				{ type: 'focus_window' },
				{ type: 'batch' },
				{ type: 'nope' },
			]) {
				expect(tool.inputSchema.safeParse(action).success, JSON.stringify(action)).toBe(false)
				expect(registry.prepareExecution(COMPUTER_USE_TOOL_NAME, action).success).toBe(false)
			}
			expect(calls).toHaveLength(0)
		})

		it('clicks and drags with the left button when the model leaves it out', () => {
			// A model asked to click the Start button sent no button, and the
			// refusal cost a round trip for nothing.
			const tool = createComputerUseTool(makeHost().host, FAST)
			expect(tool.inputSchema.parse({ type: 'mouse_click', at: { x: 1, y: 2 } })).toEqual({
				type: 'mouse_click',
				at: { x: 1, y: 2 },
				button: 'left',
			})
			expect(
				tool.inputSchema.parse({
					type: 'batch',
					actions: [{ type: 'mouse_drag', from: { x: 1, y: 2 }, to: { x: 3, y: 4 } }],
				}),
			).toMatchObject({ actions: [{ button: 'left' }] })
		})
	})

	describe('unknown outcomes', () => {
		it('returns an explicit do-not-retry result and shows the screen', async () => {
			const unknown = Object.assign(
				new Error('The outcome is unknown. Do not automatically retry.'),
				{
					code: 'computer_use_outcome_unknown' as const,
					action: 'mouse_click' as const,
					outcome: 'unknown' as const,
					retrySafety: 'unsafe' as const,
					timedOut: false,
					exitCode: 7,
				},
			)
			const { host, calls } = makeHost({
				fail: (action) => (action.type === 'mouse_click' ? unknown : undefined),
			})
			const tool = createComputerUseTool(host, FAST)
			await run(tool, { type: 'screenshot' })
			const result = await run(tool, {
				type: 'mouse_click',
				at: { x: 50, y: 60 },
				button: 'left',
			})
			expect(result.success).toBe(false)
			expect(result.error).toBe('The outcome is unknown. Do not automatically retry.')
			expect(result.data).toMatchObject({
				code: 'computer_use_outcome_unknown',
				action: 'mouse_click',
				outcome: 'unknown',
				retrySafety: 'unsafe',
				timedOut: false,
				exitCode: 7,
			})
			expect(textOf(result)).toContain('Do not automatically retry.')
			expect(calls.map((call) => call.action.type)).toEqual([
				'screenshot',
				'mouse_click',
				'screenshot',
			])
		})

		it('does not adopt an unknown-outcome record for a different action', async () => {
			const sentinel = Object.assign(new Error('wrong action'), {
				code: 'computer_use_outcome_unknown' as const,
				action: 'type_text' as const,
				outcome: 'unknown' as const,
				retrySafety: 'unsafe' as const,
				timedOut: false,
				exitCode: 7,
			})
			const { host, calls } = makeHost({
				fail: (action) => (action.type === 'mouse_click' ? sentinel : undefined),
			})
			const tool = createComputerUseTool(host, FAST)
			await run(tool, { type: 'screenshot' })
			const result = await run(tool, {
				type: 'mouse_click',
				at: { x: 50, y: 60 },
				button: 'left',
			})
			expect(result.success).toBe(false)
			expect(result.error).toBe('computer_use failed: wrong action')
			expect(result.data).not.toHaveProperty('code')
			// A plain failure never started the action: no screenshot after it.
			expect(calls).toHaveLength(2)
		})
	})

	describe('a session that cannot use it', () => {
		it('says why in the description and in every refusal', async () => {
			const host = {
				id: 'unavailable-host',
				capabilities: {
					displayServer: 'win32' as const,
					screenshot: false,
					mouse: false,
					keyboard: false,
					cursorPosition: false,
					clipboard: false,
					unavailableReason: 'the desktop did not answer: CopyFromScreen: The handle is invalid.',
				},
				getDisplayGeometry: async () => {
					throw new Error('unreachable')
				},
				execute: async () => {
					throw new Error('unreachable')
				},
			}
			const tool = createComputerUseTool(host)
			expect(tool.description).toContain('the desktop did not answer')
			expect(tool.description).toContain('Do not retry')
			const result = await tool.execute({ type: 'screenshot' }, {} as never)
			expect(result.success).toBe(false)
			expect(result.error).toContain('the desktop did not answer')
			expect(result.error).toContain('Do not retry; tell the user.')
		})

		it('refuses everything when the provider cannot carry the screenshots', async () => {
			const { host, calls } = makeHost()
			const reason = computerUseUnavailableReason({
				id: 'openai',
				capabilities: {
					supportsTools: true,
					supportsStreaming: true,
					supportsFunctionCalling: true,
					supportsToolResultImages: false,
				},
			})
			expect(reason).toContain('The openai provider cannot return images in tool results')
			const tool = createComputerUseTool(host, { unavailableReason: reason })
			expect(tool.description).toContain('cannot return images in tool results')
			const schema = tool.modelInputSchema as { properties: Record<string, { enum?: string[] }> }
			// Still a valid schema for a diagnostic call.
			expect(schema.properties.type?.enum?.length).toBeGreaterThan(0)
			for (const input of [
				{ type: 'screenshot' },
				{ type: 'key', keys: 'A' },
				{ type: 'batch', actions: [{ type: 'key', keys: 'A' }] },
			]) {
				const result = await run(tool, input)
				expect(result.success).toBe(false)
				expect(result.error).toContain('cannot return images in tool results')
			}
			expect(calls).toHaveLength(0)
		})

		it('names only providers that declare they cannot carry tool-result images', () => {
			const caps = (supportsToolResultImages?: boolean) => ({
				supportsTools: true,
				supportsStreaming: true,
				supportsFunctionCalling: true,
				...(supportsToolResultImages === undefined ? {} : { supportsToolResultImages }),
			})
			expect(computerUseUnavailableReason({ id: 'anthropic', capabilities: caps(true) })).toBe(
				undefined,
			)
			// Undeclared keeps the permissive default: a third-party driver is trusted.
			expect(computerUseUnavailableReason({ id: 'custom', capabilities: caps() })).toBe(undefined)
			expect(computerUseUnavailableReason({ id: 'custom' })).toBe(undefined)
			expect(computerUseUnavailableReason({ id: 'ollama', capabilities: caps(false) })).toContain(
				'ollama',
			)
		})
	})

	describe('options', () => {
		it('rejects nonsense', () => {
			const { host } = makeHost()
			expect(() => createComputerUseTool(host, { settleMs: -1 })).toThrow(RangeError)
			expect(() => createComputerUseTool(host, { maxBatchActions: 0 })).toThrow(RangeError)
			expect(() => createComputerUseTool(host, { maxWaitMs: 1.5 })).toThrow(RangeError)
			expect(() =>
				createComputerUseTool(host, { screenshotLimits: { maxLongEdge: 10, maxTiles: 1 } }),
			).toThrow(RangeError)
		})
	})
})
