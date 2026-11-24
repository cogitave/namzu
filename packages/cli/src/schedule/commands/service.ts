/**
 * `schedule service install | uninstall | status | start | stop | daemon | __fire`.
 */

import { randomUUID } from 'node:crypto'
import {
	existsSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
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
import { type SchedulePaths, schedulePaths } from '../paths.js'
import { parkedRunWords, resumeCommand } from '../resume-command.js'
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
import { writeManifest } from '../service/manifest.js'
import {
	filesMentioning,
	nearestExisting,
	rewriteJobPaths,
	sameFileSystem,
	scratchRootOf,
} from '../service/move.js'
import { checkServiceName, defaultServiceName } from '../service/names.js'
import {
	defaultNamzuHome,
	displayName,
	findService,
	legacyBaseName,
	matchService,
	nameClash,
	readServiceIndexChecked,
	recordService,
	removeServices,
	serviceHomePath,
	servicesRoot,
} from '../service/registry.js'
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
	// A retired spelling: one line naming the new one, and nothing runs.
	if (argv.some((a) => a === '--name' || a.startsWith('--name='))) {
		ctx.formatter.error({
			message:
				'`--name <n>` is now the word right after install: `namzu schedule service install <n>`, which keeps the service in the Namzu folder.',
		})
		return EXIT_USAGE
	}
	const args = parseArgs(argv, ['home', 'platform', 'at-boot!', 'dry-run!'])
	const platformFlag = flag(args, 'platform') ?? 'auto'
	if (args.unknown.length > 0 || args.positionals.length > 1 || !PLATFORMS.includes(platformFlag)) {
		ctx.formatter.error({
			message: `usage: namzu schedule service install [<name>] [--platform ${PLATFORMS.join('|')}] [--home <dir>] [--at-boot] [--dry-run]`,
		})
		return EXIT_USAGE
	}
	const named = args.positionals[0]
	if (named !== undefined) {
		try {
			checkServiceName(named)
		} catch (error) {
			ctx.formatter.error({ message: error instanceof Error ? error.message : String(error) })
			return EXIT_USAGE
		}
	}
	// A named service lives in the Namzu folder unless the person chose a home;
	// without a name it is the current home's own scheduler, as before.
	const paths =
		named !== undefined && flag(args, 'home') === undefined
			? schedulePaths(serviceHomePath(named))
			: pathsFor(args)
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
	const name = checkServiceName(named ?? defaultServiceName(paths.home))
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
					args: [
						'--headless',
						prog.node,
						prog.bin,
						'schedule',
						'service',
						'daemon',
						'--home',
						prog.namzuHome,
					],
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
		ctx.formatter.print({ text, platform, name, home: paths.home })
		return EXIT_OK
	}
	const clash = nameClash(name, paths.home)
	if (clash) {
		const there = findService(name)?.home
		const legacy =
			there !== undefined && named !== undefined && resolve(there) !== serviceHomePath(named)
		ctx.formatter.error({
			message: legacy
				? `${clash}; to keep it and bring its home into the Namzu folder: namzu schedule service move ${name}`
				: clash,
		})
		return 1
	}
	if (named !== undefined && flag(args, 'home') === undefined) {
		try {
			mkdirSync(paths.home, { recursive: true, mode: 0o700 })
		} catch (error) {
			ctx.formatter.error({
				message: `the service home ${paths.home} could not be created: ${error instanceof Error ? error.message : String(error)}`,
			})
			return 1
		}
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
		const indexProblem = recordService({
			name: manifest.name,
			home: paths.home,
			platform: manifest.platform,
			installedAt: manifest.installedAt,
		})
		if (indexProblem)
			ctx.formatter.info(`The service is installed but not listed by name: ${indexProblem}.`)
		for (const note of notes) ctx.formatter.info(note)
		if (problems.length > 0) {
			ctx.formatter.error({ message: `installed with problems:\n${problems.join('\n')}` })
			return 1
		}
		ctx.formatter.print({
			text: `Installed ${manifest.name} (${manifest.platform}) for ${paths.home}. Check it with \`namzu schedule service status${named !== undefined ? ` ${named}` : ''}\`.`,
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
	/** The name the command line gave, when it gave one. */
	named?: string,
): Promise<number> {
	const args = parseArgs(argv, ['home', 'keep-data!', 'purge-data!', 'wait', 'interrupt-runs!'])
	if (args.unknown.length > 0 || (has(args, 'keep-data') && has(args, 'purge-data'))) {
		ctx.formatter.error({
			message:
				'usage: namzu schedule service uninstall [--keep-data | --purge-data] [--wait 10m | --interrupt-runs]',
		})
		return EXIT_USAGE
	}
	if (args.positionals.length > 0) {
		ctx.formatter.error({
			message: `unexpected argument: ${args.positionals.join(' ')}; the service name goes right after the verb: namzu schedule service uninstall [<name>] [options]`,
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
	// Best effort and last: a damaged index never undoes the removal above.
	const indexProblem = removeServices(
		[...new Set([manifest?.name, named, defaultServiceName(paths.home)])].filter(
			(n): n is string => n !== undefined,
		),
		paths.home,
	)
	if (indexProblem) ctx.formatter.info(`The service index was not updated: ${indexProblem}.`)
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

/** Is this home's daemon answering, or recently seen? The one rule `status` and `list` share. */
async function probeHealth(paths: SchedulePaths) {
	const heartbeat = readHeartbeat(paths)
	const endpoint = readEndpoint(paths.endpoint)
	const live = endpoint ? await callEndpoint(endpoint, 'status') : undefined
	const age = heartbeat ? Date.now() - Date.parse(heartbeat.at) : undefined
	const healthy = Boolean(live) || (age !== undefined && age < 90_000)
	return { heartbeat, live, age, healthy }
}

export async function statusCommand(ctx: CommandContext, argv: readonly string[]): Promise<number> {
	const args = parseArgs(argv, ['home', 'json!'])
	if (args.unknown.length > 0) {
		ctx.formatter.error({ message: `unknown option: ${args.unknown.join(', ')}` })
		return EXIT_USAGE
	}
	if (args.positionals.length > 0) {
		ctx.formatter.error({
			message: `unexpected argument: ${args.positionals.join(' ')}; the service name goes right after the verb: namzu schedule service status [<name>] [options]`,
		})
		return EXIT_USAGE
	}
	const paths = pathsFor(args)
	const manifest = readManifest(paths)
	const { heartbeat, live, age, healthy } = await probeHealth(paths)
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
				pathProblems.push(
					`${label} ${path} no longer exists; run namzu schedule service install again`,
				)
			}
		}
		if (manifest.cliVersion !== CLI_VERSION)
			pathProblems.push(
				`installed by namzu ${manifest.cliVersion}, this is ${CLI_VERSION}; the daemon restarts on the new code by itself`,
			)
	}
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
						...(run.handoff ? { handoff: { reason: run.handoff.reason } } : {}),
						waitingFor: parkedRunWords(run),
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
				`Service        ${manifest ? `${manifest.name} (${manifest.platform})` : 'not installed — namzu schedule service install'}`,
				`Supervisor     ${supervisor}`,
				`Daemon         ${live ? `running, pid ${String(live.pid)}, version ${String(live.version)}${live.standby ? ', on standby' : ''}${live.draining ? ', draining for a restart' : ''}` : heartbeat ? `not answering; last seen ${Math.round((age ?? 0) / 1000)} s ago${heartbeat.standby ? ' (on standby)' : ''}` : 'never started'}`,
				`Notifications  ${backend.kind}${backend.kind === 'none' ? ` — ${backend.detail}` : ''}${'guessed' in backend ? ' (not reported by the daemon yet; this shell would pick it)' : ''}`,
				`Jobs           ${payload.jobs.active} active of ${payload.jobs.total}; ${payload.runsInFlight} run(s) in progress`,
				...awaitingApproval.map((w) =>
					w.handoff
						? `Waiting        ${w.job} ${w.waitingFor}; when that is done: ${w.resumeCommand}`
						: `Waiting        ${w.job} needs your approval: ${w.resumeCommand}`,
				),
				`Log            ${payload.log}`,
				...pathProblems.map((p) => `Warning        ${p}`),
			].join('\n'),
		)
	}
	if (!manifest && !live) return EXIT_NO_CONFIG
	return healthy ? EXIT_OK : EXIT_UNAVAILABLE
}

