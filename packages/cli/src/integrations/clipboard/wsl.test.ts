import { describe, expect, it } from 'vitest'
import { isWslEnv, parseWslMountRoot, windowsPathToWsl, wslSharePathToLinux } from './wsl.js'

const probe = (
	platform: NodeJS.Platform,
	env: Record<string, string>,
	version?: string,
): Parameters<typeof isWslEnv>[0] => ({
	platform,
	env,
	readText: (path) => (path === '/proc/version' ? version : undefined),
})

describe('detecting WSL', () => {
	it('trusts the distribution name or the interop socket', () => {
		expect(isWslEnv(probe('linux', { WSL_DISTRO_NAME: 'Ubuntu' }))).toBe(true)
		expect(isWslEnv(probe('linux', { WSL_INTEROP: '/run/WSL/1_interop' }))).toBe(true)
	})

	it('falls back to the kernel version string', () => {
		expect(isWslEnv(probe('linux', {}, 'Linux version 6.1 (microsoft-standard-WSL2)'))).toBe(true)
		expect(isWslEnv(probe('linux', {}, 'Linux version 6.8 (gcc) generic'))).toBe(false)
		expect(isWslEnv(probe('linux', {}, undefined))).toBe(false)
	})

	it('is never true off Linux', () => {
		expect(isWslEnv(probe('darwin', { WSL_DISTRO_NAME: 'Ubuntu' }))).toBe(false)
		expect(isWslEnv(probe('win32', {}, 'microsoft'))).toBe(false)
	})
})

describe('WSL paths', () => {
	it('reads the drive mount root from wsl.conf', () => {
		expect(parseWslMountRoot(undefined)).toBe('/mnt/')
		expect(parseWslMountRoot('[automount]\nroot = /win\n')).toBe('/win/')
		expect(parseWslMountRoot('[boot]\nroot=/x\n')).toBe('/mnt/')
	})

	it('converts drive paths under the mount root', () => {
		expect(windowsPathToWsl('C:\\Users\\a\\x.png')).toBe('/mnt/c/Users/a/x.png')
		expect(windowsPathToWsl('D:/a/b.png', '/win/')).toBe('/win/d/a/b.png')
		expect(windowsPathToWsl('\\\\server\\share\\x.png')).toBeUndefined()
	})

	it('reaches this distribution through its share, and no other', () => {
		expect(wslSharePathToLinux('\\\\wsl$\\Ubuntu\\home\\a\\x.png', 'Ubuntu')).toBe('/home/a/x.png')
		expect(wslSharePathToLinux('\\\\wsl.localhost\\ubuntu\\tmp\\x.png', 'Ubuntu')).toBe(
			'/tmp/x.png',
		)
		expect(wslSharePathToLinux('\\\\wsl$\\Debian\\tmp\\x.png', 'Ubuntu')).toBeUndefined()
		expect(wslSharePathToLinux('\\\\wsl$\\Ubuntu\\x.png', undefined)).toBeUndefined()
	})
})
