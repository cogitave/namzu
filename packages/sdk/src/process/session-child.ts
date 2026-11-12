import { readEnvironmentEntry, setEnvironmentEntry } from '../utils/process-environment.js'

/**
 * The name of the variable the kernel puts into the environment of every process it starts on a
 * session's behalf: a command the model ran, a hook, a tool server, a delegated or background run's
 * command, a terminal a session opened.
 *
 * It says one thing: this process, or one of its ancestors, was started by a running session, not by a
 * person at their own terminal. `namzu send` reads it and refuses, because a message to another session
 * is a person's, and a command a model ran is not a person.
 *
 * It is a marker and not a lock. Any process of the same account can start another with a cleaner
 * environment (`env -i`), so the kernel does not rely on it alone: the command-line permission layer
 * refuses the same command before it runs, and the receiving terminal checks the sender's process
 * ancestry. What a process of the same account can do after hiding both is the account boundary's to
 * hold, not this marker's.
 */
export const SESSION_CHILD_ENV = 'NAMZU_STARTED_BY_SESSION'

/** A copy of `env` that carries the marker. Everywhere the kernel builds a child's environment ends here. */
export function withSessionChildMarker<T extends Readonly<Record<string, string | undefined>>>(
	env: T,
	platform: NodeJS.Platform = process.platform,
): Record<string, string | undefined> {
	const out: Record<string, string> = {}
	for (const [name, value] of Object.entries(env)) if (value !== undefined) out[name] = value
	setEnvironmentEntry(out, SESSION_CHILD_ENV, '1', platform)
	return out
}

/** Whether `env` carries the marker: this process was started, directly or not, by a running session. */
export function startedBySession(
	env: Readonly<Record<string, string | undefined>> = process.env,
	platform: NodeJS.Platform = process.platform,
): boolean {
	const found = readEnvironmentEntry(env, SESSION_CHILD_ENV, platform)
	return found !== undefined && found[1] !== '' && found[1] !== '0'
}
