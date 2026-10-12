import { randomBytes } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import { posix, win32 } from 'node:path'
import type {
	RunElevatedWslcSteps,
	WslcElevatedOutcome,
	WslcSetupHost,
	WslcSetupProgress,
} from './contract.js'
import { trustedWindowsDirectory } from './windows-folder.js'

/**
 * The one elevated process of a setup plan.
 *
 * Windows PowerShell (a Microsoft-signed program, so the Windows prompt names
 * Microsoft rather than an unknown publisher) is started with
 * `Start-Process -Verb RunAs` and runs a FIXED script handed over with
 * `-EncodedCommand`. There is no script file anyone could edit between the
 * prompt and the run. Values reach the script only as single-quoted PowerShell
 * literals, after being validated here. Inside, only Microsoft tools run:
 * dism.exe, msiexec.exe and Get-FileHash.
 *
 * Exit codes of the elevated script: 0 ok, 3010 restart required,
 * 20 enabling Windows features failed, 21 installing the WSL package failed,
 * 22 the package did not match the pinned digest. The launcher (a second,
 * non-elevated PowerShell) prints `NAMZU_EXIT=<code>` with the child's exit
 * code, 1223 when the person declined the prompt, or `NAMZU_LAUNCH_FAILED`,
 * and exits 0 itself: the command runner keeps no output from a process that
 * exits nonzero, so the code travels on stdout.
 *
 * The elevated child cannot be stopped from here. Aborting the signal stops
 * waiting and stops reading progress; if the person already approved, the
 * elevated steps run to the end.
 */

export const ELEVATED_EXIT = {
	ok: 0,
	restartRequired: 3010,
	enableFeaturesFailed: 20,
	installWslFailed: 21,
	packageMismatch: 22,
	folderFailed: 23,
	cancelled: 1223,
} as const

type ElevatedStep = 'enable-windows-features' | 'install-wsl'

const ELEVATED_STEPS: readonly ElevatedStep[] = ['enable-windows-features', 'install-wsl']
const STANDARD_ADMIN_GROUP_SID = 'S-1-5-32-544'
const WINDOWS_11_FIRST_BUILD = 22000
const POLL_MS = 250
/** Windows refuses a command line longer than 32,767 characters. */
const MAX_COMMAND_LINE = 30000
/** Write, append, delete, delete-children, attribute and extended-attribute writes, change permissions, take ownership. */
const WRITE_RIGHTS_MASK = 0xd0156
const PROGRESS_FILE = 'elevated-progress.jsonl'

type Request = Parameters<RunElevatedWslcSteps>[0]
type PathApi = typeof win32

