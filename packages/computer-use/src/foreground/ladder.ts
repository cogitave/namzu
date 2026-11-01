import { type LeaseAttempt, ScreenLease } from './lease.js'
import {
	type BurstContext,
	BurstInterrupted,
	type ForegroundApprover,
	type ForegroundBlock,
	type ForegroundMonitor,
	type ForegroundOutcome,
	type ForegroundSubject,
	type MonitorState,
	PROTECTED_PROCESSES,
} from './types.js'

/** Time, replaceable so the waits below run on a fake clock in tests. */
export interface LadderClock {
	now(): number
	sleep(ms: number, signal?: AbortSignal): Promise<void>
}

export const realClock: LadderClock = {
	now: () => Date.now(),
	sleep(ms, signal) {
		return new Promise((resolve) => {
			if (signal?.aborted) return resolve()
			const timer = setTimeout(done, ms)
			function done() {
				clearTimeout(timer)
				signal?.removeEventListener('abort', done)
				resolve()
			}
			signal?.addEventListener('abort', done, { once: true })
		})
	},
}

/** The thresholds and bounds of the ladder. Every wait is bounded. */
export interface LadderTiming {
	/**
	 * How long the user must have been still before the screen is used.
	 * 2 000 ms: on the machine this was measured on, the gaps between a person's
	 * inputs rarely reach 5 s while 2 s is common between bursts of activity,
	 * and a keep-awake nudge every ~26 s leaves 24 s of every 26 free.
	 */
	readonly idleMs: number
	/** Idle needed once the user has agreed to give up the screen for a moment. */
	readonly approvedIdleMs: number
	/** How often the monitor is read while waiting. */
	readonly pollMs: number
	/** How long to wait for the user to go idle before asking them. */
	readonly userActiveWaitMs: number
	/** How long to keep waiting after they agreed. */
	readonly approvedWaitMs: number
	/** Where nobody can be asked (exec, scheduled): how long to wait for a still moment. */
	readonly parkMs: number
	readonly parkPollMs: number
	/** How long to wait for another session to release the lease. */
	readonly leaseWaitMs: number
	readonly leasePollMs: number
	/** How often a held lease is refreshed while a burst runs (well inside its time-to-live). */
	readonly leaseBeatMs: number
	/** Most time one turn may spend parked, over all its calls. */
	readonly parkTurnMs: number
}

export const DEFAULT_TIMING: LadderTiming = {
	idleMs: 2_000,
	approvedIdleMs: 500,
	pollMs: 50,
	userActiveWaitMs: 15_000,
	approvedWaitMs: 30_000,
	parkMs: 120_000,
	parkPollMs: 250,
	leaseWaitMs: 30_000,
	leasePollMs: 200,
	leaseBeatMs: 8_000,
	parkTurnMs: 600_000,
}

export interface ForegroundLadderOptions {
	/** A fresh monitor each time one is needed (it is stopped between turns). */
	readonly createMonitor: () => ForegroundMonitor
	/** Full path of the lease file. */
	readonly leasePath: string
	readonly session?: string
	/** Present where a person can be asked. */
	readonly approve?: ForegroundApprover
	readonly timing?: Partial<LadderTiming>
	readonly clock?: LadderClock
	readonly lease?: ScreenLease
}

/** What the model reads once Escape has stopped the turn. Fixed on purpose. */
export const STOPPED_TEXT =
	'The user pressed Escape, so computer use is stopped for the rest of this turn. Stop now: tell the user what is still undone, and do not call computer_use again until they send a new message.'

const seconds = (ms: number): string => `${Math.max(1, Math.round(ms / 1000))} s`

