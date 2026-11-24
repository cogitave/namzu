import { encode } from 'fast-png'
import { describe, expect, it } from 'vitest'
import type { ComputerUseHost, WindowInfo } from '../../../types/computer-use/index.js'
import type { ToolContext, ToolResult } from '../../../types/tool/index.js'
import { appTier, createComputerUseTool } from '../computer-use.js'

const png = Buffer.from(
	encode({
		width: 640,
		height: 400,
		data: new Uint8Array(640 * 400 * 3).fill(90),
		channels: 3,
		depth: 8,
	}),
)

function windowOf(app: string): WindowInfo {
	return {
		id: '0x1',
		title: 'Window',
		app,
		pid: 5,
		bounds: { x: 0, y: 0, width: 640, height: 400 },
		focused: true,
		minimized: false,
	}
}

function makeHost(app: string) {
	const win = windowOf(app)
	const touched: string[] = []
	const host: ComputerUseHost = {
		id: 'tier-host',
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
		getDisplayGeometry: async () => ({
			width: 640,
			height: 400,
			scaleFactor: 1,
		}),
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
				children: [{ ref: 'h:0', role: 'Button', name: 'OK', actions: ['invoke'] }],
			},
		}),
		uiAct: async () => {
			touched.push('uiAct')
			return { ok: true }
		},
	}
	return { host, touched }
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

describe('appTier', () => {
	it.each([
		['chrome', 'view'],
		['Chrome.exe', 'view'],
		['msedge', 'view'],
		['firefox', 'view'],
		['google-chrome-stable', 'view'],
		['C:\\Program Files\\Mozilla Firefox\\firefox.exe', 'view'],
		['brave-browser', 'view'],
		['WindowsTerminal', 'click'],
		['gnome-terminal-server', 'click'],
		['konsole', 'click'],
		['Code', 'click'],
		['code.exe', 'click'],
		['idea64', 'click'],
		['devenv', 'click'],
		['sublime_text', 'click'],
		['notepad', 'full'],
		['calc', 'full'],
		['gnome-calculator', 'full'],
		['codec-tool', 'full'],
		['Navigator', 'view'],
		['jetbrains-idea', 'click'],
		['studio', 'full'],
		['zen', 'full'],
		['arc', 'full'],
		['nova', 'full'],
		['', 'full'],
	])('classes %s as %s', (app, tier) => {
		expect(appTier(app)).toBe(tier)
	})
})

describe('computer_use app tiers', () => {
	it('refuses a click, a drag, a key and a control press in a browser, naming the browser tool', async () => {
		const { host, touched } = makeHost('chrome')
		const tool = createComputerUseTool(host, { settleMs: 0 })
		await run(tool, { type: 'screenshot', window_id: '0x1' })
		for (const input of [
			{ type: 'mouse_click', at: { x: 10, y: 10 }, button: 'left' },
			{ type: 'mouse_drag', from: { x: 1, y: 1 }, to: { x: 5, y: 5 } },
			{ type: 'type_text', text: 'hello' },
			{ type: 'key', keys: 'ENTER' },
			{ type: 'ui_act', ref: 'h:0', action: 'invoke', window_id: '0x1' },
			{ type: 'batch', actions: [{ type: 'key', keys: 'ENTER' }] },
		]) {
			const result = await run(tool, input)
			expect(result.success, JSON.stringify(input)).toBe(false)
			expect(result.error).toContain('browser tool')
			expect(result.error).toContain('Chrome')
		}
		expect(touched).toEqual([])
	})

	it('still lets a browser window be looked at and scrolled', async () => {
		const { host } = makeHost('msedge')
		const tool = createComputerUseTool(host, { settleMs: 0 })
		expect((await run(tool, { type: 'screenshot', window_id: '0x1' })).success).toBe(true)
		const scrolled = await run(tool, {
			type: 'scroll',
			at: { x: 10, y: 10 },
			direction: 'down',
			amount: 3,
		})
		expect(scrolled.error ?? '').not.toContain('browser tool')
	})

	it('lets a terminal or an editor be clicked, and refuses text and keys there with the alternative', async () => {
		for (const app of ['gnome-terminal-server', 'Code']) {
			const { host, touched } = makeHost(app)
			const tool = createComputerUseTool(host, { settleMs: 0 })
			await run(tool, { type: 'screenshot', window_id: '0x1' })
			const typed = await run(tool, { type: 'type_text', text: 'ls' })
			expect(typed.success, app).toBe(false)
			expect(typed.error).toContain('shell tool')
			if (app === 'Code') expect(typed.error).toContain('edit tools')
			const keyed = await run(tool, { type: 'key', keys: 'ENTER' })
			expect(keyed.success, app).toBe(false)
			expect(keyed.error).toContain('shell tool')
			const setValue = await run(tool, {
				type: 'ui_act',
				ref: 'h:0',
				action: 'set_value',
				value: 'x',
				window_id: '0x1',
			})
			expect(setValue.success, app).toBe(false)
			expect(touched).toEqual([])
			const clicked = await run(tool, {
				type: 'mouse_click',
				at: { x: 10, y: 10 },
				button: 'left',
			})
			expect(clicked.error ?? '', app).not.toContain('does not type')
			expect(touched.length, app).toBeGreaterThan(0)
		}
	})

	it('leaves every other application with all its actions', async () => {
		const { host, touched } = makeHost('notepad')
		const tool = createComputerUseTool(host, { settleMs: 0 })
		await run(tool, { type: 'screenshot', window_id: '0x1' })
		expect((await run(tool, { type: 'type_text', text: 'hello' })).success).toBe(true)
		expect((await run(tool, { type: 'key', keys: 'ENTER' })).success).toBe(true)
		expect(touched.length).toBe(2)
	})

	it("keeps the person's denied list on top: a denied browser says off limits", async () => {
		const { host, touched } = makeHost('chrome')
		const tool = createComputerUseTool(host, {
			settleMs: 0,
			deniedApps: ['chrome'],
		})
		const result = await run(tool, { type: 'key', keys: 'ENTER' })
		expect(result.success).toBe(false)
		expect(result.error).toContain('off limits')
		expect(touched).toEqual([])
	})

	it('still honours the denied list for an application the tiers allow', async () => {
		const { host, touched } = makeHost('notepad')
		const tool = createComputerUseTool(host, {
			settleMs: 0,
			deniedApps: ['notepad'],
		})
		const result = await run(tool, { type: 'key', keys: 'ENTER' })
		expect(result.error).toContain('off limits')
		expect(touched).toEqual([])
	})

	it('tells the model the three working habits in its description', () => {
		const { host } = makeHost('notepad')
		const { description } = createComputerUseTool(host, { settleMs: 0 })
		expect(description).toContain(
			'Look at the screen before you say what state an application is in.',
		)
		expect(description).toContain('Never click links with computer use')
		expect(description).toContain(
			'Prefer a connected tool or a command line to the screen when one does the job.',
		)
		expect(description).toContain('act on a page with the browser tool')
	})
})

