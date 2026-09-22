/**
 * What a turn-running command does when it is told to stop from outside.
 *
 * A turn holds its conversation's writer lease while it runs, renewed for five
 * minutes at a time. Node's default for SIGTERM, SIGHUP and SIGINT is to die
 * on the spot, which settles nothing and releases nothing: the conversation
 * then refuses `/resume`, `/abandon` and a new prompt ("leased by a live
 * writer") until the lease expires, although no process is writing to it.
 * A supervisor stopping a service sends SIGTERM, a closed terminal sends
 * SIGHUP, and Ctrl+C at a shell running `namzu run` sends SIGINT.
 *
 * So on the first of those signals the command:
 *
 * 1. gives back every session lease the process holds
 *    (`releaseHeldSessionLeases`). A running turn is left `interrupted` — no
 *    live lease, not paused — which the next writer closes through the
 *    explicit flow: `/abandon`, `/resume`, or the TUI's next prompt
 *    (`abandonInterrupted`). Nothing is appended for it on the way out: the
 *    process cannot know how far the turn got, and `interrupted` says exactly
 *    what is known;
 * 2. runs the command's own cleanup, bounded: stop the turn, close the
 *    session (tool servers, background jobs, the `session_end` hook) and, for
 *    the TUI, hand the terminal back;
 * 3. dies of the signal it was sent, so the parent sees the conventional
 *    status (a shell reports 143 for SIGTERM, 129 for SIGHUP, 130 for SIGINT).
 *
 * A second signal while that is under way exits at once. SIGKILL runs no code
 * at all; its lease is freed when it expires.
 */

import { constants } from 'node:os'

import { releaseHeldSessionLeases } from '@namzu/sdk'

/** The signals a turn-running command answers by giving its conversation back. */
export const TERMINATION_SIGNALS = ['SIGTERM', 'SIGHUP', 'SIGINT'] as const
export type TerminationSignal = (typeof TERMINATION_SIGNALS)[number]

/** How long step 1 may take. Local lease files; a release that has not landed by then is left to expiry. */
const LEASE_RELEASE_MS = 2_000
/** How long step 2 may take: above the TUI's own bounded session close (5 s). */
const CLEANUP_MS = 6_000
/** If a re-raised signal does not end the process (a listener swallowed it), exit anyway after this. */
const RERAISE_GRACE_MS = 1_000

let terminating: TerminationSignal | null = null

/**
 * The signal this process is stopping for, or `null`. The binary's own exit
 * path consults it: once a signal is being handled, the handler ends the
 * process, and a command that returns meanwhile must not exit ahead of it.
 */
export function terminationInProgress(): TerminationSignal | null {
	return terminating
}

export interface TerminationHandling {
	/** Add a cleanup step (run in the order added, after the leases are released). */
	onTerminate(cleanup: (signal: TerminationSignal) => Promise<void> | void): void
	/** Stop listening: the command finished on its own. */
	dispose(): void
}

/** The process surface this uses, for a test to substitute. */
export interface TerminationProcess {
	on(signal: TerminationSignal, listener: () => void): unknown
	removeListener(signal: TerminationSignal, listener: () => void): unknown
	kill(pid: number, signal: TerminationSignal): unknown
	exit(code: number): never
	readonly pid: number
	readonly platform: NodeJS.Platform
}

export interface HandleTerminationOptions {
	readonly process?: TerminationProcess
	readonly leaseReleaseMs?: number
	readonly cleanupMs?: number
	/** Test hook: called instead of the re-raise at the end. */
	readonly onFinished?: (signal: TerminationSignal) => void
}

function bounded(work: Promise<unknown>, ms: number): Promise<void> {
	let timer: NodeJS.Timeout | undefined
	return Promise.race([
		work.then(
			() => undefined,
			() => undefined,
		),
		new Promise<void>((resolve) => {
			timer = setTimeout(resolve, ms)
		}),
	]).finally(() => clearTimeout(timer))
}

/** 128 + the signal's number: what a shell reports for a process the signal killed. */
export function signalExitCode(signal: TerminationSignal): number {
	return 128 + (constants.signals[signal] ?? 15)
}

/**
 * Answer SIGTERM, SIGHUP and SIGINT as the module header describes, until
 * {@link TerminationHandling.dispose}.
 */
export function handleTerminationSignals(
	options: HandleTerminationOptions = {},
): TerminationHandling {
	const proc: TerminationProcess = options.process ?? (process as unknown as TerminationProcess)
	const cleanups: Array<(signal: TerminationSignal) => Promise<void> | void> = []
	let disposed = false

	const detach = (): void => {
		for (const signal of TERMINATION_SIGNALS) proc.removeListener(signal, listeners[signal])
	}

	const finish = (signal: TerminationSignal): void => {
		detach()
		if (options.onFinished) {
			options.onFinished(signal)
			return
		}
		// Windows cannot deliver a signal to itself; the exit status is the
		// closest honest report.
		if (proc.platform === 'win32') proc.exit(signalExitCode(signal))
		setTimeout(() => proc.exit(signalExitCode(signal)), RERAISE_GRACE_MS)
		proc.kill(proc.pid, signal)
	}

	const handle = async (signal: TerminationSignal): Promise<void> => {
		if (terminating !== null) {
			// The second signal: the operator is not waiting for the cleanup.
			proc.exit(signalExitCode(signal))
			return
		}
		terminating = signal
		await releaseHeldSessionLeases({ timeoutMs: options.leaseReleaseMs ?? LEASE_RELEASE_MS })
		await bounded(
			(async () => {
				for (const cleanup of cleanups) {
					try {
						await cleanup(signal)
					} catch {
						// A failed cleanup step must not stop the next one, nor the exit.
					}
				}
			})(),
			options.cleanupMs ?? CLEANUP_MS,
		)
		finish(signal)
	}

	const listeners = Object.fromEntries(
		TERMINATION_SIGNALS.map((signal) => [signal, () => void handle(signal)]),
	) as Record<TerminationSignal, () => void>
	for (const signal of TERMINATION_SIGNALS) proc.on(signal, listeners[signal])

	return {
		onTerminate(cleanup) {
			cleanups.push(cleanup)
		},
		dispose() {
			if (disposed) return
			disposed = true
			// Once a signal is being handled, the handler owns the exit.
			if (terminating === null) detach()
		},
	}
}

/**
 * A command handler that answers the termination signals for as long as it
 * runs. The handler adds its own cleanup once it has something to clean up.
 */
export function withTerminationHandling<A>(
	handler: (args: A, termination: TerminationHandling) => Promise<number>,
): (args: A) => Promise<number> {
	return async (args) => {
		const termination = handleTerminationSignals()
		try {
			return await handler(args, termination)
		} finally {
			termination.dispose()
		}
	}
}

/** @internal For tests: forget a handled signal. */
export function resetTerminationForTests(): void {
	terminating = null
}
