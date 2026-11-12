/**
 * Runs work once a promise has settled, and at once on every call after that. A terminal opens its
 * emulator through one: the emulator measures a character cell when it opens, so it opens after the
 * mono face is ready rather than measuring the stand-in and keeping that size.
 */
export class OpenGate {
	private open = false
	private queue: (() => void)[] = []

	constructor(ready: Promise<unknown> | undefined) {
		if (!ready) {
			this.open = true
			return
		}
		const release = () => {
			this.open = true
			const run = this.queue
			this.queue = []
			for (const job of run) job()
		}
		ready.then(release, release)
	}

	get isOpen(): boolean {
		return this.open
	}

	/** Run `job` now when the gate is open, else when it opens. */
	run(job: () => void): void {
		if (this.open) job()
		else this.queue.push(job)
	}
}
