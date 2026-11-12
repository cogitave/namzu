/**
 * What starting a host needs from the engine delivery, and nothing about how engines are chosen.
 * The connection to a host asks a launcher to run its start; the launcher picks the engine, and
 * when a fetched engine fails it goes back and asks for one more start on another.
 */

/** How to run a host: a program, its arguments and its environment. */
export interface SpawnSpec {
	program: string
	args: string[]
	env?: NodeJS.ProcessEnv
}

/** A host that is up, held against its engine's folder being removed. */
export interface HostRun {
	/** The host ended. `unexpected` is false when the app asked for it (a close, a quit). */
	exited(unexpected: boolean): void
}

export interface HostLauncher {
	/**
	 * Runs `attempt` with the engine to use. `attempt` throws when the host fails to spawn, to answer
	 * `initialize`, or lacks a required method. `retryable` tells it that a failure will be answered
	 * by another try, so it should not report the failure to anyone yet. `isFault` says whether a
	 * failure is the engine's (a project folder that is gone is not).
	 */
	start(
		attempt: (spec: SpawnSpec, info: { retryable: boolean }) => Promise<void>,
		isFault: (error: unknown) => boolean,
	): Promise<HostRun>
}
