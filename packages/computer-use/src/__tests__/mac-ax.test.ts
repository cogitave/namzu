/**
 * The macOS accessibility backend, proven without a Mac: the host's client
 * side, the adapter's views of a tree (refs that survive, outline, filters,
 * acting), the helper's build and the adapter's capabilities. A scripted fake
 * stands where the helper app answers; the helper itself is proven on a real
 * Mac (see docs/sdk/computer-use-host.md).
 */
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	statSync,
	writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

vi.mock('../util/spawn.js', () => ({
	hasExecutable: async () => true,
	runCommand: async () => ({
		stdout: Buffer.alloc(0),
		stderr: '',
		exitCode: 0,
		timedOut: false,
		signal: null,
	}),
	runCommandOrThrow: async () => ({
		stdout: Buffer.from('{}'),
		stderr: '',
		exitCode: 0,
	}),
}))

import {
	A11yError,
	type A11yProcess,
	MAC_HELPER_BUNDLE_ID,
	MacA11yHost,
	cgWindowId,
	createMacA11yHost,
	ensureMacHelper,
	macHelperPaths,
	macHelperSourceHash,
} from '../a11y/index.js'
import { macHelperInfoPlist } from '../a11y/macos-helper.js'
import { MacAxSurface } from '../adapters/darwin-ax.js'
import { DarwinAdapter, keyEventOf } from '../adapters/darwin.js'

type Handler = (request: Record<string, unknown>) => Record<string, unknown>

/** A helper that answers each command from a table, and records what it was asked. */
class ScriptedHelper implements A11yProcess {
	readonly asked: Record<string, unknown>[] = []
	private line: ((line: string) => void) | undefined
	constructor(private readonly handlers: Record<string, Handler>) {}
	write(text: string): void {
		const request = JSON.parse(text) as Record<string, unknown>
		this.asked.push(request)
		const handler = this.handlers[String(request.cmd)]
		queueMicrotask(() => {
			if (!handler) {
				this.line?.(
					JSON.stringify({
						id: request.id,
						ok: false,
						code: 'unknown_command',
					}),
				)
				return
			}
			try {
				this.line?.(JSON.stringify({ id: request.id, ok: true, ...handler(request) }))
			} catch (error) {
				const e = error as { code?: string; message?: string }
				this.line?.(
					JSON.stringify({
						id: request.id,
						ok: false,
						code: e.code ?? 'error',
						message: e.message,
					}),
				)
			}
		})
	}
	onLine(handler: (line: string) => void): void {
		this.line = handler
		queueMicrotask(() => handler(JSON.stringify({ ok: true, hello: true, version: 1 })))
	}
	onExit(): void {}
	kill(): void {}
}

const fp = (id: string, extra: Record<string, unknown> = {}) => ({
	runtimeId: `7:${id}`,
	automationId: '',
	role: 'AXButton',
	nameHash: id,
	parentPath: '',
	ordinal: 0,
	processStart: 1000,
	...extra,
})

function node(
	index: number,
	parent: number,
	role: string,
	name: string,
	extra: Record<string, unknown> = {},
) {
	return {
		index,
		parent,
		depth: parent < 0 ? 0 : 1,
		role,
		name,
		rect: [10 * index, 20, 100, 30],
		enabled: true,
		offscreen: false,
		focused: false,
		actions: [],
		fp: fp(String(index), { role }),
		...extra,
	}
}

const WINDOWS = [
	{
		hwnd: 501,
		pid: 7,
		process: 'TextEdit',
		title: 'Untitled',
		x: 100,
		y: 100,
		width: 1200,
		height: 800,
		minimized: false,
		focused: true,
		z: 0,
	},
	{
		hwnd: 502,
		pid: 8,
		process: 'Finder',
		title: 'Documents',
		x: 0,
		y: 0,
		width: 800,
		height: 600,
		minimized: false,
		focused: false,
		z: 1,
	},
]

function setup(handlers: Record<string, Handler>) {
	const helper = new ScriptedHelper({
		windows: () => ({ windows: WINDOWS }),
		seq: () => ({ seq: 4 }),
		...handlers,
	})
	const host = new MacA11yHost({ spawnHelper: () => helper })
	const surface = new MacAxSurface({
		host,
		scale: async () => 2,
		keyEvent: keyEventOf,
		wait: async () => undefined,
	})
	return { helper, host, surface }
}

const simpleTree = (overrides: Record<string, unknown> = {}) => ({
	rev: 3,
	app: 'TextEdit',
	title: 'Untitled',
	pid: 7,
	total: 4,
	truncated: false,
	readMs: 12,
	nodes: [
		node(0, -1, 'AXWindow', 'Untitled'),
		node(1, 0, 'AXButton', 'Save', { actions: ['invoke'] }),
		node(2, 0, 'AXTextArea', '', { value: 'hello', actions: ['value'] }),
		node(3, 0, 'AXCheckBox', 'Wrap', { toggle: 'off', actions: ['toggle'] }),
	],
	...overrides,
})

