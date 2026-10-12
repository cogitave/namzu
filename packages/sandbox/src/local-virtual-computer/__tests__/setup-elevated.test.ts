import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LocalComputerCommandRunner } from '../engine.js'
import type { WslcSetupHost, WslcSetupProgress } from '../setup/contract.js'
import {
	buildElevatedScripts,
	isAdministratorAccount,
	mapElevatedExit,
	parseProgressLine,
	runElevatedWslcSteps,
} from '../setup/elevated.js'

const SHA = 'ab'.repeat(32)
const STATE = 'C:\\Users\\Ali Veli\\AppData\\Local\\Namzu\\setup'
const MSI = `${STATE}\\wsl.3.0.1.0.x64.msi`

/** `whoami /groups /fo csv /nh` for an administrator whose token is filtered (not elevated). */
const ADMIN_FILTERED_TOKEN = [
	'"Mandatory Label\\Medium Mandatory Level","Label","S-1-16-8192",""',
	'"Everyone","Well-known group","S-1-1-0","Mandatory group, Enabled by default, Enabled group"',
	'"NT AUTHORITY\\Local account and member of Administrators group","Well-known group","S-1-5-114","Group used for deny only"',
	'"BUILTIN\\Administrators","Alias","S-1-5-32-544","Group used for deny only"',
	'"BUILTIN\\Users","Alias","S-1-5-32-545","Mandatory group, Enabled by default, Enabled group"',
	'"NT AUTHORITY\\INTERACTIVE","Well-known group","S-1-5-4","Mandatory group, Enabled by default, Enabled group"',
].join('\r\n')

/** The same listing for a standard user: no Administrators group at all. */
const STANDARD_USER = [
	'"Mandatory Label\\Medium Mandatory Level","Label","S-1-16-8192",""',
	'"Everyone","Well-known group","S-1-1-0","Mandatory group, Enabled by default, Enabled group"',
	'"BUILTIN\\Users","Alias","S-1-5-32-545","Mandatory group, Enabled by default, Enabled group"',
	'"NT AUTHORITY\\INTERACTIVE","Well-known group","S-1-5-4","Mandatory group, Enabled by default, Enabled group"',
].join('\r\n')

function decode(encoded: string): string {
	return Buffer.from(encoded, 'base64').toString('utf16le')
}

function request(overrides: {
	steps?: unknown
	wslPackage?: unknown
	host?: Partial<WslcSetupHost>
}): Parameters<typeof buildElevatedScripts>[0] {
	return {
		steps: ['enable-windows-features', 'install-wsl'],
		wslPackage: { path: MSI, sha256: SHA },
		host: {
			platform: 'win32',
			arch: 'x64',
			windowsBuild: 19045,
			stateDirectory: STATE,
			env: {},
			...overrides.host,
		} as WslcSetupHost,
		...(overrides.steps !== undefined ? { steps: overrides.steps } : {}),
		...('wslPackage' in overrides ? { wslPackage: overrides.wslPackage } : {}),
	} as Parameters<typeof buildElevatedScripts>[0]
}