/** Quotes, line breaks and control characters, including PowerShell's typographic quotes. */
const FORBIDDEN_QUOTES = /['"\u2018\u2019\u201A\u201B\u201C\u201D\u201E]/

function hasControlCharacter(value: string): boolean {
	for (let i = 0; i < value.length; i++) {
		const code = value.charCodeAt(i)
		if (code < 0x20 || code === 0x7f) return true
	}
	return false
}

function usesWindowsPaths(directory: string): boolean {
	return /^[A-Za-z]:[\\/]/.test(directory)
}

function psLiteral(value: string): string {
	return `'${value.replace(/'/g, "''")}'`
}

function checkLiteralPath(label: string, value: string): void {
	if (FORBIDDEN_QUOTES.test(value) || hasControlCharacter(value)) {
		throw new Error(`${label} contains a quote, a line break or a control character.`)
	}
}

function inside(api: PathApi, directory: string, candidate: string): boolean {
	const fold = (value: string) => (api === win32 ? value.toLowerCase() : value)
	const relative = api.relative(fold(api.resolve(directory)), fold(api.resolve(candidate)))
	return relative !== '' && !relative.startsWith('..') && !api.isAbsolute(relative)
}

export interface ElevatedScripts {
	/** The script that runs elevated (the user's SID is filled in by the launcher). */
	readonly inner: string
	/** The script the non-elevated launcher runs; it starts `inner`. */
	readonly launcher: string
	/** `powershell.exe` arguments that run the launcher. */
	readonly launcherArgs: readonly string[]
	/** Where the elevated process writes progress, under the protected folder. */
	readonly progressFile: string
	readonly isWindows11: boolean
}

export interface ElevatedBuildOptions {
	/** 32 hex characters naming the protected folder; random per run. */
	readonly runId?: string
	/** The Windows folder as the host reports it, used only to locate the progress file. */
	readonly windowsDirectory?: string
}

const RUN_ID = /^[0-9a-f]{32}$/
const USER_SID_PLACEHOLDER = '@@USER_SID@@'
/** The encoded elevated script must stay well under what ShellExecute accepts for a RunAs launch. */
const MAX_INNER_ENCODED = 16000

function joinFor(base: string, ...parts: string[]): string {
	return (usesWindowsPaths(base) ? win32 : posix).join(base, ...parts)
}

/**
 * Validate a request and build both scripts. Exported for tests; the public
 * entry point is {@link runElevatedWslcSteps}. Throws on any request that
 * could put a foreign value into a script.
 */
export function buildElevatedScripts(
	request: Request,
	options: ElevatedBuildOptions = {},
): ElevatedScripts {
	const { steps, wslPackage, host } = request
	if (host.platform !== 'win32') throw new Error('Elevated setup runs only on Windows.')
	if (!Array.isArray(steps) || steps.length === 0) {
		throw new Error('No elevated step was requested.')
	}
	const wanted = new Set<string>(steps)
	if (wanted.size !== steps.length) throw new Error('An elevated step was listed twice.')
	for (const step of steps) {
		if (!ELEVATED_STEPS.includes(step))
			throw new Error(`"${String(step)}" is not an elevated step.`)
	}
	if (
		host.windowsBuild === undefined ||
		!Number.isInteger(host.windowsBuild) ||
		host.windowsBuild < 1
	) {
		throw new Error('The Windows build is unknown.')
	}
	const isWindows11 = host.windowsBuild >= WINDOWS_11_FIRST_BUILD

	const stateDirectory = host.stateDirectory
	const api: PathApi = usesWindowsPaths(stateDirectory) ? win32 : posix
	if (!api.isAbsolute(stateDirectory))
		throw new Error('The setup directory is not an absolute path.')
	checkLiteralPath('The setup directory', stateDirectory)

	const runId = options.runId ?? randomBytes(16).toString('hex')
	if (!RUN_ID.test(runId)) throw new Error('The run id is not 32 hex characters.')
	const windowsDirectory = options.windowsDirectory ?? trustedWindowsDirectory(host.env)
	const progressFile = joinFor(windowsDirectory, 'Temp', `namzu-wsl-${runId}`, PROGRESS_FILE)

	let installBlock = ''
	if (wanted.has('install-wsl')) {
		if (!wslPackage) throw new Error('Installing WSL needs the downloaded package.')
		const { path, sha256 } = wslPackage
		if (!api.isAbsolute(path)) throw new Error('The WSL package path is not absolute.')
		checkLiteralPath('The WSL package path', path)
		if (!path.toLowerCase().endsWith('.msi'))
			throw new Error('The WSL package is not an .msi file.')
		if (path.split(/[\\/]/).some((segment) => segment === '..' || segment === '.')) {
			throw new Error('The WSL package path is not normalised.')
		}
		if (!inside(api, stateDirectory, path)) {
			throw new Error('The WSL package is not inside the setup directory.')
		}
		if (!/^[0-9a-fA-F]{64}$/.test(sha256))
			throw new Error('The WSL package digest is not a SHA-256.')
		installBlock = installBlockFor(path, sha256.toLowerCase())
	} else if (wslPackage !== undefined) {
		throw new Error('A WSL package was given but install-wsl was not requested.')
	}

	const inner = innerScript({
		runId,
		enable: wanted.has('enable-windows-features'),
		install: wanted.has('install-wsl'),
		isWindows11,
		installBlock,
	})
	// A real SID is at most 184 characters; budget for the longest.
	const sample = inner.replace(USER_SID_PLACEHOLDER, 'S-1-5-21'.padEnd(184, '1'))
	if (encodeCommand(sample).length > MAX_INNER_ENCODED) {
		throw new Error('The elevated script is too long.')
	}
	const launcher = launcherScript(inner)
	const launcherArgs = [
		'-NoProfile',
		'-NonInteractive',
		'-ExecutionPolicy',
		'Bypass',
		'-EncodedCommand',
		encodeCommand(launcher),
	]
	if (launcherArgs.join(' ').length > MAX_COMMAND_LINE) {
		throw new Error('The elevated script is too long for one command line.')
	}
	return { inner, launcher, launcherArgs, progressFile, isWindows11 }
}

export function encodeCommand(script: string): string {
	return Buffer.from(script, 'utf16le').toString('base64')
}

function installBlockFor(msi: string, sha256: string): string {
	return [
		"$cur = 'install-wsl'",
		"Note $cur 'started'",
		`$src = ${psLiteral(msi)}`,
		`$want = ${psLiteral(sha256)}`,
		// The package is copied into a folder only administrators can enter, then
		// hashed and installed from there, so nothing can swap it after the check.
		"$pkg = Join-Path $dir 'pkg'",
		'if (Test-Path -LiteralPath $pkg) { throw "pkg exists" }',
		'try {',
		'  $item = Get-Item -LiteralPath $src -Force',
		'  if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "link" }',
		'  New-Item -ItemType Directory -Path $pkg | Out-Null',
		'  $pacl = New-Object Security.AccessControl.DirectorySecurity',
		'  $pacl.SetAccessRuleProtection($true, $false)',
		'  foreach ($sid in $adminSids) { $pacl.AddAccessRule((Rule $sid "FullControl" "ContainerInherit,ObjectInherit")) }',
		'  Set-Acl -LiteralPath $pkg -AclObject $pacl',
		'  Test-Folder $pkg $false',
		"  $msi = Join-Path $pkg 'wsl.msi'",
		'  Copy-Item -LiteralPath $src -Destination $msi',
		'  $got = (Get-FileHash -LiteralPath $msi -Algorithm SHA256).Hash',
		'  if ($got -ine $want) {',
		"    Note $cur 'failed' @{ exitCode = 22 }",
		`    $code = ${ELEVATED_EXIT.packageMismatch}`,
		'  } else {',
		"    $msilog = Join-Path $dir 'wsl-install.log'",
		'    if (Test-Path -LiteralPath $msilog) { throw "log exists" }',
		"    $args2 = @('/i', ('\"' + $msi + '\"'), '/qn', '/norestart', '/l*v', ('\"' + $msilog + '\"'))",
		"    $p = Start-Process -FilePath (Join-Path $sys 'msiexec.exe') -ArgumentList $args2 -Wait -PassThru",
		'    $c = $p.ExitCode',
		'    if ($c -eq 0) {',
		"      Note $cur 'finished' @{ result = 'ok' }",
		'    } elseif ($c -eq 3010 -or $c -eq 1641) {',
		'      $restart = $true',
		"      Note $cur 'finished' @{ result = 'restart-required' }",
		'    } else {',
		"      Note $cur 'failed' @{ exitCode = $c }",
		`      $code = ${ELEVATED_EXIT.installWslFailed}`,
		'    }',
		'  }',
		'} finally {',
		'  Remove-Item -LiteralPath $pkg -Recurse -Force -ErrorAction SilentlyContinue',
		'}',
	].join('\n')
}

function innerScript(parts: {
	runId: string
	enable: boolean
	install: boolean
	isWindows11: boolean
	installBlock: string
}): string {
	const features = parts.isWindows11
		? ["'VirtualMachinePlatform'"]
		: ["'VirtualMachinePlatform'", "'Microsoft-Windows-Subsystem-Linux'"]
	const lines: string[] = [
		"$ErrorActionPreference = 'Stop'",
		// Tools and modules come from the operating system, never from the environment.
		'$sys = [Environment]::SystemDirectory',
		'$win = [Environment]::GetFolderPath([Environment+SpecialFolder]::Windows)',
		'$env:PATH = $sys',
		"$env:PSModulePath = Join-Path $sys 'WindowsPowerShell\\v1.0\\Modules'",
		`$userSid = '${USER_SID_PLACEHOLDER}'`,
		"$adminSids = @('S-1-5-32-544', 'S-1-5-18')",
		'function Rule($sid, $rights, $inherit) {',
		'  $id = New-Object Security.Principal.SecurityIdentifier $sid',
		"  New-Object Security.AccessControl.FileSystemAccessRule($id, $rights, $inherit, 'None', 'Allow')",
		'}',
		'function Test-Folder($path, $allowUser) {',
		'  $item = Get-Item -LiteralPath $path -Force',
		'  if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw "link" }',
		'  $a = Get-Acl -LiteralPath $path',
		'  $owner = $a.GetOwner([Security.Principal.SecurityIdentifier]).Value',
		'  if ($adminSids -notcontains $owner) { throw "owner" }',
		'  if (-not $a.AreAccessRulesProtected) { throw "inherited" }',
		'  foreach ($r in $a.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {',
		'    $who = $r.IdentityReference.Value',
		'    if ($adminSids -contains $who) { continue }',
		`    if ($allowUser -and $who -eq $userSid -and $r.AccessControlType -eq 'Allow' -and (([int]$r.FileSystemRights -band ${WRITE_RIGHTS_MASK}) -eq 0)) { continue }`,
		'    throw "access"',
		'  }',
		'}',
		'$code = 0',
		'$restart = $false',
		"$cur = ''",
		'$log = $null',
		'function Note($step, $phase, $extra) {',
		'  try {',
		'    $o = [ordered]@{ step = $step; phase = $phase }',
		'    if ($extra) { foreach ($k in $extra.Keys) { $o[$k] = $extra[$k] } }',
		'    $line = (ConvertTo-Json -InputObject $o -Compress) + "`n"',
		'    [IO.File]::AppendAllText($log, $line, (New-Object Text.UTF8Encoding $false))',
		'  } catch {}',
		'}',
		'try {',
		// The folder for progress and logs: new, owned by administrators, readable
		// (not writable) by the person who started setup. Elevated code writes
		// nowhere a standard user can write.
		`  $dir = Join-Path $win ('Temp\\namzu-wsl-${parts.runId}')`,
		// Exclusive creation: New-Item without -Force fails when the name exists,
		// so a folder someone else prepared is never adopted. The ACL is applied
		// and then READ BACK: the owner must be an administrator account, the
		// access list must be protected, and nobody but administrators may hold
		// more than read.
		'  New-Item -ItemType Directory -Path $dir | Out-Null',
		'  $acl = New-Object Security.AccessControl.DirectorySecurity',
		'  $acl.SetAccessRuleProtection($true, $false)',
		'  foreach ($sid in $adminSids) { $acl.AddAccessRule((Rule $sid "FullControl" "ContainerInherit,ObjectInherit")) }',
		'  $acl.AddAccessRule((Rule $userSid "Read" "ContainerInherit,ObjectInherit"))',
		'  Set-Acl -LiteralPath $dir -AclObject $acl',
		'  Test-Folder $dir $true',
		"  $log = Join-Path $dir 'elevated-progress.jsonl'",
		'  if (Test-Path -LiteralPath $log) { throw "log exists" }',
	]
	if (parts.enable) {
		lines.push(
			"  $cur = 'enable-windows-features'",
			"  Note $cur 'started'",
			'  $dismRestart = $false',
			`  foreach ($name in @(${features.join(', ')})) {`,
			'    & (Join-Path $sys \'dism.exe\') /online /enable-feature "/featurename:$name" /all /norestart | Out-Null',
			'    $c = $LASTEXITCODE',
			'    if ($c -eq 3010) { $dismRestart = $true }',
			"    elseif ($c -ne 0) { Note $cur 'failed' @{ exitCode = $c }; $code = " +
				`${ELEVATED_EXIT.enableFeaturesFailed}; break }`,
			'  }',
			'  if ($code -eq 0) {',
			"    if ($dismRestart) { $restart = $true; Note $cur 'finished' @{ result = 'restart-required' } }",
			"    else { Note $cur 'finished' @{ result = 'ok' } }",
			'  }',
		)
	}
	if (parts.install) {
		lines.push(
			`  if ($code -eq 0) {\n${parts.installBlock
				.split('\n')
				.map((line) => `    ${line}`)
				.join('\n')}\n  }`,
		)
	}
	lines.push(
		'} catch {',
		`  if ($cur -eq 'install-wsl') { $code = ${ELEVATED_EXIT.installWslFailed} } elseif ($cur -eq '') { $code = ${ELEVATED_EXIT.folderFailed} } else { $code = ${ELEVATED_EXIT.enableFeaturesFailed} }`,
		"  Note $cur 'failed' @{ exitCode = 1 }",
		'}',
		`if ($code -eq 0 -and $restart) { $code = ${ELEVATED_EXIT.restartRequired} }`,
		'exit $code',
	)
	return lines.join('\n')
}

function launcherScript(inner: string): string {
	return [
		"$ErrorActionPreference = 'Stop'",
		'$sys = [Environment]::SystemDirectory',
		'$env:PATH = $sys',
		"$env:PSModulePath = Join-Path $sys 'WindowsPowerShell\\v1.0\\Modules'",
		'try {',
		"  $ps = Join-Path $sys 'WindowsPowerShell\\v1.0\\powershell.exe'",
		'  $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value',
		`  $inner = ${psLiteral(inner)}.Replace('${USER_SID_PLACEHOLDER}', $sid)`,
		'  $enc = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($inner))',
		'  $psi = New-Object Diagnostics.ProcessStartInfo',
		'  $psi.FileName = $ps',
		"  $psi.Arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ' + $enc",
		"  $psi.Verb = 'runas'",
		'  $psi.UseShellExecute = $true',
		"  $psi.WindowStyle = 'Hidden'",
		// ShellExecute raises a Win32Exception straight from the declined prompt.
		'  $p = [Diagnostics.Process]::Start($psi)',
		'  $p.WaitForExit()',
		"  Write-Output ('NAMZU_EXIT=' + $p.ExitCode)",
		'} catch {',
		'  $e = $_.Exception',
		'  $declined = $false',
		'  while ($e -ne $null) {',
		`    if (($e -is [ComponentModel.Win32Exception] -and $e.NativeErrorCode -eq ${ELEVATED_EXIT.cancelled}) -or $e.Message -match 'cancel+ed by the user') { $declined = $true }`,
		'    $e = $e.InnerException',
		'  }',
		`  if ($declined) { Write-Output 'NAMZU_EXIT=${ELEVATED_EXIT.cancelled}'; exit 0 }`,
		"  Write-Output 'NAMZU_LAUNCH_FAILED'",
		'}',
	].join('\n')
}

/** What `whoami /groups` lists for an account: an administrator, even with a filtered token, has the group. */
export function isAdministratorAccount(whoamiGroupsOutput: string): boolean {
	for (const row of whoamiGroupsOutput.split(/\r?\n/)) {
		const cells = [...row.matchAll(/"((?:[^"]|"")*)"/g)].map((m) => m[1] ?? '')
		if (cells[2] === STANDARD_ADMIN_GROUP_SID) return true
	}
	return false
}

