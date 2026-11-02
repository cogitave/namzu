/**
 * The prompts waiting for the one place that may start a model turn.
 *
 * Every model-bound prompt enters this FIFO, including one submitted while
 * nothing is running: a prompt that bypassed it could start ahead of an older
 * queued one in the gap between a turn ending and the next start. The queue is
 * synchronous, so a turn that settles can ask "is anything waiting" and get the
 * answer the last caller left, not the one a render captured earlier.
 *
 * It also carries the pause. A failed or interrupted person's turn holds
 * automatic work until the person continues explicitly, and `epoch` counts
 * those explicit continuations so a failure that lands after one is told apart
 * from one that came before it.
 */

import type { QueuePause, QueuedPrompt } from './types.js'

export class RoundQueue<Trigger extends string = string> {
	#items: readonly QueuedPrompt<Trigger>[] = []
	#pause: QueuePause | null = null
	#epoch = 0
	readonly #listeners = new Set<() => void>()

	/** What is waiting now, in order. The same array until something changes. */
	readonly items = (): readonly QueuedPrompt<Trigger>[] => this.#items

	/** Why the queue is held, or `null` while it may run. */
	readonly pause = (): QueuePause | null => this.#pause

	/**
	 * Advanced by an explicit, model-bound human continuation. It also covers the
	 * interval after an error row is painted but before the failed turn settles,
	 * where a pause has not been installed yet.
	 */
	readonly epoch = (): number => this.#epoch

	readonly replace = (next: readonly QueuedPrompt<Trigger>[]): void => {
		this.#items = next
		this.#notify()
	}

	readonly enqueue = (prompt: QueuedPrompt<Trigger>): void => this.replace([...this.#items, prompt])

	readonly dequeue = (): QueuedPrompt<Trigger> | undefined => {
		const [next, ...rest] = this.#items
		if (next !== undefined) this.replace(rest)
		return next
	}

	readonly setPause = (next: QueuePause | null): void => {
		this.#pause = next
		this.#notify()
	}

	/** Empties the queue and lifts any hold. */
	readonly discard = (): void => {
		this.replace([])
		this.setPause(null)
	}

	/** A person's explicit "go on": counts it and lifts the hold. */
	readonly advanceContinuation = (): void => {
		this.#epoch += 1
		this.setPause(null)
	}

	/** For `useSyncExternalStore`. */
	readonly subscribe = (listener: () => void): (() => void) => {
		this.#listeners.add(listener)
		return () => {
			this.#listeners.delete(listener)
		}
	}

	#notify(): void {
		for (const listener of [...this.#listeners]) listener()
	}
}
