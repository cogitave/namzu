import { beforeEach, describe, expect, it, vi } from 'vitest'

const spawn = vi.hoisted(() => ({
	hasExecutable: vi.fn<(name: string) => Promise<boolean>>(),
	runCommand: vi.fn(),
	runCommandOrThrow: vi.fn(),
}))

vi.mock('../util/spawn.js', async (importOriginal) => ({
	...(await importOriginal<typeof import('../util/spawn.js')>()),
	...spawn,
}))

import type { Adapter } from '../adapters/types.js'
import { Win32PowerShellAdapter, _scripts, dragPath } from '../adapters/win32-powershell.js'
import { Win32Adapter, cuaDriverEnvironment } from '../adapters/win32.js'
import {
	type WslProbes,
	mergeWslenv,
	parseWslMountRoot,
	wslChildEnv,
	wslInteropSocket,
} from '../adapters/wsl.js'

const POWERSHELL = '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe'

function probes(
	overrides: Partial<WslProbes> & { files?: Record<string, string> } = {},
): WslProbes {
	const files = overrides.files ?? {}
	return {
		readFile: overrides.readFile ?? ((path) => files[path]),
		exists: overrides.exists ?? ((path) => path in files || path === POWERSHELL),
		interopSockets: overrides.interopSockets ?? (() => []),
	}
}

const WSL_ENV = { WSL_DISTRO_NAME: 'archlinux', WSL_INTEROP: '/run/WSL/240_interop' }

/** The script inside `-EncodedCommand`, decoded. */
function decodedScript(args: readonly string[]): string {
	const encoded = args[args.indexOf('-EncodedCommand') + 1] ?? ''
	return Buffer.from(encoded, 'base64').toString('utf16le')
}

describe('the PowerShell fallback under WSL', () => {
	beforeEach(() => {
		spawn.hasExecutable.mockReset()
		spawn.runCommandOrThrow.mockReset()
		spawn.hasExecutable.mockImplementation(async (name) => name === 'powershell.exe')
		spawn.runCommandOrThrow.mockResolvedValue({
			exitCode: 0,
			stdout: Buffer.from('{"x":0,"y":0,"width":3440,"height":1440,"scaleFactor":1.25}'),
			stderr: '',
			timedOut: false,
			signal: null,
		})
	})

	it('runs Windows PowerShell by its absolute path, without asking PATH', async () => {
		const adapter = await Win32PowerShellAdapter.create({
			env: WSL_ENV,
			platform: 'linux',
			wslProbes: probes(),
		})
		await expect(adapter.getDisplayGeometry()).resolves.toEqual({
			width: 3440,
			height: 1440,
			scaleFactor: 1.25,
		})
		expect(spawn.hasExecutable).not.toHaveBeenCalled()
		expect(spawn.runCommandOrThrow.mock.calls[0]?.[0]).toBe(POWERSHELL)
	})

	it('falls back to PATH when the Windows drive is not mounted where it should be', async () => {
		const adapter = await Win32PowerShellAdapter.create({
			env: WSL_ENV,
			platform: 'linux',
			wslProbes: probes({ exists: () => false }),
		})
		await adapter.getDisplayGeometry()
		expect(spawn.hasExecutable.mock.calls.map(([name]) => name)).toEqual([
			'pwsh',
			'powershell',
			'pwsh.exe',
			'powershell.exe',
		])
		expect(spawn.runCommandOrThrow.mock.calls[0]?.[0]).toBe('powershell.exe')
	})

	it('sends every script as -EncodedCommand, DPI aware before anything else', async () => {
		const adapter = await Win32PowerShellAdapter.create({
			env: WSL_ENV,
			platform: 'linux',
			wslProbes: probes(),
		})
		await adapter.getDisplayGeometry()
		const args = spawn.runCommandOrThrow.mock.calls[0]?.[1] as string[]
		expect(args).not.toContain('-Command')
		const script = decodedScript(args)
		expect(script.indexOf('SetProcessDpiAwarenessContext(new IntPtr(-4))')).toBeGreaterThan(-1)
		expect(script.indexOf('[Namzu.Desktop]::MakeDpiAware()')).toBeLessThan(
			script.indexOf('PrimaryScreen'),
		)
	})

	it('types Turkish text through Unicode key events, carried as base64 so nothing is re-quoted', async () => {
		const text = "Merhaba dünya ığüşöçİ 'quoted' {braces} +%^~"
		const script = _scripts.typeText(text)
		const encoded = /FromBase64String\('([^']+)'\)/.exec(script)?.[1] ?? ''
		expect(Buffer.from(encoded, 'base64').toString('utf8')).toBe(text)
		expect(script).not.toContain('SendKeys')
		expect(script).toContain('[Namzu.Desktop]::TypeText(')
	})

	it('drags through intermediate points instead of teleporting', () => {
		expect(dragPath({ x: 0, y: 0 }, { x: 120, y: 60 }, 4)).toEqual([
			{ x: 30, y: 15 },
			{ x: 60, y: 30 },
			{ x: 90, y: 45 },
			{ x: 120, y: 60 },
		])
		const script = _scripts.mouseDrag({ x: 0, y: 0 }, { x: 120, y: 60 }, 'left')
		expect(script.match(/\[Namzu\.Desktop\]::SetCursorPos/g)?.length).toBe(13)
	})

	it('describes the captured display', async () => {
		const png = Buffer.alloc(33)
		png.write('IHDR', 12, 'ascii')
		png.writeUInt32BE(3440, 16)
		png.writeUInt32BE(1440, 20)
		spawn.runCommandOrThrow.mockResolvedValueOnce({
			exitCode: 0,
			stdout: Buffer.from(
				JSON.stringify({
					x: 0,
					y: 0,
					width: 3440,
					height: 1440,
					scaleFactor: 1.5,
					png: png.toString('base64'),
				}),
			),
			stderr: '',
			timedOut: false,
			signal: null,
		})
		const adapter = await Win32PowerShellAdapter.create({
			env: WSL_ENV,
			platform: 'linux',
			wslProbes: probes(),
		})
		const shot = await adapter.execute({ type: 'screenshot' })
		expect(shot).toMatchObject({
			type: 'screenshot',
			result: {
				width: 3440,
				height: 1440,
				display: {
					id: 'primary',
					x: 0,
					y: 0,
					width: 3440,
					height: 1440,
					scaleFactor: 1.5,
					primary: true,
				},
			},
		})
	})
})

