import { encode } from 'fast-png'
import { describe, expect, it, vi } from 'vitest'
import type { ComputerUseHost, WindowInfo } from '../../../types/computer-use/index.js'
import type { ToolContext, ToolResult } from '../../../types/tool/index.js'
import {
	type BrowserWindowAnswer,
	type ComputerUseToolOptions,
	createComputerUseTool,
} from '../computer-use.js'

const png = Buffer.from(
	encode({
		width: 640,
		height: 400,
		data: new Uint8Array(640 * 400 * 3).fill(90),
		channels: 3,
		depth: 8,
	}),
)

function makeHost(app: string) {
	const win: WindowInfo = {
		id: '0x1',
		title: 'SharePoint admin center',
		app,
		pid: 5,
		bounds: { x: 0, y: 0, width: 640, height: 400 },
		focused: true,
		minimized: false,
	}
	const touched: string[] = []
	const host: ComputerUseHost = {
		id: 'browser-host',
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
		listWindows: async () => [win],
		captureWindow: async () => ({
			data: png,
			mimeType: 'image/png',
			width: 640,
			height: 400,
			window: win,
			captureId: 'w1',
		}),
		executeWindow: async () => {
			touched.push('executeWindow')
			return { delivery: 'delivered_unverified', retrySafety: 'unsafe' }
		},
		uiSnapshot: async () => ({
			title: 'Window',
			root: {
				ref: '',
				role: 'Window',
				name: 'Window',
				children: [
					{ ref: 'h:0', role: 'Button', name: 'Sites', actions: ['invoke'] },
					{ ref: 'h:1', role: 'Button', name: 'Accept terms', actions: ['invoke'] },
				],
			},
		}),
		uiAct: async () => {
			touched.push('uiAct')
			return { ok: true }
		},
	}
	return { host, touched }
}

function context(turn = '4adf3fdd-2823-4640-be0a-5d21fe28b6d2'): ToolContext {
	return {
		sessionId: '0190a5b2-7c3d-7e4f-8a9b-0c1d2e3f4a5b' as never,
		turnId: turn as never,
		workingDirectory: '/tmp',
		abortSignal: new AbortController().signal,
		env: {},
		log: () => {},
	}
}

async function run(
	tool: ReturnType<typeof createComputerUseTool>,
	input: unknown,
	turn?: string,
): Promise<ToolResult> {
	return tool.execute(tool.inputSchema.parse(input), context(turn))
}

const CLICK = { type: 'mouse_click', at: { x: 10, y: 10 }, button: 'left' }

function build(app: string, options: ComputerUseToolOptions) {
	const { host, touched } = makeHost(app)
	return { tool: createComputerUseTool(host, { settleMs: 0, ...options }), touched }
}

const WAYS = ['for this conversation', "Namzu's own browser", 'while you guide them'] as const

describe('computerUse.browserWindows: the tier decision per setting', () => {
	it('look refuses a click and says the three ways forward', async () => {
		const { tool, touched } = build('brave-browser', { browserWindows: 'look' })
		await run(tool, { type: 'screenshot', window_id: '0x1' })
		const result = await run(tool, CLICK)
		expect(result.success).toBe(false)
		expect(result.error).toContain('only looks at')
		expect(result.error).toContain('Settings')
		expect(result.error).toContain("Namzu's own browser")
		expect(result.error).toContain('while you guide them')
		expect(touched).toEqual([])
	})

	it('look is the default when the option is absent', async () => {
		const { tool, touched } = build('chrome', {})
		await run(tool, { type: 'screenshot', window_id: '0x1' })
		expect((await run(tool, CLICK)).success).toBe(false)
		expect(touched).toEqual([])
	})

	it('act clicks and types in a browser like any other application', async () => {
		const { tool, touched } = build('brave-browser', { browserWindows: 'act' })
		await run(tool, { type: 'screenshot', window_id: '0x1' })
		expect((await run(tool, CLICK)).success).toBe(true)
		expect((await run(tool, { type: 'type_text', text: 'hello' })).success).toBe(true)
		expect(touched.length).toBeGreaterThan(0)
	})

	it('ask asks a person the first time and acts after a yes, without asking again', async () => {
		const ask = vi.fn(async (_q: { app: string }): Promise<BrowserWindowAnswer> => 'allow')
		const { tool, touched } = build('Brave Browser', {
			browserWindows: 'ask',
			askBrowserWindow: ask,
		})
		await run(tool, { type: 'screenshot', window_id: '0x1' })
		expect((await run(tool, CLICK)).success).toBe(true)
		expect((await run(tool, { type: 'type_text', text: 'x' })).success).toBe(true)
		expect(ask).toHaveBeenCalledTimes(1)
		expect(ask.mock.calls[0]?.[0]).toMatchObject({ app: 'Brave Browser' })
		expect(touched.length).toBeGreaterThan(0)
		expect(tool.browserGrants()).toEqual(['Brave Browser'])
	})

	it('ask keeps a look-only window when the person says not now, and asks once per turn', async () => {
		const ask = vi.fn(async (): Promise<BrowserWindowAnswer> => 'deny')
		const { tool, touched } = build('brave-browser', {
			browserWindows: 'ask',
			askBrowserWindow: ask,
		})
		const first = await run(tool, CLICK, 'turn-1')
		expect(first.success).toBe(false)
		for (const text of WAYS) expect(first.error).toContain(text)
		expect((await run(tool, CLICK, 'turn-1')).success).toBe(false)
		expect(ask).toHaveBeenCalledTimes(1)
		expect(touched).toEqual([])
		await run(tool, CLICK, 'turn-2')
		expect(ask).toHaveBeenCalledTimes(2)
		expect(tool.browserGrants()).toEqual([])
	})
})