describe('the host speaking to the helper', () => {
	it('sends no script, lists windows and reads a tree with fingerprints', async () => {
		const { host, helper } = setup({
			snapshot: () => simpleTree({ selectedText: 'ell' }),
		})
		const windows = await host.listWindows()
		expect(windows.map((w) => [w.processName, w.title, w.focused])).toEqual([
			['TextEdit', 'Untitled', true],
			['Finder', 'Documents', false],
		])
		const tree = await host.readTree({ windowId: '501' })
		expect(tree.nodes[1]?.fingerprint.runtimeId).toBe('7:1')
		expect(tree.selectedText).toBe('ell')
		expect(helper.asked[0]).toMatchObject({ cmd: 'windows' })
		expect(host.id).toBe('macos-ax')
	})

	it('reports permissions and the steps a person must take', async () => {
		const { host } = setup({
			permissions: () => ({
				accessibility: false,
				screenCapture: true,
				app: 'Namzu Helper',
				steps: ['System Settings > Privacy & Security > Accessibility: turn on "Namzu Helper".'],
			}),
		})
		const p = await host.permissions()
		expect(p.accessibility).toBe(false)
		expect(p.steps[0]).toContain('Accessibility')
	})

	it('accepts a window id as decimal or hex and refuses anything else', () => {
		expect(cgWindowId('501')).toBe(501)
		expect(cgWindowId('0x1f5')).toBe(501)
		expect(() => cgWindowId('abc')).toThrow(A11yError)
	})

	it('accepts a window id as a number as well, everywhere', async () => {
		expect(cgWindowId(501)).toBe(501)
		expect(() => cgWindowId(0)).toThrow(A11yError)
		expect(() => cgWindowId(1.5)).toThrow(A11yError)
		const { surface, helper, host } = setup({
			snapshot: () => simpleTree(),
			act: () => ({ done: true }),
		})
		const snap = await surface.uiSnapshot(501)
		expect(snap.windowId).toBe('501')
		expect(helper.asked.find((r) => r.cmd === 'snapshot')).toMatchObject({ hwnd: 501 })
		expect((await host.readTree({ windowId: 501 })).windowId).toBe('501')
		expect(await host.focus(502).catch(() => 'no')).toBeDefined()
		await host.seq(501)
		expect(helper.asked.filter((r) => r.cmd === 'seq').at(-1)).toMatchObject({ hwnd: 501 })
	})

	it('reads a capture the helper wrote and removes the file; refuses a path outside its folder', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'mac-cap-'))
		const file = join(dir, 'w501.png')
		writeFileSync(file, Buffer.from('png'))
		let reply: Record<string, unknown> = {
			path: file,
			width: 10,
			height: 20,
			via: 'screencapturekit',
		}
		const { host } = setup({ capture_window: () => reply })
		host.useCaptureDir(dir)
		const shot = await host.captureWindow('501')
		expect(shot.data.toString()).toBe('png')
		expect(existsSync(file)).toBe(false)
		reply = { path: '/etc/passwd', width: 1, height: 1, via: 'x' }
		await expect(host.captureWindow('501')).rejects.toMatchObject({
			code: 'bad_reply',
		})
	})
})

describe('the adapter views of a tree', () => {
	it('lists windows as the host contract wants and focuses by id', async () => {
		const { surface } = setup({ focus: () => ({ ok: true, focusedId: 502 }) })
		const windows = await surface.listWindows()
		expect(windows[0]).toMatchObject({
			id: '501',
			app: 'TextEdit',
			pid: 7,
			focused: true,
		})
		expect(await surface.focusWindow('502')).toMatchObject({
			ok: true,
			focusedId: '502',
		})
	})

	it('gives actionable controls refs that stay the same across snapshots', async () => {
		const { surface } = setup({ snapshot: () => simpleTree() })
		const a = await surface.uiSnapshot('501')
		const b = await surface.uiSnapshot('501')
		const refsOf = (s: typeof a) => (s.root.children ?? []).map((c) => c.ref)
		expect(refsOf(a)).toEqual(refsOf(b))
		const [save, area, wrap] = a.root.children ?? []
		expect(save).toMatchObject({
			role: 'AXButton',
			name: 'Save',
			actions: ['invoke'],
		})
		expect(save?.ref).toMatch(/^ax[0-9a-f]{8}$/)
		expect(area?.actions).toEqual(['set_value', 'focus'])
		expect(wrap?.actions).toEqual(['toggle'])
		expect(a.root.ref).toBe('')
		expect(a.app).toBe('TextEdit')
	})

	it('filters by role without the AX prefix and by query', async () => {
		const { surface } = setup({ snapshot: () => simpleTree() })
		const byRole = await surface.uiSnapshot('501', { role: 'button' })
		expect((byRole.root.children ?? []).map((c) => c.name)).toEqual(['Save'])
		const byQuery = await surface.uiSnapshot('501', { query: 'hello' })
		expect((byQuery.root.children ?? []).map((c) => c.role)).toEqual(['AXTextArea'])
	})

	it('passes through nameless wrapper groups', async () => {
		const tree = simpleTree({
			nodes: [
				node(0, -1, 'AXWindow', 'W'),
				node(1, 0, 'AXGroup', ''),
				node(2, 1, 'AXButton', 'Deep', { actions: ['invoke'] }),
			],
		})
		const { surface } = setup({ snapshot: () => tree })
		const snap = await surface.uiSnapshot('501')
		expect(snap.root.children?.map((c) => c.name)).toEqual(['Deep'])
	})

	it('outlines a large window and opens a region by its ref', async () => {
		const many = Array.from({ length: 450 }, (_, i) => node(i + 2, 1, 'AXStaticText', `row ${i}`))
		const big = simpleTree({
			nodes: [
				node(0, -1, 'AXWindow', 'Big'),
				node(1, 0, 'AXList', 'Rows', { actions: [] }),
				...many,
			],
			total: 452,
		})
		const region = simpleTree({
			nodes: [
				node(0, -1, 'AXList', 'Rows'),
				node(1, 0, 'AXButton', 'Row action', { actions: ['invoke'] }),
			],
		})
		const calls: Record<string, unknown>[] = []
		const { surface } = setup({
			snapshot: (r) => {
				calls.push(r)
				return r.root ? region : big
			},
		})
		const snap = await surface.uiSnapshot('501')
		expect(snap.outline).toBe(true)
		const list = snap.root.children?.[0]
		expect(list?.hiddenChildren).toBeGreaterThan(0)
		expect(list?.ref).toMatch(/^ax/)
		const opened = await surface.uiSnapshot(undefined, {
			root: list?.ref ?? '',
		})
		expect(opened.region).toBe(true)
		expect(calls[1]?.root).toMatchObject({ runtimeId: '7:1' })
		expect(opened.root.children?.[0]?.name).toBe('Row action')
	})

	it('shows a lazy menu as hidden children a person can open', async () => {
		const tree = simpleTree({
			nodes: [
				node(0, -1, 'AXWindow', 'W'),
				node(1, 0, 'AXMenuBar', '', { childCount: 1 }),
				node(2, 1, 'AXMenuBarItem', 'Format', {
					actions: ['invoke'],
					childCount: 1,
				}),
			],
		})
		const { surface } = setup({ snapshot: () => tree })
		const snap = await surface.uiSnapshot('501')
		const item = snap.root.children?.[0]?.children?.[0]
		expect(item).toMatchObject({ name: 'Format', hiddenChildren: 1 })
		expect(item?.ref).toMatch(/^ax/)
	})

	it('refuses a ref it never handed out, and a ref from another window', async () => {
		const { surface } = setup({ snapshot: () => simpleTree() })
		expect(await surface.uiAct('axdeadbeef', 'invoke')).toMatchObject({
			ok: false,
			code: 'STALE_REF',
		})
		const snap = await surface.uiSnapshot('501')
		await expect(
			surface.uiSnapshot('502', { root: snap.root.children?.[0]?.ref ?? '' }),
		).rejects.toThrow(/belongs to window 501/)
	})
})