const BLOCKS = {
	locked_desktop: (): ForegroundBlock => ({
		code: 'locked_desktop',
		detail:
			'The computer is locked or showing a sign-in screen, so nothing was sent. Ask the user to unlock it, then continue. Do not try to work around it.',
	}),
	secure_desktop: (): ForegroundBlock => ({
		code: 'secure_desktop',
		detail:
			'A system prompt that only the user can answer has the screen (an administrator-permission prompt, for example), so nothing was sent. Ask the user to answer it themselves. Never try to work around it.',
	}),
	uac_prompt: (): ForegroundBlock => ({
		code: 'uac_prompt',
		detail:
			'An administrator-permission prompt is in front, so nothing was sent. Ask the user to answer it themselves. Never try to work around it.',
	}),
	elevated_target: (inFront = false): ForegroundBlock => ({
		code: 'elevated_target',
		detail: inFront
			? 'The window in front belongs to a program with higher rights (or one this program cannot inspect), so it cannot be replaced from here and nothing was sent. Ask the user to click away from it, or to do this step themselves. Do not try to work around it.'
			: 'This program runs with administrator rights, so input from here is blocked and nothing was sent. Ask the user to act in it, or to restart it without administrator rights. Do not try to work around it.',
	}),
	monitor_unavailable: (reason: string): ForegroundBlock => ({
		code: 'monitor_unavailable',
		detail: `This computer cannot watch for the user's keyboard and mouse (${reason}), so the screen is not used and nothing was sent. Use controls by ref (ui_act) in the background, or ask the user to do this step.`,
	}),
	declined: (app: string): ForegroundBlock => ({
		code: 'declined',
		detail: `The user did not allow ${app} to use the screen for this, so nothing was sent. Do not ask again this turn; tell them what you could not do.`,
	}),
	stopped: (): ForegroundBlock => ({ code: 'stopped', detail: STOPPED_TEXT }),
	lease_busy: (waited: number): ForegroundBlock => ({
		code: 'lease_busy',
		detail: `Another Namzu session has been using the screen for the last ${seconds(waited)}, so nothing was sent. Try this action again in a moment.`,
	}),
	user_active: (waited: number, asked: boolean): ForegroundBlock => ({
		code: 'user_active',
		detail: `The user kept using the keyboard or mouse for ${seconds(waited)}${asked ? ' even after agreeing' : ''}, so the screen was not taken and nothing was sent. Do other work that does not need the screen, or try this action again later.`,
	}),
}

/** Times a burst start is retried because input arrived between the last look and the start. */
const MAX_INTERFERED_STARTS = 3

interface Stop {
	readonly turnId: string | undefined
}

/**
 * The foreground ladder. `run` takes a burst (a function that sends input
 * which can only be delivered in the foreground) through:
 *
 * 1. the lease: one session at a time, a stale lease taken over;
 * 2. the safety checks: lock screen, system prompts, administrator windows;
 * 3. the idle gate: the user still for `idleMs`;
 * 4. if the user stays busy for `userActiveWaitMs`: one question to them, or,
 *    where nobody can be asked, a bounded wait that retries;
 * 5. the burst, watched for real input from start to end;
 * 6. a conditional restore of the window and cursor that were there before.
 *
 * Nothing here sends input itself and nothing waits without a bound.
 */
export class ForegroundLadder {
	private readonly timing: LadderTiming
	private readonly clock: LadderClock
	private readonly lease: ScreenLease
	private monitor: ForegroundMonitor | undefined
	private queue: Promise<unknown> = Promise.resolve()
	private stop: Stop | undefined
	private readonly leaseBeatMs: number
	private parkedMs = 0
	private turn: string | undefined
	private readonly allowed = new Set<string>()
	private readonly denied = new Set<string>()

	constructor(private readonly options: ForegroundLadderOptions) {
		this.timing = { ...DEFAULT_TIMING, ...options.timing }
		this.clock = options.clock ?? realClock
		this.leaseBeatMs = this.timing.leaseBeatMs
		this.lease =
			options.lease ??
			new ScreenLease({
				path: options.leasePath,
				session: options.session ?? 'session',
				now: () => this.clock.now(),
			})
	}

	/** True after a physical Escape, until the next user turn. */
	get stopped(): boolean {
		return this.stop !== undefined
	}

	/**
	 * The model's turn `turnId` is starting a tool call. A new turn lifts an
	 * Escape stop and forgets refused permissions. A caller that has no turn id
	 * passes undefined, which always counts as a new turn.
	 */
	beginTurn(turnId: string | undefined): void {
		if (this.stop && (turnId === undefined || turnId !== this.stop.turnId)) this.stop = undefined
		if (turnId === undefined || turnId !== this.turn) {
			this.denied.clear()
			this.parkedMs = 0
		}
		this.turn = turnId
	}

	/** The model's turn ended or was interrupted: nothing stays watched or held. */
	async endTurn(): Promise<void> {
		this.denied.clear()
		await this.dropMonitor()
	}

	async dispose(): Promise<void> {
		this.allowed.clear()
		await this.endTurn()
	}

	run<T>(
		request: {
			readonly subject: ForegroundSubject
			/** The burst leaves the cursor where it put it (a `mouse_move`). */
			readonly keepCursor?: boolean
			readonly signal?: AbortSignal
		},
		burst: (context: BurstContext) => Promise<T>,
	): Promise<ForegroundOutcome<T>> {
		const run = this.queue.then(() => this.runOne(request, burst))
		this.queue = run.catch(() => undefined)
		return run
	}