function isGroupListing(output: string): boolean {
	return output.split(/\r?\n/).some((row) => /^"[^"]*","[^"]*","S-1-[0-9-]+",/.test(row))
}

interface ProgressLine {
	readonly step: ElevatedStep
	readonly phase: 'started' | 'finished' | 'failed'
	readonly result?: 'ok' | 'restart-required'
	readonly exitCode?: number
}

export function parseProgressLine(line: string): ProgressLine | undefined {
	let value: unknown
	try {
		value = JSON.parse(line.replace(/^\uFEFF/, ''))
	} catch {
		return undefined
	}
	if (typeof value !== 'object' || value === null) return undefined
	const record = value as Record<string, unknown>
	const step = record.step
	const phase = record.phase
	if (step !== 'enable-windows-features' && step !== 'install-wsl') return undefined
	if (phase !== 'started' && phase !== 'finished' && phase !== 'failed') return undefined
	const result =
		record.result === 'ok' || record.result === 'restart-required' ? record.result : undefined
	const exitCode = typeof record.exitCode === 'number' ? record.exitCode : undefined
	return { step, phase, result, exitCode }
}

/** Map the launcher's answer to an outcome. `standardUser` is only consulted when needed. */
export function mapElevatedExit(
	code: number,
	steps: readonly ElevatedStep[],
	failure: { readonly step?: ElevatedStep; readonly exitCode?: number },
): WslcElevatedOutcome | 'cancelled' {
	switch (code) {
		case ELEVATED_EXIT.ok:
			return { outcome: 'ok' }
		case ELEVATED_EXIT.restartRequired:
			return { outcome: 'restart-required' }
		case ELEVATED_EXIT.cancelled:
			return 'cancelled'
		case ELEVATED_EXIT.enableFeaturesFailed:
			return {
				outcome: 'failed',
				step: 'enable-windows-features',
				code: 'feature-enable-failed',
				exitCode: failure.exitCode ?? code,
			}
		case ELEVATED_EXIT.installWslFailed:
		case ELEVATED_EXIT.packageMismatch:
			return {
				outcome: 'failed',
				step: 'install-wsl',
				code: 'wsl-install-failed',
				exitCode: failure.exitCode ?? code,
			}
		default:
			return {
				outcome: 'failed',
				step: failure.step ?? steps[0] ?? 'enable-windows-features',
				code: 'elevation-failed',
				exitCode: code,
			}
	}
}

