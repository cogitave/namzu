import { type SpawnOptions, execFile, spawn } from 'node:child_process'
import { watch } from 'node:fs'
import { ExtensionHost, type HostOptions } from '../host.js'
import type { EngineLocation } from '../signin/launcher.js'
import { runnerDir } from '../signin/launcher.js'
import { type RegistrarOptions, createRegistrar, reconcileSignin } from '../signin/reconcile.js'
import { type CtlResponse, type CtlServer, ctlRequest, startCtlServer } from './ctl.js'
import { acquireRunnerLock, liveRunner, releaseRunnerLock, runnerLockPath } from './lock.js'
import { RunnerLog } from './log.js'
import { type RunnerStartPlan, planRunnerStart, queryTaskExistsArgs } from './start.js'

/**
 * The runner: Namzu's own headless supervisor, one per user. It is the same `ExtensionHost` as in the app
 * (signature and hash check at each start, licence check, consent check, clean environment, limits, audit,
 * no orphans) with three differences: it detaches, it supervises only extensions that are enabled with
 * their background switch on, and the sign-in entry can start it. It is never the extension's own file
 * that the system starts: the system starts Namzu's launcher, which starts this.
 */

export const IDLE_EXIT_MS = 60_000
export const TICK_MS = 30_000

export interface DaemonOptions {
	readonly home: string
	readonly hostVersion: string
	readonly engine: EngineLocation
	readonly env?: NodeJS.ProcessEnv
	readonly platform?: NodeJS.Platform
	readonly now?: () => number
	readonly hostOptions?: Partial<HostOptions>
	readonly registrar?: RegistrarOptions['exec']
	readonly idleMs?: number
	readonly tickMs?: number
	/** Called once the runner has stopped, with the exit code. */
	readonly onExit?: (code: number) => void
}

export type DaemonHandle =
	| { running: false; reason: 'already-running'; pid: number }
	| {
			running: true
			host: ExtensionHost
			ctl: CtlServer
			/** Stop the runner: the extensions it runs shut down cleanly first. */
			stop(reason?: 'stop' | 'idle'): Promise<void>
			/** Re-read the state files now (the runner also does at every tick). */
			reload(): void
	  }

export async function runDaemon(o: DaemonOptions): Promise<DaemonHandle> {
	const env = o.env ?? process.env
	const platform = o.platform ?? process.platform
	const now = o.now ?? Date.now
	const root = `${o.home}/extensions`
	const log = new RunnerLog(root, now)
	const existing = liveRunner(root)
	if (existing && existing.pid !== process.pid)
		return { running: false, reason: 'already-running', pid: existing.pid }
	if (!acquireRunnerLock(root, now()))
		return { running: false, reason: 'already-running', pid: liveRunner(root)?.pid ?? 0 }

	const registrar = createRegistrar({
		platform,
		extensionsRoot: root,
		env,
		...(o.registrar ? { exec: o.registrar } : {}),
	})
	const host = new ExtensionHost({
		home: o.home,
		hostVersion: o.hostVersion,
		kind: 'daemon',
		env,
		platform,
		now,
		signin: async (wanted) => {
			const s = await reconcileSignin({
				registrar,
				extensionsRoot: root,
				engine: o.engine,
				platform,
				wanted,
				log: (e, d) => log.write(e as never, d),
			})
			return s
		},
		...o.hostOptions,
	})
	let stopped = false
	let idleTimer: ReturnType<typeof setTimeout> | undefined
	const tick: { checker?: ReturnType<typeof setInterval> } = {}

	const stop = async (reason: 'stop' | 'idle' = 'stop'): Promise<void> => {
		if (stopped) return
		stopped = true
		if (idleTimer) clearTimeout(idleTimer)
		idleTimer = undefined
		if (tick.checker) clearInterval(tick.checker)
		await host.stopSupervision()
		await ctl.close()
		releaseRunnerLock(root)
		log.write(reason === 'idle' ? 'runner-idle-exit' : 'runner-stop')
		o.onExit?.(0)
	}

	/** Exit when nothing needs the runner for a minute: no empty runner lingers. */
	const checkIdle = (): void => {
		if (stopped) return
		const busy = host.backgroundIds().length > 0
		if (busy) {
			if (idleTimer) clearTimeout(idleTimer)
			idleTimer = undefined
			return
		}
		if (idleTimer) return
		idleTimer = setTimeout(() => void stop('idle'), o.idleMs ?? IDLE_EXIT_MS)
		idleTimer.unref?.()
	}
	const reload = (): void => {
		host.tick()
		log.write('reconcile', `${host.backgroundIds().length} extensions`)
		checkIdle()
	}

	const status = (): CtlResponse => ({
		ok: true,
		pid: process.pid,
		since: now(),
		extensions: host.backgroundIds().map((id) => {
			const v = host.view(id)
			return { id, state: v.state, running: v.running }
		}),
	})
	const ctl = await startCtlServer(
		root,
		{
			// The answer comes after every stop this reload began has finished, so a caller that is about to
			// delete an extension's files knows its process is gone.
			reload: async () => {
				reload()
				await host.settled()
				return { ok: true }
			},
			status,
			stop: () => {
				void stop('stop')
				return { ok: true }
			},
			restart: (id) => ({ ok: host.restartExtension(id) }),
		},
		platform,
	)
	log.write('runner-start', `pid ${process.pid}`)
	host.startSupervision(o.tickMs ?? TICK_MS)
	// A tick also decides whether the runner is still needed.
	tick.checker = setInterval(checkIdle, o.tickMs ?? TICK_MS)
	tick.checker.unref?.()
	void host.reconcile()
	checkIdle()
	return { running: true, host, ctl, stop, reload }
}

