import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { homedir, userInfo } from 'node:os'
import { join } from 'node:path'
import { atomicWrite } from '../store.js'
import { type EngineLocation, runnerDir, writeLauncher } from './launcher.js'
import { LinuxRegistrar, autostartDir } from './linux.js'
import { MacRegistrar } from './macos.js'
import type { Exec, SigninKind, SigninRegistrar } from './registrar.js'
import { WindowsRegistrar } from './windows.js'

/**
 * `reconcileSignin()`: create, repair or remove the one per-user entry so that it exists exactly while at
 * least one extension is enabled with its background switch on. Idempotent; it runs at every host start
 * and after every change of that set. It never re-enables an entry the person switched off in the
 * operating system: it records `disabledByOs` and says so.
 */

export interface RunnerState {
	schema: 1
	signin: { kind?: SigninKind; disabledByOs?: boolean; registered: boolean; reason?: string }
}

const stateFile = (root: string) => join(runnerDir(root), 'state.json')

export function readRunnerState(root: string): RunnerState | undefined {
	try {
		return JSON.parse(readFileSync(stateFile(root), 'utf8')) as RunnerState
	} catch {
		return undefined
	}
}

export const realExec: Exec = (file, args) =>
	new Promise((resolve) => {
		execFile(file, [...args], { windowsHide: true, timeout: 15_000 }, (err, stdout, stderr) => {
			const code = err
				? typeof (err as { code?: unknown }).code === 'number'
					? (err as { code: number }).code
					: 1
				: 0
			resolve({ code, stdout: String(stdout), stderr: String(stderr) })
		})
	})

export interface RegistrarOptions {
	readonly platform: NodeJS.Platform
	readonly extensionsRoot: string
	readonly env: NodeJS.ProcessEnv
	/** Dry mode (`NAMZU_EXT_SIGNIN_DRY=1`): the Windows and macOS registrars write only under `_signin-dry/` and run nothing. */
	readonly dry?: boolean
	readonly exec?: Exec
}

/** A recorder used in dry mode: it runs nothing and appends each command line to `_signin-dry/commands.log`. */
export function dryExec(extensionsRoot: string): Exec {
	return async (file, args) => {
		const dir = join(extensionsRoot, '_signin-dry')
		mkdirSync(dir, { recursive: true, mode: 0o700 })
		const log = join(dir, 'commands.log')
		let cur = ''
		try {
			cur = readFileSync(log, 'utf8')
		} catch {
			// first line
		}
		atomicWrite(log, `${cur}${JSON.stringify([file, ...args])}\n`, 0o600)
		return { code: 0, stdout: '', stderr: '' }
	}
}

export function createRegistrar(o: RegistrarOptions): SigninRegistrar | undefined {
	const dry = o.dry ?? o.env.NAMZU_EXT_SIGNIN_DRY === '1'
	const exec = o.exec ?? (dry ? dryExec(o.extensionsRoot) : realExec)
	const dryDir = join(o.extensionsRoot, '_signin-dry')
	switch (o.platform) {
		case 'win32': {
			const user =
				o.env.USERDOMAIN && o.env.USERNAME
					? `${o.env.USERDOMAIN}\\${o.env.USERNAME}`
					: (o.env.USERNAME ?? userInfo().username)
			if (dry) mkdirSync(dryDir, { recursive: true, mode: 0o700 })
			return new WindowsRegistrar(
				exec,
				join(dry ? dryDir : runnerDir(o.extensionsRoot), 'signin-task.xml'),
				user,
			)
		}
		case 'darwin': {
			const dir = dry
				? join(dryDir, 'LaunchAgents')
				: join(o.env.HOME || homedir(), 'Library', 'LaunchAgents')
			return new MacRegistrar(
				dir,
				typeof process.getuid === 'function' ? process.getuid() : 501,
				exec,
			)
		}
		case 'linux':
			// A desktop session is needed: a server or an ssh login does not start an autostart file.
			return new LinuxRegistrar(
				autostartDir({ XDG_CONFIG_HOME: o.env.XDG_CONFIG_HOME, HOME: o.env.HOME || homedir() }),
			)
		default:
			return undefined
	}
}

export interface ReconcileInput {
	readonly registrar: SigninRegistrar | undefined
	readonly extensionsRoot: string
	readonly engine: EngineLocation
	readonly platform: NodeJS.Platform
	/** At least one extension is enabled with its background switch on. */
	readonly wanted: boolean
	readonly log?: (event: string, detail?: string) => void
}

export async function reconcileSignin(i: ReconcileInput): Promise<RunnerState['signin']> {
	const save = (s: RunnerState['signin']): RunnerState['signin'] => {
		try {
			atomicWrite(
				stateFile(i.extensionsRoot),
				`${JSON.stringify({ schema: 1, signin: s } satisfies RunnerState)}\n`,
				0o600,
			)
		} catch {
			// the state is a convenience for the screens
		}
		return s
	}
	if (!i.registrar)
		return save({ registered: false, reason: 'no sign-in mechanism on this system' })
	if (!i.wanted) {
		const cur = await i.registrar.status()
		if (cur.registered) {
			await i.registrar.unregister()
			i.log?.('signin-removed')
		}
		// The launcher goes with the entry: nothing of Namzu's stays behind once no extension needs it.
		for (const n of [
			'start.cmd',
			'start.vbs',
			'start.sh',
			'engine.cmd',
			'engine.sh',
			'engine.json',
		])
			rmSync(join(runnerDir(i.extensionsRoot), n), { force: true })
		return save({ registered: false })
	}
	const paths = writeLauncher(i.extensionsRoot, i.engine, i.platform)
	const spec = {
		launcher: paths.launcher,
		...(paths.hidden ? { hiddenLauncher: paths.hidden } : {}),
	}
	// Asked with the launcher it should name: an entry an earlier version made (on Windows one that ran
	// `start.cmd`, which opens a console window) is registered again even when no launcher file changed.
	const cur = await i.registrar.status(spec)
	if (cur.registered && cur.disabledByOs) {
		i.log?.('signin-disabled-by-os')
		return save({ registered: true, ...(cur.kind ? { kind: cur.kind } : {}), disabledByOs: true })
	}
	if (cur.registered && !paths.changed && !cur.stale)
		return save({ registered: true, ...(cur.kind ? { kind: cur.kind } : {}) })
	const r = await i.registrar.register(spec)
	if (!r.ok) return save({ registered: false, reason: r.reason })
	i.log?.('signin-registered', r.kind)
	return save({ registered: true, kind: r.kind })
}

/** For an uninstaller: remove the entry and the launcher, never any data. */
export async function removeSigninEverywhere(
	o: RegistrarOptions & { engine?: EngineLocation },
): Promise<void> {
	const reg = createRegistrar(o)
	await reg?.unregister()
	for (const n of ['start.cmd', 'start.vbs', 'start.sh', 'engine.cmd', 'engine.sh', 'engine.json'])
		if (existsSync(join(runnerDir(o.extensionsRoot), n)))
			rmSync(join(runnerDir(o.extensionsRoot), n), { force: true })
}
