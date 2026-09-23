import { describe, expect, it } from 'vitest'
import {
	type BrowserEnvironmentProbes,
	detectBrowserEnvironment,
	isWsl,
	runnableBrowserPlan,
	wslInteropAvailable,
	wslInteropSocket,
	wslNetworkingMode,
} from '../detect.js'

function probes(
	files: Record<string, string> = {},
	dirs: Record<string, string[]> = {},
	extra: Partial<BrowserEnvironmentProbes> = {},
): BrowserEnvironmentProbes {
	return {
		exists: (path) => path in files || path in dirs,
		readFile: (path) => files[path],
		listDir: (path) => dirs[path] ?? [],
		...extra,
	}
}

const WSL_KERNEL = { '/proc/sys/kernel/osrelease': '6.18.33.2-microsoft-standard-WSL2\n' }
const INTEROP = { '/proc/sys/fs/binfmt_misc/WSLInterop': 'enabled' }
const POWERSHELL = { '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe': '' }
const WIN_CHROME = { '/mnt/c/Program Files/Google/Chrome/Application/chrome.exe': '' }
const WIN_EDGE = { '/mnt/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe': '' }
const RUN_WSL = { '/run/WSL': ['1_interop', '52_interop'] }

describe('detectBrowserEnvironment: WSL', () => {
	const full = probes({ ...WSL_KERNEL, ...INTEROP, ...POWERSHELL, ...WIN_CHROME }, RUN_WSL)

	it('plans the Windows browser over CDP, runnable as it is', () => {
		const plan = detectBrowserEnvironment({ DISPLAY: ':0' }, 'linux', full)
		expect(plan.engine).toBe('windows-cdp')
		if (plan.engine !== 'windows-cdp') return
		expect(plan.browser).toBe('chrome')
		expect(plan.executable).toBe('/mnt/c/Program Files/Google/Chrome/Application/chrome.exe')
		expect(plan.windowsExecutable).toBe(
			'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
		)
		expect(plan.powershell).toBe('/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe')
		expect(plan.mountRoot).toBe('/mnt/')
		expect(plan.unavailableReason).toBeUndefined()
		expect(plan.fallback).toBeUndefined()
		expect(plan.headless).toBe(false)
		expect(runnableBrowserPlan(plan)).toBe(plan)
	})

	it('hands a systemd service the /run/WSL socket, and nothing when WSL_INTEROP works', () => {
		const service = detectBrowserEnvironment({}, 'linux', full)
		expect(service.engine === 'windows-cdp' && service.interopSocket).toBe('/run/WSL/1_interop')

		const session = detectBrowserEnvironment(
			{ WSL_INTEROP: '/run/WSL/52_interop' },
			'linux',
			probes(
				{ ...WSL_KERNEL, ...INTEROP, ...POWERSHELL, ...WIN_CHROME, '/run/WSL/52_interop': '' },
				RUN_WSL,
			),
		)
		expect(session.engine).toBe('windows-cdp')
		expect(session.engine === 'windows-cdp' && session.interopSocket).toBeUndefined()
	})

	it('picks the newest session socket when there is no 1_interop', () => {
		const p = probes(
			{},
			{ '/run/WSL': ['7_interop', '88_interop', 'not-a-socket'] },
			{
				modifiedMs: (path) => (path.endsWith('/7_interop') ? 2_000 : 1_000),
			},
		)
		expect(wslInteropSocket({}, p)).toBe('/run/WSL/7_interop')
		expect(wslInteropSocket({ WSL_INTEROP: '/gone' }, p)).toBe('/run/WSL/7_interop')
		expect(wslInteropSocket({}, probes())).toBeUndefined()
	})

	it('reads the networking mode from wslinfo, then from the one .wslconfig', () => {
		const withWslinfo = (answer: string | undefined) =>
			probes({ '/usr/bin/wslinfo': '' }, {}, { run: () => answer })
		expect(wslNetworkingMode(withWslinfo('mirrored\n'))).toBe('mirrored')
		expect(wslNetworkingMode(withWslinfo('nat\n'))).toBe('nat')

		const users = { '/mnt/c/Users': ['Public', 'Default', 'Arda', 'desktop.ini'] }
		const config = '[wsl2]\r\nmemory=24GB\r\nnetworkingMode = mirrored # fast\r\n'
		expect(
			wslNetworkingMode(
				probes({ '/mnt/c/Users/Arda/.wslconfig': config, '/usr/bin/wslinfo': '' }, users, {
					run: () => undefined,
				}),
			),
		).toBe('mirrored')
		// No wslinfo to run and no setting: WSL's default, NAT.
		expect(
			wslNetworkingMode(probes({ '/mnt/c/Users/Arda/.wslconfig': '[wsl2]\nswap=0\n' }, users)),
		).toBe('nat')
		// Two people's settings: which one is ours is not known.
		expect(
			wslNetworkingMode(
				probes(
					{ '/mnt/c/Users/A/.wslconfig': config, '/mnt/c/Users/B/.wslconfig': config },
					{ '/mnt/c/Users': ['A', 'B'] },
				),
			),
		).toBe('unknown')
	})

	it('puts the networking mode in the plan', () => {
		const plan = detectBrowserEnvironment(
			{},
			'linux',
			probes(
				{ ...WSL_KERNEL, ...INTEROP, ...POWERSHELL, ...WIN_CHROME, '/usr/bin/wslinfo': '' },
				RUN_WSL,
				{
					run: (file, args) =>
						file === '/usr/bin/wslinfo' && args[0] === '--networking-mode' ? 'mirrored' : undefined,
				},
			),
		)
		expect(plan.engine === 'windows-cdp' && plan.networkingMode).toBe('mirrored')
	})

	it('follows a moved mount root from /etc/wsl.conf', () => {
		const plan = detectBrowserEnvironment(
			{},
			'linux',
			probes(
				{
					...WSL_KERNEL,
					...INTEROP,
					'/etc/wsl.conf': '[automount]\nroot = /\noptions = "metadata"\n',
					'/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe': '',
					'/c/Program Files/Google/Chrome/Application/chrome.exe': '',
				},
				RUN_WSL,
			),
		)
		expect(plan.engine).toBe('windows-cdp')
		if (plan.engine !== 'windows-cdp') return
		expect(plan.mountRoot).toBe('/')
		expect(plan.powershell).toBe('/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe')
		expect(plan.windowsExecutable).toBe(
			'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
		)
	})

	it('finds Edge when there is no Chrome, and uses Edge when asked', () => {
		const edgeOnly = detectBrowserEnvironment(
			{},
			'linux',
			probes({ ...WSL_KERNEL, ...INTEROP, ...POWERSHELL, ...WIN_EDGE }, RUN_WSL),
		)
		expect(edgeOnly.engine === 'windows-cdp' && edgeOnly.browser).toBe('msedge')

		const both = probes(
			{ ...WSL_KERNEL, ...INTEROP, ...POWERSHELL, ...WIN_CHROME, ...WIN_EDGE },
			RUN_WSL,
		)
		const asked = detectBrowserEnvironment({}, 'linux', both, { windowsBrowser: 'msedge' })
		expect(asked.engine === 'windows-cdp' && asked.windowsExecutable).toBe(
			'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
		)
		expect(asked.warnings).toEqual([])

		const missing = detectBrowserEnvironment(
			{},
			'linux',
			probes({ ...WSL_KERNEL, ...INTEROP, ...POWERSHELL, ...WIN_CHROME }, RUN_WSL),
			{ windowsBrowser: 'msedge' },
		)
		expect(missing.engine === 'windows-cdp' && missing.browser).toBe('chrome')
		expect(missing.warnings.join(' ')).toMatch(/Microsoft Edge is not installed/)
	})

	it('recognises WSL from the kernel alone, as under a systemd service', () => {
		expect(isWsl({}, probes(WSL_KERNEL))).toBe(true)
		expect(isWsl({}, probes({ '/proc/sys/kernel/osrelease': '6.8.0-45-generic' }))).toBe(false)
		expect(isWsl({ WSL_DISTRO_NAME: 'Arch' }, probes())).toBe(true)
	})

	it('needs the binfmt handler and a socket for interop', () => {
		expect(wslInteropAvailable({}, probes(INTEROP, RUN_WSL))).toBe(true)
		expect(wslInteropAvailable({}, probes(INTEROP))).toBe(false)
		expect(
			wslInteropAvailable(
				{ WSL_INTEROP: '/run/WSL/9_interop' },
				probes({ ...INTEROP, '/run/WSL/9_interop': '' }),
			),
		).toBe(true)
		expect(wslInteropAvailable({}, probes({}, RUN_WSL))).toBe(false)
	})

	it('falls back to Chromium inside WSL with a warning when interop is off', () => {
		const plan = detectBrowserEnvironment(
			{ WAYLAND_DISPLAY: 'wayland-0' },
			'linux',
			probes({ ...WSL_KERNEL, ...POWERSHELL, ...WIN_CHROME }),
		)
		expect(plan.engine).toBe('local')
		expect(plan.platform).toBe('wsl')
		expect(plan.headless).toBe(false)
		expect(plan.warnings.join(' ')).toMatch(/interop is off/)
	})

	it('reports why when windows is forced and cannot run', () => {
		const plan = detectBrowserEnvironment(
			{},
			'linux',
			probes({ ...WSL_KERNEL, ...INTEROP }, RUN_WSL),
			{
				engine: 'windows',
			},
		)
		expect(plan.unavailableReason).toMatch(/powershell\.exe was not found/)
	})

	it('uses the local engine when asked, even with a Windows browser present', () => {
		const plan = detectBrowserEnvironment({}, 'linux', full, { engine: 'local' })
		expect(plan.engine).toBe('local')
		expect(plan.headless).toBe(true)
	})

	it('keeps the Windows plan headless for an unattended run', () => {
		const plan = detectBrowserEnvironment({ DISPLAY: ':0' }, 'linux', full, { mode: 'unattended' })
		expect(plan.engine).toBe('windows-cdp')
		expect(plan.headless).toBe(true)
	})
})