export interface EnsureOptions {
	readonly root: string
	readonly engine: EngineLocation
	readonly env?: NodeJS.ProcessEnv
	/** Start `daemon run` detached; replaced by tests. */
	readonly spawnDetached?: (
		exe: string,
		args: string[],
		opts: SpawnOptions,
	) => { onExit(cb: () => void): void }
	/** How long to wait for the runner to take its lock. Real time only on the failure path. */
	readonly waitMs?: number
	readonly platform?: NodeJS.Platform
	/** Runs a program and says how it ended; replaced by tests, which never run `schtasks`. */
	readonly exec?: (file: string, args: readonly string[]) => Promise<number>
}

const runExec = (file: string, args: readonly string[]): Promise<number> =>
	new Promise((resolve) => {
		execFile(file, [...args], { windowsHide: true }, (err) =>
			resolve(err ? ((err as { code?: number }).code ?? 1) || 1 : 0),
		)
	})

function startDetached(
	o: EnsureOptions,
	plan: Extract<RunnerStartPlan, { kind: 'detached' }>,
): { onExit(cb: () => void): void } {
	const run =
		o.spawnDetached ??
		((exe, args, opts) => {
			const c = spawn(exe, args, opts)
			c.unref()
			return { onExit: (cb) => void c.once('exit', cb) }
		})
	const child = run(plan.file, [...plan.args], plan.options)
	// `cmd start` ends at once by design, with the runner already handed to the system: its exit says
	// nothing, so only the lock (or the timer) decides.
	return plan.verbatim ? { onExit: () => {} } : child
}

/**
 * Make sure the one runner is running, and resolve to whether it is: a live lock means attach; otherwise
 * start it detached and wait for its lock (watching the runner folder, not sleeping in a loop).
 */
export async function ensureRunner(o: EnsureOptions): Promise<boolean> {
	if (liveRunner(o.root)) return true
	const platform = o.platform ?? process.platform
	const exec = o.exec ?? runExec
	const taskExists = platform === 'win32' && (await exec('schtasks', queryTaskExistsArgs())) === 0
	const env = { ...(o.env ?? process.env), ...o.engine.env }
	const plan = planRunnerStart({
		platform,
		taskExists,
		exe: o.engine.exe,
		args: [...o.engine.args, 'extension', 'daemon', 'run'],
		env,
	})
	if (!plan) return false
	let child: { onExit(cb: () => void): void }
	if (plan.kind === 'task') {
		// Task Scheduler starts the launcher, so the runner is its child and never Namzu's. When the task
		// cannot be run, start the runner the other way rather than leave the person without it.
		if ((await exec(plan.file, plan.args)) === 0) {
			child = { onExit: () => {} }
		} else {
			const fallback = planRunnerStart({
				platform,
				taskExists: false,
				exe: o.engine.exe,
				args: [...o.engine.args, 'extension', 'daemon', 'run'],
				env,
			})
			if (!fallback || fallback.kind !== 'detached') return false
			child = startDetached(o, fallback)
		}
	} else child = startDetached(o, plan)
	return new Promise<boolean>((resolve) => {
		let done = false
		const finish = (ok: boolean): void => {
			if (done) return
			done = true
			watcher?.close()
			clearTimeout(timer)
			resolve(ok)
		}
		const check = (): void => {
			if (liveRunner(o.root)) finish(true)
		}
		let watcher: ReturnType<typeof watch> | undefined
		try {
			watcher = watch(runnerDir(o.root), check)
		} catch {
			// the folder is made by the runner itself: the exit event and the timer still end the wait
		}
		child.onExit(() => {
			// Exited at once: either another runner won the race (then it is live) or it could not start.
			setImmediate(() => finish(liveRunner(o.root) !== undefined))
		})
		const timer = setTimeout(() => finish(liveRunner(o.root) !== undefined), o.waitMs ?? 10_000)
		check()
	})
}

/** Ask a running runner to stop, and say whether anything answered. */
export async function stopRunner(root: string): Promise<boolean> {
	const r = await ctlRequest(root, { op: 'stop' })
	return r?.ok === true
}

export { runnerLockPath }
