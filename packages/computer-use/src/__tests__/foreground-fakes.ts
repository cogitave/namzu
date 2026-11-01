import { ForegroundLadder, type LadderClock, type LadderTiming } from '../foreground/ladder.js'
import { type LeaseFs, ScreenLease } from '../foreground/lease.js'
import type {
	ForegroundApprover,
	ForegroundMonitor,
	MonitorBurstEnd,
	MonitorState,
} from '../foreground/types.js'

/** A clock whose sleep moves it forward at once: no test waits on real time. */
export class FakeClock implements LadderClock {
	time = 1_000_000
	sleeps: number[] = []
	now(): number {
		return this.time
	}
	async sleep(ms: number): Promise<void> {
		this.sleeps.push(ms)
		this.time += ms
	}
}

export function memoryLeaseFs(): LeaseFs & { files: Map<string, string> } {
	const files = new Map<string, string>()
	return {
		files,
		createExclusive(path, text) {
			if (files.has(path)) return false
			files.set(path, text)
			return true
		},
		read: (path) => files.get(path),
		remove: (path) => void files.delete(path),
		rename(from, to) {
			const text = files.get(from)
			if (text === undefined) throw new Error('ENOENT')
			files.delete(from)
			files.set(to, text)
		},
		overwrite: (path, text) => void files.set(path, text),
	}
}

export const baseState: MonitorState = {
	userIdleMs: 60_000,
	userInputs: 0,
	escapes: 0,
	foreground: { hwnd: '0x10', pid: 10, exe: 'explorer.exe', elevated: false },
	cursor: { x: 5, y: 5 },
	desktop: 'Default',
	selfElevated: false,
}

/** A monitor whose answers a test scripts; it records what the ladder asked of it. */
export class FakeMonitor implements ForegroundMonitor {
	started = 0
	disposed = 0
	calls: string[] = []
	startError: Error | undefined
	/** What `state` answers; given how many times it was asked. */
	state_: (n: number, query?: { pid?: number }) => MonitorState = () => baseState
	/** Real input and Escape presses that happen during the burst. */
	during: { inputs: number; escapes: number } = { inputs: 0, escapes: 0 }
	/** The `begin` answer may differ from the last `state` (input in between). */
	beginState: (() => MonitorState) | undefined
	stateCalls = 0
	ends: { restore: boolean; keepCursor?: boolean }[] = []
	released: string[] = []

	async start(): Promise<void> {
		this.started++
		if (this.startError) throw this.startError
	}
	async state(query?: { pid?: number }): Promise<MonitorState> {
		this.calls.push('state')
		return this.state_(this.stateCalls++, query)
	}
	begins: { raise?: string }[] = []
	async begin(args?: { raise?: string }): Promise<MonitorState> {
		this.calls.push('begin')
		this.begins.push({ ...(args?.raise !== undefined ? { raise: args.raise } : {}) })
		return this.beginState ? this.beginState() : this.state_(this.stateCalls, undefined)
	}
	async end(args: {
		restore: boolean
		keepCursor?: boolean
	}): Promise<MonitorBurstEnd> {
		this.calls.push('end')
		this.ends.push(args)
		const quiet = this.during.inputs === 0
		return {
			inputsDuring: this.during.inputs,
			escapesDuring: this.during.escapes,
			restoredForeground: args.restore && quiet,
			restoredCursor: args.restore && quiet && args.keepCursor !== true,
		}
	}
	async release(args: { token: string }): Promise<void> {
		this.released.push(args.token)
	}
	async dispose(): Promise<void> {
		this.disposed++
	}
}

export function makeLadder(
	options: {
		monitor?: FakeMonitor
		clock?: FakeClock
		fs?: ReturnType<typeof memoryLeaseFs>
		approve?: ForegroundApprover
		timing?: Partial<LadderTiming>
		session?: string
		pid?: number
		alive?: (pid: number) => boolean
	} = {},
) {
	const monitor = options.monitor ?? new FakeMonitor()
	const clock = options.clock ?? new FakeClock()
	const fs = options.fs ?? memoryLeaseFs()
	const lease = new ScreenLease({
		path: '/home/.namzu/computer-use/screen.lease',
		session: options.session ?? 'a',
		now: () => clock.now(),
		fs,
		pid: options.pid ?? 100,
		identity: (pid) => `start-${pid}`,
		alive: options.alive ?? (() => true),
	})
	const ladder = new ForegroundLadder({
		createMonitor: () => monitor,
		leasePath: lease.path,
		clock,
		lease,
		...(options.approve ? { approve: options.approve } : {}),
		...(options.timing ? { timing: options.timing } : {}),
	})
	return { ladder, monitor, clock, fs, lease }
}
