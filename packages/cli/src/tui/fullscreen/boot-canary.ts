import { hostname } from 'node:os'

import {
	type TerminalState,
	readTerminalState,
	updateTerminalState,
} from '../../terminal-setup/state.js'
import { CLI_VERSION } from '../../version.js'

/**
 * Telling a fullscreen start that never finished from one that did.
 *
 * A launch that asks for fullscreen writes a pending record under its own
 * process id and removes it once the screen has been drawn and the process is
 * still healthy 10 seconds later, or when it exits cleanly. The next launch
 * reads what is left: a record whose process is gone (or died drawing) is one
 * failed start. One failed start gives that launch the normal screen and a
 * line saying so; two in a row turn fullscreen off on this machine until the
 * next version of Namzu or `/tui fullscreen`. Records from another machine or
 * system are ignored until they are 30 days old, and a live record older than
 * 10 minutes is dropped.
 *
 * `NAMZU_FULLSCREEN` is the person's word and is never second-guessed: when it
 * is set, nothing here runs.
 */

export const HEALTHY_AFTER_MS = 10_000
export const STICKY_STRIKES = 2
const LIVE_RECORD_MAX_AGE_MS = 10 * 60_000
const OTHER_HOST_MAX_AGE_MS = 30 * 24 * 60 * 60_000

export const ONE_FAILED_START_LINE =
	"Namzu's fullscreen mode didn't finish starting last time on this machine, so this launch uses the normal screen. It will try fullscreen again next launch; /tui default keeps the normal screen."
export const REPEATED_FAILED_START_LINE =
	"Namzu's fullscreen mode has repeatedly failed to start on this machine, so it has been turned off here. Run /tui fullscreen to try it again (this also resets after an update)."

export interface BootWorld {
	readonly now: number
	readonly version: string
	readonly host: string
	readonly platform: string
	readonly ownPid: number
	readonly isGone: (pid: number) => boolean
}

export type BootDecision =
	| { readonly kind: 'none' }
	| { readonly kind: 'pending_alive' }
	| { readonly kind: 'disabled' }
	| { readonly kind: 'strike'; readonly strikes: number }
	| { readonly kind: 'tripped'; readonly strikes: number }

type BootFields = Pick<
	TerminalState,
	'fullscreenBootPending' | 'fullscreenBootStrikes' | 'fullscreenAutoDisabled'
>

/** Read the records left by earlier launches: what is now settled, and the verdict for this launch. */
export function evaluateBoot(
	state: TerminalState,
	world: BootWorld,
): { next: BootFields; decision: BootDecision } {
	const pending = { ...state.fullscreenBootPending }
	let disabled = state.fullscreenAutoDisabled
	let strikes =
		state.fullscreenBootStrikes?.version === world.version ? state.fullscreenBootStrikes.count : 0
	if (disabled && disabled.version !== world.version) disabled = undefined
	let fresh = 0
	let live = false
	for (const [key, record] of Object.entries(pending)) {
		const pid = Number(key)
		if (!Number.isInteger(pid) || pid < 1 || typeof record !== 'object' || record === null) {
			delete pending[key]
			continue
		}
		const age = Math.max(0, world.now - record.startedAt)
		if (record.host !== world.host || record.platform !== world.platform) {
			if (age > OTHER_HOST_MAX_AGE_MS) delete pending[key]
			continue
		}
		if (record.died !== undefined || pid === world.ownPid || world.isGone(pid)) {
			delete pending[key]
			if (record.version === world.version) fresh += 1
		} else if (age > LIVE_RECORD_MAX_AGE_MS) delete pending[key]
		else live = true
	}
	let decision: BootDecision = { kind: 'none' }
	if (disabled) decision = { kind: 'disabled' }
	else if (fresh > 0) {
		strikes += fresh
		if (strikes >= STICKY_STRIKES) {
			disabled = { version: world.version, at: world.now, strikes }
			decision = { kind: 'tripped', strikes }
			strikes = 0
		} else decision = { kind: 'strike', strikes }
	} else if (live) decision = { kind: 'pending_alive' }
	return {
		next: {
			...(Object.keys(pending).length > 0 ? { fullscreenBootPending: pending } : {}),
			...(strikes > 0 ? { fullscreenBootStrikes: { count: strikes, version: world.version } } : {}),
			...(disabled ? { fullscreenAutoDisabled: disabled } : {}),
		},
		decision,
	}
}

function pidIsGone(pid: number): boolean {
	try {
		process.kill(pid, 0)
		return false
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === 'ESRCH'
	}
}

export function realBootWorld(now: number = Date.now()): BootWorld {
	let host = 'unknown'
	try {
		host = hostname()
	} catch {
		// an unknown host still keys its own records
	}
	return {
		now,
		version: CLI_VERSION,
		host,
		platform: process.platform,
		ownPid: process.pid,
		isGone: pidIsGone,
	}
}

/**
 * Settle the records earlier launches left, and say what this launch should do.
 * `autoOff` is true when this launch must use the normal screen.
 */