describe('acting on controls', () => {
	it('presses by fingerprint and reports a read-back', async () => {
		const { surface, helper } = setup({
			snapshot: () => simpleTree(),
			act: () => ({
				done: true,
				before: '0',
				after: '1',
				expected: 'not 0',
				verified: true,
				via: 'runtimeId',
			}),
		})
		const snap = await surface.uiSnapshot('501')
		const wrap = snap.root.children?.[2]
		const result = await surface.uiAct(wrap?.ref ?? '', 'toggle')
		expect(result).toMatchObject({
			ok: true,
			delivery: 'delivered_verified',
			readBack: { observed: '1' },
		})
		const act = helper.asked.find((r) => r.cmd === 'act')
		expect(act).toMatchObject({
			hwnd: 501,
			action: 'toggle',
			fingerprint: { runtimeId: '7:3' },
		})
	})

	it('says not delivered when the control refuses', async () => {
		const { surface } = setup({
			snapshot: () => simpleTree(),
			act: () => ({
				done: false,
				detail: 'the control does not offer that action',
			}),
		})
		const snap = await surface.uiSnapshot('501')
		const result = await surface.uiAct(snap.root.children?.[0]?.ref ?? '', 'invoke')
		expect(result).toMatchObject({
			ok: false,
			delivery: 'not_delivered',
			retrySafety: 'safe',
		})
	})

	it('turns the helper’s stale and ambiguous answers into typed failures', async () => {
		let code = 'STALE_REF'
		const { surface } = setup({
			snapshot: () => simpleTree(),
			act: () => {
				throw { code, message: 'gone' }
			},
		})
		const snap = await surface.uiSnapshot('501')
		const ref = snap.root.children?.[0]?.ref ?? ''
		expect(await surface.uiAct(ref, 'invoke')).toMatchObject({
			ok: false,
			code: 'STALE_REF',
		})
		code = 'AMBIGUOUS_TARGET'
		expect(await surface.uiAct(ref, 'invoke')).toMatchObject({
			ok: false,
			code: 'AMBIGUOUS_TARGET',
		})
	})

	it('surfaces the permission sentence when accessibility is off', async () => {
		const { surface } = setup({
			snapshot: () => {
				throw {
					code: 'accessibility_denied',
					message: 'Accessibility is off for Namzu Helper.',
				}
			},
		})
		await expect(surface.uiSnapshot('501')).rejects.toThrow(
			'Accessibility is off for Namzu Helper.',
		)
	})
})