describe('choosing the Windows backend', () => {
	beforeEach(() => {
		spawn.hasExecutable.mockReset()
		spawn.hasExecutable.mockImplementation(async (name) => name === 'powershell.exe')
	})

	function fakeCua(fail?: Error): Adapter & { disposed: boolean } {
		const adapter = {
			disposed: false,
			backend: 'cua-driver 0.28.2',
			capabilities: Object.freeze({
				displayServer: 'win32' as const,
				screenshot: true,
				mouse: true,
				keyboard: true,
				cursorPosition: true,
				clipboard: false,
				windows: true,
			}),
			async getDisplayGeometry() {
				if (fail) throw fail
				return { width: 3440, height: 1440, scaleFactor: 1 }
			},
			async execute() {
				return { type: 'ok' as const }
			},
			async dispose() {
				adapter.disposed = true
			},
		}
		return adapter
	}

	const common = { env: WSL_ENV, platform: 'linux' as const, wslProbes: probes() }

	it('uses cua-driver when it resolves and answers', async () => {
		const cua = fakeCua()
		const resolve = vi.fn(async () => ({ path: '/cache/cua-driver.exe', source: 'cache' as const }))
		const adapter = await Win32Adapter.create({
			...common,
			resolve,
			createCuaDriverAdapter: () => cua,
		})
		expect(adapter).toBe(cua)
		expect(resolve).toHaveBeenCalledWith(expect.objectContaining({ env: WSL_ENV }))
	})

	it('falls back to PowerShell, saying why, when cua-driver cannot be had', async () => {
		const resolve = vi.fn(async () => {
			throw new Error('Could not download …: fetch failed')
		})
		const adapter = await Win32Adapter.create({ ...common, resolve })
		expect(adapter.backend).toBe('powershell')
		expect(adapter.fallbackReason).toMatch(/fetch failed/)
	})

	it('falls back, and stops the driver, when cua-driver starts but the desktop does not answer', async () => {
		const cua = fakeCua(new Error('get_screen_size: no interactive session'))
		const adapter = await Win32Adapter.create({
			...common,
			resolve: async () => ({ path: '/cache/cua-driver.exe', source: 'cache' as const }),
			createCuaDriverAdapter: () => cua,
		})
		expect(cua.disposed).toBe(true)
		expect(adapter.backend).toBe('powershell')
		expect(adapter.fallbackReason).toMatch(/no interactive session/)
	})

	it('refuses instead of falling back when cua-driver was required', async () => {
		await expect(
			Win32Adapter.create({
				...common,
				backend: 'cua-driver',
				resolve: async () => {
					throw new Error('downloading it is turned off')
				},
			}),
		).rejects.toThrow(/cua-driver is not usable: downloading it is turned off/)
	})

	it('honours NAMZU_CUA_DRIVER=off and NAMZU_CUA_DRIVER=<path>', async () => {
		const resolve = vi.fn(async (options?: { path?: string }) => ({
			path: options?.path ?? '/cache/cua-driver.exe',
			source: 'configured' as const,
		}))
		const off = await Win32Adapter.create({
			...common,
			env: { ...WSL_ENV, NAMZU_CUA_DRIVER: 'off' },
			resolve,
		})
		expect(off.backend).toBe('powershell')
		expect(resolve).not.toHaveBeenCalled()

		const seen: string[] = []
		await Win32Adapter.create({
			...common,
			env: { ...WSL_ENV, NAMZU_CUA_DRIVER: '/opt/cua/cua-driver.exe' },
			resolve,
			createCuaDriverAdapter: (options) => {
				seen.push(options.executable)
				return fakeCua()
			},
		})
		expect(seen).toEqual(['/opt/cua/cua-driver.exe'])
	})
})

