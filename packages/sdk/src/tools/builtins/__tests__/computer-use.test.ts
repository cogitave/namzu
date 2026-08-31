import { describe, expect, it } from 'vitest'
import type {
	ComputerUseAction,
	ComputerUseCapabilities,
	ComputerUseHost,
	ComputerUseResult,
	DisplayGeometry,
} from '../../../types/computer-use/index.js'
import type { ToolContext } from '../../../types/tool/index.js'
import { COMPUTER_USE_TOOL_NAME, createComputerUseTool } from '../computer-use.js'

function makeHost(overrides: Partial<ComputerUseCapabilities> = {}): {
	host: ComputerUseHost
	calls: ComputerUseAction[]
} {
	const calls: ComputerUseAction[] = []
	const capabilities: ComputerUseCapabilities = {
		displayServer: 'darwin',
		screenshot: true,
		mouse: true,
		keyboard: true,
		cursorPosition: true,
		clipboard: true,
		...overrides,
	}
	const host: ComputerUseHost = {
		id: 'mock-host',
		capabilities,
		async getDisplayGeometry(): Promise<DisplayGeometry> {
			return { width: 1920, height: 1080, scaleFactor: 2 }
		},
		async execute(action: ComputerUseAction): Promise<ComputerUseResult> {
			calls.push(action)
			switch (action.type) {
				case 'screenshot':
					return {
						type: 'screenshot',
						result: {
							data: Buffer.from([0x89, 0x50, 0x4e, 0x47]),
							mimeType: 'image/png',
							width: 1920,
							height: 1080,
						},
					}
				case 'cursor_position':
					return { type: 'cursor_position', point: { x: 10, y: 20 } }
				default:
					return { type: 'ok' }
			}
		},
	}
	return { host, calls }
}

function makeContext(): ToolContext {
	return {
		runId: 'run_test' as never,
		workingDirectory: '/tmp',
		abortSignal: new AbortController().signal,
		env: {},
		log: () => {},
	}
}