describe('computer_use app tiers, fresh placement and scroll keys', () => {
	it('reads a fresh window list before placing a display call with no window', async () => {
		const { host } = makeHost('notepad')
		const win = windowOf('notepad')
		let current = win
		host.listWindows = async () => [current]
		const tool = createComputerUseTool(host, { settleMs: 0 })
		await run(tool, { type: 'list_windows' })
		current = windowOf('chrome')
		const refused = await run(tool, {
			type: 'mouse_click',
			at: { x: 10, y: 10 },
			button: 'left',
		})
		expect(refused.success).toBe(false)
		expect(refused.error).toContain('only looks at')
	})

	it('allows page-moving keys in a browser and refuses others', async () => {
		const { host } = makeHost('chrome')
		const tool = createComputerUseTool(host, { settleMs: 0 })
		await run(tool, { type: 'screenshot', window_id: '0x1' })
		const scroll = await run(tool, { type: 'key', keys: 'PAGE_DOWN' })
		expect(scroll.error ?? '').not.toContain('only looks at')
		const other = await run(tool, { type: 'key', keys: 'CTRL+L' })
		expect(other.success).toBe(false)
		expect(other.error).toContain('only looks at')
	})

	it('does not advise keys when window pixel scrolling is unavailable', async () => {
		const { host } = makeHost('notepad')
		Object.assign(host, {
			capabilities: { ...host.capabilities, windowScroll: false },
		})
		const tool = createComputerUseTool(host, { settleMs: 0 })
		await run(tool, { type: 'screenshot', window_id: '0x1' })
		const res = await run(tool, {
			type: 'scroll',
			at: { x: 5, y: 5 },
			direction: 'down',
			amount: 3,
		})
		expect(res.success).toBe(false)
		expect(res.error ?? '').not.toContain('PAGE_DOWN')
	})
})

describe('appTier with macOS display names', () => {
	it.each([
		'Google Chrome',
		'Google Chrome Canary',
		'Microsoft Edge',
		'Brave Browser',
		'Arc',
		'Safari',
		'Firefox',
	])('looks only in %s', (name) => {
		expect(appTier(name)).toBe('view')
	})
	it.each([
		'Sublime Text',
		'Android Studio',
		'Visual Studio Code',
		'IntelliJ IDEA',
		'Zed',
		'Terminal',
	])('clicks but does not type in %s', (name) => {
		expect(appTier(name)).toBe('click')
	})
	it('leaves other applications full', () => {
		expect(appTier('Notes')).toBe('full')
	})
})
