import type { HostPty, HostPtyModule } from '../../pty.js'

/** A pseudo-terminal that is a script: the test says what it prints and when it ends. */
export class FakePty implements HostPty {
	readonly writes: string[] = []
	readonly resizes: { cols: number; rows: number }[] = []
	readonly kills: (string | undefined)[] = []
	pauses = 0
	resumes = 0
	private data = new Set<(data: string) => void>()
	private exit = new Set<(event: { exitCode: number; signal?: number }) => void>()

	constructor(
		readonly pid: number,
		readonly file: string,
		readonly args: string[],
		readonly options: Parameters<HostPtyModule['spawn']>[2],
	) {}

	write(data: string): void {
		this.writes.push(data)
	}
	resize(cols: number, rows: number): void {
		this.resizes.push({ cols, rows })
	}
	pause(): void {
		this.pauses += 1
	}
	resume(): void {
		this.resumes += 1
	}
	kill(signal?: string): void {
		this.kills.push(signal)
	}
	onData(listener: (data: string) => void) {
		this.data.add(listener)
		return { dispose: () => this.data.delete(listener) }
	}
	onExit(listener: (event: { exitCode: number; signal?: number }) => void) {
		this.exit.add(listener)
		return { dispose: () => this.exit.delete(listener) }
	}

	print(data: string): void {
		for (const listener of this.data) listener(data)
	}
	end(exitCode = 0, signal?: number): void {
		for (const listener of this.exit) listener({ exitCode, ...(signal ? { signal } : {}) })
	}
}

export function fakeBinding(): { binding: HostPtyModule; spawned: FakePty[] } {
	const spawned: FakePty[] = []
	return {
		spawned,
		binding: {
			spawn: (file, args, options) => {
				const pty = new FakePty(1000 + spawned.length, file, args, options)
				spawned.push(pty)
				return pty
			},
		},
	}
}

/** Runs deferred work only when the test says so. */
export function manualDefer(): { defer: (run: () => void) => void; run: () => void } {
	const queue: (() => void)[] = []
	return {
		defer: (run) => void queue.push(run),
		run: () => {
			for (const run of queue.splice(0)) run()
		},
	}
}