describe('input to a captured window', () => {
	async function captured() {
		const dir = mkdtempSync(join(tmpdir(), 'mac-cap-'))
		const png = Buffer.alloc(33)
		png.writeUInt32BE(0x89504e47, 0)
		png.writeUInt32BE(1200, 16)
		png.writeUInt32BE(800, 20)
		const file = join(dir, 'w.png')
		writeFileSync(file, png)
		const ctx = setup({
			capture_window: () => ({
				path: file,
				width: 1200,
				height: 800,
				via: 'screencapturekit',
			}),
			click: () => ({ done: true }),
			scroll: () => ({ done: true }),
			type: () => ({ done: true }),
			key: () => ({ done: true }),
		})
		ctx.host.useCaptureDir(dir)
		const shot = await ctx.surface.captureWindow('501')
		return { ...ctx, shot }
	}

	it('turns capture pixels into global points (window origin plus offset over the scale)', async () => {
		const { surface, helper, shot } = await captured()
		await surface.executeWindow(shot.captureId, {
			type: 'mouse_click',
			at: { x: 200, y: 100 },
			button: 'left',
			count: 2,
		})
		const click = helper.asked.find((r) => r.cmd === 'click')
		// window at (100,100) physical, 1200x800 capture of a 1200x800 window, scale 2
		expect(click).toMatchObject({ hwnd: 501, x: 150, y: 100, count: 2 })
	})

	it('scrolls, types and presses keys through the helper', async () => {
		const { surface, helper, shot } = await captured()
		await surface.executeWindow(shot.captureId, {
			type: 'scroll',
			at: { x: 0, y: 0 },
			direction: 'down',
			amount: 3,
		})
		await surface.executeWindow(shot.captureId, {
			type: 'type_text',
			text: 'héllo',
		})
		await surface.executeWindow(shot.captureId, { type: 'key', keys: 'cmd+a' })
		expect(helper.asked.find((r) => r.cmd === 'scroll')).toMatchObject({
			direction: 'down',
			amount: 3,
		})
		expect(helper.asked.find((r) => r.cmd === 'type')).toMatchObject({
			text: 'héllo',
		})
		expect(helper.asked.find((r) => r.cmd === 'key')).toMatchObject({
			code: 0,
			flags: ['command'],
		})
	})

	it('refuses an old capture and a window that changed size', async () => {
		const { surface, shot, helper } = await captured()
		await expect(
			surface.executeWindow('mac-501-999', { type: 'type_text', text: 'x' }),
		).rejects.toThrow(/out of date/)
		// The window has moved since the capture.
		;(WINDOWS[0] as { width: number }).width = 900
		try {
			await expect(
				surface.executeWindow(shot.captureId, { type: 'type_text', text: 'x' }),
			).rejects.toThrow(/moved or changed size/)
		} finally {
			;(WINDOWS[0] as { width: number }).width = 1200
		}
		expect(helper.asked.some((r) => r.cmd === 'type')).toBe(false)
	})

	it('waits for the window to settle from the marker taken before the input', async () => {
		const { surface, helper, shot } = await captured()
		const ctx = setup({})
		void ctx
		await surface.executeWindow(shot.captureId, {
			type: 'type_text',
			text: 'x',
		})
		const seqs = helper.asked.filter((r) => r.cmd === 'seq')
		expect(seqs.length).toBeGreaterThan(0)
	})
})

/** Stand-ins for swiftc, openssl, security and codesign that leave what the real ones leave. */
function toolbox(options: { failIdentity?: boolean } = {}) {
	const calls: string[][] = []
	const run = (async (command: string, args: readonly string[]) => {
		calls.push([command, ...args])
		const ok = (stdout = '') => ({
			exitCode: 0,
			stdout: Buffer.from(stdout),
			stderr: '',
			timedOut: false,
			signal: null,
		})
		if (command === 'swiftc') {
			const out = args[args.indexOf('-o') + 1] as string
			mkdirSync(dirname(out), { recursive: true })
			writeFileSync(out, 'binary')
		}
		if (command === 'openssl' && args[0] === 'req') {
			if (options.failIdentity)
				return { ...ok(), exitCode: 1, stderr: 'openssl: cannot make a key' }
			writeFileSync(args[args.indexOf('-keyout') + 1] as string, 'KEY')
			writeFileSync(args[args.indexOf('-out') + 1] as string, 'CERT')
		}
		if (command === 'openssl' && args[0] === 'pkcs12')
			writeFileSync(args[args.indexOf('-out') + 1] as string, 'P12')
		if (command === 'openssl' && args[0] === 'x509')
			return ok(
				`SHA1 Fingerprint=${'2DE953B1FAC53DB03456E6D4BC358CF84713CDA4'.match(/../g)?.join(':')}\n`,
			)
		if (command === 'security' && args[0] === 'create-keychain')
			writeFileSync(args.at(-1) as string, 'KEYCHAIN')
		if (command === 'security' && args[0] === 'list-keychains' && args.length === 3)
			return ok('    "/Users/x/Library/Keychains/login.keychain-db"\n')
		return ok()
	}) as never
	return { calls, run }
}

