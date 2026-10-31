import { type HostPty, type HostPtyModule, killProcessTree } from '../terminal/pty.js'
import { HeadlessScreen } from '../terminal/screen.js'

/** What to run in a session's pseudo-terminal. */
export interface SessionSpec {
	readonly file: string
	readonly args: readonly string[]
	readonly cwd: string
	readonly env: Record<string, string>
}

/**
 * `starting` until the program prints its first byte, `running` after, `exited`
 * once it is gone for any reason. How it ended is `ending`.
 */
export type SessionStatus = 'starting' | 'running' | 'exited'
export type SessionEnding = 'finished' | 'stopped' | 'could-not-start'

const SCROLLBACK = 2000

/**
 * One child program in a pseudo-terminal, with a headless screen that follows
 * what it prints. Everything that touches the pseudo-terminal after the program
 * is gone is a no-op: writing or resizing a closed descriptor throws, and a host
 * that dies on a child's exit would take every other session down with it.
 */
export class ChildSession {
	status: SessionStatus = 'starting'
	ending: SessionEnding | undefined
	readonly screen: HeadlessScreen
	private pty: HostPty | undefined
	private cols: number
	private rows: number

	constructor(
		readonly label: string,
		private readonly spec: SessionSpec,
		size: { cols: number; rows: number },
		private readonly onChange: () => void,
		private readonly kill: (
			pty: HostPty,
			signal: 'SIGHUP' | 'SIGTERM' | 'SIGKILL',
		) => void = killProcessTree,
	) {
		this.cols = size.cols
		this.rows = size.rows
		this.screen = new HeadlessScreen(size.cols, size.rows, SCROLLBACK)
	}

	start(binding: HostPtyModule): void {
		try {
			const pty = binding.spawn(this.spec.file, [...this.spec.args], {
				name: 'xterm-256color',
				cols: this.cols,
				rows: this.rows,
				cwd: this.spec.cwd,
				env: this.spec.env,
			})
			this.pty = pty
			pty.onData((data) => {
				try {
					if (this.status === 'starting') this.status = 'running'
					this.screen.write(data)
					this.onChange()
				} catch {
					/* A bad byte stream must not take the host down. */
				}
			})
			pty.onExit(({ exitCode, signal }) => {
				this.finish(exitCode === 0 && !signal ? 'finished' : 'stopped')
			})
			this.screen.onResponse((reply) => this.write(reply))
		} catch {
			this.finish('could-not-start')
		}
	}

	private finish(ending: SessionEnding): void {
		if (this.status === 'exited') return
		this.status = 'exited'
		this.ending = ending
		this.onChange()
	}

	/** Sends input to the program; nothing once it has ended. */
	write(data: string): void {
		if (this.status === 'exited' || !this.pty) return
		try {
			this.pty.write(data)
		} catch {
			/* The descriptor closed between the check and the write. */
		}
	}

	/** Gives the program a new size; the screen follows even when the program is gone. */
	resize(cols: number, rows: number): void {
		if (cols < 1 || rows < 1) return
		if (cols === this.cols && rows === this.rows) return
		this.cols = cols
		this.rows = rows
		try {
			this.screen.resize(cols, rows)
		} catch {
			/* Nothing to redraw. */
		}
		if (this.status === 'exited' || !this.pty) return
		try {
			this.pty.resize(cols, rows)
		} catch {
			/* Ended while this was being asked. */
		}
	}

	/** Ends the program and what it started. */
	stop(signal: 'SIGHUP' | 'SIGTERM' | 'SIGKILL' = 'SIGHUP'): void {
		if (this.status === 'exited' || !this.pty) return
		this.kill(this.pty, signal)
	}

	dispose(): void {
		this.screen.dispose()
	}
}
