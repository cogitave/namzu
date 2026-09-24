import { beforeEach, describe, expect, it, vi } from 'vitest'

const spawn = vi.hoisted(() => vi.fn())
const accessSync = vi.hoisted(() => vi.fn())
vi.mock('node:child_process', async (importOriginal) => ({
	...(await importOriginal<typeof import('node:child_process')>()),
	spawn,
}))
vi.mock('node:fs', async (importOriginal) => ({
	...(await importOriginal<typeof import('node:fs')>()),
	accessSync,
}))

import { WSL_OPEN_SCRIPT, WSL_POWERSHELL, openInBrowser } from './open-browser.js'

// A plain Linux desktop, whatever machine the suite runs on (a WSL one would
// otherwise take the Windows branch).
const linux = { platform: 'linux', env: { PATH: '/usr/bin' }, exists: () => false } as const

function child() {
	return { on: vi.fn(), unref: vi.fn() }
}

describe('openInBrowser', () => {
	beforeEach(() => {
		spawn.mockReset()
		accessSync.mockReset()
		accessSync.mockReturnValue(undefined)
	})

	it('refuses anything that is not a web address', () => {
		spawn.mockReturnValue(child())
		for (const bad of [
			'file:///etc/passwd',
			'javascript:alert(1)',
			'ftp://example.invalid',
			'/usr/bin/thing',
			'',
		]) {
			expect(openInBrowser(bad, linux)).toBe(false)
		}
		expect(spawn).not.toHaveBeenCalled()
	})

	it('never routes the address through a shell', () => {
		spawn.mockReturnValue(child())
		// The metacharacters that make `cmd /c start <url>` a command line.
		openInBrowser('https://example.invalid/?a=1&b=2^c|d', linux)
		expect(spawn).toHaveBeenCalledTimes(1)
		const [command, args, options] = spawn.mock.calls[0] as [string, string[], object]
		expect(options).not.toHaveProperty('shell', true)
		expect(command).not.toMatch(/cmd(\.exe)?$/i)
		expect(command).not.toMatch(/(^|[\\/])sh$|bash|powershell/i)
		// The address is one argument, unsplit and unquoted.
		expect(args).toContain('https://example.invalid/?a=1&b=2^c|d')
		expect(command).toMatch(/^\//)
	})

	it('reports no browser when the host has no launcher', () => {
		accessSync.mockImplementation(() => {
			throw new Error('ENOENT')
		})

		expect(openInBrowser('https://example.invalid/', linux)).toBe(false)
		expect(spawn).not.toHaveBeenCalled()
	})

	it('reports failure rather than throwing when no launcher can start', () => {
		spawn.mockImplementation(() => {
			throw new Error('ENOENT')
		})
		expect(openInBrowser('https://example.invalid/', linux)).toBe(false)
	})

	it('survives a launcher that fails asynchronously, which is the headless case', () => {
		const c = child()
		spawn.mockReturnValue(c)
		expect(openInBrowser('https://example.invalid/', linux)).toBe(true)
		// An `error` handler must be attached, or a missing `xdg-open` in a
		// container becomes an unhandled event and takes the process down.
		expect(c.on).toHaveBeenCalledWith('error', expect.any(Function))
		const handler = c.on.mock.calls.find((call) => call[0] === 'error')?.[1] as () => void
		expect(() => handler()).not.toThrow()
		// And it must be detached, or namzu waits on a browser to exit.
		expect(c.unref).toHaveBeenCalled()
	})
})

describe('openInBrowser under WSL', () => {
	const wslEnv = {
		PATH: '/usr/bin',
		WSL_DISTRO_NAME: 'archlinux',
		WSL_INTEROP: '/run/WSL/240_interop',
		WSLENV: 'WT_SESSION:USERPROFILE/p',
	}
	const powershellPresent = (path: string) => path === WSL_POWERSHELL

	beforeEach(() => {
		spawn.mockReset()
		accessSync.mockReset()
		accessSync.mockReturnValue(undefined)
	})

	it('opens the Windows browser through PowerShell by absolute path, the address as data only', () => {
		spawn.mockReturnValue(child())
		const url = 'https://example.invalid/?a=1&b=\'x\'"y"$(calc)`z`'
		expect(openInBrowser(url, { platform: 'linux', env: wslEnv, exists: powershellPresent })).toBe(
			true,
		)
		expect(spawn).toHaveBeenCalledTimes(1)
		const [command, args, options] = spawn.mock.calls[0] as [
			string,
			string[],
			{ env: NodeJS.ProcessEnv; cwd: string; shell?: boolean; detached: boolean },
		]
		expect(command).toBe(WSL_POWERSHELL)
		expect(options.shell).toBeUndefined()
		expect(options.detached).toBe(true)
		expect(options.cwd).toBe('/mnt/c')
		// The script is a constant: nothing of the address is in any argument.
		expect(args.slice(0, -1)).toEqual([
			'-NoProfile',
			'-NonInteractive',
			'-ExecutionPolicy',
			'Bypass',
			'-EncodedCommand',
		])
		expect(Buffer.from(args.at(-1) as string, 'base64').toString('utf16le')).toBe(WSL_OPEN_SCRIPT)
		expect(WSL_OPEN_SCRIPT).toContain('Start-Process -FilePath $env:NAMZU_OPEN_URL')
		expect(args.join(' ')).not.toContain('example.invalid')
		// It reaches Windows through the environment, named in WSLENV.
		expect(options.env.NAMZU_OPEN_URL).toBe(url)
		expect(options.env.WSLENV).toBe('WT_SESSION:USERPROFILE/p:NAMZU_OPEN_URL')
	})

	it('never uses cmd.exe or explorer.exe', () => {
		spawn.mockReturnValue(child())
		openInBrowser('https://example.invalid/', {
			platform: 'linux',
			env: wslEnv,
			exists: powershellPresent,
		})
		const [command] = spawn.mock.calls[0] as [string]
		expect(command).not.toMatch(/cmd\.exe|explorer\.exe/i)
	})

	it('falls back to xdg-open when interop is off or PowerShell is missing', () => {
		spawn.mockReturnValue(child())
		openInBrowser('https://example.invalid/', {
			platform: 'linux',
			env: { PATH: '/usr/bin', WSL_DISTRO_NAME: 'archlinux' },
			exists: () => false,
		})
		openInBrowser('https://example.invalid/', {
			platform: 'linux',
			env: wslEnv,
			exists: () => false,
		})
		expect(spawn.mock.calls.map((call) => call[0])).toEqual([
			'/usr/bin/xdg-open',
			'/usr/bin/xdg-open',
		])
	})

	it('still refuses anything that is not a web address', () => {
		expect(
			openInBrowser('file:///etc/passwd', {
				platform: 'linux',
				env: wslEnv,
				exists: powershellPresent,
			}),
		).toBe(false)
		expect(spawn).not.toHaveBeenCalled()
	})
})