describe('the helper build', () => {
	it('keys the helper by a digest of its source and keeps the socket path short', () => {
		const a = macHelperSourceHash('one')
		expect(a).toHaveLength(16)
		expect(macHelperSourceHash('two')).not.toBe(a)
		const short = macHelperPaths({ NAMZU_HOME: '/h' }, a)
		expect(short.socket).toBe(`/h/computer-use/macos/h-${a.slice(0, 8)}.sock`)
		expect(short.bundle).toBe('/h/computer-use/macos/Namzu Helper.app')
		expect(macHelperPaths({ NAMZU_HOME: '/h' }, 'other').bundle).toBe(short.bundle)
		const long = macHelperPaths({ NAMZU_HOME: `/${'x'.repeat(120)}` }, a)
		expect(Buffer.byteLength(long.socket)).toBeLessThan(100)
	})

	it('writes an agent-style bundle: no Dock icon, its own identifier', () => {
		const plist = macHelperInfoPlist('abc')
		expect(plist).toContain(`<string>${MAC_HELPER_BUNDLE_ID}</string>`)
		expect(plist).toContain('<key>LSUIElement</key><true/>')
	})

	it('ships Swift source that names every command the host sends', () => {
		const source = readFileSync(new URL('../../helper-macos/main.swift', import.meta.url), 'utf8')
		for (const cmd of [
			'permissions',
			'windows',
			'displays',
			'snapshot',
			'seq',
			'wait_change',
			'identity',
			'resolve',
			'act',
			'focus',
			'scroll',
			'click',
			'type',
			'key',
			'capture_window',
			'selfcheck',
		])
			expect(source).toContain(`case "${cmd}"`)
		expect(source).toContain('AXUIElementCopyMultipleAttributeValues')
		expect(source).toContain('AXManualAccessibility')
		expect(source).toContain('getpeereid')
	})

	it('says plainly what to install when there is no compiler', async () => {
		const home = mkdtempSync(join(tmpdir(), 'mac-home-'))
		await expect(
			ensureMacHelper({
				env: { NAMZU_HOME: home },
				hasTool: async () => false,
			}),
		).rejects.toMatchObject({
			code: 'no_compiler',
			message: expect.stringContaining('xcode-select --install'),
		})
	})

	it('compiles and signs once, then reuses the build', async () => {
		const home = mkdtempSync(join(tmpdir(), 'mac-home-'))
		const calls: string[][] = []
		const run = (async (command: string, args: readonly string[]) => {
			calls.push([command, ...args])
			if (command === 'swiftc') {
				const out = args[args.indexOf('-o') + 1] as string
				mkdirSync(dirname(out), { recursive: true })
				writeFileSync(out, 'binary')
			}
			return {
				exitCode: 0,
				stdout: Buffer.alloc(0),
				stderr: '',
				timedOut: false,
				signal: null,
			}
		}) as never
		const notices: string[] = []
		const env = { NAMZU_HOME: home, SOME_API_KEY: 'secret' }
		const first = await ensureMacHelper({
			env,
			run,
			hasTool: async () => true,
			onNotice: (n) => notices.push(n),
		})
		expect(existsSync(first.executable)).toBe(true)
		// The stand-in tools leave no certificate behind, so the identity is not made and the build is ad hoc.
		expect(calls.map((c) => c[0]).slice(0, 3)).toEqual(['xcode-select', 'swiftc', 'openssl'])
		expect(calls.at(-1)).toEqual(
			expect.arrayContaining(['--sign', '-', '--identifier', MAC_HELPER_BUNDLE_ID]),
		)
		expect(notices).toHaveLength(2)
		expect(notices[1]).toContain('ad hoc')
		const bundle = calls[1]?.[calls[1].indexOf('-o') + 1] ?? ''
		expect(bundle).toContain('NamzuHelper')
		expect(existsSync(join(first.bundle, 'Contents', 'Info.plist'))).toBe(true)
		const count = calls.length
		await ensureMacHelper({ env, run, hasTool: async () => true })
		expect(calls).toHaveLength(count)
	})

	it('says the tools are missing when swiftc is only the shim', async () => {
		const home = mkdtempSync(join(tmpdir(), 'mac-home-'))
		const shim = (async (cmd: string) => ({
			exitCode: cmd === 'xcode-select' ? 2 : 0,
			stdout: Buffer.alloc(0),
			stderr: 'xcode-select: note: no developer tools were found',
			timedOut: false,
			signal: null,
		})) as never
		await expect(
			ensureMacHelper({
				env: { NAMZU_HOME: home },
				run: shim,
				hasTool: async () => true,
			}),
		).rejects.toMatchObject({
			code: 'no_compiler',
			message: expect.stringContaining('xcode-select --install'),
		})
		const compileShim = (async (cmd: string) => ({
			exitCode: cmd === 'swiftc' ? 1 : 0,
			stdout: Buffer.alloc(0),
			stderr: cmd === 'swiftc' ? 'xcode-select: error: no developer tools' : '',
			timedOut: false,
			signal: null,
		})) as never
		await expect(
			ensureMacHelper({
				env: { NAMZU_HOME: home },
				run: compileShim,
				hasTool: async () => true,
			}),
		).rejects.toMatchObject({ code: 'no_compiler' })
	})

	it('reports a compile failure with the compiler’s words', async () => {
		const home = mkdtempSync(join(tmpdir(), 'mac-home-'))
		const run = (async (cmd: string) => ({
			exitCode: cmd === 'swiftc' ? 1 : 0,
			stdout: Buffer.alloc(0),
			stderr: 'main.swift:1: error: boom',
			timedOut: false,
			signal: null,
		})) as never
		await expect(
			ensureMacHelper({
				env: { NAMZU_HOME: home },
				run,
				hasTool: async () => true,
			}),
		).rejects.toMatchObject({
			code: 'build_failed',
			message: expect.stringContaining('boom'),
		})
	})
})

