import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LocalComputerCommandRunner } from '../engine.js'
import type { WslcSetupHost, WslcSetupProgress } from '../setup/contract.js'
import {
	buildElevatedScripts,
	encodeCommand,
	isAdministratorAccount,
	mapElevatedExit,
	parseProgressLine,
	runElevatedWith,
	runElevatedWslcSteps,
} from '../setup/elevated.js'

const SHA = 'ab'.repeat(32)
const STATE = 'C:\\Users\\Ali Veli\\AppData\\Local\\Namzu\\setup'
const MSI = `${STATE}\\wsl.3.0.1.0.x64.msi`
const RUN_ID = '0123456789abcdef0123456789abcdef'

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
			{ runId: RUN_ID, windowsDirectory: 'C:\\Windows' },
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
		const scripts = buildElevatedScripts(request({ steps: ['install-wsl'] }), {
			runId: RUN_ID,
			windowsDirectory: 'C:\\Windows',
		})
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

	it('compares the package digest before msiexec and sets exit 22 on a mismatch', () => {
		const { inner } = buildElevatedScripts(request({ steps: ['install-wsl'] }))
		const compare = inner.indexOf('if ($got -ine $want) {')
		const install = inner.indexOf("Start-Process -FilePath (Join-Path $sys 'msiexec.exe')")
		expect(compare).toBeGreaterThan(inner.indexOf('Get-FileHash'))
		expect(install).toBeGreaterThan(compare)
		// The mismatch branch sets 22 and holds no msiexec; msiexec sits only in the else branch.
		const mismatch = inner.slice(compare, inner.indexOf('} else {', compare))
		expect(mismatch).toContain('$code = 22')
		expect(mismatch).not.toContain('msiexec')
		expect(inner.match(/msiexec\.exe/g)).toHaveLength(1)
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
		// The launcher carries the inner script as one literal and encodes it itself.
		expect(scripts.launcher).toContain(`.Replace('@@USER_SID@@', $sid)`)
		expect(scripts.launcher).toContain(scripts.inner.replace(/'/g, "''"))
		expect(scripts.launcher).toContain("$psi.Verb = 'runas'")
		expect(scripts.launcher).toContain('$psi.UseShellExecute = $true')
		expect(scripts.launcher).toContain("$psi.WindowStyle = 'Hidden'")
		expect(scripts.launcher).toContain('[Diagnostics.Process]::Start($psi)')
		expect(scripts.launcher).not.toContain('-Verb RunAs')
		expect(scripts.launcherArgs.join(' ').length).toBeLessThan(30000)
	})

	it('takes tools and folders from the operating system, never from the environment', () => {
		const { inner, launcher } = buildElevatedScripts(request({}))
		for (const script of [inner, launcher]) {
			expect(script).not.toMatch(/\$env:(SystemRoot|windir|TEMP|TMP|ProgramFiles)/i)
			expect(script).toContain('[Environment]::SystemDirectory')
			expect(script).toContain('$env:PSModulePath = Join-Path $sys')
		}
		expect(inner).toContain('$env:PATH = $sys')
	})

	it('writes only inside a new folder only administrators can write', () => {
		const scripts = buildElevatedScripts(request({}), {
			runId: RUN_ID,
			windowsDirectory: 'C:\\Windows',
		})
		expect(scripts.progressFile).toBe(
			`C:\\Windows\\Temp\\namzu-wsl-${RUN_ID}\\elevated-progress.jsonl`,
		)
		expect(scripts.inner).toContain(`Join-Path $win ('Temp\\namzu-wsl-${RUN_ID}')`)
		// Exclusive creation (no -Force, so an existing name fails), then the result is read back.
		expect(scripts.inner).toContain('New-Item -ItemType Directory -Path $dir | Out-Null')
		expect(scripts.inner).not.toMatch(/New-Item[^\n]*-Force/)
		expect(scripts.inner).not.toContain('IO.DirectoryInfo')
		expect(scripts.inner).toContain('Test-Folder $dir $true')
		expect(scripts.inner).toContain('if ($adminSids -notcontains $owner) { throw "owner" }')
		expect(scripts.inner).toContain('if (-not $a.AreAccessRulesProtected) { throw "inherited" }')
		expect(scripts.inner).toContain('Test-Folder $pkg $false')
		expect(scripts.inner).toContain('if (Test-Path -LiteralPath $pkg) { throw "pkg exists" }')
		expect(scripts.inner).toContain('if (Test-Path -LiteralPath $log) { throw "log exists" }')
		expect(scripts.inner).toContain('if (Test-Path -LiteralPath $msilog) { throw "log exists" }')
		// The owner check runs before anything is written into the folder.
		expect(scripts.inner.indexOf('Test-Folder $dir $true')).toBeLessThan(
			scripts.inner.indexOf("$log = Join-Path $dir 'elevated-progress.jsonl'"),
		)
		expect(scripts.inner).toContain('SetAccessRuleProtection($true, $false)')
		expect(scripts.inner).toContain('$acl.AddAccessRule((Rule $userSid "Read"')
		// The log and the progress file live in that folder; the user's own folder is only read.
		expect(scripts.inner).toContain("$msilog = Join-Path $dir 'wsl-install.log'")
		expect(scripts.inner).toContain("$log = Join-Path $dir 'elevated-progress.jsonl'")
		expect(scripts.inner).not.toContain(`${STATE}\\elevated`)
		expect(scripts.inner).not.toContain(`${STATE}\\wsl-install`)
		expect(scripts.inner).toContain('ReparsePoint')
		// The copy of the package sits where even the person who started setup cannot read it.
		expect(scripts.inner).toContain("$pkg = Join-Path $dir 'pkg'")
		expect(scripts.inner.indexOf("$pkg = Join-Path $dir 'pkg'")).toBeLessThan(
			scripts.inner.indexOf('Copy-Item'),
		)
	})

	it('refuses a run id that is not 32 hex characters', () => {
		for (const runId of ['', 'abc', "a'b".padEnd(32, 'a'), 'g'.repeat(32)]) {
			expect(() => buildElevatedScripts(request({}), { runId })).toThrow(/run id/)
		}
	})

	it('keeps the encoded elevated script under half of what ShellExecute accepts', () => {
		const { inner } = buildElevatedScripts(request({}))
		const longest = inner.replace('@@USER_SID@@', 'S-1-5-21'.padEnd(184, '1'))
		expect(encodeCommand(longest).length).toBeLessThan(16000)
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

	it('rejects an MSI path equal to the setup directory', () => {
		const same = 'C:\\Users\\Someone\\AppData\\Local\\Namzu\\setup\\wsl.msi'
		reject(
			{ host: { stateDirectory: same }, wslPackage: { path: same, sha256: SHA } },
			/not inside the setup directory/,
		)
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
	it('compares the SID column exactly, not as text anywhere in the output', () => {
		const lookalike = [
			'"Contoso\\S-1-5-32-544 admins","Group","S-1-5-21-1-2-3-1001","Mandatory group"',
			'"BUILTIN\\Users","Alias","S-1-5-32-545","Mandatory group"',
			'"Group S-1-5-32-5445","Alias","S-1-5-32-5445","Mandatory group"',
		].join('\r\n')
		expect(isAdministratorAccount(lookalike)).toBe(false)
		expect(isAdministratorAccount('S-1-5-32-544')).toBe(false)
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
		env?: NodeJS.ProcessEnv
		cwd?: string
	}

	const runId = RUN_ID
	const progressFile = () =>
		join(directory, 'Temp', `namzu-wsl-${runId}`, 'elevated-progress.jsonl')
	const pinned = () => ({ runId, windowsDirectory: directory })
	const run = (request: Parameters<typeof runElevatedWith>[0]) => runElevatedWith(request, pinned())

	function setup(
		launcher: (call: Call, progressFile: string) => Promise<string>,
		whoami: string | Error = ADMIN_FILTERED_TOKEN,
	) {
		const calls: Call[] = []
		const events: WslcSetupProgress[] = []
		const runner: LocalComputerCommandRunner = {
			async run(binary, args, options) {
				const call = {
					binary,
					args,
					signal: options?.signal,
					env: options?.env,
					cwd: options?.cwd,
				}
				await mkdir(join(directory, 'Temp', `namzu-wsl-${runId}`), { recursive: true })
				calls.push(call)
				if (binary.endsWith('whoami.exe')) {
					if (whoami instanceof Error) throw whoami
					return whoami
				}
				return launcher(call, progressFile())
			},
		}
		const host = {
			platform: 'win32',
			arch: 'x64',
			windowsBuild: 22631,
			// A real directory stands in for the setup directory and the Windows folder, so the progress file can be read back.
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
		const outcome = await run({ ...both(), host })
		expect(outcome).toEqual({ outcome: 'ok' })
		expect(calls).toHaveLength(1)
		expect(calls[0]?.binary).toBe(`${directory}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`)
		const scripts = buildElevatedScripts({ ...both(), host }, pinned())
		expect(calls[0]?.args).toEqual(scripts.launcherArgs)
	})

	it('runs the launcher and whoami from the Windows System32 folder, never the caller directory', async () => {
		const standard = setup(async () => 'NAMZU_EXIT=1223', STANDARD_USER)
		await run({ ...both(), host: standard.host })
		expect(standard.calls.map((call) => call.cwd)).toEqual([
			`${directory}\\System32`,
			`${directory}\\System32`,
		])
		expect(standard.calls[1]?.binary).toBe(`${directory}\\System32\\whoami.exe`)
		expect(buildElevatedScripts({ ...both(), host: standard.host }, pinned()).launcher).toContain(
			'$psi.WorkingDirectory = $sys',
		)
	})

	it('maps 0 and 3010', async () => {
		expect(await run({ ...both(), host: setup(async () => 'NAMZU_EXIT=0').host })).toEqual({
			outcome: 'ok',
		})
		expect(await run({ ...both(), host: setup(async () => 'NAMZU_EXIT=3010').host })).toEqual({
			outcome: 'restart-required',
		})
	})

	it('reports an administrator who declined the prompt as cancelled', async () => {
		const { host, calls } = setup(async () => 'NAMZU_EXIT=1223')
		expect(await run({ ...both(), host })).toEqual({ outcome: 'cancelled' })
		expect(calls.map((call) => call.binary.split('\\').pop())).toEqual([
			'powershell.exe',
			'whoami.exe',
		])
		expect(calls[1]?.args).toEqual(['/groups', '/fo', 'csv', '/nh'])
	})

	it('reports a standard user who did not get an administrator to approve as needs-administrator', async () => {
		const { host } = setup(async () => 'NAMZU_EXIT=1223', STANDARD_USER)
		expect(await run({ ...both(), host })).toEqual({
			outcome: 'needs-administrator',
		})
		const failedLaunch = setup(async () => 'NAMZU_LAUNCH_FAILED', STANDARD_USER)
		expect(await run({ ...both(), host: failedLaunch.host })).toEqual({
			outcome: 'needs-administrator',
		})
	})

	it('does not ask whoami when the elevated steps ran', async () => {
		const { host, calls } = setup(async () => 'NAMZU_EXIT=21', STANDARD_USER)
		await run({ ...both(), host })
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
			expect(await run({ ...both(), host })).toEqual({
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
		expect(await run({ ...both(), host })).toEqual({
			outcome: 'failed',
			step: 'enable-windows-features',
			code: 'feature-enable-failed',
			exitCode: 1603,
		})
	})

	it('maps install failures and a digest mismatch to wsl-install-failed', async () => {
		for (const code of [21, 22]) {
			const { host } = setup(async () => `NAMZU_EXIT=${code}`)
			expect(await run({ ...both(), host })).toMatchObject({
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
		await run({ ...both(), host, onProgress })
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
		const pending = run({ ...both(), host, onProgress: watched })
		await hasStarted
		const file = progressFile()
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

	it('ignores a progress file of another run', async () => {
		const other = join(directory, 'Temp', `namzu-wsl-${'f'.repeat(32)}`)
		await mkdir(other, { recursive: true })
		await writeFile(
			join(other, 'elevated-progress.jsonl'),
			'{"step":"install-wsl","phase":"failed","exitCode":1603}\n',
		)
		const { host } = setup(async () => 'NAMZU_EXIT=20')
		expect(await run({ ...both(), host })).toMatchObject({ exitCode: 20 })
	})

	it('launches the real Windows PowerShell with a clean environment whatever the host environment says', async () => {
		const { calls, host } = setup(async () => 'NAMZU_EXIT=0')
		const hostile = {
			...host,
			env: {
				SystemRoot: 'C:\\Users\\evil',
				windir: 'D:\\evil',
				Path: 'C:\\evil',
				PSModulePath: 'C:\\evil\\modules',
				KEEP: 'yes',
			},
		} as unknown as WslcSetupHost
		const outcome = await runElevatedWslcSteps({ ...both(), host: hostile })
		expect(outcome).toEqual({ outcome: 'ok' })
		expect(calls[0]?.binary).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
		expect(calls[0]?.env).toEqual({
			SystemRoot: 'C:\\Windows',
			windir: 'C:\\Windows',
			PATH: 'C:\\Windows\\System32',
		})
		const standard = await runElevatedWslcSteps({
			...both(),
			host: setup(async () => 'NAMZU_EXIT=1223', STANDARD_USER).host,
		})
		expect(standard).toEqual({ outcome: 'needs-administrator' })
	})

	it('forwards only an allow-list of environment variables to the launcher', async () => {
		const { calls, host } = setup(async () => 'NAMZU_EXIT=0')
		const loaded = {
			...host,
			env: {
				COR_ENABLE_PROFILING: '1',
				COR_PROFILER: '{evil}',
				COR_PROFILER_PATH: 'C:\\evil\\p.dll',
				CORECLR_ENABLE_PROFILING: '1',
				COMPLUS_Version: 'v1.0',
				DOTNET_STARTUP_HOOKS: 'C:\\evil\\h.dll',
				DOTNET_gcServer: '1',
				__COMPAT_LAYER: 'RunAsInvoker',
				PATHEXT: '.EVIL;.EXE',
				PSModulePath: 'C:\\evil',
				USERPROFILE: 'C:\\Users\\Ali',
				APPDATA: 'C:\\Users\\Ali\\AppData\\Roaming',
				PROCESSOR_ARCHITECTURE: 'AMD64',
				'ProgramFiles(x86)': 'C:\\Program Files (x86)',
				TEMP: 'C:\\Users\\Ali\\AppData\\Local\\Temp',
				TMP: 'D:\\evil',
			},
		} as unknown as WslcSetupHost
		await runElevatedWslcSteps({ ...both(), host: loaded })
		expect(calls[0]?.env).toEqual({
			USERPROFILE: 'C:\\Users\\Ali',
			APPDATA: 'C:\\Users\\Ali\\AppData\\Roaming',
			PROCESSOR_ARCHITECTURE: 'AMD64',
			'ProgramFiles(x86)': 'C:\\Program Files (x86)',
			TEMP: 'C:\\Users\\Ali\\AppData\\Local\\Temp',
			SystemRoot: 'C:\\Windows',
			windir: 'C:\\Windows',
			PATH: 'C:\\Windows\\System32',
		})
	})

	it('does not call a failed launch a standard user unless whoami shows one', async () => {
		for (const answer of ['', 'garbage', 'ERROR: Access is denied']) {
			const { host } = setup(async () => 'NAMZU_LAUNCH_FAILED', answer)
			const outcome = await runElevatedWslcSteps({ ...both(), host })
			expect(outcome).toMatchObject({ outcome: 'failed', code: 'elevation-failed' })
		}
		const { host } = setup(async () => 'NAMZU_LAUNCH_FAILED', STANDARD_USER)
		expect(await runElevatedWslcSteps({ ...both(), host })).toEqual({
			outcome: 'needs-administrator',
		})
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
		const pending = run({ ...both(), host, signal: controller.signal })
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
			run({
				steps: ['install-wsl'],
				wslPackage: { path: 'C:\\x.msi', sha256: SHA },
				host,
			}),
		).rejects.toThrow()
		expect(calls).toEqual([])
	})
})
