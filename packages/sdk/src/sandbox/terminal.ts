/**
 * A real terminal inside the sandbox, or nothing.
 *
 * `exec` runs a command and hands back what it printed. That is the whole
 * shape of it, and a large class of work does not fit: an interactive
 * installer waiting on a prompt, a REPL, `git rebase -i`, anything that
 * draws with escape codes, anything that asks for a password. Every one of
 * those needs a pseudo-terminal, and a pipe is not one.
 *
 * **The refusal is the design.** A pseudo-terminal needs a native binding
 * this kernel deliberately does not depend on — it would make every install
 * build C++ for a capability most runs never use. So the terminal is
 * optional, and where it is unavailable it is REFUSED rather than
 * substituted with a pipe. A pipe would work: `spawn` would run, bytes
 * would flow, and every program that calls `isatty` would take its
 * non-interactive branch. The prompt never appears, the REPL exits
 * immediately, the progress bar prints ten thousand lines, and nothing says
 * why. That is the same rule `Sandbox.setNetworkPolicy` states for itself:
 * a capability accepted and not applied is worse than one never offered,
 * because the caller stops looking.
 */

export interface TerminalSize {
	readonly cols: number
	readonly rows: number
}

export interface OpenTerminalOptions {
	/** The program to run. Defaults to the sandbox's own shell. */
	readonly command?: string
	readonly args?: readonly string[]
	readonly cwd?: string
	readonly env?: Readonly<Record<string, string>>
	/**
	 * The initial size.
	 *
	 * Required rather than defaulted, because a program that draws to the
	 * screen asks the terminal how big it is before it draws anything, and a
	 * default that is wrong produces a first frame nobody can read. A caller
	 * with no window to measure passes its own choice, deliberately.
	 */
	readonly size: TerminalSize
}

export interface TerminalSession {
	/** Send keystrokes. Bytes, not lines — the program decides what a line is. */
	write(data: string): void
	/**
	 * Tell the program the window changed.
	 *
	 * A separate call rather than a settable property, because it has to
	 * reach the child as SIGWINCH: a program redraws on the signal, not on
	 * our bookkeeping.
	 */
	resize(size: TerminalSize): void
	/** Everything the program printed, as it arrives. Returns an unsubscribe. */
	onData(listener: (chunk: string) => void): () => void
	/** Resolves when the program exits. */
	readonly exited: Promise<{ exitCode: number; signal?: number }>
	/** Stop it. */
	kill(signal?: string): void
}

/** A terminal asked for where none can be provided. */
export class TerminalUnavailableError extends Error {
	readonly details: { specifier: string; reason: 'absent' | 'broken'; cause?: string }

	constructor(details: { specifier: string; reason: 'absent' | 'broken'; cause?: string }) {
		super(
			details.reason === 'absent'
				? `No pseudo-terminal is available: "${details.specifier}" is not installed. Install it to use a terminal session, or use exec() — which is not a terminal and does not pretend to be.`
				: `A pseudo-terminal is installed but unusable: "${details.specifier}" failed to load (${details.cause ?? 'no detail'}). This is usually a native build that does not match this Node version.`,
		)
		this.name = 'TerminalUnavailableError'
		this.details = details
	}
}

/**
 * The binding this looks for.
 *
 * Named rather than searched for: probing several candidates would make the
 * capability's behaviour depend on which one happened to be installed, and
 * a refusal that could not say what to install is a refusal nobody can act
 * on.
 */
export const PTY_SPECIFIER = 'node-pty'

/** The slice of the binding this uses. Structural, so a test needs no native build. */
export interface PtyModule {
	spawn(
		file: string,
		args: readonly string[],
		options: {
			name?: string
			cols: number
			rows: number
			cwd?: string
			env?: Record<string, string>
		},
	): PtyProcess
}

export interface PtyProcess {
	write(data: string): void
	resize(cols: number, rows: number): void
	onData(listener: (data: string) => void): { dispose(): void }
	onExit(listener: (event: { exitCode: number; signal?: number }) => void): { dispose(): void }
	kill(signal?: string): void
}

export type PtyLoader = () => Promise<PtyModule>

/**
 * Load the binding, or say precisely why not.
 *
 * The two failures are kept apart because the fixes are different: `absent`
 * is "install it", `broken` is almost always a native build compiled
 * against a different Node version, and telling somebody to install a thing
 * they already installed is the least useful message available.
 */
export async function loadPty(loader?: PtyLoader): Promise<PtyModule> {
	const load = loader ?? (async () => (await import(PTY_SPECIFIER)) as unknown as PtyModule)
	try {
		const module = await load()
		if (typeof module?.spawn !== 'function') {
			throw new Error('the module has no spawn()')
		}
		return module
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err)
		// A resolution failure and a load failure look different in the
		// message, and that is the only signal available — the import throws
		// the same class either way.
		const absent = /Cannot find (module|package)|ERR_MODULE_NOT_FOUND/.test(message)
		throw new TerminalUnavailableError({
			specifier: PTY_SPECIFIER,
			reason: absent ? 'absent' : 'broken',
			cause: message,
		})
	}
}

/**
 * Open a terminal, given a loaded binding.
 *
 * Separated from `loadPty` so the refusal and the session are testable
 * apart: one is about a missing dependency, the other about wiring a
 * process that exists.
 */
export function openTerminalWith(
	pty: PtyModule,
	options: OpenTerminalOptions,
	defaults: { readonly shell: string; readonly cwd: string },
): TerminalSession {
	const listeners = new Set<(chunk: string) => void>()

	const child = pty.spawn(options.command ?? defaults.shell, options.args ?? [], {
		// `xterm-256color`, and this is not cosmetic: `TERM` is how a program
		// decides which escape sequences it may emit. Leaving it unset makes
		// well-behaved programs fall back to no colour and no cursor
		// movement, which is a terminal that works and looks broken.
		name: 'xterm-256color',
		cols: options.size.cols,
		rows: options.size.rows,
		cwd: options.cwd ?? defaults.cwd,
		...(options.env ? { env: { ...options.env } } : {}),
	})

	const dataSub = child.onData((chunk) => {
		for (const listener of listeners) listener(chunk)
	})

	const exited = new Promise<{ exitCode: number; signal?: number }>((resolve) => {
		const exitSub = child.onExit((event) => {
			// Unsubscribed on exit, both of them. A binding that holds a
			// listener for a dead process keeps this session's closure alive
			// for as long as the binding lives, and a long-running host opens
			// many of these.
			dataSub.dispose()
			exitSub.dispose()
			listeners.clear()
			resolve(event)
		})
	})

	return {
		write: (data) => child.write(data),
		resize: (size) => child.resize(size.cols, size.rows),
		onData(listener) {
			listeners.add(listener)
			return () => listeners.delete(listener)
		},
		exited,
		kill: (signal) => child.kill(signal),
	}
}
