/**
 * What a terminal does with a message from another session: accept it, hold it
 * for the person, or refuse it. One pure decision for mail from another machine
 * and mail from another terminal of this machine, plus the counters and the
 * hold queue that decision depends on.
 *
 * A held message is not in the model's context and approves nothing. It waits
 * for the person for ten minutes; if nobody answers it expires and the sender
 * is told. Allowing is "allow once": nothing is remembered.
 *
 * @experimental
 */

import type { NetworkClock } from './clock.js'
import { MAX_HOPS, MAX_NET_TEXT_BYTES } from './wire.js'

export type MailSetting = 'members' | 'hold' | 'off'

export interface MailDecisionInput {
	readonly scope: 'remote' | 'local'
	readonly text: string
	readonly hops: number
	readonly receiver: {
		readonly mode: string | undefined
		readonly bypass: boolean
		/** The terminal takes messages at all (`enabled`, ready). */
		readonly accepting: boolean
		readonly setting: MailSetting
	}
	readonly sender: {
		/** What the sender says its mode is. */
		readonly claimedMode: string
		/** What its machine's own roster says. Absent when it could not be vouched for. */
		readonly vouchedMode: string | undefined
	}
	/** False when the sending machine's bucket is empty. */
	readonly rateOk: boolean
	/** Messages between this pair of sessions in the last 60 seconds, counting this one. */
	readonly pairCount: number
}

export type MailDecision =
	| { readonly action: 'accept' }
	| { readonly action: 'hold'; readonly reason: string }
	| { readonly action: 'refuse'; readonly reason: string }

export const LOOP_THRESHOLD = 8

export function decideMail(input: MailDecisionInput): MailDecision {
	const { receiver, sender } = input
	if (input.scope === 'remote' && receiver.setting === 'off') {
		return { action: 'refuse', reason: 'This machine does not take messages from other machines.' }
	}
	if (!receiver.accepting)
		return { action: 'refuse', reason: 'That terminal is not taking messages.' }
	if (input.text.trim().length === 0) return { action: 'refuse', reason: 'The message is empty.' }
	if (Buffer.byteLength(input.text, 'utf8') > MAX_NET_TEXT_BYTES) {
		return { action: 'refuse', reason: 'The message is too long.' }
	}
	if (input.scope === 'remote' && !input.rateOk) {
		return {
			action: 'refuse',
			reason: 'Too many messages from that machine; try again in a moment.',
		}
	}
	if (input.scope === 'remote' && input.hops > MAX_HOPS) {
		return { action: 'refuse', reason: 'This conversation between sessions is going in circles.' }
	}
	if (receiver.mode === undefined)
		return { action: 'hold', reason: 'its permission mode is not known' }
	if (receiver.bypass) return { action: 'hold', reason: 'this terminal is in bypass mode' }
	if (sender.vouchedMode === undefined || sender.claimedMode !== sender.vouchedMode) {
		return { action: 'hold', reason: 'the sender’s permission mode could not be confirmed' }
	}
	if (sender.vouchedMode !== receiver.mode) {
		return {
			action: 'hold',
			reason: `its permission mode differs (it is in ${sender.vouchedMode}, you are in ${receiver.mode})`,
		}
	}
	if (input.pairCount > LOOP_THRESHOLD)
		return { action: 'hold', reason: 'these two sessions are messaging each other very fast' }
	if (input.scope === 'remote' && receiver.setting === 'hold') {
		return {
			action: 'hold',
			reason: 'you asked to see every message from your other machines first',
		}
	}
	return { action: 'accept' }
}

export interface TokenBucketOptions {
	readonly capacity: number
	/** Tokens added per second. */
	readonly refillPerSecond: number
	readonly clock: NetworkClock
}

/** A token bucket per key. Empty means refuse until the clock refills it. */
export class TokenBuckets {
	private readonly state = new Map<string, { tokens: number; at: number }>()
	constructor(private readonly options: TokenBucketOptions) {}

	take(key: string): boolean {
		const now = this.options.clock.now()
		const prior = this.state.get(key) ?? { tokens: this.options.capacity, at: now }
		const tokens = Math.min(
			this.options.capacity,
			prior.tokens + ((now - prior.at) / 1000) * this.options.refillPerSecond,
		)
		if (tokens < 1) {
			this.state.set(key, { tokens, at: now })
			return false
		}
		this.state.set(key, { tokens: tokens - 1, at: now })
		return true
	}
}

/** A sliding window counter per key, for "more than N in the last W ms". */
export class SlidingCounter {
	private readonly hits = new Map<string, number[]>()
	constructor(
		private readonly clock: NetworkClock,
		private readonly windowMs: number,
	) {}

	/** Record one hit and return how many fall in the window, this one included. */
	record(key: string): number {
		const now = this.clock.now()
		const recent = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs)
		recent.push(now)
		this.hits.set(key, recent)
		if (this.hits.size > 512) {
			for (const [k, v] of this.hits)
				if (v.every((t) => now - t >= this.windowMs)) this.hits.delete(k)
		}
		return recent.length
	}
}

export const HOLD_EXPIRY_MS = 10 * 60 * 1000
export const MAX_HELD_PER_TERMINAL = 8

export interface HoldQueueOptions<T> {
	readonly clock: NetworkClock
	readonly expiryMs?: number
	readonly capacity?: number
	readonly onExpire: (id: string, item: T) => void
}

export interface HeldEntry<T> {
	readonly id: string
	readonly item: T
	readonly heldAt: number
	readonly expiresAt: number
}

/** Mail waiting for the person. Holds nothing past its expiry. */
export class HoldQueue<T> {
	private readonly entries = new Map<string, HeldEntry<T> & { cancel: () => void }>()
	constructor(private readonly options: HoldQueueOptions<T>) {}

	/** False when the queue is full; the caller refuses instead. */
	hold(id: string, item: T): boolean {
		if (this.entries.has(id)) return true
		if (this.entries.size >= (this.options.capacity ?? MAX_HELD_PER_TERMINAL)) return false
		const heldAt = this.options.clock.now()
		const expiryMs = this.options.expiryMs ?? HOLD_EXPIRY_MS
		const cancel = this.options.clock.setTimer(() => {
			if (this.entries.delete(id)) this.options.onExpire(id, item)
		}, expiryMs)
		this.entries.set(id, { id, item, heldAt, expiresAt: heldAt + expiryMs, cancel })
		return true
	}

	/** Take an entry out of the queue (allow or deny). */
	release(id: string): HeldEntry<T> | undefined {
		const entry = this.entries.get(id)
		if (!entry) return undefined
		entry.cancel()
		this.entries.delete(id)
		return entry
	}

	list(): readonly HeldEntry<T>[] {
		return [...this.entries.values()]
	}

	get size(): number {
		return this.entries.size
	}

	clear(): void {
		for (const e of this.entries.values()) e.cancel()
		this.entries.clear()
	}
}