describe('script generation', () => {
	it('builds the Windows 11 enable script (snapshot)', () => {
		const scripts = buildElevatedScripts(
			request({
				steps: ['enable-windows-features'],
				wslPackage: undefined,
				host: { windowsBuild: 22631 },
			}),
		)
		expect(scripts.isWindows11).toBe(true)
		expect(scripts.inner).toMatchSnapshot()
	})

	it('adds the WSL optional component on Windows 10 only', () => {
		const ten = buildElevatedScripts(
			request({ steps: ['enable-windows-features'], wslPackage: undefined }),
		)
		const eleven = buildElevatedScripts(
			request({
				steps: ['enable-windows-features'],
				wslPackage: undefined,
				host: { windowsBuild: 22000 },
			}),
		)
		expect(ten.isWindows11).toBe(false)
		expect(ten.inner).toContain("'VirtualMachinePlatform', 'Microsoft-Windows-Subsystem-Linux'")
		expect(eleven.inner).toContain("@('VirtualMachinePlatform')")
		expect(eleven.inner).not.toContain('Subsystem-Linux')
		expect(ten.inner).toContain('/online /enable-feature')
		expect(ten.inner).toContain('/all /norestart')
	})

	it('builds the install script with the digest check inside the elevated process (snapshot)', () => {
		const scripts = buildElevatedScripts(request({ steps: ['install-wsl'] }))
		expect(scripts.inner).not.toContain('dism.exe')
		expect(scripts.inner).toContain(`$want = '${SHA}'`)
		expect(scripts.inner).toContain('Get-FileHash')
		expect(scripts.inner).toContain('/qn')
		expect(scripts.inner).toContain('/norestart')
		expect(scripts.inner).toContain('/l*v')
		// The package is hashed where only administrators can write, not where it was downloaded.
		expect(scripts.inner.indexOf('Copy-Item')).toBeLessThan(scripts.inner.indexOf('Get-FileHash'))
		expect(scripts.inner.indexOf('Get-FileHash')).toBeLessThan(scripts.inner.indexOf('msiexec.exe'))
		expect(scripts.inner).toMatchSnapshot()
	})

	it('runs only Microsoft tools', () => {
		const { inner } = buildElevatedScripts(request({}))
		const programs = inner.match(/[A-Za-z0-9_-]+\.exe/g) ?? []
		expect([...new Set(programs)].sort()).toEqual(['dism.exe', 'msiexec.exe'])
		expect(inner).not.toMatch(/Invoke-WebRequest|DownloadFile|Invoke-Expression|\biex\b|curl|wget/i)
	})

	it('lowercases the digest and wraps the launcher around the encoded inner script', () => {
		const scripts = buildElevatedScripts(
			request({ wslPackage: { path: MSI, sha256: 'AB'.repeat(32) } }),
		)
		expect(scripts.inner).toContain(`'${SHA}'`)
		expect(scripts.launcherArgs.slice(0, 5)).toEqual([
			'-NoProfile',
			'-NonInteractive',
			'-ExecutionPolicy',
			'Bypass',
			'-EncodedCommand',
		])
		expect(decode(scripts.launcherArgs[5] as string)).toBe(scripts.launcher)
		const embedded = /'-EncodedCommand', '([A-Za-z0-9+/=]+)'/.exec(scripts.launcher)?.[1]
		expect(decode(embedded as string)).toBe(scripts.inner)
		expect(scripts.launcher).toContain('-Verb RunAs')
		expect(scripts.launcher).toContain('-Wait -PassThru -WindowStyle Hidden')
		expect(scripts.launcher).toContain('1223')
		expect(scripts.progressFile).toBe(`${STATE}\\elevated-progress.jsonl`)
		expect(scripts.launcherArgs.join(' ').length).toBeLessThan(30000)
	})

	it('keeps shell metacharacters inside single-quoted literals', () => {
		const state = 'C:\\Users\\a $(calc) `b` ; & (c)\\setup'
		const scripts = buildElevatedScripts(
			request({
				host: { stateDirectory: state },
				wslPackage: { path: `${state}\\wsl.msi`, sha256: SHA },
			}),
		)
		expect(scripts.inner).toContain(`$src = '${state}\\wsl.msi'`)
		expect(scripts.inner).toContain(`$log = '${state}\\elevated-progress.jsonl'`)
	})
})

describe('request validation', () => {
	const reject = (overrides: Parameters<typeof request>[0], message: RegExp) =>
		expect(() => buildElevatedScripts(request(overrides))).toThrow(message)

	it('rejects a step list that is empty, duplicated or unknown', () => {
		reject({ steps: [] }, /No elevated step/)
		reject({ steps: ['install-wsl', 'install-wsl'] }, /twice/)
		reject({ steps: ['download-wsl'] }, /not an elevated step/)
		reject({ steps: ['enable-windows-features', 'format-disk'] }, /not an elevated step/)
		reject({ steps: ['install-wsl; calc'] }, /not an elevated step/)
	})

	it.each([
		['a single quote', `${STATE}\\it's.msi`],
		['a double quote', `${STATE}\\a"b.msi`],
		['a typographic quote', `${STATE}\\a\u2019b.msi`],
		['a low typographic quote', `${STATE}\\a\u201Ab.msi`],
		['a line feed', `${STATE}\\a\nb.msi`],
		['a carriage return', `${STATE}\\a\rb.msi`],
		['a NUL', `${STATE}\\a\0b.msi`],
		['a path outside the setup directory', 'C:\\Windows\\Temp\\wsl.msi'],
		['a sibling directory with the same prefix', `${STATE}-evil\\wsl.msi`],
		['a parent-directory segment', `${STATE}\\..\\..\\Temp\\wsl.msi`],
		['a parent segment that returns inside', `${STATE}\\x\\..\\wsl.msi`],
		['a path that is the directory itself', STATE],
		['a file that is not an .msi', `${STATE}\\wsl.exe`],
		['a relative path', 'wsl.msi'],
		['a UNC path', '\\\\server\\share\\wsl.msi'],
	])('rejects an MSI path with %s', (_name, path) => {
		reject({ wslPackage: { path, sha256: SHA } }, /WSL package/)
	})

	it.each([
		['too short', 'ab'.repeat(31)],
		['too long', 'ab'.repeat(33)],
		['not hex', 'zz'.repeat(32)],
		['with a quote', `${'ab'.repeat(31)}a'`],
		['empty', ''],
	])('rejects a digest that is %s', (_name, sha256) => {
		reject({ wslPackage: { path: MSI, sha256 } }, /digest/)
	})

	it('rejects a setup directory with a quote or a line break', () => {
		reject(
			{
				host: { stateDirectory: "C:\\Users\\O'Neil\\setup" },
				wslPackage: undefined,
				steps: ['enable-windows-features'],
			},
			/setup directory/,
		)
		reject(
			{
				host: { stateDirectory: 'C:\\Users\\a\nb\\setup' },
				wslPackage: undefined,
				steps: ['enable-windows-features'],
			},
			/setup directory/,
		)
		reject(
			{
				host: { stateDirectory: 'setup' },
				wslPackage: undefined,
				steps: ['enable-windows-features'],
			},
			/absolute/,
		)
	})

	it('needs the package for install-wsl and refuses one without it', () => {
		reject({ steps: ['install-wsl'], wslPackage: undefined }, /needs the downloaded package/)
		reject({ steps: ['enable-windows-features'] }, /was not requested/)
	})

	it('refuses a host that is not Windows or has no known build', () => {
		reject({ host: { platform: 'linux' } }, /only on Windows/)
		reject({ host: { windowsBuild: undefined } }, /build is unknown/)
	})
})

