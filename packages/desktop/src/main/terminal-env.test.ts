import { describe, expect, it } from 'vitest'
import { engineHost, shellEnvironment } from './terminal-env.js'

const files = (...paths: string[]) => {
	const set = new Set(paths)
	return { exists: (path: string) => set.has(path), executable: (path: string) => set.has(path) }
}

describe('shellEnvironment', () => {
	const windows = (present: string[], env: Record<string, string> = {}) =>
		shellEnvironment({
			platform: 'win32',
			env: { PATH: 'C:\\a;C:\\b\\', ...env },
			home: 'C:\\Users\\A',
			...files(...present),
		})

	it('finds a program on PATH and in the places Windows keeps its shells', () => {
		const host = windows(['C:\\b\\pwsh.exe', 'C:\\Windows\\System32\\wsl.exe'])
		expect(host.find('pwsh.exe')).toBe('C:\\b\\pwsh.exe')
		expect(host.find('wsl.exe')).toBe('C:\\Windows\\System32\\wsl.exe')
		expect(host.find('powershell.exe')).toBeUndefined()
	})

	it('uses the system root the environment names', () => {
		const host = windows(['D:\\Win\\System32\\cmd.exe'], { SystemRoot: 'D:\\Win' })
		expect(host.find('cmd.exe')).toBe('D:\\Win\\System32\\cmd.exe')
	})

	it('finds nothing elsewhere than Windows, where the login shell is used', () => {
		const host = shellEnvironment({
			platform: 'linux',
			env: { PATH: '/usr/bin' },
			home: '/home/a',
			...files('/usr/bin/pwsh.exe'),
		})
		expect(host.find('pwsh.exe')).toBeUndefined()
	})
})

describe('engineHost', () => {
	it('finds an engine CLI on PATH or in the person-level tool folders', () => {
		const host = engineHost(
			{ execPath: '/opt/namzu', cliEntry: '/opt/cli/bin.js', nodeArgs: [] },
			{
				platform: 'linux',
				env: { PATH: '/usr/bin:/bin' },
				home: '/home/a',
				...files('/home/a/.local/bin/claude', '/bin/codex'),
			},
		)
		expect(host.resolve('codex')).toEqual({ path: '/bin/codex', shim: false })
		expect(host.resolve('claude')).toEqual({ path: '/home/a/.local/bin/claude', shim: false })
		expect(host).toMatchObject({ execPath: '/opt/namzu', cliEntry: '/opt/cli/bin.js' })
	})

	it('answers undefined for a CLI that is not installed', () => {
		const host = engineHost(
			{ execPath: '/opt/namzu', nodeArgs: [] },
			{ platform: 'linux', env: { PATH: '/usr/bin' }, home: '/h', ...files() },
		)
		expect(host.resolve('codex')).toBeUndefined()
		expect(host.cliEntry).toBeUndefined()
	})

	it('resolves a Windows native program and an npm shim', () => {
		const host = engineHost(
			{ execPath: 'C:\\n\\Namzu.exe', nodeArgs: ['--use-system-ca'] },
			{
				platform: 'win32',
				env: { PATH: 'C:\\bin', APPDATA: 'C:\\Users\\A\\AppData\\Roaming' },
				home: 'C:\\Users\\A',
				...files('C:\\bin\\claude.exe', 'C:\\Users\\A\\AppData\\Roaming\\npm\\codex.cmd'),
			},
		)
		expect(host.resolve('claude')).toEqual({ path: 'C:\\bin\\claude.exe', shim: false })
		expect(host.resolve('codex')).toEqual({
			path: 'C:\\Users\\A\\AppData\\Roaming\\npm\\codex.cmd',
			shim: true,
		})
	})
})
