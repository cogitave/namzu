/**
 * The live switch for computer use in one open conversation.
 *
 * The person turns `computerUse.enabled` on or off in `/config` or Settings. The tool used to be
 * mounted once, when the session was built, so a change did nothing until the next conversation.
 * This follows the setting between messages instead:
 *
 * - `refresh()` is awaited at the top of every turn, before the request is built. It reads the
 *   setting (or takes the value a write just reported through `notify`) and, the first time it is
 *   on, starts the host exactly once.
 * - `ready()` is read for every request. It is false the moment the setting is off, so the tool
 *   leaves the next request even in the middle of a turn that was already running.
 * - A host that does not start stays suspended with its reason and is not retried while the
 *   setting stays on. Turning it off and on again tries once more. The model is told why.
 * - A setting that cannot be read counts as off.
 */

export type ComputerUseLiveState = 'idle' | 'starting' | 'ready' | 'failed'

export interface ComputerUseLive {
	/** Whether the tool may be offered now: the setting is on and the host started. */
	ready(): boolean
	/** The setting as last read or reported. */
	wanted(): boolean
	readonly state: ComputerUseLiveState
	/** Why the host did not start, while `state` is `failed`. */
	readonly failure: Error | undefined
	/** Follow the setting; starts the host the first time it is on. Never throws. */
	refresh(): Promise<void>
	/**
	 * The setting was just written with this value. It takes effect at once, and the next
	 * `refresh()` skips reading the file. The file stays the source of truth after that.
	 */
	notify(value: boolean): void
}

export interface ComputerUseLiveOptions {
	/** The setting as the files and the managed layer say it now. */
	readonly read: () => boolean
	/** Start the host. Throws when it cannot start. */
	readonly start: () => Promise<void>
}

export function createComputerUseLive(options: ComputerUseLiveOptions): ComputerUseLive {
	let state: ComputerUseLiveState = 'idle'
	let failure: Error | undefined
	let wanted = false
	let reported = false
	let starting: Promise<void> | undefined

	const begin = (): Promise<void> => {
		state = 'starting'
		failure = undefined
		const run = (async () => {
			try {
				await options.start()
				state = 'ready'
			} catch (error) {
				failure = error instanceof Error ? error : new Error(String(error))
				state = 'failed'
			} finally {
				starting = undefined
			}
		})()
		starting = run
		return run
	}

	return {
		ready: () => wanted && state === 'ready',
		wanted: () => wanted,
		get state() {
			return state
		},
		get failure() {
			return failure
		},
		async refresh() {
			if (reported) {
				reported = false
			} else {
				try {
					wanted = options.read()
				} catch {
					// A consent key fails closed: a file that does not load right now means off, so a
					// managed off that cannot be parsed is never overridden by an earlier on.
					wanted = false
				}
			}
			if (!wanted) {
				// Off: a failed start is forgotten so the next flip to on tries again. A host that
				// started stays up until the session ends.
				if (state === 'failed') {
					state = 'idle'
					failure = undefined
				}
				return
			}
			if (state === 'idle') await begin()
			else if (starting) await starting
		},
		notify(value) {
			wanted = value
			reported = true
		},
	}
}