describe('mapElevatedExit', () => {
	const both = ['enable-windows-features', 'install-wsl'] as const
	it('maps the documented codes', () => {
		expect(mapElevatedExit(0, both, {})).toEqual({ outcome: 'ok' })
		expect(mapElevatedExit(3010, both, {})).toEqual({ outcome: 'restart-required' })
		expect(mapElevatedExit(1223, both, {})).toBe('cancelled')
		expect(mapElevatedExit(20, both, { exitCode: 1603 })).toEqual({
			outcome: 'failed',
			step: 'enable-windows-features',
			code: 'feature-enable-failed',
			exitCode: 1603,
		})
		expect(mapElevatedExit(21, both, {})).toEqual({
			outcome: 'failed',
			step: 'install-wsl',
			code: 'wsl-install-failed',
			exitCode: 21,
		})
		expect(mapElevatedExit(22, both, { exitCode: 22 })).toMatchObject({
			step: 'install-wsl',
			code: 'wsl-install-failed',
		})
	})

	it('maps anything else to elevation-failed on the step that was running, or the first', () => {
		expect(mapElevatedExit(-1, both, {})).toEqual({
			outcome: 'failed',
			step: 'enable-windows-features',
			code: 'elevation-failed',
			exitCode: -1,
		})
		expect(mapElevatedExit(5, ['install-wsl'], {})).toMatchObject({ step: 'install-wsl' })
		expect(mapElevatedExit(5, both, { step: 'install-wsl' })).toMatchObject({ step: 'install-wsl' })
	})
})

describe('isAdministratorAccount', () => {
	it('sees the Administrators group of an administrator even with a filtered token', () => {
		expect(isAdministratorAccount(ADMIN_FILTERED_TOKEN)).toBe(true)
	})
	it('does not see it for a standard user', () => {
		expect(isAdministratorAccount(STANDARD_USER)).toBe(false)
		expect(isAdministratorAccount('')).toBe(false)
	})
})

describe('parseProgressLine', () => {
	it('reads started, finished and failed lines, with or without a byte-order mark', () => {
		expect(parseProgressLine('\uFEFF{"step":"install-wsl","phase":"started"}')).toMatchObject({
			step: 'install-wsl',
			phase: 'started',
		})
		expect(
			parseProgressLine(
				'{"step":"enable-windows-features","phase":"finished","result":"restart-required"}',
			),
		).toMatchObject({ result: 'restart-required' })
		expect(
			parseProgressLine('{"step":"install-wsl","phase":"failed","exitCode":1603}'),
		).toMatchObject({
			exitCode: 1603,
		})
	})
	it('ignores lines it does not understand', () => {
		for (const line of [
			'',
			'not json',
			'[]',
			'null',
			'{"step":"x","phase":"started"}',
			'{"step":"install-wsl","phase":"later"}',
		]) {
			expect(parseProgressLine(line)).toBeUndefined()
		}
	})
})