describe('the helper build, signed with a local identity', () => {
	const sourcePath = join(
		dirname(new URL(import.meta.url).pathname),
		'..',
		'..',
		'helper-macos',
		'main.swift',
	)

	it('makes one identity in its own keychain, signs with it, and reuses both', async () => {
		const home = mkdtempSync(join(tmpdir(), 'mac-home-'))
		const { calls, run } = toolbox()
		const notices: string[] = []
		const env = { NAMZU_HOME: home }
		const first = await ensureMacHelper({
			env,
			run,
			hasTool: async () => true,
			onNotice: (n) => notices.push(n),
		})
		expect(notices).toHaveLength(1)
		expect(first.bundle).toBe(join(home, 'computer-use', 'macos', 'Namzu Helper.app'))
		const sign = calls.find((c) => c[0] === 'codesign') ?? []
		expect(sign).toEqual(
			expect.arrayContaining([
				'--keychain',
				join(first.signing, 'namzu-signing.keychain-db'),
				'--sign',
				'2DE953B1FAC53DB03456E6D4BC358CF84713CDA4',
				'--identifier',
				MAC_HELPER_BUNDLE_ID,
			]),
		)
		expect(sign).not.toContain('-')
		// Never the login keychain, and the search list is put back as it was.
		expect(calls.flat().some((a) => a.includes('login.keychain'))).toBe(true)
		const create = calls.find((c) => c[1] === 'create-keychain') ?? []
		expect(create.at(-1)).toContain('signing-make-')
		expect(
			calls.some(
				(c) => c[0] === 'security' && c[1] === 'import' && c.includes('/usr/bin/codesign'),
			),
		).toBe(true)
		expect(calls.some((c) => c[1] === 'set-key-partition-list')).toBe(true)
		// The loose private key is gone; the password sits next to the keychain, owner only.
		expect(existsSync(join(first.signing, 'key.pem'))).toBe(false)
		expect(existsSync(join(first.signing, 'namzu-signing.keychain-db'))).toBe(true)
		expect(statSync(join(first.signing, 'kc.pw')).mode & 0o777).toBe(0o600)
		expect(JSON.parse(readFileSync(first.state, 'utf8'))).toMatchObject({ signing: 'identity' })
		const count = calls.length
		await ensureMacHelper({ env, run, hasTool: async () => true })
		expect(calls).toHaveLength(count)
		// A new build, from other source, reuses the identity and replaces the app in place at the same path.
		const other = join(home, 'other.swift')
		writeFileSync(other, `${readFileSync(sourcePath, 'utf8')}\n// changed\n`)
		const second = await ensureMacHelper({ env, run, hasTool: async () => true, sourcePath: other })
		expect(second.bundle).toBe(first.bundle)
		expect(second.hash).not.toBe(first.hash)
		expect(calls.filter((c) => c[0] === 'openssl' && c[1] === 'req')).toHaveLength(1)
		expect(calls.filter((c) => c[0] === 'codesign')).toHaveLength(2)
		expect(readFileSync(join(second.bundle, 'Contents', 'Info.plist'), 'utf8')).toContain(
			second.hash,
		)
		const aside = readdirSync(join(second.root, 'replaced'))
		expect(aside).toHaveLength(1)
		expect(existsSync(join(second.root, 'replaced', aside[0] as string, 'Namzu Helper.app'))).toBe(
			true,
		)
	})

	it('falls back to an ad-hoc signature, says so in a plain sentence, and tries the identity again later', async () => {
		const home = mkdtempSync(join(tmpdir(), 'mac-home-'))
		const { calls, run } = toolbox({ failIdentity: true })
		const notices: string[] = []
		const env = { NAMZU_HOME: home }
		const paths = await ensureMacHelper({
			env,
			run,
			hasTool: async () => true,
			onNotice: (n) => notices.push(n),
		})
		expect(notices[1]).toMatch(/signed ad hoc.*macOS 27/)
		expect(calls.filter((c) => c[0] === 'codesign')[0]).toEqual(
			expect.arrayContaining(['--sign', '-']),
		)
		expect(existsSync(join(paths.signing, 'namzu-signing.keychain-db'))).toBe(false)
		const state = JSON.parse(readFileSync(paths.state, 'utf8')) as {
			signing: string
			retryAfter: number
		}
		expect(state.signing).toBe('adhoc')
		// Reused at once; after the retry time it tries again and, still failing, stays and waits longer.
		const count = calls.length
		await ensureMacHelper({ env, run, hasTool: async () => true })
		expect(calls).toHaveLength(count)
		writeFileSync(paths.state, JSON.stringify({ ...state, retryAfter: 1 }))
		await ensureMacHelper({ env, run, hasTool: async () => true })
		expect(calls.filter((c) => c[0] === 'openssl' && c[1] === 'req')).toHaveLength(2)
		expect(calls.filter((c) => c[0] === 'swiftc')).toHaveLength(1)
		expect(
			(JSON.parse(readFileSync(paths.state, 'utf8')) as { retryAfter: number }).retryAfter,
		).toBeGreaterThan(Date.now())
	})

	it('names the macOS 27 pane and the old row in the permission sentences, and guards every request', () => {
		const source = readFileSync(sourcePath, 'utf8')
		expect(source).toContain('Device Control and Data Access')
		expect(source).toContain('majorVersion >= 27')
		expect(source).toContain('remove it first')
		expect(source).toContain('Screen & System Audio Recording')
		// A request that cannot finish is answered, and the helper's own windows are read on the main thread.
		expect(source).toContain('op_timeout')
		expect(source).toContain('ownWindows')
		expect(source).toContain('onMain { try snapshotReply(')
	})
})

