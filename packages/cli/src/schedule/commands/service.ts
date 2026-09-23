/**
 * `schedule install | uninstall | status | start | stop | daemon | __fire`.
 */

import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { CommandContext } from '../../commands/types.js'
import { loadBootstrapConfigWithProvenance } from '../../config/load.js'
import { EXIT_NO_CONFIG, EXIT_OK, EXIT_UNAVAILABLE, EXIT_USAGE } from '../../exit-codes.js'
import {
	selectDesktopBackend,
	sendDesktopNotification,
} from '../../integrations/notifications/desktop.js'
import { cliLogger, installCliLogging } from '../../logging.js'
import type { TerminationHandling } from '../../termination.js'
import { CLI_VERSION } from '../../version.js'
import {
	ScheduleDaemon,
	installedFingerprint,
	requestStop,
	spawnFireProcess,
	stopRequestPath,
} from '../daemon/daemon.js'
import { callEndpoint, readEndpoint } from '../daemon/endpoint.js'
import { EXIT_STOP_REQUESTED } from '../daemon/exit.js'
import { daemonLogPath, daemonLogSink } from '../daemon/log.js'
import { type FireArgs, parseFireArgs, runFire } from '../fire/fire.js'
import { isFinal, readRunResult, writeRunResult } from '../fire/result.js'
import type { SchedulePaths } from '../paths.js'
import { resumeCommand } from '../resume-command.js'
import { detectPlatform } from '../service/detect.js'
import {
	ServiceRefusal,
	installService,
	serviceState,
	startService,
	stopService,
	uninstallService,
} from '../service/index.js'
import { launchdLabel, launchdPlist } from '../service/launchd.js'
import { type ServicePlatform, readManifest } from '../service/manifest.js'
import { checkServiceName, defaultServiceName } from '../service/names.js'
import { runCommand } from '../service/runner.js'
import { systemdUnit, systemdUserAvailable } from '../service/systemd.js'
import { taskXml } from '../service/windows-task.js'
import { wslTaskDefinition } from '../service/wsl.js'
import { listJobs } from '../store/jobs.js'
import { readState } from '../store/state.js'
import { flag, has, parseArgs, parseMs, pathsFor } from './args.js'

const PLATFORMS: readonly string[] = [
	'auto',
	'systemd-user',
	'launchd',
	'windows-task',
	'wsl-windows-task',
]

/** The CLI entry point this code was loaded from, as the service will start it. */
export function installedBin(): string {
	const here = dirname(fileURLToPath(import.meta.url))
	const candidate = join(here, '..', '..', 'bin.js')
	try {
		return realpathSync(candidate)
	} catch {
		return realpathSync(process.argv[1] ?? candidate)
	}
}

function program(paths: SchedulePaths) {
	return { node: realpathSync(process.execPath), bin: installedBin(), namzuHome: paths.home }
}

