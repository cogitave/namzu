import type { ChildLike } from './spawn.js'
import type { AUDIT_EVENTS } from './store.js'
import type { Manifest } from './types.js'

/**
 * One supervisor per extension process. It starts the process, waits for `hello`, watches the
 * heartbeat, restarts with backoff, counts failures, stops cleanly then by force, and refuses what the
 * manifest did not declare (R4 to R6). The indicator state it reports is computed here from the live
 * process, never from what the extension claims about itself.
 */

export type RunState =
	| 'idle'
	| 'starting'
	| 'collecting'
	| 'degraded'
	| 'not-responding'
	| 'stopping'
	| 'stopped'
	| 'failed'

export interface StatusMessage {
	state: string
	signals?: Record<string, string>
	rssMB?: number
	cpuPct?: number
	lastWriteAt?: string
	storeBytes?: number
	/** The extension's own visible mark while Namzu is closed: it says whether the icon is on the screen. */
	indicator?: { shown?: boolean }
	/** The state ids of the extension's status chips: ids only, never text. */
	chip?: Record<string, string>
}

export interface Snapshot {
	state: RunState
	failedReason?: string
	restartsLastHour: number
	lastStatus?: StatusMessage
	pid?: number
	since: number
}

export const HELLO_TIMEOUT_MS = 10_000
export const HEARTBEAT_EVERY_MS = 30_000
export const HEARTBEAT_MISSED_MS = 90_000
export const MAX_LINE = 64 * 1024
const STRIKES = 3
const HOUR = 3_600_000

type AuditEvent = (typeof AUDIT_EVENTS)[number]

export interface SupervisorOptions {
	readonly manifest: Manifest
	readonly spawn: () => ChildLike
	readonly granted: () => readonly string[]
	readonly audit: (event: AuditEvent, detail?: string) => void
	readonly onChange: (snapshot: Snapshot) => void
	/**
	 * The runner requires the extension's own mark to be shown in every status: two statuses in a row
	 * without `indicator.shown: true` stop it as failed (indicator-hidden) and a restart needs the person.
	 */
	readonly requireIndicator?: boolean
	/**
	 * Resolves true once the process's query endpoint accepts connections. When given, the first status of
	 * a start does not report `collecting` (shown as running) until it has: a status is the process saying
	 * it works, and the socket it serves queries on opens a moment after, so a query issued the instant the
	 * state turned running could find nothing there. False fails the start like a missing hello.
	 */
	readonly endpointReady?: () => Promise<boolean>
}

export class Supervisor {
	private child: ChildLike | undefined
	private generation = 0
	private state: RunState = 'idle'
	private failedReason: string | undefined
	private lastStatus: StatusMessage | undefined
	private since = Date.now()
	private helloTimer: ReturnType<typeof setTimeout> | undefined
	private beatTimer: ReturnType<typeof setInterval> | undefined
	private restartTimer: ReturnType<typeof setTimeout> | undefined
	private lastBeat = 0
	private startedAt = 0
	private consecutive = 0
	private restarts: number[] = []
	private strikes = 0
	private badStatus = 0
	private indicatorMisses = 0
	private expectedStop = false
	private stopWaiters: (() => void)[] = []
	private endpointUp = false
	private endpointWait: 'none' | 'waiting' = 'none'
	private pendingState: RunState = 'collecting'

	constructor(private readonly o: SupervisorOptions) {}

	/** The version of the extension this supervisor runs. */
	get version(): string {
		return this.o.manifest.version
	}

	snapshot(): Snapshot {
		return {
			state: this.state,
			...(this.failedReason ? { failedReason: this.failedReason } : {}),
			restartsLastHour: this.restartsInLastHour(),
			...(this.lastStatus ? { lastStatus: this.lastStatus } : {}),
			...(this.child?.pid !== undefined ? { pid: this.child.pid } : {}),
			since: this.since,
		}
	}

	private restartsInLastHour(): number {
		const cut = Date.now() - HOUR
		return this.restarts.filter((t) => t > cut).length
	}

	private set(state: RunState, failedReason?: string): void {
		if (this.state === state && this.failedReason === failedReason) return
		this.state = state
		this.failedReason = failedReason
		this.since = Date.now()
		this.o.onChange(this.snapshot())
	}

