/** Live host facts only: no replay cursor, computer lease, private body or error text. */
export type PalLifecycleEvent =
	| { readonly type: 'computer.starting'; readonly palId: string }
	| {
			readonly type: 'computer.ready'
			readonly palId: string
			readonly generation: number
	  }
	| {
			readonly type: 'computer.stopping' | 'computer.stopped' | 'computer.stop-failed'
			readonly palId: string
			/** Omitted when releasing an invalid rejected lease, never an accepted generation. */
			readonly generation?: number
	  }
	| {
			readonly type: 'computer.start-failed'
			readonly palId: string
			readonly reason: 'unavailable' | 'cleanup-required'
	  }
	| {
			readonly type: 'admission.acquired'
			readonly palId: string
			readonly generation: number
			readonly conversationId: string
	  }
	| {
			readonly type: 'admission.released'
			readonly palId: string
			readonly generation: number
			readonly conversationId: string
			readonly reason: 'released' | 'closed'
	  }

export type PalLifecycleListener = (event: PalLifecycleEvent) => void | Promise<void>

/** Observer failures cannot backpressure or change computer/controller ownership. */
export class PalLifecycleEmitter {
	private readonly listeners = new Set<PalLifecycleListener>()
	on(listener: PalLifecycleListener): () => void {
		if (typeof listener !== 'function') throw new TypeError('A Pal lifecycle listener is required.')
		this.listeners.add(listener)
		return () => {
			this.listeners.delete(listener)
		}
	}
	emit(event: PalLifecycleEvent): void {
		const captured = Object.freeze({ ...event })
		for (const listener of [...this.listeners]) {
			try {
				void Promise.resolve(listener(captured)).catch(() => {})
			} catch {}
		}
	}
}