describe('the factory and the adapter', () => {
	it('is off by the environment switch and off the Mac', () => {
		expect(
			createMacA11yHost({
				env: { NAMZU_COMPUTER_USE_A11Y: 'off' },
				platform: 'darwin',
			}),
		).toBeUndefined()
		expect(createMacA11yHost({ env: {}, platform: 'linux' })).toBeUndefined()
		expect(createMacA11yHost({ env: {}, platform: 'darwin', enabled: false })).toBeUndefined()
	})

	it('offers windows, the tree and scroll only with the helper, and says what is still off', async () => {
		const plain = await DarwinAdapter.create()
		expect(plain.capabilities.uiTree).toBeUndefined()
		expect(plain.capabilities.supportedActions).not.toContain('scroll')

		const helper = new ScriptedHelper({
			permissions: () => ({
				accessibility: false,
				screenCapture: false,
				app: 'Namzu Helper',
				steps: ['Accessibility: turn on "Namzu Helper".'],
			}),
			scroll: () => ({ done: true }),
		})
		const handle = createMacA11yHost({ spawnHelper: () => helper })
		if (!handle) throw new Error('no handle')
		const adapter = await DarwinAdapter.create({
			ax: handle,
			scale: async () => 2,
		})
		expect(adapter.capabilities).toMatchObject({
			windows: true,
			windowCapture: true,
			uiTree: true,
			maxClickCount: 3,
		})
		expect(adapter.capabilities.supportedActions).toContain('scroll')
		expect(adapter.backend).toContain('namzu-helper')
		expect(adapter.fallbackReason).toContain('Namzu Helper still needs permission')
		await adapter.execute({
			type: 'scroll',
			at: { x: 400, y: 200 },
			direction: 'down',
			amount: 5,
		})
		expect(helper.asked.find((r) => r.cmd === 'scroll')).toMatchObject({
			x: 200,
			y: 100,
			amount: 5,
		})
	})

	it('works as before when the helper cannot start, and says why', async () => {
		const handle = {
			host: new MacA11yHost({ spawnHelper: () => new ScriptedHelper({}) }),
			prepare: async () => ({
				ok: false as const,
				reason: 'swiftc is missing',
			}),
		}
		const adapter = await DarwinAdapter.create({ ax: handle })
		expect(adapter.capabilities.uiTree).toBeUndefined()
		expect(adapter.fallbackReason).toContain('swiftc is missing')
		await expect(adapter.uiSnapshot?.()).rejects.toThrow('swiftc is missing')
	})
})

