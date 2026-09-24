/**
 * No test in this package can act on the real desktop.
 *
 * `tools/vitest-desktop-guard.mjs` (a setup file of this package) turns every
 * start of a desktop program — `powershell.exe`, `cua-driver.exe`, `xdotool`,
 * `cliclick`, … — into the start of a path that does not exist, and the
 * suite runs with `NAMZU_CUA_DRIVER=off`. This proves both through the
 * package's own code paths, on any machine: the adapters that would click
 * and type reach their program only through `node:child_process`, and there
 * it is refused before anything runs.
 */
import { spawn, spawnSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SubprocessComputerUseHost } from '../SubprocessComputerUseHost.js'
import { Win32PowerShellAdapter } from '../adapters/win32-powershell.js'
import type { WslProbes } from '../adapters/wsl.js'

interface Refused {
	readonly api: string
	readonly program: string
	readonly command: string
}

const refused = (): readonly Refused[] =>
	(globalThis as { __namzuRefusedDesktopLaunches?: Refused[] }).__namzuRefusedDesktopLaunches ?? []

const POWERSHELL = '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe'

/** A WSL whose Windows PowerShell exists, whatever machine runs the test. */
const wsl: WslProbes = {
	readFile: (path) =>
		path === '/proc/sys/kernel/osrelease' ? '6.6.87.2-microsoft-standard-WSL2' : undefined,
	exists: (path) => path === POWERSHELL,
	interopSockets: () => [],
}

const temps: string[] = []
afterEach(async () => {
	for (const dir of temps.splice(0)) await rm(dir, { recursive: true, force: true })
})

describe('tests never reach the desktop', () => {
	it('run with cua-driver switched off and the guard installed', () => {
		expect(process.env.NAMZU_CUA_DRIVER).toBe('off')
		expect(
			Array.isArray(
				(globalThis as { __namzuRefusedDesktopLaunches?: unknown }).__namzuRefusedDesktopLaunches,
			),
		).toBe(true)
	})

	it('refuse a desktop program as missing, whichever child_process call starts it', async () => {
		const before = refused().length
		const error = await new Promise<NodeJS.ErrnoException>((resolve) => {
			const child = spawn(POWERSHELL, [
				'-NoProfile',
				'-Command',
				'Add-Type -AssemblyName System.Windows.Forms',
			])
			child.on('error', resolve)
		})
		expect(error.code).toBe('ENOENT')
		expect(spawnSync('cua-driver.exe', ['mcp']).error?.message).toMatch(/ENOENT/)
		expect(spawnSync('xdotool', ['click', '1']).error?.message).toMatch(/ENOENT/)
		expect(
			refused()
				.slice(before)
				.map((entry) => entry.program),
		).toEqual(['powershell', 'cua-driver', 'xdotool'])
	})

	it('let the PowerShell fallback start nothing: it cannot read the display, so it can never click', async () => {
		const before = refused().length
		const adapter = await Win32PowerShellAdapter.create({
			platform: 'linux',
			env: { WSL_DISTRO_NAME: 'Ubuntu' },
			wslProbes: wsl,
		})
		await expect(adapter.getDisplayGeometry()).rejects.toThrow()
		await expect(
			adapter.execute({ type: 'mouse_click', at: { x: 10, y: 10 }, button: 'left' }),
		).rejects.toThrow()
		await expect(adapter.execute({ type: 'type_text', text: 'rm -rf /' })).rejects.toThrow()
		const started = refused().slice(before)
		expect(started.length).toBeGreaterThanOrEqual(3)
		expect(new Set(started.map((entry) => entry.program))).toEqual(new Set(['powershell']))
	})

	it('let a host that asks for cua-driver by path start nothing either', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'namzu-desktop-guard-'))
		temps.push(dir)
		const driver = join(dir, 'cua-driver.exe')
		await writeFile(driver, 'not a driver', { mode: 0o755 })
		const before = refused().length
		const host = new SubprocessComputerUseHost({
			platform: 'win32',
			env: { ...process.env, NAMZU_CUA_DRIVER: driver },
			windows: { backend: 'cua-driver', cuaDriverPath: driver, download: false },
		})
		await expect(host.initialize()).rejects.toThrow()
		expect(
			refused()
				.slice(before)
				.map((entry) => entry.program),
		).toContain('cua-driver')
		await expect(host.execute({ type: 'key', keys: 'ENTER' })).rejects.toThrow(/not initialised/)
	})

	it('leave the default host unable to initialize, on this machine or any other', async () => {
		const host = new SubprocessComputerUseHost()
		await expect(host.initialize()).rejects.toThrow()
		expect(host.capabilities.mouse).toBe(false)
		expect(host.capabilities.keyboard).toBe(false)
	})
})