export function settleEarlierStarts(
	opts: { readonly home?: string; readonly world?: BootWorld } = {},
): { autoOff: boolean; decision: BootDecision; line?: string } {
	const world = opts.world ?? realBootWorld()
	const verdict: { decision: BootDecision } = { decision: { kind: 'none' } }
	updateTerminalState((s) => {
		const settled = evaluateBoot(s, world)
		verdict.decision = settled.decision
		const { fullscreenBootPending, fullscreenBootStrikes, fullscreenAutoDisabled, ...rest } = s
		void fullscreenBootPending
		void fullscreenBootStrikes
		void fullscreenAutoDisabled
		return { ...rest, ...settled.next }
	}, opts.home)
	const decision = verdict.decision
	const autoOff =
		decision.kind === 'strike' || decision.kind === 'tripped' || decision.kind === 'disabled'
	const line =
		decision.kind === 'strike'
			? ONE_FAILED_START_LINE
			: decision.kind === 'tripped'
				? REPEATED_FAILED_START_LINE
				: undefined
	return { autoOff, decision, ...(line ? { line } : {}) }
}

/** Fullscreen is turned off on this machine for this version, or a failed start is on record. */
export function failedStartOnRecord(
	home?: string,
	version: string = CLI_VERSION,
): 'repeated' | 'once' | undefined {
	const state = readTerminalState(home)
	if (state.fullscreenAutoDisabled?.version === version) return 'repeated'
	if (state.fullscreenBootStrikes?.version === version && state.fullscreenBootStrikes.count > 0)
		return 'once'
	return undefined
}

/** Forget the failed starts: `/tui` calls this on any switch. */
export function clearFailedStarts(home?: string): void {
	updateTerminalState((s) => {
		const { fullscreenAutoDisabled, fullscreenBootStrikes, ...rest } = s
		void fullscreenAutoDisabled
		void fullscreenBootStrikes
		return rest
	}, home)
}

export interface BootCanary {
	/** The first frame was drawn: the healthy timer starts. */
	firstFrame(): void
	/** The interface failed while starting: the next launch counts it. */
	failed(): void
	/** The launch ended or the canary is no longer needed. */
	retire(): void
}

/** Write this launch's pending record. Call only for a launch that is about to draw fullscreen. */
export function armBootCanary(
	opts: {
		readonly home?: string
		readonly world?: BootWorld
		readonly healthyAfterMs?: number
		readonly onExit?: (handler: () => void) => () => void
	} = {},
): BootCanary {
	const world = opts.world ?? realBootWorld()
	const key = String(world.ownPid)
	let settled = false
	let timer: ReturnType<typeof setTimeout> | undefined
	const remove = (healthy = false): void => {
		updateTerminalState((s) => {
			// A launch that was seen to be healthy ends the run of failed starts: "two in a row".
			let base = s
			if (healthy) {
				const { fullscreenBootStrikes, ...kept } = s
				void fullscreenBootStrikes
				base = kept
			}
			if (s.fullscreenBootPending?.[key] === undefined) return base
			const { [key]: _own, ...others } = s.fullscreenBootPending
			void _own
			const { fullscreenBootPending, ...rest } = base
			void fullscreenBootPending
			return Object.keys(others).length > 0 ? { ...rest, fullscreenBootPending: others } : rest
		}, opts.home)
	}
	updateTerminalState(
		(s) => ({
			...s,
			fullscreenBootPending: {
				...s.fullscreenBootPending,
				[key]: {
					startedAt: world.now,
					version: world.version,
					host: world.host,
					platform: world.platform,
				},
			},
		}),
		opts.home,
	)
	// A clean exit takes the record away; a crash or a kill leaves it for the next launch.
	const onExit =
		opts.onExit ??
		((handler) => {
			process.on('exit', handler)
			return () => process.off('exit', handler)
		})
	const offExit = onExit(() => {
		if (!settled && (process.exitCode === undefined || process.exitCode === 0))
			remove(timer !== undefined)
	})
	const settle = (): void => {
		settled = true
		if (timer !== undefined) clearTimeout(timer)
		offExit()
	}
	return {
		firstFrame() {
			if (settled || timer !== undefined) return
			timer = setTimeout(() => {
				if (settled) return
				if (process.exitCode !== undefined && process.exitCode !== 0) return
				settle()
				remove(true)
			}, opts.healthyAfterMs ?? HEALTHY_AFTER_MS)
			timer.unref?.()
		},
		failed() {
			if (settled) return
			settle()
			updateTerminalState((s) => {
				const own = s.fullscreenBootPending?.[key]
				if (own === undefined || own.died !== undefined) return s
				return {
					...s,
					fullscreenBootPending: {
						...s.fullscreenBootPending,
						[key]: { ...own, died: 'render_error' },
					},
				}
			}, opts.home)
		},
		retire() {
			if (settled) return
			const drawn = timer !== undefined
			settle()
			remove(drawn)
		},
	}
}
