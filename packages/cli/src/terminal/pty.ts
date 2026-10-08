// The default export is the module object itself, which is what the binding's `require` sees and
// the only form whose members can be reassigned; the namespace import is read-only.
import childProcess from 'node:child_process'
import { readFile, readdir } from 'node:fs/promises'
import { basename } from 'node:path'
import { type PtyModule, loadPty } from '@namzu/sdk'

/** What the host uses of a spawned pseudo-terminal. A superset of the kernel's slice. */
export interface HostPty {
	readonly pid: number
	write(data: string): void
	resize(cols: number, rows: number): void
	pause(): void
	resume(): void
	kill(signal?: string): void
	onData(listener: (data: string) => void): { dispose(): void }
	onExit(listener: (event: { exitCode: number; signal?: number }) => void): { dispose(): void }
}

export interface HostPtyModule {
	spawn(
		file: string,
		args: string[],
		options: {
			name: string
			cols: number
			rows: number
			cwd: string
			env: Record<string, string>
			encoding?: string | null
		},
	): HostPty
}

export type HostPtyLoader = () => Promise<HostPtyModule>

/**
 * The binding is optional: it compiles on a machine without prebuilt binaries, and
 * a failed install must leave every other command working. This asks for it by
 * name from this package, because the kernel's own import resolves from the
 * kernel's folder and a strict package layout hides this package's dependency
 * from it.
 */
export async function loadHostPty(loader?: HostPtyLoader): Promise<HostPtyModule> {
	const load: HostPtyLoader =
		loader ??
		(async () => {
			const loaded = (await import('node-pty')) as unknown as {
				default?: HostPtyModule
			} & HostPtyModule
			return typeof loaded.spawn === 'function' ? loaded : (loaded.default as HostPtyModule)
		})
	return (await loadPty(load as unknown as () => Promise<PtyModule>)) as unknown as HostPtyModule
}

/**
 * Stop the binding's Windows kill path from printing to this process's stderr.
 *
 * Killing a console session forks a helper that lists the console's processes, and
 * the helper writes `AttachConsole failed` to the inherited stderr whenever the
 * session is already gone. The parent is unaffected, but stderr is the desktop
 * application's diagnostic channel and the line is noise there. The fork is
 * redone with a piped stderr, for that one helper only.
 */
export function quietConptyHelper(
	cp: Pick<typeof childProcess, 'fork'> = childProcess,
	platform: NodeJS.Platform = process.platform,
): boolean {
	if (platform !== 'win32') return false
	const patched = cp.fork as typeof childProcess.fork & { quiet?: true }
	if (patched.quiet) return true
	const original = cp.fork
	const quiet = ((modulePath: string | URL, ...rest: unknown[]) => {
		if (!String(modulePath).includes('conpty_console_list_agent'))
			return (original as (...args: unknown[]) => childProcess.ChildProcess)(modulePath, ...rest)
		const args = Array.isArray(rest[0]) ? (rest[0] as string[]) : []
		const options = (Array.isArray(rest[0]) ? rest[1] : rest[0]) as
			| childProcess.ForkOptions
			| undefined
		return original(modulePath, args, { ...options, silent: true })
	}) as typeof childProcess.fork & { quiet?: true }
	quiet.quiet = true
	;(cp as { fork: typeof childProcess.fork }).fork = quiet
	return true
}

/** The program a terminal runs when the caller names none. */
export function defaultShell(
	env: NodeJS.ProcessEnv = process.env,
	platform: NodeJS.Platform = process.platform,
): string {
	if (platform === 'win32') return env.ComSpec || 'cmd.exe'
	return env.SHELL || (platform === 'darwin' ? '/bin/zsh' : '/bin/sh')
}

export function defaultTitle(command: string): string {
	const name = basename(command.replaceAll('\\', '/'))
	return name.replace(/\.(exe|cmd|bat)$/iu, '') || command
}