	private async runOne<T>(
		request: {
			readonly subject: ForegroundSubject
			readonly keepCursor?: boolean
			readonly signal?: AbortSignal
		},
		burst: (context: BurstContext) => Promise<T>,
		attempt = 0,
	): Promise<ForegroundOutcome<T>> {
		const { subject, signal } = request
		if (this.stop) return { kind: 'blocked', block: BLOCKS.stopped() }
		const monitor = await this.ensureMonitor()
		if (!monitor.ok)
			return {
				kind: 'blocked',
				block: BLOCKS.monitor_unavailable(monitor.reason),
			}

		const leaseStart = this.clock.now()
		const token = await this.acquireLease(signal)
		if (token === undefined)
			return {
				kind: 'blocked',
				block: BLOCKS.lease_busy(this.clock.now() - leaseStart),
			}
		try {
			const state = await this.gate(monitor.monitor, subject, signal)
			if ('block' in state) return { kind: 'blocked', block: state.block }
			const startedAt = this.clock.now()
			const begun = await monitor.monitor.begin({
				leasePath: this.lease.path,
				token,
				// Checked by the monitor before it raises anything, so a person who
				// started typing after the last look is not displaced.
				idleMs: state.needed,
				...(subject.hwnd !== undefined ? { raise: subject.hwnd } : {}),
			})
			// A person touched input between the last look and now: not yet.
			if (begun.refused === true || begun.userInputs !== state.state.userInputs) {
				if (attempt >= MAX_INTERFERED_STARTS) {
					await monitor.monitor.end({ restore: true }).catch(() => undefined)
					return {
						kind: 'blocked',
						block: BLOCKS.user_active(this.clock.now() - startedAt, false),
					}
				}
				return await this.retryAfterInterference(
					monitor.monitor,
					request,
					burst,
					token,
					attempt + 1,
				)
			}
			const beat = setInterval(
				() => void this.lease.heartbeat(token),
				Math.max(1, Math.floor(this.leaseBeatMs)),
			)
			beat.unref?.()
			let value: T | undefined
			let failure: { readonly error: unknown } | undefined
			try {
				value = await burst({
					checkpoint: async () => {
						if (!this.lease.heartbeat(token)) throw new BurstInterrupted()
						const now = await monitor.monitor.state()
						if (now.userInputs !== begun.userInputs) throw new BurstInterrupted()
					},
				})
			} catch (error) {
				failure = { error }
			} finally {
				clearInterval(beat)
			}
			// The burst ends, and what it moved is put back, whether it returned or
			// threw; an Escape pressed on the way stops the turn either way.
			const ended = await monitor.monitor
				.end({
					restore: true,
					...(request.keepCursor ? { keepCursor: true } : {}),
				})
				.catch(() => undefined)
			const stopped = (ended?.escapesDuring ?? 0) > 0
			if (stopped) this.stop = { turnId: this.turn }
			if (failure) throw failure.error
			return {
				kind: 'ran',
				value: value as T,
				// Input went out; if the monitor cannot say what happened around it,
				// the result is not proof either way.
				interfered: ended === undefined || ended.inputsDuring > 0,
				stopped,
				restoredForeground: ended?.restoredForeground ?? false,
				restoredCursor: ended?.restoredCursor ?? false,
				...(ended?.restoreNote ? { restoreNote: ended.restoreNote } : {}),
				heldMs: this.clock.now() - startedAt,
			}
		} finally {
			this.lease.release(token)
			await this.monitor?.release({ leasePath: this.lease.path, token }).catch(() => undefined)
		}
	}

	private async retryAfterInterference<T>(
		monitor: ForegroundMonitor,
		request: {
			readonly subject: ForegroundSubject
			readonly keepCursor?: boolean
			readonly signal?: AbortSignal
		},
		burst: (context: BurstContext) => Promise<T>,
		token: string,
		attempt: number,
	): Promise<ForegroundOutcome<T>> {
		// A raise that happened just before a person's input is undone too.
		await monitor.end({ restore: true }).catch(() => undefined)
		// The lease is ours until runOne's finally; release it so the nested run takes it afresh.
		this.lease.release(token)
		return this.runOne(request, burst, attempt)
	}

