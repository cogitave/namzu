import type { Message } from '@namzu/sdk'

import { assistantTranscriptTexts } from '../tui/conversation-history.js'
import { frameReminder, isOperatorTurn, reminderKindOf } from './frame.js'

/**
 * A nudge after a long quiet stretch.
 *
 * On a screen someone is watching, a model may work for minutes and many tool
 * calls without one visible sentence. Our doctrine already asks for a few
 * words after a long stretch and small models do not do it, so the runtime
 * asks once, at the moment it is true.
 *
 * It fires when at least `afterMs` of work and `afterCalls` tool calls have
 * passed since the person last saw text from the assistant, or since their own
 * message, and not again until visible text resets the stretch. Time spent
 * waiting on the person (a permission prompt, a question) does not count, and
 * neither does time between turns.
 *
 * The count of calls and whether the nudge was already said are read from the
 * conversation itself, so a resumed or compacted conversation needs nothing
 * carried over. Only the clock is state, and it is injected.
 *
 * Measurement, 168 benchmark runs on the two small models: the longest quiet
 * stretch of a run had a median of 8 s and a maximum of 59 s, and a third of
 * the runs passed 6 calls in under a minute. Calls alone cannot tell a short
 * task from a long one; time can. 90 s sits above the longest of them.
 */
export const QUIET_STRETCH_MS = 90_000
export const QUIET_STRETCH_CALLS = 6

export interface QuietStretchOptions {
	readonly afterMs?: number
	readonly afterCalls?: number
	/** Milliseconds; injected so a test advances time by hand. */
	readonly now: () => number
}

const NUDGE =
	'You have been working for a while without telling the person anything. In your next response, write one sentence on what you are doing and what you have found so far, and make your next tool call in that same response, then carry on. Do not stop to wait for a reply, and do not repeat this note. It is for you alone.'

/** Where the current quiet stretch begins: the person's last message, or the assistant's last visible text. */
function stretchStart(messages: readonly Message[]): number {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i] as Message
		if (isOperatorTurn(message)) return i
		if (message.role === 'assistant' && assistantTranscriptTexts(message).length > 0) return i
	}
	return -1
}

export class QuietStretch {
	readonly #afterMs: number
	readonly #afterCalls: number
	readonly #now: () => number
	/** Which stretch the clock below is counting. */
	#key: string | undefined
	#active = 0
	#lastSeen = 0
	#waitingSince: number | undefined
	#waiters = 0
	#waited = 0
	readonly #open = new Map<string, () => void>()

	constructor(options: QuietStretchOptions) {
		this.#afterMs = options.afterMs ?? QUIET_STRETCH_MS
		this.#afterCalls = options.afterCalls ?? QUIET_STRETCH_CALLS
		this.#now = options.now
	}

	/** A turn begins: the time since the last request was nobody's work. */
	turnStarted(): void {
		this.#lastSeen = this.#now()
		this.#waited = 0
		if (this.#waiters > 0) this.#waitingSince = this.#lastSeen
	}

	/**
	 * The turn is waiting on the person. Call the returned function when they
	 * have answered. Waits may overlap (several questions at once).
	 */
	waitStarted(): () => void {
		if (this.#waiters === 0) this.#waitingSince = this.#now()
		this.#waiters += 1
		let ended = false
		return () => {
			if (ended) return
			ended = true
			this.#waiters -= 1
			if (this.#waiters === 0 && this.#waitingSince !== undefined) {
				this.#waited += this.#now() - this.#waitingSince
				this.#waitingSince = undefined
			}
		}
	}

	/**
	 * Feed the session's events: a tool review or a question to the person opens
	 * a wait, and its answer (or the turn stopping) closes it.
	 */
	observe(event: { readonly type: string; readonly questionId?: string }): void {
		switch (event.type) {
			case 'tool_review_requested':
				if (!this.#open.has('review')) this.#open.set('review', this.waitStarted())
				break
			case 'user_question_asked':
				if (!this.#open.has(`q:${event.questionId ?? ''}`))
					this.#open.set(`q:${event.questionId ?? ''}`, this.waitStarted())
				break
			case 'tool_review_completed':
				this.#close('review')
				break
			case 'user_question_answered':
				// An answer may not name its question: it closes whichever is open.
				for (const key of [...this.#open.keys()])
					if (
						key.startsWith('q:') &&
						(event.questionId === undefined || key === `q:${event.questionId}`)
					)
						this.#close(key)
				break
			case 'turn_paused':
			case 'turn_completed':
			case 'turn_failed':
				for (const key of [...this.#open.keys()]) this.#close(key)
				break
		}
	}

	#close(key: string): void {
		this.#open.get(key)?.()
		this.#open.delete(key)
	}

	/** Called at the start of every model request; says what, if anything, to tell the model. */
	remind(messages: readonly Message[]): string[] {
		const now = this.#now()
		const start = stretchStart(messages)
		const anchor = start >= 0 ? (messages[start] as Message) : undefined
		const key = `${start}:${anchor?.role ?? ''}:${anchor?.timestamp ?? ''}`
		// A wait still open counts up to now, then starts again from now.
		let waited = this.#waited
		if (this.#waitingSince !== undefined) {
			waited += now - this.#waitingSince
			this.#waitingSince = now
		}
		this.#waited = 0
		if (key !== this.#key) {
			this.#key = key
			this.#active = 0
		} else {
			this.#active += Math.max(0, now - this.#lastSeen - waited)
		}
		this.#lastSeen = now

		let calls = 0
		for (let i = start + 1; i < messages.length; i++) {
			const message = messages[i] as Message
			if (message.role === 'assistant') calls += message.toolCalls?.length ?? 0
			else if (reminderKindOf(message) === 'quiet-stretch') return []
		}
		if (calls < this.#afterCalls || this.#active < this.#afterMs) return []
		return [frameReminder('quiet-stretch', NUDGE)]
	}
}