function progressEvent(line: ProgressLine): WslcSetupProgress | undefined {
	if (line.phase === 'started') return { step: line.step, phase: 'started' }
	if (line.phase === 'finished' && line.result) {
		return { step: line.step, phase: 'finished', result: line.result }
	}
	return undefined
}

function sleepUnlessSettled(
	ms: number,
	settled: Promise<unknown>,
	signal?: AbortSignal,
): Promise<void> {
	return new Promise((resolve) => {
		const timer = setTimeout(done, ms)
		function done() {
			clearTimeout(timer)
			signal?.removeEventListener('abort', done)
			resolve()
		}
		signal?.addEventListener('abort', done, { once: true })
		settled.then(done, done)
	})
}

class ProgressTail {
	private seen = 0
	readonly failures: ProgressLine[] = []
	constructor(
		private readonly file: string,
		private readonly onProgress?: (progress: WslcSetupProgress) => void,
	) {}

	async poll(): Promise<void> {
		let text: string
		try {
			text = await readFile(this.file, 'utf8')
		} catch {
			return
		}
		const lines = text.split('\n')
		lines.pop() // the last piece is empty or a line still being written
		for (; this.seen < lines.length; this.seen++) {
			const parsed = parseProgressLine(lines[this.seen]?.trim() ?? '')
			if (!parsed) continue
			if (parsed.phase === 'failed') this.failures.push(parsed)
			const event = progressEvent(parsed)
			if (event) this.onProgress?.(event)
		}
	}
}

