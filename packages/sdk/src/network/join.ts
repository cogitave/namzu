/**
 * The join handshake's two small pieces: the short code both screens show,
 * and the table of pending requests.
 *
 * The code is bound to the channel: it is computed from the two certificates'
 * machine ids as each side saw them plus both nonces. A machine relaying
 * between the joiner and a member presents different certificates on each leg,
 * so the two screens differ. Skipping the glance is allowed; it is the
 * documented residual risk.
 *
 * @experimental
 */

import { createHash } from 'node:crypto'
import type { NetworkClock } from './clock.js'

const CODE_DOMAIN = 'namzu-net/join/1'

/** Six digits from the channel facts. Same inputs, same code; any swapped fingerprint, a different one. */
export function joinCode(
	joinerMachineId: string,
	memberMachineId: string,
	joinerNonce: string,
	memberNonce: string,
): string {
	const digest = createHash('sha256')
		.update(
			JSON.stringify([CODE_DOMAIN, joinerMachineId, memberMachineId, joinerNonce, memberNonce]),
			'utf8',
		)
		.digest()
	return String(digest.readUInt32BE(0) % 1_000_000).padStart(6, '0')
}

/** `482913` as `482 913`. */
export function formatJoinCode(code: string): string {
	return `${code.slice(0, 3)} ${code.slice(3)}`
}

export const JOIN_EXPIRY_MS = 10 * 60 * 1000
export const MAX_PENDING_JOINS = 8
export const JOIN_ADDRESS_WINDOW_MS = 60 * 1000
/** After a person denied the ask, this machine does not ask that network again on its own for this long. */
export const JOIN_BACKOFF_DENIED_MS = 60 * 60 * 1000
/** After the ask expired unanswered or was refused: shorter, because nobody said no. */
export const JOIN_BACKOFF_OTHER_MS = 10 * 60 * 1000

export interface PendingJoin {
	readonly requestId: string
	readonly name: string
	readonly code: string
	readonly sourceAddr: string
	readonly createdAt: number
	readonly expiresAt: number
	/** The member the joiner is connected to. */
	readonly viaMachineId: string
	/** True on the member the joiner reached; only there is the joiner's connection held. */
	readonly local: boolean
	readonly joinerMachineId?: string
	readonly joinerPublicKey?: string
}

export type JoinDecisionOutcome = 'ok' | 'already' | 'unknown'

const MAX_DECIDED = 512

export interface JoinTableOptions {
	readonly clock: NetworkClock
	readonly onExpire: (entry: PendingJoin) => void
}

export class JoinTable {
	private readonly entries = new Map<string, PendingJoin & { cancel: () => void }>()
	private readonly decided = new Map<string, 'allow' | 'deny' | 'expired'>()
	private readonly lastByAddress = new Map<string, number>()
	constructor(private readonly options: JoinTableOptions) {}

	/** A request that arrived on this machine. Refused when the address asked too recently or the table is full. */
	addLocal(
		input: Omit<PendingJoin, 'local' | 'expiresAt' | 'createdAt'>,
		options: { readonly replacing?: boolean } = {},
	): { ok: true; entry: PendingJoin } | { ok: false; reason: 'rate' | 'full' } {
		const now = this.options.clock.now()
		const last = this.lastByAddress.get(input.sourceAddr)
		// A machine that already has a request waiting replaces it; that is one request, not a second.
		if (!options.replacing && last !== undefined && now - last < JOIN_ADDRESS_WINDOW_MS)
			return { ok: false, reason: 'rate' }
		if (this.localCount() >= MAX_PENDING_JOINS) return { ok: false, reason: 'full' }
		this.lastByAddress.set(input.sourceAddr, now)
		return {
			ok: true,
			entry: this.insert({
				...input,
				local: true,
				createdAt: now,
				expiresAt: now + JOIN_EXPIRY_MS,
			}),
		}
	}

	/** A request another member told us about. */
	addRemote(input: Omit<PendingJoin, 'local' | 'expiresAt'>): PendingJoin | undefined {
		if (this.entries.has(input.requestId) || this.decided.has(input.requestId)) return undefined
		if (this.entries.size >= MAX_PENDING_JOINS * 2) return undefined
		const now = this.options.clock.now()
		// A request is as old as it says only up to now: a member cannot make one outlive its ten minutes.
		const createdAt = Math.min(input.createdAt, now)
		const expiresAt = createdAt + JOIN_EXPIRY_MS
		if (expiresAt <= now) return undefined
		return this.insert({ ...input, createdAt, local: false, expiresAt }, expiresAt - now)
	}

	private insert(entry: PendingJoin, ttl = JOIN_EXPIRY_MS): PendingJoin {
		const cancel = this.options.clock.setTimer(() => {
			if (this.entries.delete(entry.requestId)) {
				this.remember(entry.requestId, 'expired')
				this.options.onExpire(entry)
			}
		}, ttl)
		this.entries.set(entry.requestId, { ...entry, cancel })
		return entry
	}

	private localCount(): number {
		let n = 0
		for (const e of this.entries.values()) if (e.local) n++
		return n
	}

	/** The request waiting from this machine, if any: a machine has at most one. */
	findByJoiner(joinerMachineId: string): PendingJoin | undefined {
		return this.list().find((e) => e.joinerMachineId === joinerMachineId)
	}

	get(requestId: string): PendingJoin | undefined {
		return this.entries.get(requestId)
	}

	/** Find by request id, code (with or without the space) or the joiner's name. */
	find(query: string): PendingJoin | undefined {
		const q = query.trim()
		const digits = q.replace(/\s+/g, '')
		const all = this.list()
		// A name is only an address while it is unique: two requests with one name (a stranger copying
		// the real one) are told apart by their codes, never by whichever came first.
		const byName = all.filter((e) => e.name.toLowerCase() === q.toLowerCase())
		return (
			all.find((e) => e.requestId === q) ??
			all.find((e) => /^\d{6}$/.test(digits) && e.code === digits) ??
			(byName.length === 1 ? byName[0] : undefined)
		)
	}

	list(): readonly PendingJoin[] {
		return [...this.entries.values()].map(({ cancel: _cancel, ...rest }) => rest)
	}

	/** The first decision wins; a later one is `already`. */
	decide(requestId: string, decision: 'allow' | 'deny'): JoinDecisionOutcome {
		const entry = this.entries.get(requestId)
		if (!entry) return this.decided.has(requestId) ? 'already' : 'unknown'
		entry.cancel()
		this.entries.delete(requestId)
		this.remember(requestId, decision)
		return 'ok'
	}

	/** Record a decision made elsewhere (a gossiped `join_decision`). */
	settle(requestId: string, decision: 'allow' | 'deny'): void {
		const entry = this.entries.get(requestId)
		if (entry) {
			entry.cancel()
			this.entries.delete(requestId)
		}
		this.remember(requestId, decision)
	}

	private remember(requestId: string, decision: 'allow' | 'deny' | 'expired'): void {
		this.decided.set(requestId, decision)
		if (this.decided.size > MAX_DECIDED)
			this.decided.delete(this.decided.keys().next().value as string)
	}

	clear(): void {
		for (const e of this.entries.values()) e.cancel()
		this.entries.clear()
	}
}