	/** Start the process. Does nothing when one is already running or waiting to restart. */
	start(): void {
		if (this.child || this.restartTimer) return
		this.failedReason = undefined
		this.expectedStop = false
		this.strikes = 0
		this.badStatus = 0
		this.indicatorMisses = 0
		this.lastStatus = undefined
		this.endpointUp = false
		this.endpointWait = 'none'
		this.set('starting')
		const gen = ++this.generation
		let child: ChildLike
		try {
			child = this.o.spawn()
		} catch (error) {
			this.fail(`could not start: ${(error as Error).message}`)
			return
		}
		this.child = child
		this.startedAt = Date.now()
		this.o.audit('started', child.pid !== undefined ? `pid ${child.pid}` : undefined)
		child.onLine((line) => {
			if (gen === this.generation) this.onLine(child, line)
		})
		child.onExit((code, signal) => {
			if (gen === this.generation) this.onExit(code, signal)
		})
		this.helloTimer = setTimeout(
			() => this.fail('no hello within 10 seconds', true),
			HELLO_TIMEOUT_MS,
		)
	}

	/** After `failed`: the person pressed Start again. Forgets the failures and starts. */
	startAgain(): void {
		this.consecutive = 0
		this.restarts = []
		this.start()
	}

	private clearTimers(): void {
		if (this.helloTimer) clearTimeout(this.helloTimer)
		if (this.beatTimer) clearInterval(this.beatTimer)
		this.helloTimer = undefined
		this.beatTimer = undefined
	}

	private strike(why: string): void {
		this.o.audit('message-refused', why)
		this.strikes++
		if (this.strikes >= STRIKES) this.fail('three refused messages in a row', true)
	}

