/**
 * Whether this process is stopping for a signal, and which one.
 *
 * Split from `termination.ts` because the binary's exit path asks it, and
 * `termination.ts` imports the SDK to give back session leases: asking
 * "is a signal being handled" at startup compiled the SDK for `--version`.
 */

/** The signals a turn-running command answers by giving its conversation back. */
export const TERMINATION_SIGNALS = ['SIGTERM', 'SIGHUP', 'SIGINT'] as const
export type TerminationSignal = (typeof TERMINATION_SIGNALS)[number]

let terminating: TerminationSignal | null = null

/**
 * The signal this process is stopping for, or `null`. The binary's own exit
 * path consults it: once a signal is being handled, the handler ends the
 * process, and a command that returns meanwhile must not exit ahead of it.
 */
export function terminationInProgress(): TerminationSignal | null {
	return terminating
}

/** Record that the process is stopping for `signal`; `null` clears it (tests). */
export function setTerminating(signal: TerminationSignal | null): void {
	terminating = signal
}