	private async ensureMonitor(): Promise<
		{ readonly ok: true; readonly monitor: ForegroundMonitor } | { ok: false; reason: string }
	> {
		if (this.monitor) return { ok: true, monitor: this.monitor }
		const monitor = this.options.createMonitor()
		try {
			await monitor.start()
		} catch (error) {
			await monitor.dispose().catch(() => undefined)
			return {
				ok: false,
				reason: error instanceof Error ? error.message : String(error),
			}
		}
		this.monitor = monitor
		return { ok: true, monitor }
	}

	private async dropMonitor(): Promise<void> {
		const monitor = this.monitor
		this.monitor = undefined
		await monitor?.dispose().catch(() => undefined)
	}

	private async acquireLease(signal?: AbortSignal): Promise<string | undefined> {
		const deadline = this.clock.now() + this.timing.leaseWaitMs
		for (;;) {
			const attempt: LeaseAttempt = this.lease.tryAcquire()
			if (attempt.held) return attempt.token
			if (this.clock.now() >= deadline || signal?.aborted) return undefined
			await this.clock.sleep(this.timing.leasePollMs, signal)
		}
	}

	/** Safety checks and the idle gate, with the one question to the user. */
	private async gate(
		monitor: ForegroundMonitor,
		subject: ForegroundSubject,
		signal?: AbortSignal,
	): Promise<
		{ readonly state: MonitorState; readonly needed: number } | { readonly block: ForegroundBlock }
	> {
		const started = this.clock.now()
		let phase: 'gate' | 'approved' | 'parked' = 'gate'
		let phaseStart = started
		let asked = false
		let first = true
		for (;;) {
			const state = await monitor.state(subject.pid !== undefined ? { pid: subject.pid } : {})
			const unsafe = this.unsafe(state)
			if (unsafe) return { block: unsafe }
			const who = effectiveSubject(subject, state)
			const key = (who.exe ?? who.app).toLowerCase()
			if (first && this.allowed.has(key)) {
				phase = 'approved'
				asked = true
			}
			first = false
			const needed = phase === 'approved' ? this.timing.approvedIdleMs : this.timing.idleMs
			if (state.userIdleMs >= needed) return { state, needed }
			const now = this.clock.now()
			const limit =
				phase === 'gate'
					? this.timing.userActiveWaitMs
					: phase === 'approved'
						? this.timing.approvedWaitMs
						: this.timing.parkMs
			if (
				now - phaseStart >= limit ||
				signal?.aborted ||
				(phase === 'parked' && this.parkedMs >= this.timing.parkTurnMs)
			) {
				if (phase === 'gate' && !signal?.aborted) {
					if (this.denied.has(key)) return { block: BLOCKS.declined(who.app) }
					const answer = (await this.options.approve?.(who, signal)) ?? 'unavailable'
					if (answer === 'deny') {
						this.denied.add(key)
						return { block: BLOCKS.declined(who.app) }
					}
					if (answer === 'allow') {
						this.allowed.add(key)
						phase = 'approved'
						asked = true
					} else {
						phase = 'parked'
					}
					phaseStart = this.clock.now()
					continue
				}
				return { block: BLOCKS.user_active(now - started, asked) }
			}
			const wait = phase === 'parked' ? this.timing.parkPollMs : this.timing.pollMs
			if (phase === 'parked') this.parkedMs += wait
			await this.clock.sleep(wait, signal)
		}
	}

	private unsafe(state: MonitorState): ForegroundBlock | undefined {
		if (state.desktop.toLowerCase() !== 'default') return BLOCKS.secure_desktop()
		const front = state.foreground?.exe.toLowerCase()
		const protectedKind = front === undefined ? undefined : PROTECTED_PROCESSES.get(front)
		if (protectedKind) return BLOCKS[protectedKind]()
		if (state.selfElevated) return undefined
		if (state.target?.elevated) return BLOCKS.elevated_target()
		// Windows will not let a program with lower rights take the front from one
		// with higher rights, so the burst could neither raise its target nor type.
		if (state.foreground?.elevated) return BLOCKS.elevated_target(true)
		return undefined
	}
}

/** A burst for the desktop as such is for whichever program is in front when it starts. */
function effectiveSubject(subject: ForegroundSubject, state: MonitorState): ForegroundSubject {
	if (subject.exe !== undefined || subject.pid !== undefined || !state.foreground) return subject
	const exe = state.foreground.exe
	return {
		app: exe.replace(/\.exe$/i, '') || subject.app,
		exe,
		pid: state.foreground.pid,
	}
}