describe('runElevatedWslcSteps', () => {
	let directory: string
	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), 'namzu-t4-elevated-'))
	})
	afterEach(async () => {
		vi.useRealTimers()
		await rm(directory, { recursive: true, force: true })
	})

	interface Call {
		binary: string
		args: readonly string[]
		signal?: AbortSignal
	}

	function setup(
		launcher: (call: Call, progressFile: string) => Promise<string>,
		whoami: string | Error = ADMIN_FILTERED_TOKEN,
	) {
		const calls: Call[] = []
		const events: WslcSetupProgress[] = []
		const runner: LocalComputerCommandRunner = {
			async run(binary, args, options) {
				const call = { binary, args, signal: options?.signal }
				calls.push(call)
				if (binary.endsWith('whoami.exe')) {
					if (whoami instanceof Error) throw whoami
					return whoami
				}
				return launcher(call, join(directory, 'elevated-progress.jsonl'))
			},
		}
		const host = {
			platform: 'win32',
			arch: 'x64',
			windowsBuild: 22631,
			// A real directory stands in for the setup directory, so the progress file can be read back.
			stateDirectory: directory,
			env: { SystemRoot: 'C:\\Windows' },
			runner,
		} as unknown as WslcSetupHost
		return { calls, events, host, onProgress: (event: WslcSetupProgress) => events.push(event) }
	}

	const msi = () => join(directory, 'wsl.msi')
	const both = () => ({
		steps: ['enable-windows-features', 'install-wsl'] as (
			| 'enable-windows-features'
			| 'install-wsl'
		)[],
		wslPackage: { path: msi(), sha256: SHA },
	})

	it('starts a hidden-window launcher of Windows PowerShell with the encoded script', async () => {
		const { calls, host } = setup(async () => 'NAMZU_EXIT=0\r\n')
		const outcome = await runElevatedWslcSteps({ ...both(), host })
		expect(outcome).toEqual({ outcome: 'ok' })
		expect(calls).toHaveLength(1)
		expect(calls[0]?.binary).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
		const scripts = buildElevatedScripts({ ...both(), host })
		expect(calls[0]?.args).toEqual(scripts.launcherArgs)
	})

	it('maps 0 and 3010', async () => {
		expect(
			await runElevatedWslcSteps({ ...both(), host: setup(async () => 'NAMZU_EXIT=0').host }),
		).toEqual({ outcome: 'ok' })
		expect(
			await runElevatedWslcSteps({ ...both(), host: setup(async () => 'NAMZU_EXIT=3010').host }),
		).toEqual({
			outcome: 'restart-required',
		})
	})

	it('reports an administrator who declined the prompt as cancelled', async () => {
		const { host, calls } = setup(async () => 'NAMZU_EXIT=1223')
		expect(await runElevatedWslcSteps({ ...both(), host })).toEqual({ outcome: 'cancelled' })
		expect(calls.map((call) => call.binary.split('\\').pop())).toEqual([
			'powershell.exe',
			'whoami.exe',
		])
		expect(calls[1]?.args).toEqual(['/groups', '/fo', 'csv', '/nh'])
	})

	it('reports a standard user who did not get an administrator to approve as needs-administrator', async () => {
		const { host } = setup(async () => 'NAMZU_EXIT=1223', STANDARD_USER)
		expect(await runElevatedWslcSteps({ ...both(), host })).toEqual({
			outcome: 'needs-administrator',
		})
		const failedLaunch = setup(async () => 'NAMZU_LAUNCH_FAILED', STANDARD_USER)
		expect(await runElevatedWslcSteps({ ...both(), host: failedLaunch.host })).toEqual({
			outcome: 'needs-administrator',
		})
	})

	it('does not ask whoami when the elevated steps ran', async () => {
		const { host, calls } = setup(async () => 'NAMZU_EXIT=21', STANDARD_USER)
		await runElevatedWslcSteps({ ...both(), host })
		expect(calls).toHaveLength(1)
	})

	it('fails with elevation-failed when the launcher cannot start or prints nothing', async () => {
		for (const launcher of [
			async () => {
				throw new Error('spawn failed')
			},
			async () => '',
			async () => 'NAMZU_LAUNCH_FAILED',
		]) {
			const { host } = setup(launcher)
			expect(await runElevatedWslcSteps({ ...both(), host })).toEqual({
				outcome: 'failed',
				step: 'enable-windows-features',
				code: 'elevation-failed',
				exitCode: undefined,
			})
		}
	})

	it('takes the Windows exit code of a failed step from the progress file', async () => {
		const { host } = setup(async (_call, file) => {
			await writeFile(
				file,
				'{"step":"enable-windows-features","phase":"started"}\n{"step":"enable-windows-features","phase":"failed","exitCode":1603}\n',
			)
			return 'NAMZU_EXIT=20'
		})
		expect(await runElevatedWslcSteps({ ...both(), host })).toEqual({
			outcome: 'failed',
			step: 'enable-windows-features',
			code: 'feature-enable-failed',
			exitCode: 1603,
		})
	})

	it('maps install failures and a digest mismatch to wsl-install-failed', async () => {
		for (const code of [21, 22]) {
			const { host } = setup(async () => `NAMZU_EXIT=${code}`)
			expect(await runElevatedWslcSteps({ ...both(), host })).toMatchObject({
				outcome: 'failed',
				step: 'install-wsl',
				code: 'wsl-install-failed',
				exitCode: code,
			})
		}
	})

	it('reads the progress file written by the elevated process, including a late partial line', async () => {
		const { host, events, onProgress } = setup(async (_call, file) => {
			await writeFile(
				file,
				'\uFEFF{"step":"enable-windows-features","phase":"started"}\n{"step":"enable-windows-features","phase":"finished","result":"restart-required"}\n{"step":"install-wsl","pha',
			)
			return 'NAMZU_EXIT=3010'
		})
		await runElevatedWslcSteps({ ...both(), host, onProgress })
		expect(events).toEqual([
			{ step: 'enable-windows-features', phase: 'started' },
			{ step: 'enable-windows-features', phase: 'finished', result: 'restart-required' },
		])
	})

	it('emits progress while the elevated process is still running and never repeats an event', async () => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
		let release: (value: string) => void = () => {}
		let started: () => void = () => {}
		const hasStarted = new Promise<void>((resolve) => {
			started = resolve
		})
		const { host, events, onProgress } = setup(() => {
			started()
			return new Promise<string>((resolve) => {
				release = resolve
			})
		})
		let notify: () => void = () => {}
		const seen = (count: number) =>
			new Promise<void>((resolve) => {
				const check = () => {
					if (events.length >= count) resolve()
				}
				notify = check
				check()
			})
		const watched = (event: WslcSetupProgress) => {
			onProgress(event)
			notify()
		}
		const pending = runElevatedWslcSteps({ ...both(), host, onProgress: watched })
		await hasStarted
		const file = join(directory, 'elevated-progress.jsonl')
		await writeFile(file, '{"step":"enable-windows-features","phase":"started"}\n')
		const first = seen(1)
		await vi.advanceTimersByTimeAsync(250)
		await first
		expect(events).toEqual([{ step: 'enable-windows-features', phase: 'started' }])
		await appendFile(file, '{"step":"enable-windows-features","phase":"finished","result":"ok"}\n')
		const second = seen(2)
		await vi.advanceTimersByTimeAsync(250)
		await second
		await vi.advanceTimersByTimeAsync(250)
		expect(events).toHaveLength(2)
		release('NAMZU_EXIT=0')
		expect(await pending).toEqual({ outcome: 'ok' })
		expect(events).toHaveLength(2)
	})

	it('discards a progress file left by an earlier run', async () => {
		await writeFile(
			join(directory, 'elevated-progress.jsonl'),
			'{"step":"install-wsl","phase":"failed","exitCode":1603}\n',
		)
		const { host } = setup(async () => 'NAMZU_EXIT=20')
		expect(await runElevatedWslcSteps({ ...both(), host })).toMatchObject({ exitCode: 20 })
	})

	it('stops waiting when the signal aborts, and passes the signal to the launcher', async () => {
		const controller = new AbortController()
		let seenSignal: AbortSignal | undefined
		let started: () => void = () => {}
		const hasStarted = new Promise<void>((resolve) => {
			started = resolve
		})
		const { host } = setup((call) => {
			seenSignal = call.signal
			started()
			return new Promise<string>(() => {})
		})
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
		const pending = runElevatedWslcSteps({ ...both(), host, signal: controller.signal })
		const settled = pending.then(
			() => 'resolved',
			(error: unknown) => error,
		)
		await hasStarted
		expect(seenSignal).toBe(controller.signal)
		controller.abort(new Error('stopped'))
		expect(await settled).toEqual(new Error('stopped'))
	})

	it('does not start anything for a request that fails validation', async () => {
		const { host, calls } = setup(async () => 'NAMZU_EXIT=0')
		await expect(
			runElevatedWslcSteps({
				steps: ['install-wsl'],
				wslPackage: { path: 'C:\\x.msi', sha256: SHA },
				host,
			}),
		).rejects.toThrow()
		expect(calls).toEqual([])
	})
})