/**
 * Names the launcher may inherit. Everything else (runtime hooks such as the
 * profiler, startup-hook and compatibility-layer variables, PATHEXT, module
 * paths, anything a caller or a registry value added) is dropped, because the
 * elevated copy of Windows PowerShell inherits what the launcher has.
 * Values set for the person in the registry (`HKCU\Environment`) reach every
 * process they start and cannot be defended against from here.
 */
const LAUNCHER_ENV_ALLOW =
	/^(ComSpec|USERNAME|USERDOMAIN|USERPROFILE|APPDATA|LOCALAPPDATA|ProgramData|ProgramFiles(\(x86\)|W6432)?|CommonProgramFiles(\(x86\)|W6432)?|PROCESSOR_[A-Z]+|NUMBER_OF_PROCESSORS|OS)$/i

function underProfile(profile: string | undefined, value: string): boolean {
	if (!profile || !/^[A-Za-z]:\\/.test(profile)) return false
	const fold = (text: string) => text.replace(/[\\/]+$/, '').toLowerCase()
	return fold(value).startsWith(`${fold(profile)}\\`)
}

function launcherEnvironment(host: WslcSetupHost, windowsDirectory: string): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {}
	let profile: string | undefined
	for (const [name, value] of Object.entries(host.env)) {
		if (/^USERPROFILE$/i.test(name)) profile = value
	}
	for (const [name, value] of Object.entries(host.env)) {
		if (value === undefined) continue
		if (LAUNCHER_ENV_ALLOW.test(name)) env[name] = value
		else if (/^(TEMP|TMP)$/i.test(name) && underProfile(profile, value)) env[name] = value
	}
	return {
		...env,
		SystemRoot: windowsDirectory,
		windir: windowsDirectory,
		PATH: `${windowsDirectory}\\System32`,
	}
}