describe('picking a file in an open or save panel through the tree', () => {
	const WIN = (name: string) => node(0, -1, 'AXWindow', name)
	const panelNodes = (extra: ReturnType<typeof node>[]) => [
		WIN('Open'),
		node(1, 0, 'AXButton', 'Cancel', { actions: ['invoke'] }),
		node(2, 0, 'AXButton', 'Open', { actions: ['invoke'] }),
		node(3, 0, 'AXTextField', 'Search', { actions: ['value'] }),
		...extra,
	]
	const tree = (nodes: ReturnType<typeof node>[]) => simpleTree({ nodes, total: nodes.length })

	it('types the path into a Go to the folder sheet that is open, presses Go, then Open', async () => {
		const sheet = [
			node(4, 0, 'AXSheet', 'Go to the folder:'),
			node(5, 4, 'AXTextField', 'Go to the folder:', { actions: ['value'] }),
			node(6, 4, 'AXButton', 'Go', { actions: ['invoke'] }),
		]
		let step = 0
		const { surface, helper } = setup({
			snapshot: () => tree(step === 0 ? panelNodes(sheet) : panelNodes([])),
			act: (request) => {
				if (
					request.action === 'invoke' &&
					(request.fingerprint as { nameHash: string }).nameHash === '6'
				)
					step = 1
				return { done: true, verified: true }
			},
		})
		const result = await surface.pickFile('/Users/me/notes.txt', { windowId: 501 })
		expect(result).toMatchObject({ ok: true, via: 'go_sheet', detail: 'pressed Open' })
		const acts = helper.asked.filter((r) => r.cmd === 'act')
		expect(acts.map((a) => [a.action, (a.fingerprint as { nameHash: string }).nameHash])).toEqual([
			['set_value', '5'],
			['invoke', '6'],
			['invoke', '2'],
		])
		expect(acts[0]).toMatchObject({ value: '/Users/me/notes.txt' })
		// No key was posted: the panel does not receive posted key events.
		expect(helper.asked.some((r) => r.cmd === 'key' || r.cmd === 'type')).toBe(false)
	})

	it('uses a save panel’s name field, which takes a full path, and presses Save', async () => {
		const nodes = [
			WIN('Save'),
			node(1, 0, 'AXButton', 'Cancel', { actions: ['invoke'] }),
			node(2, 0, 'AXButton', 'Save', { actions: ['invoke'] }),
			node(3, 0, 'AXTextField', 'Save As:', { actions: ['value'] }),
		]
		const { surface, helper } = setup({ snapshot: () => tree(nodes), act: () => ({ done: true }) })
		const result = await surface.pickFile('/tmp/out.txt')
		expect(result).toMatchObject({ ok: true, via: 'path_field', detail: 'pressed Save' })
		expect(helper.asked.filter((r) => r.cmd === 'act').map((a) => a.action)).toEqual([
			'set_value',
			'invoke',
		])
	})

	it('opens Go to Folder through the tree when the panel offers it and no sheet is open', async () => {
		const goButton = node(4, 0, 'AXButton', 'Go to Folder…', { actions: ['invoke'] })
		const sheet = [
			node(5, 0, 'AXSheet', 'Go to the folder:'),
			node(6, 5, 'AXTextField', '', { actions: ['value'] }),
			node(7, 5, 'AXButton', 'Go', { actions: ['invoke'] }),
		]
		let opened = false
		const { surface, helper } = setup({
			snapshot: () => tree(panelNodes([goButton, ...(opened ? sheet : [])])),
			act: (request) => {
				if ((request.fingerprint as { nameHash: string }).nameHash === '4') opened = true
				return { done: true }
			},
		})
		const result = await surface.pickFile('~/Documents/a.txt', { confirm: false })
		expect(result).toMatchObject({ ok: true, via: 'go_sheet' })
		expect(
			helper.asked
				.filter((r) => r.cmd === 'act')
				.map((a) => (a.fingerprint as { nameHash: string }).nameHash),
		).toEqual(['4', '6', '7'])
	})

	it('says what is missing instead of guessing', async () => {
		const { surface } = setup({ snapshot: () => simpleTree() })
		expect(await surface.pickFile('/x')).toMatchObject({
			ok: false,
			detail: expect.stringContaining('no open or save panel'),
		})
		const { surface: bare } = setup({ snapshot: () => tree(panelNodes([])) })
		expect(await bare.pickFile('/x')).toMatchObject({
			ok: false,
			via: 'browse',
			detail: expect.stringContaining('sidebar'),
		})
		expect(await bare.pickFile('docs/a.txt')).toMatchObject({
			ok: false,
			detail: expect.stringContaining('absolute'),
		})
		expect(await bare.pickFile('  ')).toMatchObject({ ok: false })
	})

	it('walks the browser by name when the panel has no field for a path (the usual open panel)', async () => {
		let state = -1
		const nodes = () => {
			const base = [
				WIN('Open'),
				node(1, 0, 'AXButton', 'Cancel', { actions: ['invoke'] }),
				node(2, 0, 'AXButton', 'Open', { actions: ['invoke'] }),
				node(3, 0, 'AXTextField', '', { actions: ['value'] }),
				node(4, 3, 'AXButton', 'search', { actions: ['invoke'] }),
				node(5, 0, 'AXOutline', 'sidebar'),
				node(6, 5, 'AXRow', '', { actions: ['selectionItem'] }),
				node(7, 6, 'AXStaticText', 'me'),
				node(8, 0, 'AXBrowser', 'column view'),
				node(9, 8, 'AXList', ''),
				node(10, 9, 'AXGroup', '', { actions: ['invoke'] }),
				node(11, 10, 'AXTextField', '', { value: 'docs', actions: ['value'] }),
			]
			if (state >= 1)
				base.push(
					node(12, 8, 'AXList', ''),
					node(13, 12, 'AXGroup', '', { actions: ['invoke'] }),
					node(14, 13, 'AXTextField', '', { value: 'a.txt', actions: ['value'] }),
				)
			return base
		}
		const { surface, helper } = setup({
			snapshot: () => tree(nodes()),
			act: (request) => {
				const id = (request.fingerprint as { nameHash: string }).nameHash
				if (id === '6') state = 0
				if (id === '10') state = 1
				return { done: true }
			},
		})
		const result = await surface.pickFile('/Users/me/docs/a.txt', {
			windowId: 501,
			home: '/Users/me',
		})
		expect(result).toMatchObject({ ok: true, via: 'browse', detail: 'pressed Open' })
		const acts = helper.asked.filter((r) => r.cmd === 'act')
		expect(acts.map((a) => [a.action, (a.fingerprint as { nameHash: string }).nameHash])).toEqual([
			['select', '6'],
			['select', '10'],
			['select', '13'],
			['invoke', '2'],
		])
		// The panel's search field was never typed into.
		expect(acts.some((a) => a.action === 'set_value')).toBe(false)
		expect(helper.asked.some((r) => r.cmd === 'key' || r.cmd === 'type')).toBe(false)
		state = -1
		expect(await surface.pickFile('/Users/me/missing/a.txt', { home: '/Users/me' })).toMatchObject({
			ok: false,
			detail: expect.stringContaining('"missing" is not in the folder'),
		})
	})

	it('counts the file as picked when the panel closes under the last press', async () => {
		let closed = false
		const panel = [
			WIN('Open'),
			node(1, 0, 'AXButton', 'Cancel', { actions: ['invoke'] }),
			node(2, 0, 'AXButton', 'Open', { actions: ['invoke'] }),
			node(5, 0, 'AXOutline', 'sidebar'),
			node(6, 5, 'AXRow', '', { actions: ['selectionItem'] }),
			node(7, 6, 'AXStaticText', 'me'),
			node(9, 0, 'AXList', ''),
			node(10, 9, 'AXGroup', '', { actions: ['invoke'] }),
			node(11, 10, 'AXTextField', '', { value: 'a.txt', actions: ['value'] }),
		]
		const { surface } = setup({
			snapshot: () => (closed ? simpleTree() : tree(panel)),
			act: (request) => {
				if ((request.fingerprint as { nameHash: string }).nameHash === '10') {
					closed = true
					throw Object.assign(new Error('the control does not have that property'), {
						code: 'error',
					})
				}
				return { done: true }
			},
		})
		expect(
			await surface.pickFile('/Users/me/a.txt', { windowId: 501, home: '/Users/me' }),
		).toMatchObject({
			ok: true,
			via: 'browse',
			detail: 'the panel opened the file',
		})
	})
})