describe('detectBrowserEnvironment: Linux', () => {
	it('is headed with a display in an interactive session, headless otherwise', () => {
		expect(detectBrowserEnvironment({ DISPLAY: ':0' }, 'linux', probes()).headless).toBe(false)
		expect(
			detectBrowserEnvironment({ DISPLAY: ':0' }, 'linux', probes(), { mode: 'unattended' })
				.headless,
		).toBe(true)
		expect(
			detectBrowserEnvironment({ DISPLAY: ':0' }, 'linux', probes(), { headless: 'always' })
				.headless,
		).toBe(true)
	})

	it('runs headless without a display and says so', () => {
		const plan = detectBrowserEnvironment({}, 'linux', probes())
		expect(plan.headless).toBe(true)
		expect(plan.display).toBe(false)
		expect(plan.unavailableReason).toBeUndefined()
		expect(plan.warnings.join(' ')).toMatch(/No display/)
	})

	it('is unavailable when a window is required and there is no display', () => {
		const plan = detectBrowserEnvironment({}, 'linux', probes(), { headless: 'never' })
		expect(plan.unavailableReason).toMatch(/no display/)
	})

	it('prefers an installed Google Chrome over Playwright Chromium', () => {
		const chrome = detectBrowserEnvironment(
			{},
			'linux',
			probes({ '/opt/google/chrome/chrome': '' }),
		)
		expect(chrome.engine === 'local' && chrome.channel).toBe('chrome')
		const bundled = detectBrowserEnvironment({}, 'linux', probes())
		expect(bundled.engine === 'local' && bundled.browser).toBe('chromium')
		expect(bundled.engine === 'local' && bundled.channel).toBeUndefined()
	})

	it('refuses engine windows outside WSL', () => {
		const plan = detectBrowserEnvironment({}, 'linux', probes(), { engine: 'windows' })
		expect(plan.unavailableReason).toMatch(/this is not WSL/)
	})
})

