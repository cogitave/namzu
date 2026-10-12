import { mkdir, readFile, rm } from 'node:fs/promises'
import { posix, win32 } from 'node:path'
import type {
	RunElevatedWslcSteps,
	WslcElevatedOutcome,
	WslcSetupHost,
	WslcSetupProgress,
} from './contract.js'

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
	cancelled: 1223,
} as const

type ElevatedStep = 'enable-windows-features' | 'install-wsl'

const ELEVATED_STEPS: readonly ElevatedStep[] = ['enable-windows-features', 'install-wsl']
const STANDARD_ADMIN_GROUP_SID = 'S-1-5-32-544'
const WINDOWS_11_FIRST_BUILD = 22000
const POLL_MS = 250
/** Windows refuses a command line longer than 32,767 characters. */
const MAX_COMMAND_LINE = 30000
const PROGRESS_FILE = 'elevated-progress.jsonl'
const MSI_LOG_FILE = 'wsl-install.log'

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
	/** The script that runs elevated. */
	readonly inner: string
	/** The script the non-elevated launcher runs; it starts `inner`. */
	readonly launcher: string
	/** `powershell.exe` arguments that run the launcher. */
	readonly launcherArgs: readonly string[]
	readonly progressFile: string
	readonly isWindows11: boolean
}

/**
 * Validate a request and build both scripts. Exported for tests; the public
 * entry point is {@link runElevatedWslcSteps}. Throws on any request that
 * could put a foreign value into a script.
 */
export function buildElevatedScripts(request: Request): ElevatedScripts {
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
	const progressFile = api.join(stateDirectory, PROGRESS_FILE)
	const msiLog = api.join(stateDirectory, MSI_LOG_FILE)

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
		installBlock = installBlockFor(path, sha256.toLowerCase(), msiLog)
	} else if (wslPackage !== undefined) {
		throw new Error('A WSL package was given but install-wsl was not requested.')
	}

	const inner = innerScript({
		progressFile,
		enable: wanted.has('enable-windows-features'),
		install: wanted.has('install-wsl'),
		isWindows11,
		installBlock,
	})
	const innerEncoded = encodeCommand(inner)
	const launcher = launcherScript(innerEncoded)
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

function installBlockFor(msi: string, sha256: string, msiLog: string): string {
	return [
		"$cur = 'install-wsl'",
		"Note $cur 'started'",
		`$src = ${psLiteral(msi)}`,
		`$want = ${psLiteral(sha256)}`,
		`$msilog = ${psLiteral(msiLog)}`,
		// The package is copied into a folder only administrators can write, then
		// hashed and installed from there, so nothing can swap it after the check.
		"$dir = Join-Path $env:SystemRoot ('Temp\\namzu-wsl-' + [guid]::NewGuid().ToString('N'))",
		'try {',
		'  $acl = New-Object Security.AccessControl.DirectorySecurity',
		'  $acl.SetAccessRuleProtection($true, $false)',
		"  foreach ($sid in 'S-1-5-32-544', 'S-1-5-18') {",
		'    $id = New-Object Security.Principal.SecurityIdentifier $sid',
		"    $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($id, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')))",
		'  }',
		'  (New-Object IO.DirectoryInfo $dir).Create($acl)',
		"  $msi = Join-Path $dir 'wsl.msi'",
		'  Copy-Item -LiteralPath $src -Destination $msi',
		'  $got = (Get-FileHash -LiteralPath $msi -Algorithm SHA256).Hash',
		'  if ($got -ine $want) {',
		"    Note $cur 'failed' @{ exitCode = 22 }",
		`    $code = ${ELEVATED_EXIT.packageMismatch}`,
		'  } else {',
		"    $args2 = @('/i', ('\"' + $msi + '\"'), '/qn', '/norestart', '/l*v', ('\"' + $msilog + '\"'))",
		"    $p = Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\\msiexec.exe') -ArgumentList $args2 -Wait -PassThru",
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
		'  Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction SilentlyContinue',
		'}',
	].join('\n')
}