export async function installCommand(
	ctx: CommandContext,
	argv: readonly string[],
): Promise<number> {
	const args = parseArgs(argv, ['home', 'platform', 'name', 'at-boot!', 'dry-run!'])
	const platformFlag = flag(args, 'platform') ?? 'auto'
	if (args.unknown.length > 0 || !PLATFORMS.includes(platformFlag)) {
		ctx.formatter.error({
			message: `usage: namzu schedule install [--platform ${PLATFORMS.join('|')}] [--name <n>] [--at-boot] [--dry-run]`,
		})
		return EXIT_USAGE
	}
	const paths = pathsFor(args)
	let platform: ServicePlatform
	if (platformFlag === 'auto') {
		const detected = detectPlatform({
			systemdUser: await systemdUserAvailable({ run: runCommand }),
		})
		if (!detected.platform) {
			ctx.formatter.error({ message: detected.reason })
			return EXIT_UNAVAILABLE
		}
		platform = detected.platform
	} else platform = platformFlag as ServicePlatform
	const name = checkServiceName(flag(args, 'name') ?? defaultServiceName(paths.home))
	const prog = program(paths)
	if (has(args, 'dry-run')) {
		let text: string
		switch (platform) {
			case 'systemd-user':
				text = systemdUnit(prog)
				break
			case 'launchd':
				text = launchdPlist(launchdLabel(name), prog)
				break
			case 'windows-task':
				text = taskXml({
					userId: 'DOMAIN\\user',
					description: 'namzu scheduler',
					command: 'C:\\Windows\\System32\\conhost.exe',
					args: ['--headless', prog.node, prog.bin, 'schedule', 'daemon', '--home', prog.namzuHome],
				})
				break
			case 'wsl-windows-task':
				text = taskXml(
					wslTaskDefinition({
						userId: 'DOMAIN\\user',
						distro: process.env.WSL_DISTRO_NAME ?? 'distro',
						linuxUser: process.env.USER ?? 'user',
						...prog,
					}),
				)
				break
		}
		ctx.formatter.print({ text, platform, name })
		return EXIT_OK
	}
	const existing = readManifest(paths)
	if (existing && existing.name !== name && existing.platform !== platform) {
		ctx.formatter.error({
			message: `a scheduler service (${existing.name}, ${existing.platform}) is already installed for this home; uninstall it first`,
		})
		return 1
	}
	try {
		requestStop(paths, false)
		const { manifest, problems, notes } = await installService(
			{ paths, run: runCommand, env: process.env, version: CLI_VERSION },
			{ platform, name, program: prog, atBoot: has(args, 'at-boot') },
		)
		for (const note of notes) ctx.formatter.info(note)
		if (problems.length > 0) {
			ctx.formatter.error({ message: `installed with problems:\n${problems.join('\n')}` })
			return 1
		}
		ctx.formatter.print({
			text: `Installed ${manifest.name} (${manifest.platform}). Check it with \`namzu schedule status\`.`,
			platform: manifest.platform,
			name: manifest.name,
		})
		return EXIT_OK
	} catch (error) {
		ctx.formatter.error({ message: error instanceof Error ? error.message : String(error) })
		return error instanceof ServiceRefusal ? EXIT_UNAVAILABLE : 1
	}
}

/** Runs still working: started, and without a final result of their own yet. */
function runsInFlight(paths: SchedulePaths): number {
	let n = 0
	for (const job of listJobs(paths).jobs) {
		const run = readState(paths, job.id).activeRun
		if (run?.status === 'running' && !isFinal(readRunResult(paths, job.id, run.runId))) n++
	}
	return n
}

export async function uninstallCommand(
	ctx: CommandContext,
	argv: readonly string[],
): Promise<number> {
	const args = parseArgs(argv, ['home', 'keep-data!', 'purge-data!', 'wait', 'interrupt-runs!'])
	if (args.unknown.length > 0 || (has(args, 'keep-data') && has(args, 'purge-data'))) {
		ctx.formatter.error({
			message:
				'usage: namzu schedule uninstall [--keep-data | --purge-data] [--wait 10m | --interrupt-runs]',
		})
		return EXIT_USAGE
	}
	const paths = pathsFor(args)
	const manifest = readManifest(paths)
	const endpoint = readEndpoint(paths.endpoint)
	requestStop(paths, true)
	if (endpoint) await callEndpoint(endpoint, 'stop')
	if (manifest)
		await stopService({ paths, run: runCommand, env: process.env, version: CLI_VERSION }, manifest)
	if (!has(args, 'interrupt-runs')) {
		const waitMs = parseMs('--wait', flag(args, 'wait')) ?? 10 * 60_000
		const deadline = Date.now() + waitMs
		while (runsInFlight(paths) > 0 && Date.now() < deadline) {
			ctx.formatter.info(`waiting for ${runsInFlight(paths)} run(s) in progress to finish…`)
			await new Promise((r) => setTimeout(r, 5_000))
		}
	}
	const inFlight = runsInFlight(paths)
	if (inFlight > 0)
		ctx.formatter.info(`${inFlight} run(s) are still in progress; they finish on their own.`)
	const { problems } = await uninstallService({
		paths,
		run: runCommand,
		env: process.env,
		version: CLI_VERSION,
	})
	if (problems.length > 0) {
		ctx.formatter.error({ message: `could not remove everything:\n${problems.join('\n')}` })
		return 1
	}
	if (has(args, 'purge-data')) rmSync(paths.root, { recursive: true, force: true })
	ctx.formatter.print({
		text: manifest
			? `Removed ${manifest.name}.${has(args, 'purge-data') ? ' Scheduler data deleted.' : ' Jobs and history are kept.'}`
			: `No scheduler service was installed for ${paths.home}.${has(args, 'purge-data') ? ' Scheduler data deleted.' : ''}`,
	})
	return EXIT_OK
}