describe('detectBrowserEnvironment: macOS and Windows', () => {
	it('uses Chrome on macOS when installed and is headed interactively', () => {
		const plan = detectBrowserEnvironment(
			{},
			'darwin',
			probes({ '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome': '' }),
		)
		expect(plan.engine === 'local' && plan.browser).toBe('chrome')
		expect(plan.headless).toBe(false)
	})

	it('uses Chrome, then Edge, then Chromium on Windows', () => {
		const env = {
			PROGRAMFILES: 'C:\\Program Files',
			'PROGRAMFILES(X86)': 'C:\\Program Files (x86)',
		}
		const chrome = detectBrowserEnvironment(
			env,
			'win32',
			probes({ 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe': '' }),
		)
		expect(chrome.engine === 'local' && chrome.browser).toBe('chrome')
		const edge = detectBrowserEnvironment(
			env,
			'win32',
			probes({ 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe': '' }),
		)
		expect(edge.engine === 'local' && edge.channel).toBe('msedge')
		const none = detectBrowserEnvironment(env, 'win32', probes())
		expect(none.engine === 'local' && none.browser).toBe('chromium')
	})

	it('is unavailable on other platforms', () => {
		expect(detectBrowserEnvironment({}, 'freebsd', probes()).unavailableReason).toMatch(/freebsd/)
	})
})
