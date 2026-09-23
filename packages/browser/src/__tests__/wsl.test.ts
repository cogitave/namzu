import { describe, expect, it } from 'vitest'
import {
	findWslInteropSocket,
	parseNetworkingModeOutput,
	parseWslConfigNetworkingMode,
	parseWslMountRoot,
	windowsPathToWsl,
	wslPathToWindows,
} from '../wsl.js'

describe('Windows and WSL paths', () => {
	it('turns a drive path into its mount and back', () => {
		const windows = 'C:\\Users\\Arda\\AppData\\Local\\namzu\\browser\\profiles\\work'
		const linux = '/mnt/c/Users/Arda/AppData/Local/namzu/browser/profiles/work'
		expect(windowsPathToWsl(windows)).toBe(linux)
		expect(wslPathToWindows(linux)).toBe(windows)
		expect(windowsPathToWsl('d:/Data/x/')).toBe('/mnt/d/Data/x')
		expect(windowsPathToWsl('C:\\')).toBe('/mnt/c')
		expect(windowsPathToWsl('C:')).toBe('/mnt/c')
		expect(wslPathToWindows('/mnt/c')).toBe('C:\\')
		expect(
			wslPathToWindows('/mnt/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'),
		).toBe('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe')
	})

	it('honours a moved mount root', () => {
		expect(windowsPathToWsl('C:\\Windows', '/')).toBe('/c/Windows')
		expect(windowsPathToWsl('C:\\Windows', '/win')).toBe('/win/c/Windows')
		expect(wslPathToWindows('/c/Windows', '/')).toBe('C:\\Windows')
	})

	it('refuses what is not on a drive', () => {
		expect(windowsPathToWsl('\\\\server\\share\\x')).toBeUndefined()
		expect(windowsPathToWsl('relative\\x')).toBeUndefined()
		expect(wslPathToWindows('/home/arda')).toBeUndefined()
		expect(wslPathToWindows('/mnt/wsl/x')).toBeUndefined()
		expect(wslPathToWindows('/mnt/cd/x')).toBeUndefined()
	})
})

describe('WSL configuration', () => {
	it('reads the mount root from /etc/wsl.conf', () => {
		expect(parseWslMountRoot(undefined)).toBe('/mnt/')
		expect(parseWslMountRoot('[boot]\nsystemd=true\n')).toBe('/mnt/')
		expect(parseWslMountRoot('[automount]\nroot = /\n')).toBe('/')
		expect(parseWslMountRoot('[AutoMount]\r\nroot="/win" # moved\r\n')).toBe('/win/')
		expect(parseWslMountRoot('[automount]\nroot = relative\n')).toBe('/mnt/')
	})

	it('parses wslinfo --networking-mode', () => {
		expect(parseNetworkingModeOutput('nat\n')).toBe('nat')
		expect(parseNetworkingModeOutput(' Mirrored ')).toBe('mirrored')
		expect(parseNetworkingModeOutput('virtioproxy')).toBe('virtioproxy')
		expect(parseNetworkingModeOutput('wslinfo: unknown option')).toBe('unknown')
		expect(parseNetworkingModeOutput(undefined)).toBe('unknown')
	})

	it('parses a .wslconfig', () => {
		expect(parseWslConfigNetworkingMode('[wsl2]\nnetworkingMode=mirrored\n')).toBe('mirrored')
		expect(parseWslConfigNetworkingMode('\uFEFF[WSL2]\r\nNetworkingMode = NAT\r\n')).toBe('nat')
		expect(parseWslConfigNetworkingMode('[experimental]\nnetworkingMode=mirrored\n')).toBe(
			'mirrored',
		)
		expect(parseWslConfigNetworkingMode('[wsl2]\n# networkingMode=mirrored\nmemory=8GB\n')).toBe(
			'nat',
		)
		expect(parseWslConfigNetworkingMode('[other]\nnetworkingMode=mirrored\n')).toBe('nat')
		expect(parseWslConfigNetworkingMode(undefined)).toBe('unknown')
	})

	it('prefers the distro-lifetime interop socket, then the newest', () => {
		expect(
			findWslInteropSocket([
				{ path: '/run/WSL/240_interop', mtimeMs: 5 },
				{ path: '/run/WSL/1_interop', mtimeMs: 1 },
			]),
		).toBe('/run/WSL/1_interop')
		expect(
			findWslInteropSocket([
				{ path: '/run/WSL/240_interop', mtimeMs: 5 },
				{ path: '/run/WSL/9_interop', mtimeMs: 9 },
			]),
		).toBe('/run/WSL/9_interop')
		expect(findWslInteropSocket([])).toBeUndefined()
	})
})
