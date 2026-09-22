/**
 * The session writer leases this process holds, so a process that is told to
 * stop can give them back before it exits.
 *
 * A turn renews its lease while it runs and releases it when it settles. A
 * process that is terminated mid-turn (SIGTERM from a supervisor, SIGHUP when
 * its terminal closes) settles nothing, and without this its lease stays live
 * until it expires: the session refuses `/resume`, `/abandon` and a new prompt
 * for up to the lease's time-to-live although no process is writing to it.
 *
 * {@link releaseHeldSessionLeases} publishes a release for every holding,
 * which leaves a running turn `interrupted` (no live lease, not paused; spec
 * §4.5): the next writer takes the session at once and closes the turn
 * through the explicit flow — `abandonTurn`, `resumeSession`, or
 * `beginTurn({ abandonInterrupted })`. Nothing is appended on the way out,
 * because the dying process cannot know how far its turn got.
 *
 * A process killed with SIGKILL runs no code; its lease is freed by expiry.
 */

/** One log instance's current holding, released under that log's own write order. */
export interface HeldSessionLease {
	release(): Promise<void>
}

const held = new Set<HeldSessionLease>()
let releasedForExit = false

/** A claim made after {@link releaseHeldSessionLeases}: this process is on its way out. */
export class SessionLeasesReleasedError extends Error {
	override readonly name = 'SessionLeasesReleasedError'
	constructor() {
		super(
			'This process gave its session leases back to exit (releaseHeldSessionLeases); it takes no new lease.',
		)
	}
}

/** @internal Record a holding a log instance took. */
export function trackHeldSessionLease(holding: HeldSessionLease): void {
	held.add(holding)
}

/** @internal Forget a holding its log instance gave up. */
export function untrackHeldSessionLease(holding: HeldSessionLease): void {
	held.delete(holding)
}

/** @internal Whether this process has released its leases to exit. */
export function sessionLeasesReleasedForExit(): boolean {
	return releasedForExit
}

export interface ReleaseHeldSessionLeasesOptions {
	/**
	 * How long to wait for the releases. Each waits for its log's write in
	 * flight, if any, so a release never lands under a half-written record.
	 * Default 2000.
	 */
	readonly timeoutMs?: number
}

export interface ReleaseHeldSessionLeasesResult {
	/** Holdings whose release landed (or was already stale: somebody took the session over). */
	readonly released: number
	/** Holdings whose release had not landed when the wait ended, or failed; expiry frees those. */
	readonly unfinished: number
}

/**
 * Give back every session writer lease this process holds, for a process that
 * is about to exit. From the first call on, every later claim in this process
 * is refused with {@link SessionLeasesReleasedError}, so a turn still unwinding
 * cannot renew or retake the lease it just gave up. Never throws.
 */
export async function releaseHeldSessionLeases(
	options: ReleaseHeldSessionLeasesOptions = {},
): Promise<ReleaseHeldSessionLeasesResult> {
	releasedForExit = true
	const holdings = [...held]
	if (holdings.length === 0) return { released: 0, unfinished: 0 }
	let released = 0
	const all = Promise.all(
		holdings.map((holding) =>
			holding.release().then(
				() => {
					released += 1
				},
				() => {
					// A release that failed (an unwritable directory) cannot be retried
					// by a process that is exiting; expiry frees that session.
				},
			),
		),
	)
	let timer: NodeJS.Timeout | undefined
	const deadline = new Promise<void>((resolve) => {
		timer = setTimeout(resolve, options.timeoutMs ?? 2_000)
	})
	await Promise.race([all, deadline])
	clearTimeout(timer)
	return { released, unfinished: holdings.length - released }
}