/** `schedule service list`: every indexed service with its live state; a gone home is `missing`. */
export async function listCommand(ctx: CommandContext, argv: readonly string[]): Promise<number> {
	const args = parseArgs(argv, ['json!'])
	if (args.unknown.length > 0 || args.positionals.length > 0) {
		ctx.formatter.error({ message: 'usage: namzu schedule service list [--json]' })
		return EXIT_USAGE
	}
	const index = readServiceIndexChecked()
	const rows = []
	for (const entry of index.services) {
		const paths = schedulePaths(entry.home)
		let state: 'running' | 'not running' | 'not installed' | 'missing'
		try {
			if (!existsSync(entry.home)) state = 'missing'
			else if (!readManifest(paths)) state = 'not installed'
			else state = (await probeHealth(paths)).healthy ? 'running' : 'not running'
		} catch {
			state = 'missing'
		}
		rows.push({ name: displayName(entry), home: entry.home, platform: entry.platform, state })
	}
	if (has(args, 'json') || ctx.formatter.name !== 'text') {
		const payload = { v: 1, services: rows, ...(index.problem ? { error: index.problem } : {}) }
		ctx.formatter.print(ctx.formatter.name === 'text' ? JSON.stringify(payload, null, 2) : payload)
	} else if (index.problem) {
		ctx.formatter.error({ message: index.problem })
		return 1
	} else if (rows.length === 0) {
		ctx.formatter.print('No scheduler service is installed; namzu schedule service install')
	} else {
		const width = Math.max(...rows.map((r) => r.name.length))
		ctx.formatter.print(
			rows
				.map((r) => `${r.name.padEnd(width)}  ${r.state.padEnd(13)}  ${r.platform}  ${r.home}`)
				.join('\n'),
		)
	}
	return EXIT_OK
}

