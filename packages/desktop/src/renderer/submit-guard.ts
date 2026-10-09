/**
 * Lets one submit through at a time. It is a plain object read synchronously, not React state:
 * two clicks or two Enter presses can arrive before the next render says "saving".
 */
export interface SubmitGuard {
	readonly busy: boolean
	/** Runs the action unless one is running. Returns false when it was refused. */
	run(action: () => Promise<void>): boolean
}

export function createSubmitGuard(): SubmitGuard {
	let busy = false
	return {
		get busy() {
			return busy
		},
		run(action) {
			if (busy) return false
			busy = true
			const release = () => {
				busy = false
			}
			// The caller reports its own failure; the guard only lets go.
			void action().then(release, release)
			return true
		},
	}
}