describe('the environment a Windows program gets from WSL', () => {
	it('drops secrets, switches telemetry and the update check off, and forwards both through WSLENV', () => {
		const env = cuaDriverEnvironment(
			{
				...WSL_ENV,
				WSLENV: 'USERPROFILE/p',
				ANTHROPIC_API_KEY: 'sk-ant',
				GITHUB_TOKEN: 'ghp',
				AWS_SECRET_ACCESS_KEY: 'aws',
				HOME: '/home/arda',
			},
			true,
			probes({ exists: (path) => path === '/run/WSL/240_interop' }),
		)
		expect(env.ANTHROPIC_API_KEY).toBeUndefined()
		expect(env.GITHUB_TOKEN).toBeUndefined()
		expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined()
		expect(env.HOME).toBe('/home/arda')
		expect(env.CUA_DRIVER_RS_TELEMETRY_ENABLED).toBe('0')
		expect(env.CUA_DRIVER_RS_UPDATE_CHECK).toBe('0')
		expect(env.WSLENV).toBe(
			'USERPROFILE/p:CUA_DRIVER_RS_TELEMETRY_ENABLED:CUA_DRIVER_RS_UPDATE_CHECK',
		)
		expect(env.WSL_INTEROP).toBe('/run/WSL/240_interop')
	})

	it('finds an interop socket for a process whose WSL_INTEROP is missing or stale', () => {
		const sockets = [
			{ path: '/run/WSL/240_interop', mtimeMs: 10 },
			{ path: '/run/WSL/3202802_interop', mtimeMs: 30 },
		]
		const noStable = probes({ exists: () => false, interopSockets: () => sockets })
		expect(wslInteropSocket({ WSL_INTEROP: '/run/WSL/9_interop' }, noStable)).toBe(
			'/run/WSL/3202802_interop',
		)
		const withStable = probes({
			exists: () => false,
			interopSockets: () => [...sockets, { path: '/run/WSL/1_interop', mtimeMs: 1 }],
		})
		expect(wslInteropSocket({}, withStable)).toBe('/run/WSL/1_interop')
		expect(wslChildEnv({}, [], withStable).WSL_INTEROP).toBe('/run/WSL/1_interop')
	})

	it('merges WSLENV entries once each, flags included', () => {
		expect(mergeWslenv(undefined, ['A', 'B/p'])).toBe('A:B/p')
		expect(mergeWslenv('A/u:C', ['A', 'B'])).toBe('A/u:C:B')
	})

	it('reads the drive mount root from wsl.conf', () => {
		expect(parseWslMountRoot(undefined)).toBe('/mnt/')
		expect(parseWslMountRoot('[automount]\nroot = /win\n')).toBe('/win/')
		expect(parseWslMountRoot('[automount]\noptions="metadata"\n[interop]\nroot=/nope\n')).toBe(
			'/mnt/',
		)
	})
})