export const runElevatedWslcSteps: RunElevatedWslcSteps = (request) => runElevatedWith(request, {})

/** {@link runElevatedWslcSteps} with the run id and Windows folder a test pins. */
export async function runElevatedWith(
	request: Request,
	options: ElevatedBuildOptions,
): Promise<WslcElevatedOutcome> {
	const { host, signal, onProgress } = request
	const scripts = buildElevatedScripts(request, options)
	const steps = request.steps as readonly ElevatedStep[]
	signal?.throwIfAborted()

	await mkdir(host.stateDirectory, { recursive: true })

	const windowsDirectory = options.windowsDirectory ?? trustedWindowsDirectory(host.env)
	const powershell = `${windowsDirectory}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
	const tail = new ProgressTail(scripts.progressFile, onProgress)

	type Settled = { ok: true; output: string } | { ok: false }
	let finished = false
	const launched: Promise<Settled> = host.runner
		.run(powershell, scripts.launcherArgs, {
			signal,
			env: launcherEnvironment(host, windowsDirectory),
		})
		.then(
			(output): Settled => ({ ok: true, output }),
			(): Settled => ({ ok: false }),
		)
		.finally(() => {
			finished = true
		})

	while (!finished) {
		await sleepUnlessSettled(POLL_MS, launched, signal)
		if (signal?.aborted) throw signal.reason
		await tail.poll()
	}
	const settled = await launched
	if (signal?.aborted) throw signal.reason
	await tail.poll()

	const lastFailure = tail.failures[tail.failures.length - 1] ?? {}
	const fallbackStep = steps[0] ?? 'enable-windows-features'
	const failed = (exitCode?: number): WslcElevatedOutcome => ({
		outcome: 'failed',
		step: fallbackStep,
		code: 'elevation-failed',
		exitCode,
	})

	let mapped: WslcElevatedOutcome | 'cancelled' | 'launch-failed'
	const match = settled.ok ? /NAMZU_EXIT=(-?\d+)/.exec(settled.output) : null
	if (match?.[1] !== undefined) {
		mapped = mapElevatedExit(Number(match[1]), steps, lastFailure)
	} else {
		mapped = 'launch-failed'
	}

	if (mapped === 'cancelled' || mapped === 'launch-failed') {
		// A standard user who cannot supply an administrator's approval reads
		// differently from an administrator who said no.
		const standard = await isStandardUser(host, windowsDirectory, signal)
		if (standard) return { outcome: 'needs-administrator' }
		return mapped === 'cancelled' ? { outcome: 'cancelled' } : failed()
	}
	return mapped
}

async function isStandardUser(
	host: WslcSetupHost,
	root: string,
	signal?: AbortSignal,
): Promise<boolean> {
	try {
		const output = await host.runner.run(
			`${root}\\System32\\whoami.exe`,
			['/groups', '/fo', 'csv', '/nh'],
			{ signal, env: launcherEnvironment(host, root) },
		)
		// Only a listing that parses and lacks the group shows a standard user;
		// empty or garbled output shows nothing.
		return isGroupListing(output) && !isAdministratorAccount(output)
	} catch {
		// Not knowing is not a reason to tell an administrator they are not one.
		return false
	}
}