interface Heartbeat {
	readonly at: string
	readonly pid: number
	readonly epoch: string
	readonly version: string
	readonly standby: boolean
	readonly runsInFlight: number
	readonly notifications: string
}

function readHeartbeat(paths: SchedulePaths): Heartbeat | undefined {
	try {
		return JSON.parse(readFileSync(paths.heartbeat, 'utf8')) as Heartbeat
	} catch {
		return undefined
	}
}

/** The backend the daemon reported, `kind: detail`, live or from its heartbeat. */
function daemonNotifications(
	heartbeat: Heartbeat | undefined,
	live: Record<string, unknown> | undefined,
): { kind: string; detail: string } | undefined {
	const reported =
		typeof live?.notifications === 'string' ? live.notifications : heartbeat?.notifications
	if (!reported || reported === 'unknown') return undefined
	const at = reported.indexOf(': ')
	return at < 0
		? { kind: reported, detail: '' }
		: { kind: reported.slice(0, at), detail: reported.slice(at + 2) }
}

export async function statusCommand(ctx: CommandContext, argv: readonly string[]): Promise<number> {
	const args = parseArgs(argv, ['home', 'json!'])
	if (args.unknown.length > 0) {
		ctx.formatter.error({ message: `unknown option: ${args.unknown.join(', ')}` })
		return EXIT_USAGE
	}
	const paths = pathsFor(args)
	const manifest = readManifest(paths)
	const heartbeat = readHeartbeat(paths)
	const endpoint = readEndpoint(paths.endpoint)
	const live = endpoint ? await callEndpoint(endpoint, 'status') : undefined
	const age = heartbeat ? Date.now() - Date.parse(heartbeat.at) : undefined
	const supervisor = manifest
		? await serviceState(
				{ paths, run: runCommand, env: process.env, version: CLI_VERSION },
				manifest,
			)
		: 'not installed'
	const jobs = listJobs(paths).jobs
	// What the daemon picked, from its own heartbeat: this shell's environment
	// is not the service's (under systemd in WSL it has no WSL_INTEROP), so a
	// backend computed here named one the daemon was not using.
	const backend = daemonNotifications(heartbeat, live) ?? {
		...selectDesktopBackend(
			manifest?.windows?.powershell ? { powershell: manifest.windows.powershell } : {},
		),
		guessed: true,
	}
	const pathProblems: string[] = []
	if (manifest) {
		for (const [label, path] of [
			['node', manifest.nodePath],
			['namzu', manifest.binPath],
		] as const) {
			try {
				realpathSync(path)
			} catch {
				pathProblems.push(`${label} ${path} no longer exists; run namzu schedule install again`)
			}
		}
		if (manifest.cliVersion !== CLI_VERSION)
			pathProblems.push(
				`installed by namzu ${manifest.cliVersion}, this is ${CLI_VERSION}; the daemon restarts on the new code by itself`,
			)
	}
	const healthy = Boolean(live) || (age !== undefined && age < 90_000)
	// Runs waiting for the operator, each with the command that answers it:
	// conversations are stored per folder, so the command carries the folder.
	const awaitingApproval = jobs.flatMap((job) => {
		const run = readState(paths, job.id).activeRun
		return run?.status === 'awaiting-approval' && run.sessionId
			? [
					{
						job: job.name,
						sessionId: run.sessionId,
						resumeCommand: resumeCommand(job, run.sessionId),
					},
				]
			: []
	})
	const payload = {
		v: 1,
		installed: Boolean(manifest),
		platform: manifest?.platform ?? null,
		name: manifest?.name ?? null,
		supervisor,
		daemon: live
			? { responding: true, ...live }
			: heartbeat
				? {
						responding: false,
						lastSeen: heartbeat.at,
						standby: heartbeat.standby,
						pid: heartbeat.pid,
						version: heartbeat.version,
					}
				: null,
		notifications: `${backend.kind} (${backend.detail})${'guessed' in backend ? ' — the daemon has not reported, so this is what this shell would pick' : ''}`,
		jobs: { total: jobs.length, active: jobs.filter((j) => j.state === 'active').length },
		runsInFlight: runsInFlight(paths),
		awaitingApproval,
		problems: pathProblems,
		log: daemonLogPath(paths.daemonLog),
	}
	if (has(args, 'json') || ctx.formatter.name !== 'text') {
		ctx.formatter.print(ctx.formatter.name === 'text' ? JSON.stringify(payload, null, 2) : payload)
	} else {
		ctx.formatter.print(
			[
				`Service        ${manifest ? `${manifest.name} (${manifest.platform})` : 'not installed — namzu schedule install'}`,
				`Supervisor     ${supervisor}`,
				`Daemon         ${live ? `running, pid ${String(live.pid)}, version ${String(live.version)}${live.standby ? ', on standby' : ''}${live.draining ? ', draining for a restart' : ''}` : heartbeat ? `not answering; last seen ${Math.round((age ?? 0) / 1000)} s ago${heartbeat.standby ? ' (on standby)' : ''}` : 'never started'}`,
				`Notifications  ${backend.kind}${backend.kind === 'none' ? ` — ${backend.detail}` : ''}${'guessed' in backend ? ' (not reported by the daemon yet; this shell would pick it)' : ''}`,
				`Jobs           ${payload.jobs.active} active of ${payload.jobs.total}; ${payload.runsInFlight} run(s) in progress`,
				...awaitingApproval.map(
					(w) => `Waiting        ${w.job} needs your approval: ${w.resumeCommand}`,
				),
				`Log            ${payload.log}`,
				...pathProblems.map((p) => `Warning        ${p}`),
			].join('\n'),
		)
	}
	if (!manifest && !live) return EXIT_NO_CONFIG
	return healthy ? EXIT_OK : EXIT_UNAVAILABLE
}