describe('the browser grant', () => {
	it('is per application: another browser is asked on its own', async () => {
		const ask = vi.fn(async (): Promise<BrowserWindowAnswer> => 'allow')
		const first = build('brave-browser', { browserWindows: 'ask', askBrowserWindow: ask })
		await run(first.tool, CLICK)
		expect(ask).toHaveBeenCalledTimes(1)
		const second = build('firefox', { browserWindows: 'ask', askBrowserWindow: ask })
		expect(second.tool.browserGrants()).toEqual([])
		await run(second.tool, CLICK)
		expect(ask).toHaveBeenCalledTimes(2)
	})

	it('is per conversation: a new tool starts with no grant', async () => {
		const ask = vi.fn(async (): Promise<BrowserWindowAnswer> => 'allow')
		const a = build('chrome', { browserWindows: 'ask', askBrowserWindow: ask })
		await run(a.tool, CLICK)
		expect(a.tool.browserGrants()).toHaveLength(1)
		const b = build('chrome', { browserWindows: 'ask', askBrowserWindow: ask })
		expect(b.tool.browserGrants()).toEqual([])
	})

	it('can be taken back, and the next action asks again', async () => {
		const ask = vi.fn(async (): Promise<BrowserWindowAnswer> => 'allow')
		const { tool } = build('Microsoft Edge', { browserWindows: 'ask', askBrowserWindow: ask })
		await run(tool, CLICK)
		expect(tool.revokeBrowserGrant('msedge')).toBe(false)
		expect(tool.revokeBrowserGrant('microsoft edge')).toBe(true)
		await run(tool, CLICK)
		expect(ask).toHaveBeenCalledTimes(2)
	})

	it('never comes from anything but the answer: no question channel means look-only (scheduled, unattended)', async () => {
		const { tool, touched } = build('brave-browser', { browserWindows: 'ask' })
		const result = await run(tool, CLICK)
		expect(result.success).toBe(false)
		expect(result.error).toContain('nobody can be asked')
		expect(tool.browserGrants()).toEqual([])
		expect(touched).toEqual([])
	})

	it('an unanswered question is not a yes', async () => {
		const { tool, touched } = build('brave-browser', {
			browserWindows: 'ask',
			askBrowserWindow: async () => 'unavailable',
		})
		expect((await run(tool, CLICK)).success).toBe(false)
		expect(touched).toEqual([])
		const thrown = build('brave-browser', {
			browserWindows: 'ask',
			askBrowserWindow: async () => {
				throw new Error('gone')
			},
		})
		expect((await run(thrown.tool, CLICK)).success).toBe(false)
		expect(thrown.touched).toEqual([])
	})

	it('is never asked under look or act', async () => {
		const ask = vi.fn(async (): Promise<BrowserWindowAnswer> => 'allow')
		for (const setting of ['look', 'act'] as const) {
			const { tool } = build('chrome', { browserWindows: setting, askBrowserWindow: ask })
			await run(tool, CLICK)
			expect(tool.browserGrants()).toEqual([])
		}
		expect(ask).not.toHaveBeenCalled()
	})

	it('keeps the denied list on top of a grant', async () => {
		const { tool, touched } = build('chrome', {
			browserWindows: 'act',
			deniedApps: ['chrome'],
		})
		const result = await run(tool, CLICK)
		expect(result.error).toContain('off limits')
		expect(touched).toEqual([])
	})
})

describe('the safety asks still fire for a browser window', () => {
	it('reads a destructive or consequential action as one to answer for, with the grant or without', () => {
		const { tool } = build('brave-browser', { browserWindows: 'act' })
		expect(tool.consequence({ type: 'key', keys: 'delete' })).toBeDefined()
		for (const target of [
			'Accept terms',
			'Delete site',
			'Send',
			'Post',
			'Submit order',
			'Password',
			'Publish',
		]) {
			expect(tool.consequence({ type: 'ui_do', target }), target).toBeDefined()
		}
		expect(tool.consequence({ type: 'ui_do', target: 'Sites' })).toBeUndefined()
	})

	it('still marks a click as destructive so a review asks', () => {
		const { tool } = build('brave-browser', { browserWindows: 'act' })
		expect(tool.isDestructive?.({ type: 'mouse_click', at: { x: 1, y: 1 }, button: 'left' })).toBe(
			true,
		)
	})
})

describe('the tool texts', () => {
	it('explain the browser rule once, per setting, without promising a reload helps', () => {
		for (const setting of ['look', 'ask', 'act'] as const) {
			const { tool } = build('chrome', { browserWindows: setting })
			const text = tool.description
			expect(text, setting).toContain('browser')
			expect(text, setting).not.toMatch(/reload/i)
		}
		const ask = build('chrome', { browserWindows: 'ask' }).tool.description
		for (const text of WAYS) expect(ask).toContain(text)
		expect(ask).toContain('password field')
		expect(ask).toContain('organisation-wide admin settings')
		expect(build('chrome', { browserWindows: 'look' }).tool.description).toContain(
			'act on a page with the browser tool',
		)
		expect(build('chrome', { browserWindows: 'act' }).tool.description).toContain('password field')
	})

	it('refusals never say reloading helps', async () => {
		const { tool } = build('chrome', {
			browserWindows: 'ask',
			askBrowserWindow: async () => 'deny',
		})
		const result = await run(tool, CLICK)
		expect(result.error).not.toMatch(/reload/i)
	})
})