	private onLine(child: ChildLike, line: string): void {
		if (line.length > MAX_LINE) {
			this.strike('a line over 64 KiB')
			return
		}
		let msg: Record<string, unknown>
		try {
			const parsed = JSON.parse(line)
			if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
				this.strike('not a JSON object')
				return
			}
			msg = parsed
		} catch {
			this.strike('not JSON')
			return
		}
		switch (msg.t) {
			case 'hello':
				this.onHello(child, msg)
				return
			case 'status':
				this.onStatus(msg)
				return
			case 'log':
				return
			default:
				this.strike(`message type ${String(msg.t)}`)
				return
		}
	}

	private onHello(child: ChildLike, msg: Record<string, unknown>): void {
		if (this.helloTimer === undefined) {
			this.strike('hello twice')
			return
		}
		clearTimeout(this.helloTimer)
		this.helloTimer = undefined
		const declared = this.o.manifest.permissions
		const granted = this.o.granted()
		const uses = Array.isArray(msg.uses) ? (msg.uses as unknown[]) : []
		if (msg.api !== 1) {
			this.denyPermission(`api ${String(msg.api)}`)
			return
		}
		for (const u of uses) {
			const p = declared.find((d) => d.id === u)
			if (!p) {
				this.denyPermission(`uses ${String(u)}, which the manifest does not declare`)
				return
			}
			if (p.optional && !granted.includes(p.id)) {
				this.denyPermission(`uses ${p.id}, which was not granted`)
				return
			}
		}
		this.lastBeat = Date.now()
		child.write(JSON.stringify({ t: 'hello-ack', granted: [...granted] }))
		this.beatTimer = setInterval(() => {
			if (Date.now() - this.lastBeat >= HEARTBEAT_MISSED_MS)
				this.fail('three missed heartbeats', true)
		}, HEARTBEAT_EVERY_MS)
	}

	private denyPermission(detail: string): void {
		this.o.audit('failed', `undeclared-permission: ${detail}`)
		this.clearTimers()
		const child = this.child
		this.child = undefined
		this.generation++
		child?.kill(true)
		this.set('failed', 'undeclared-permission')
	}

	private denyIndicator(): void {
		this.o.audit('indicator-missing', 'two statuses in a row without the own mark shown')
		this.clearTimers()
		const child = this.child
		this.child = undefined
		this.generation++
		child?.kill(true)
		this.set('failed', 'indicator-hidden')
	}

	private onStatus(msg: Record<string, unknown>): void {
		this.lastBeat = Date.now()
		this.strikes = 0
		const m = msg as unknown as StatusMessage
		const m1 = this.o.manifest
		const states = m1.contributes.indicator.states as Record<string, unknown>
		const declaredPerms = new Set(m1.permissions.map((p) => p.id))
		let bad = typeof m.state !== 'string' || !(m.state in states)
		if (m.signals && typeof m.signals === 'object')
			for (const k of Object.keys(m.signals)) if (!declaredPerms.has(k)) bad = true
		this.lastStatus = m
		if (bad) {
			this.badStatus++
			this.o.audit('message-refused', 'a status the manifest did not declare')
			this.publish('degraded')
			return
		}
		this.badStatus = 0
		if (this.o.requireIndicator) {
			if (m.indicator?.shown === true) this.indicatorMisses = 0
			else if (++this.indicatorMisses >= 2) {
				this.denyIndicator()
				return
			}
		}
		this.publish(m.state === 'degraded' ? 'degraded' : 'collecting')
	}

	/** Report a state a status produced; the first one of a start waits until the query endpoint is up. */
	private publish(next: RunState): void {
		if (this.endpointUp || !this.o.endpointReady || this.state !== 'starting') {
			this.set(next)
			return
		}
		this.pendingState = next
		if (this.endpointWait === 'waiting') return
		this.endpointWait = 'waiting'
		const gen = this.generation
		void this.o.endpointReady().then((up) => {
			if (gen !== this.generation) return
			this.endpointWait = 'none'
			if (!up) {
				this.o.audit('failed', 'query endpoint did not open')
				this.fail('query endpoint did not open', true)
				return
			}
			this.endpointUp = true
			this.set(this.pendingState)
		})
	}

	private onExit(code: number | null, signal: string | null): void {
		this.clearTimers()
		this.child = undefined
		if (this.expectedStop) {
			this.o.audit('stopped')
			this.set('stopped')
			this.flushStop()
			return
		}
		// Any exit the host did not ask for counts as a failure, even a clean 0.
		this.o.audit('exited', `code ${code ?? 'none'}${signal ? ` signal ${signal}` : ''}`)
		this.fail(`exited unasked (code ${code ?? 'none'})`, false)
	}

	private fail(reason: string, kill = false): void {
		this.clearTimers()
		const child = this.child
		this.child = undefined
		this.generation++
		if (kill) child?.kill(true)
		const now = Date.now()
		if (now - this.startedAt >= this.o.manifest.entry.process.restart.stableAfterMs)
			this.consecutive = 0
		this.consecutive++
		this.restarts = this.restarts.filter((t) => t > now - HOUR)
		this.restarts.push(now)
		const r = this.o.manifest.entry.process.restart
		if (r.policy === 'never' || this.restarts.length > r.maxPerHour) {
			this.o.audit('failed', `${reason}; restart cap reached`)
			this.set('failed', reason)
			return
		}
		const wait = r.backoffMs[Math.min(this.consecutive - 1, r.backoffMs.length - 1)] ?? 1000
		this.o.audit('restart', `${reason}; in ${wait} ms`)
		this.set(kill && reason.includes('heartbeat') ? 'not-responding' : 'starting')
		this.restartTimer = setTimeout(() => {
			this.restartTimer = undefined
			this.start()
		}, wait)
	}

	private flushStop(): void {
		const w = this.stopWaiters
		this.stopWaiters = []
		for (const f of w) f()
	}

	/** Last resort when the host itself is exiting and cannot wait: kill the process group now. */
	killNow(): void {
		if (this.restartTimer) clearTimeout(this.restartTimer)
		this.restartTimer = undefined
		this.clearTimers()
		this.expectedStop = true
		try {
			this.child?.kill(true)
		} catch {
			// already gone
		}
	}

	/** The clean stop: `shutdown`, wait the grace period, then force. Resolves when the process is gone. */
	stop(): Promise<void> {
		if (this.restartTimer) {
			clearTimeout(this.restartTimer)
			this.restartTimer = undefined
		}
		const child = this.child
		if (!child) {
			this.clearTimers()
			if (this.state !== 'failed') this.set('stopped')
			return Promise.resolve()
		}
		this.set('stopping')
		this.expectedStop = true
		this.clearTimers()
		return new Promise<void>((resolve) => {
			this.stopWaiters.push(resolve)
			try {
				child.write(JSON.stringify({ t: 'shutdown' }))
			} catch {
				// the pipe is already gone
			}
			setTimeout(() => {
				if (this.child === child) {
					child.kill(true)
					// If the exit event never arrives, do not hold the caller forever.
					setTimeout(() => {
						if (this.child === child) {
							this.child = undefined
							this.generation++
							this.set('stopped')
							this.flushStop()
						}
					}, 1000)
				}
			}, this.o.manifest.entry.process.stopGraceMs)
		})
	}
}
