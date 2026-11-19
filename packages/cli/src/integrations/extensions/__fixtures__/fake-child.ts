import type { ChildLike, SpawnSpec } from '../spawn.js'

/** A child that is not a process: lines go in and out in memory. */
export class FakeChild implements ChildLike {
	static count = 0
	pid = 40000 + FakeChild.count++
	written: string[] = []
	killed: boolean[] = []
	private lineCb: (l: string) => void = () => {}
	private exitCb: (c: number | null, s: string | null) => void = () => {}
	constructor(
		readonly spec?: SpawnSpec,
		private readonly obeysShutdown = true,
	) {}
	write(line: string): void {
		this.written.push(line)
		if (this.obeysShutdown && line.includes('"shutdown"')) this.exit(0)
	}
	endInput(): void {}
	kill(force: boolean): void {
		this.killed.push(force)
		if (force) this.exit(null, 'SIGKILL')
	}
	onLine(cb: (l: string) => void): void {
		this.lineCb = cb
	}
	onExit(cb: (c: number | null, s: string | null) => void): void {
		this.exitCb = cb
	}
	say(o: unknown): void {
		this.lineCb(typeof o === 'string' ? o : JSON.stringify(o))
	}
	exit(code: number | null, signal: string | null = null): void {
		this.exitCb(code, signal)
	}
}

/** A spawn function that records every spec and gives each child a good hello and status. */
export function recordingSpawn(opts: { uses?: string[]; maintenanceExit?: boolean } = {}) {
	const children: FakeChild[] = []
	const spawn = (spec: SpawnSpec): FakeChild => {
		const c = new FakeChild(spec)
		children.push(c)
		const maintenance = spec.args.includes('purge')
		queueMicrotask(() => {
			if (maintenance) {
				c.exit(0)
				return
			}
			c.say({ t: 'hello', api: 1, version: '1.0.0', uses: opts.uses ?? ['os.foregroundWindow'] })
			c.say({ t: 'status', state: 'collecting', signals: { 'os.foregroundWindow': 'ok' } })
		})
		return c
	}
	return {
		spawn,
		children,
		runs: () => children.filter((c) => !c.spec?.args.includes('purge')),
		maintenance: () => children.filter((c) => c.spec?.args.includes('purge')),
	}
}

export const settle = (): Promise<void> => new Promise((r) => setImmediate(r))