export async function startStopCommand(
	ctx: CommandContext,
	argv: readonly string[],
	verb: 'start' | 'stop',
): Promise<number> {
	const args = parseArgs(argv, ['home'])
	const paths = pathsFor(args)
	const manifest = readManifest(paths)
	if (!manifest) {
		ctx.formatter.error({
			message: 'no scheduler service is installed for this home; namzu schedule install',
		})
		return EXIT_NO_CONFIG
	}
	const context = { paths, run: runCommand, env: process.env, version: CLI_VERSION }
	// Before the supervisor acts: a standby daemon, or one a Windows task no
	// longer holds, is reached only through this file.
	requestStop(paths, verb === 'stop')
	const problems =
		verb === 'start' ? await startService(context, manifest) : await stopService(context, manifest)
	if (verb === 'stop') {
		const endpoint = readEndpoint(paths.endpoint)
		if (endpoint) await callEndpoint(endpoint, 'stop')
	}
	if (problems.length > 0) {
		ctx.formatter.error({ message: problems.join('\n') })
		return 1
	}
	ctx.formatter.print({
		text:
			verb === 'start'
				? `Started ${manifest.name}.`
				: `Stopped ${manifest.name}; it stays stopped until namzu schedule start.`,
	})
	return EXIT_OK
}