function innerScript(parts: {
	progressFile: string
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
		`$log = ${psLiteral(parts.progressFile)}`,
		'function Note($step, $phase, $extra) {',
		'  $o = [ordered]@{ step = $step; phase = $phase }',
		'  if ($extra) { foreach ($k in $extra.Keys) { $o[$k] = $extra[$k] } }',
		'  $line = (ConvertTo-Json -InputObject $o -Compress) + "`n"',
		'  [IO.File]::AppendAllText($log, $line, (New-Object Text.UTF8Encoding $false))',
		'}',
		'$code = 0',
		'$restart = $false',
		"$cur = ''",
		'try {',
	]
	if (parts.enable) {
		lines.push(
			"  $cur = 'enable-windows-features'",
			"  Note $cur 'started'",
			'  $dismRestart = $false',
			`  foreach ($name in @(${features.join(', ')})) {`,
			'    & (Join-Path $env:SystemRoot \'System32\\dism.exe\') /online /enable-feature "/featurename:$name" /all /norestart | Out-Null',
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
		`  if ($cur -eq 'install-wsl') { $code = ${ELEVATED_EXIT.installWslFailed} } else { $code = ${ELEVATED_EXIT.enableFeaturesFailed} }`,
		"  try { Note $cur 'failed' @{ exitCode = 1 } } catch {}",
		'}',
		`if ($code -eq 0 -and $restart) { $code = ${ELEVATED_EXIT.restartRequired} }`,
		'exit $code',
	)
	return lines.join('\n')
}

function launcherScript(innerEncoded: string): string {
	return [
		"$ErrorActionPreference = 'Stop'",
		'try {',
		"  $ps = Join-Path $env:SystemRoot 'System32\\WindowsPowerShell\\v1.0\\powershell.exe'",
		`  $a = @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', ${psLiteral(innerEncoded)})`,
		'  $p = Start-Process -FilePath $ps -ArgumentList $a -Verb RunAs -Wait -PassThru -WindowStyle Hidden',
		"  Write-Output ('NAMZU_EXIT=' + $p.ExitCode)",
		'} catch {',
		'  $e = $_.Exception',
		'  $n = $null',
		'  while ($e -ne $null -and $n -eq $null) {',
		'    if ($e -is [ComponentModel.Win32Exception]) { $n = $e.NativeErrorCode } else { $e = $e.InnerException }',
		'  }',
		`  if ($n -eq ${ELEVATED_EXIT.cancelled}) { Write-Output 'NAMZU_EXIT=${ELEVATED_EXIT.cancelled}'; exit 0 }`,
		"  Write-Output 'NAMZU_LAUNCH_FAILED'",
		'}',
	].join('\n')
}

/** What `whoami /groups` lists for an account: an administrator, even with a filtered token, has the group. */
export function isAdministratorAccount(whoamiGroupsOutput: string): boolean {
	return whoamiGroupsOutput.includes(STANDARD_ADMIN_GROUP_SID)
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

export const runElevatedWslcSteps: RunElevatedWslcSteps = async (request) => {
	const { host, signal, onProgress } = request
	const scripts = buildElevatedScripts(request)
	const steps = request.steps as readonly ElevatedStep[]
	signal?.throwIfAborted()

	await mkdir(host.stateDirectory, { recursive: true })
	await rm(scripts.progressFile, { force: true })

	const powershell = `${(host.env.SystemRoot ?? host.env.windir ?? 'C:\\Windows').replace(/[\\/]+$/, '')}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
	const tail = new ProgressTail(scripts.progressFile, onProgress)

	type Settled = { ok: true; output: string } | { ok: false }
	let finished = false
	const launched: Promise<Settled> = host.runner
		.run(powershell, scripts.launcherArgs, { signal })
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
		const standard = await isStandardUser(host, signal)
		if (standard) return { outcome: 'needs-administrator' }
		return mapped === 'cancelled' ? { outcome: 'cancelled' } : failed()
	}
	return mapped
}

async function isStandardUser(host: WslcSetupHost, signal?: AbortSignal): Promise<boolean> {
	const root = (host.env.SystemRoot ?? host.env.windir ?? 'C:\\Windows').replace(/[\\/]+$/, '')
	try {
		const output = await host.runner.run(
			`${root}\\System32\\whoami.exe`,
			['/groups', '/fo', 'csv', '/nh'],
			{
				signal,
			},
		)
		return !isAdministratorAccount(output)
	} catch {
		return false
	}
}