export async function startStopCommand(
	ctx: CommandContext,
	argv: readonly string[],
	verb: 'start' | 'stop',
): Promise<number> {
	const args = parseArgs(argv, ['home'])
	if (args.unknown.length > 0) {
		ctx.formatter.error({ message: `unknown option: ${args.unknown.join(', ')}` })
		return EXIT_USAGE
	}
	if (args.positionals.length > 0) {
		ctx.formatter.error({
			message: `unexpected argument: ${args.positionals.join(' ')}; the service name goes right after the verb: namzu schedule service ${verb} [<name>] [options]`,
		})
		return EXIT_USAGE
	}
	const paths = pathsFor(args)
	const manifest = readManifest(paths)
	if (!manifest) {
		ctx.formatter.error({
			message: 'no scheduler service is installed for this home; namzu schedule service install',
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
				: `Stopped ${manifest.name}; it stays stopped until namzu schedule service start.`,
	})
	return EXIT_OK
}

/** `schedule service daemon`: run the scheduler in this process until stopped. */
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
			message: `the scheduler for ${paths.home} was stopped with \`namzu schedule service stop\`; \`namzu schedule service start\` lets it run again`,
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

/**
 * `schedule service move <name>`: bring the service's home to
 * `<default home>/services/<name>`. See `../service/move.ts` for what inside
 * the home follows it.
 */
export async function moveCommand(
	ctx: CommandContext,
	argv: readonly string[],
	/** The name the command line gave. */
	named: string | undefined,
): Promise<number> {
	const args = parseArgs(argv, ['wait', 'dry-run!'])
	if (args.unknown.length > 0 || args.positionals.length > 0 || named === undefined) {
		ctx.formatter.error({
			message: 'usage: namzu schedule service move <name> [--dry-run] [--wait 10m]',
		})
		return EXIT_USAGE
	}
	const index = readServiceIndexChecked()
	const entry = matchService(index.services, named)
	if (!entry) {
		ctx.formatter.error({
			message: index.problem
				? `cannot look up ${named}: ${index.problem}`
				: `no scheduler service is named ${named}; see namzu schedule service list`,
		})
		return index.problem ? 1 : EXIT_USAGE
	}
	const refuse = (message: string): number => {
		ctx.formatter.error({ message })
		return 1
	}
	if (legacyBaseName(entry) !== undefined)
		return refuse(
			`${entry.name} was registered by an older namzu under a distro-suffixed name; uninstall it and install it again by name: namzu schedule service uninstall ${displayName(entry)}, then namzu schedule service install ${displayName(entry)}`,
		)
	let name: string
	try {
		name = checkServiceName(entry.name)
	} catch (error) {
		return refuse(
			`the service index holds a name that is not a service name (${error instanceof Error ? error.message : String(error)}); nothing was changed`,
		)
	}
	const from = resolve(entry.home)
	const to = serviceHomePath(name)
	const inside = resolve(servicesRoot())
	if (dirname(resolve(to)) !== inside)
		return refuse(`${name} would land outside ${inside}; nothing was changed`)
	if (from === to) {
		ctx.formatter.print({
			text: `${name} is already in the Namzu folder (${to}); nothing to move.`,
		})
		return EXIT_OK
	}
	const main = defaultNamzuHome()
	if (from === main || main.startsWith(`${from}/`) || main.startsWith(`${from}\\`))
		return refuse(
			`${name} serves ${from}, which is the Namzu home itself or contains it; it is not moved`,
		)
	if (to.startsWith(`${from}/`) || to.startsWith(`${from}\\`))
		return refuse(`${name} serves ${from}, which contains ${to}; it is not moved`)
	if (!existsSync(from) || !statSync(from).isDirectory())
		return refuse(`${name} serves ${from}, which does not exist; there is nothing to move`)
	if (existsSync(to))
		return refuse(`${to} already exists; move or remove it first, nothing was changed`)
	const scratchFrom = scratchRootOf(from)
	const scratchTo = scratchRootOf(to)
	const hasScratch = existsSync(scratchFrom)
	if (hasScratch && existsSync(scratchTo))
		return refuse(`${scratchTo} already exists; move or remove it first, nothing was changed`)
	for (const [source, target] of [
		[from, to],
		...(hasScratch ? [[scratchFrom, scratchTo] as const] : []),
	] as const) {
		if (!sameFileSystem(source, target))
			return refuse(
				`${source} and ${nearestExisting(target)} are on different file systems, and a move there would copy and delete; stop the service (namzu schedule service stop ${name}), move the folder by hand to ${target} and then run namzu schedule service install ${name}`,
			)
	}
	const paths = schedulePaths(from)
	const manifest = readManifest(paths)
	if (!manifest)
		return refuse(
			`no scheduler service is installed in ${from}; namzu schedule service install ${name} installs one in the Namzu folder`,
		)
	const inFlight = runsInFlight(paths)
	const jobs = listJobs(paths).jobs
	const plan = [
		`Move ${name} (${manifest.platform})`,
		`  home      ${from}`,
		`        to  ${to}`,
		...(hasScratch ? [`  scratch   ${scratchFrom}`, `        to  ${scratchTo}`] : []),
		`  jobs      ${jobs.length} (${jobs.filter((j) => j.workspace === 'none').length} with a scratch folder that is rewritten and needs confirming again)`,
		'  then      reinstall the service unit for the new home; start it again if it was running',
	]
	if (has(args, 'dry-run')) {
		ctx.formatter.print({
			text: [
				...plan,
				...(inFlight > 0
					? [
							`  blocked   ${inFlight} run(s) in progress; a real move waits for them (--wait) or refuses`,
						]
					: []),
				'Nothing was changed.',
			].join('\n'),
		})
		return EXIT_OK
	}
	const context = { paths, run: runCommand, env: process.env, version: CLI_VERSION }
	const wasRunning = (await probeHealth(paths)).healthy
	const restart = async (): Promise<void> => {
		requestStop(paths, !wasRunning)
		if (wasRunning) await startService(context, manifest)
	}
	// Stop the daemon first; a run already started finishes on its own (the
	// unit leaves runs alone), and a move waits for it or refuses.
	requestStop(paths, true)
	const endpoint = readEndpoint(paths.endpoint)
	if (endpoint) await callEndpoint(endpoint, 'stop')
	await stopService(context, manifest)
	const waitMs = parseMs('--wait', flag(args, 'wait')) ?? 0
	const deadline = Date.now() + waitMs
	while (runsInFlight(paths) > 0 && Date.now() < deadline) {
		ctx.formatter.info(`waiting for ${runsInFlight(paths)} run(s) in progress to finish…`)
		await new Promise((r) => setTimeout(r, 5_000))
	}
	const still = runsInFlight(paths)
	if (still > 0) {
		await restart()
		return refuse(
			`${still} run(s) of ${name} are in progress, and their files would move under them; wait for them to finish (namzu schedule service status ${name}) or pass --wait 10m. Nothing was changed.`,
		)
	}
	const indexBefore = {
		name,
		home: from,
		platform: manifest.platform,
		installedAt: manifest.installedAt,
	}
	// Re-check right before the rename: a run started since the first look
	// (by hand, or from another process) would have its files move under it.
	if (runsInFlight(paths) > 0) {
		await restart()
		return refuse(
			`a run of ${name} started while the move was being prepared; wait for it to finish and run the move again. Nothing was changed.`,
		)
	}
	const putBack = (): void => {
		try {
			if (hasScratch && existsSync(scratchTo) && !existsSync(scratchFrom))
				renameSync(scratchTo, scratchFrom)
		} catch {}
		try {
			if (existsSync(to) && !existsSync(from)) renameSync(to, from)
		} catch {}
	}
	try {
		mkdirSync(servicesRoot(), { recursive: true, mode: 0o700 })
		renameSync(from, to)
		if (hasScratch) renameSync(scratchFrom, scratchTo)
	} catch (error) {
		putBack()
		await restart()
		return refuse(
			`the folder could not be moved: ${error instanceof Error ? error.message : String(error)}. Nothing was changed.`,
		)
	}
	const moved = schedulePaths(to)
	const problems: string[] = []
	// The index and the manifest are the point of no return: if either cannot
	// be written, the folder goes back and the old unit still serves it.
	const indexProblem = recordService({ ...indexBefore, home: to })
	let manifestProblem: string | undefined
	if (!indexProblem) {
		try {
			writeManifest(moved, { ...manifest, namzuHome: to })
		} catch (error) {
			manifestProblem = error instanceof Error ? error.message : String(error)
			recordService(indexBefore)
		}
	}
	if (indexProblem || manifestProblem) {
		putBack()
		await restart()
		return refuse(
			`the move was undone, ${name} is back in ${from}: ${indexProblem ? `the service index was not updated (${indexProblem})` : `the service manifest was not written (${manifestProblem})`}.`,
		)
	}
	const notes: string[] = []
	const rewrite = rewriteJobPaths(moved, from, to)
	problems.push(...rewrite.problems)
	// A daemon started by the reinstall exits at once when the stop request is
	// still there: leave it for a service that was stopped, clear it otherwise.
	requestStop(moved, !wasRunning)
	try {
		const reinstalled = await installService(
			{ paths: moved, run: runCommand, env: process.env, version: CLI_VERSION },
			{
				platform: manifest.platform,
				name,
				program: program(moved),
				atBoot: manifest.enabledLinger === true,
			},
		)
		// `enabledLinger` and the first install time say what this service did, not this move.
		writeManifest(moved, {
			...reinstalled.manifest,
			installedAt: manifest.installedAt,
			...(manifest.enabledLinger !== undefined ? { enabledLinger: manifest.enabledLinger } : {}),
		})
		problems.push(...reinstalled.problems)
		if (!wasRunning) await stopService({ ...context, paths: moved }, reinstalled.manifest)
	} catch (error) {
		problems.push(error instanceof Error ? error.message : String(error))
	}
	const mentions = filesMentioning(to, from)
	const lines = [
		`Moved ${name}: ${from} -> ${to}`,
		...(hasScratch ? [`Scratch folders: ${scratchFrom} -> ${scratchTo}`] : []),
		`Service unit reinstalled for the new home; ${wasRunning ? 'it is running again' : 'it was stopped, and stays stopped'}.`,
		rewrite.rewritten.length > 0
			? `Rewritten to the new scratch folder: ${rewrite.rewritten.join(', ')}.`
			: 'No job file needed rewriting.',
		...(rewrite.needConfirming.length > 0
			? [
					`Confirm again (their confirmation covers the old scratch folder): ${rewrite.needConfirming.join(', ')}. Use namzu schedule confirm <job> --service ${name}.`,
				]
			: []),
		rewrite.stillConfirmed.length > 0
			? `Confirmations still hold for ${rewrite.stillConfirmed.length} job(s): their folders are outside the home.`
			: rewrite.needConfirming.length === 0
				? 'No confirmed job was affected.'
				: 'No other confirmed job.',
		...(mentions.length > 0
			? [`Still names the old home (not rewritten): ${mentions.join(', ')}.`]
			: []),
		'daemon.env and the other files that may hold secrets moved with the folder unread.',
	]
	for (const note of notes) ctx.formatter.info(note)
	ctx.formatter.print({ text: lines.join('\n') })
	if (problems.length > 0) {
		ctx.formatter.error({
			message: `the folder moved, but not everything followed:\n${problems.join('\n')}\nRun namzu schedule service install ${name} to finish.`,
		})
		return 1
	}
	return EXIT_OK
}