/**
 * The environment a terminal starts with: this process's own, minus what only
 * means something to this process, plus what a terminal program expects.
 *
 * `ELECTRON_RUN_AS_NODE` is how the desktop runs this very host; inherited into a
 * shell it would turn every Electron program started there into a plain Node
 * interpreter. A caller that wants it (to run the bundled CLI) sets it explicitly.
 */
export function buildPtyEnv(
	base: NodeJS.ProcessEnv,
	overrides: Readonly<Record<string, string | null>>,
	platform: NodeJS.Platform = process.platform,
): Record<string, string> {
	const env: Record<string, string> = {}
	for (const [name, value] of Object.entries(base))
		if (value !== undefined && name !== 'ELECTRON_RUN_AS_NODE') env[name] = value
	if (platform !== 'win32') {
		env.TERM = 'xterm-256color'
		env.COLORTERM = 'truecolor'
	}
	for (const [name, value] of Object.entries(overrides)) {
		if (value === null) {
			for (const existing of Object.keys(env))
				if (
					platform === 'win32' ? existing.toLowerCase() === name.toLowerCase() : existing === name
				)
					delete env[existing]
		} else env[name] = value
	}
	return env
}

/**
 * End a program and everything it started.
 *
 * POSIX: the program leads its own session, so its process group is its tree.
 * Windows: the console session's process list is what the binding kills, and a
 * tree kill by the system tool covers any stray descendant.
 */
export function killProcessTree(
	pty: Pick<HostPty, 'pid' | 'kill'>,
	signal: 'SIGHUP' | 'SIGTERM' | 'SIGKILL',
	platform: NodeJS.Platform = process.platform,
	run: (program: string, args: string[]) => void = (program, args) => {
		childProcess.execFile(program, args, { windowsHide: true }, () => undefined)
	},
): void {
	if (platform === 'win32') {
		try {
			pty.kill()
		} catch {
			/* Already gone. */
		}
		if (signal === 'SIGKILL' && pty.pid > 0) {
			const root = process.env.SystemRoot ?? process.env.windir
			run(root ? `${root}\\System32\\taskkill.exe` : 'taskkill', [
				'/pid',
				String(pty.pid),
				'/t',
				'/f',
			])
		}
		return
	}
	if (pty.pid > 0) {
		try {
			process.kill(-pty.pid, signal)
			return
		} catch {
			/* The group is gone or was never ours; fall through to the program itself. */
		}
	}
	try {
		pty.kill(signal)
	} catch {
		/* Already gone. */
	}
}

/**
 * Every process below `root`, by walking parent links. Linux reads `/proc`, one entry at a time so
 * the event loop is never held; elsewhere `ps` lists them. Nothing below a missing pid is found.
 */
export async function descendantsOf(
	root: number,
	platform: NodeJS.Platform = process.platform,
): Promise<number[]> {
	const parents = new Map<number, number>()
	if (platform === 'linux') {
		for (const name of await readdir('/proc').catch(() => [] as string[])) {
			if (!/^\d+$/u.test(name)) continue
			try {
				const stat = await readFile(`/proc/${name}/stat`, 'utf8')
				// The command name may hold spaces and parentheses; the fields start after the last one.
				const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
				parents.set(Number(name), Number(fields[1]))
			} catch {
				/* The process ended while the list was read. */
			}
		}
	} else {
		const output = await new Promise<string>((done) => {
			childProcess.execFile('ps', ['-A', '-o', 'pid=,ppid='], { windowsHide: true }, (_e, out) =>
				done(typeof out === 'string' ? out : ''),
			)
		})
		for (const line of output.split('\n')) {
			const [pid, ppid] = line.trim().split(/\s+/u).map(Number)
			if (Number.isInteger(pid) && Number.isInteger(ppid))
				parents.set(pid as number, ppid as number)
		}
	}
	const found: number[] = []
	const queue = [root]
	while (queue.length > 0) {
		const parent = queue.shift() as number
		for (const [pid, ppid] of parents)
			if (ppid === parent && pid !== root && !found.includes(pid)) {
				found.push(pid)
				queue.push(pid)
			}
	}
	return found
}