describe('createComputerUseTool', () => {
	it('exposes the canonical tool name', () => {
		expect(COMPUTER_USE_TOOL_NAME).toBe('computer_use')
		const { host } = makeHost()
		const tool = createComputerUseTool(host)
		expect(tool.name).toBe('computer_use')
	})

	it('surfaces host capabilities in the description', () => {
		const { host } = makeHost({ keyboard: false, mouse: false, cursorPosition: false })
		const tool = createComputerUseTool(host)
		expect(tool.description).toContain('darwin')
		expect(tool.description.toLowerCase()).toContain('unavailable')
		expect(tool.description).toContain('keyboard')
	})

	it('authors human activity labels instead of exposing the action JSON', () => {
		const { host } = makeHost()
		const tool = createComputerUseTool(host)

		expect(tool.presentCall?.({ type: 'screenshot' })).toEqual({
			kind: 'generic',
			label: 'Capture screenshot',
			presentation: 'activity',
		})
		expect(tool.presentCall?.({ type: 'key', keys: 'CTRL+R' })).toEqual({
			kind: 'generic',
			label: 'Press CTRL+R',
			presentation: 'activity',
		})
		expect(
			tool.presentCall?.({ type: 'mouse_click', at: { x: 50, y: 60 }, button: 'left' }),
		).toEqual({
			kind: 'generic',
			label: 'Click left at (50, 60)',
			presentation: 'activity',
		})
	})

	it('hides only a successful empty acknowledgement result', () => {
		const { host } = makeHost()
		const tool = createComputerUseTool(host)

		expect(
			tool.presentResult?.({ type: 'key', keys: 'ENTER' }, { success: true, output: 'ok' }),
		).toEqual({ kind: 'generic', label: 'ok', visibility: 'hidden' })
		expect(
			tool.presentResult?.(
				{ type: 'screenshot' },
				{ success: true, output: 'Screenshot captured (1920x1080, image/png).' },
			),
		).toBeUndefined()
		expect(
			tool.presentResult?.(
				{ type: 'key', keys: 'ENTER' },
				{ success: false, output: 'ok', error: 'failed' },
			),
		).toBeUndefined()
	})

	it('marks click/type/key/drag/scroll as destructive and screenshot/move as not', () => {
		const { host } = makeHost()
		const tool = createComputerUseTool(host)
		expect(tool.isDestructive?.({ type: 'screenshot' } as never)).toBe(false)
		expect(tool.isDestructive?.({ type: 'cursor_position' } as never)).toBe(false)
		expect(tool.isDestructive?.({ type: 'mouse_move', to: { x: 0, y: 0 } } as never)).toBe(false)
		expect(
			tool.isDestructive?.({
				type: 'mouse_click',
				at: { x: 0, y: 0 },
				button: 'left',
			} as never),
		).toBe(true)
		expect(
			tool.isDestructive?.({
				type: 'mouse_drag',
				from: { x: 0, y: 0 },
				to: { x: 10, y: 10 },
				button: 'left',
			} as never),
		).toBe(true)
		expect(
			tool.isDestructive?.({
				type: 'scroll',
				at: { x: 0, y: 0 },
				direction: 'down',
				amount: 3,
			} as never),
		).toBe(true)
		expect(tool.isDestructive?.({ type: 'type_text', text: 'hi' } as never)).toBe(true)
		expect(tool.isDestructive?.({ type: 'key', keys: 'ctrl+c' } as never)).toBe(true)
	})

	it('rejects actions whose required capability is missing', async () => {
		const { host, calls } = makeHost({ keyboard: false })
		const tool = createComputerUseTool(host)

		const result = await tool.execute({ type: 'type_text', text: 'hi' }, makeContext())

		expect(result.success).toBe(false)
		expect(result.error).toContain('keyboard')
		expect(calls).toHaveLength(0)
	})

	it('rejects cursor_position when the host does not support it', async () => {
		const { host, calls } = makeHost({ cursorPosition: false })
		const tool = createComputerUseTool(host)

		const result = await tool.execute({ type: 'cursor_position' }, makeContext())

		expect(result.success).toBe(false)
		expect(result.error).toContain('cursorPosition')
		expect(calls).toHaveLength(0)
	})

	it('returns the screenshot as an image BLOCK, not as base64 text', async () => {
		const { host } = makeHost()
		const tool = createComputerUseTool(host)

		const result = await tool.execute({ type: 'screenshot' }, makeContext())

		expect(result.success).toBe(true)

		// `output` used to BE the base64 payload, so the model received
		// hundreds of thousands of tokens of undecodable characters and
		// could not see the screen at all. It is now a short description.
		expect(result.output).toContain('1920x1080')
		expect(result.output.length).toBeLessThan(200)

		const blocks = result.content
		expect(Array.isArray(blocks)).toBe(true)
		const image = (blocks as Array<{ type: string; data?: string; mediaType?: string }>)[0]
		expect(image?.type).toBe('image')
		expect(image?.mediaType).toBe('image/png')
		expect(Buffer.from(image?.data ?? '', 'base64').subarray(0, 4)).toEqual(
			Buffer.from([0x89, 0x50, 0x4e, 0x47]),
		)

		expect(result.data).toMatchObject({
			mimeType: 'image/png',
			width: 1920,
			height: 1080,
			encoding: 'base64',
		})
	})

	it('returns JSON point output for cursor_position', async () => {
		const { host } = makeHost()
		const tool = createComputerUseTool(host)

		const result = await tool.execute({ type: 'cursor_position' }, makeContext())

		expect(result.success).toBe(true)
		expect(JSON.parse(result.output)).toEqual({ x: 10, y: 20 })
	})

	it('returns ok for side-effect actions and records the dispatch', async () => {
		const { host, calls } = makeHost()
		const tool = createComputerUseTool(host)

		const action = { type: 'mouse_click', at: { x: 50, y: 60 }, button: 'left' } as const
		const result = await tool.execute(action, makeContext())

		expect(result.success).toBe(true)
		expect(result.output).toBe('ok')
		expect(calls).toEqual([action])
	})

	it('returns an explicit do-not-retry result when a started desktop action has an unknown outcome', async () => {
		const { host } = makeHost()
		host.execute = async (action) => {
			throw Object.assign(new Error('The outcome is unknown. Do not automatically retry.'), {
				code: 'computer_use_outcome_unknown' as const,
				action: action.type,
				outcome: 'unknown' as const,
				retrySafety: 'unsafe' as const,
				timedOut: false,
				exitCode: 7,
			})
		}
		const tool = createComputerUseTool(host)

		const result = await tool.execute(
			{ type: 'mouse_click', at: { x: 50, y: 60 }, button: 'left' },
			makeContext(),
		)

		expect(result).toEqual({
			success: false,
			output: '',
			error: 'The outcome is unknown. Do not automatically retry.',
			data: {
				code: 'computer_use_outcome_unknown',
				action: 'mouse_click',
				outcome: 'unknown',
				retrySafety: 'unsafe',
				timedOut: false,
				exitCode: 7,
			},
		})
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
		const { host } = makeHost()
		host.execute = async () => {
			throw sentinel
		}
		const tool = createComputerUseTool(host)

		const result = await tool.execute(
			{ type: 'mouse_click', at: { x: 50, y: 60 }, button: 'left' },
			makeContext(),
		)

		expect(result).toEqual({
			success: false,
			output: '',
			error: 'computer_use failed: wrong action',
		})
	})

	it('validates input via the discriminated union schema', () => {
		const { host } = makeHost()
		const tool = createComputerUseTool(host)

		expect(() => tool.inputSchema.parse({ type: 'screenshot' })).not.toThrow()
		expect(() =>
			tool.inputSchema.parse({ type: 'mouse_click', at: { x: 1, y: 2 }, button: 'left' }),
		).not.toThrow()
		expect(() => tool.inputSchema.parse({ type: 'mouse_click' })).toThrow()
		expect(() => tool.inputSchema.parse({ type: 'nope' })).toThrow()
		expect(() => tool.inputSchema.parse({ type: 'scroll', at: { x: 0, y: 0 } })).toThrow()
	})
})
