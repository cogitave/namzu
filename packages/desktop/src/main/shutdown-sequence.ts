/**
 * What quitting does, and in which order. Steps that need each other stay in order; the rest run
 * at the same time, so a quit costs its slowest step instead of the sum of all of them.
 *
 * 1. Listening stops and the terminals write their last screens. The terminals' hosts are still
 *    running at this point, because their screens are read from them.
 * 2. Only then do the runtimes stop (they flush their own journals while ending), the speech
 *    engines are released and the idle Pal computer machine is stopped, all at once. The machine stop
 *    is safe beside them: it does nothing while a Pal computer runs, and `computer stop-idle` refuses
 *    while anything does.
 * 3. The live viewer's port closes once the runtimes have stopped, because a runtime lets go of its
 *    live viewers while it ends.
 */
export interface ShutdownSteps {
	stopListening: () => Promise<void>
	shutdownTerminals: () => Promise<void>
	closeRuntimes: () => Promise<void>
	disposeSpeech: () => Promise<void>
	disposeListening: () => Promise<void>
	/** Stops the Pal computer's machine when none runs. Never required for a clean quit. */
	stopComputer: () => Promise<void>
	closeStreams: () => Promise<void>
	record: (error: unknown) => void
	/** Runs `run` after `ms`; returns the way to cancel it. */
	after: (ms: number, run: () => void) => () => void
}

/** The most quitting waits for the machine stop; it goes on without it after this. */
export const COMPUTER_STOP_CAP_MS = 6000

/** Runs the steps; rejects with the first failure that matters (a runtime that did not stop). */
export async function runShutdown(steps: ShutdownSteps): Promise<void> {
	await Promise.all(
		[steps.stopListening, steps.shutdownTerminals].map((step) =>
			step().catch((error: unknown) => steps.record(error)),
		),
	)
	let cancel: (() => void) | undefined
	const computer = new Promise<void>((resolve) => {
		cancel = steps.after(COMPUTER_STOP_CAP_MS, resolve)
		steps
			.stopComputer()
			.catch((error: unknown) => steps.record(error))
			.then(resolve)
	}).finally(() => cancel?.())
	const released = Promise.allSettled([steps.disposeSpeech(), steps.disposeListening()])
	const [runtimes] = await Promise.allSettled([steps.closeRuntimes()])
	// Only after the runtimes: they let go of the live viewers while they end.
	const [streams] = await Promise.allSettled([steps.closeStreams()])
	const required = [runtimes, ...(await released), streams]
	await computer
	const failed = required.find((result) => result.status === 'rejected')
	if (failed?.status === 'rejected') throw failed.reason
}