/** `schedule daemon`: run the scheduler in this process until stopped. */
export async function daemonCommand(ctx: CommandContext, argv: readonly string[]): Promise<number> {
	const args = parseArgs(argv, ['home', 'foreground!', 'once-or-exit!'])
	if (args.unknown.length > 0) {
		ctx.formatter.error({ message: `unknown option: ${args.unknown.join(', ')}` })
		return EXIT_USAGE
	}
	const paths = pathsFor(args)
	// The service names its home with --home; everything this process and its
	// children resolve on their own must agree with it.
	process.env.NAMZU_HOME = paths.home
	const config = (() => {
		try {
			return loadBootstrapConfigWithProvenance({ env: process.env }).config
		} catch {
			return ctx.config
		}
	})()
	installCliLogging(daemonLogSink(paths.daemonLog), 'info')
	const log = cliLogger()
	const manifest = (() => {
		try {
			return readManifest(paths)
		} catch {
			return undefined
		}
	})()
	const backend = selectDesktopBackend(
		manifest?.windows?.powershell ? { powershell: manifest.windows.powershell } : {},
	)
	const bin = installedBin()
	if (existsSync(stopRequestPath(paths))) {
		ctx.formatter.error({
			message: `the scheduler for ${paths.home} was stopped with \`namzu schedule stop\`; \`namzu schedule start\` lets it run again`,
		})
		return EXIT_STOP_REQUESTED
	}
	const daemon = new ScheduleDaemon({
		paths,
		log,
		version: CLI_VERSION,
		epoch: randomUUID(),
		maxConcurrentRuns: config.schedule?.maxConcurrentRuns ?? 2,
		notifications: config.schedule?.notifications ?? true,
		notificationBackend: `${backend.kind}: ${backend.detail}`,
		spawnFire: spawnFireProcess({ node: process.execPath, bin, paths, env: process.env }),
		notify: async (notice) => {
			const result = await sendDesktopNotification(backend, notice)
			if (result.kind !== 'sent') {
				log.warn('scheduled run notification not shown', {
					'namzu.schedule.job_id': notice.jobId,
					'namzu.schedule.notify_result': result.kind,
				})
			}
		},
		fingerprint: installedFingerprint(bin),
		onceOrExit: has(args, 'once-or-exit'),
	})
	const stop = () => daemon.stop()
	process.on('SIGTERM', stop)
	process.on('SIGINT', stop)
	process.on('SIGHUP', stop)
	log.info('scheduler starting', {
		'namzu.schedule.home': paths.home,
		'namzu.schedule.version': CLI_VERSION,
	})
	try {
		const code = await daemon.run()
		if (code === 75) {
			const endpoint = readEndpoint(paths.endpoint)
			ctx.formatter.error({
				message: `another scheduler owns ${paths.home}${endpoint ? ` (pid ${endpoint.pid})` : ''}`,
			})
		}
		return code
	} finally {
		process.removeListener('SIGTERM', stop)
		process.removeListener('SIGINT', stop)
		process.removeListener('SIGHUP', stop)
	}
}

/** `schedule __fire`: one run, started by the daemon. */
export async function fireCommand(
	ctx: CommandContext,
	argv: readonly string[],
	termination?: TerminationHandling,
): Promise<number> {
	const args = parseArgs(argv, [
		'home',
		'job',
		'run',
		'key',
		'revision',
		'trigger',
		'scheduled-for',
		'epoch',
	])
	const parsed = parseFireArgs(argv)
	if ('error' in parsed || args.unknown.length > 0) {
		ctx.formatter.error({
			message: 'error' in parsed ? parsed.error : `unknown option: ${args.unknown.join(', ')}`,
		})
		return EXIT_USAGE
	}
	const paths = pathsFor(args)
	const fire: FireArgs = parsed
	termination?.onTerminate(async (signal) => {
		const current = readRunResult(paths, fire.jobId, fire.runId)
		if (current && current.status === 'running') {
			writeRunResult(paths, {
				...current,
				status: 'interrupted',
				exitCode: 1,
				reason: `stopped by ${signal}`,
				endedAt: new Date().toISOString(),
			})
		}
	})
	return runFire(ctx, paths, fire)
}
