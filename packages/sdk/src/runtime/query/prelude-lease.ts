import { DEFAULT_TURN_LEASE_TTL_MS } from '../../manager/session/turn-recorder.js'
import { type SessionLease, type SessionLog, isLeaseLive } from '../../store/session-log/index.js'
import { NamzuError } from '../../types/errors/index.js'
import type { SessionId, TurnId } from '../../types/ids/index.js'
import { TurnInProgressError } from '../../types/session/turn.js'

/** Keep an internally claimed writer lease live while the query prelude awaits providers. */
export class PreludeSessionLease {
	readonly ownsLease: boolean
	readonly #log: SessionLog
	readonly #holder: string
	#current: SessionLease
	#renewal: Promise<void> = Promise.resolve()
	#renewalError: unknown
	#timer: ReturnType<typeof setInterval> | undefined
	#transferred = false

	private constructor(log: SessionLog, lease: SessionLease, ownsLease: boolean) {
		this.#log = log
		this.#current = lease
		this.#holder = lease.holder
		this.ownsLease = ownsLease
		if (ownsLease) {
			this.#timer = setInterval(() => this.#queueRenewal(), DEFAULT_TURN_LEASE_TTL_MS / 2)
			this.#timer.unref()
		}
	}

	static async acquire(
		log: SessionLog,
		sessionId: SessionId,
		turnId: TurnId,
		supplied?: SessionLease,
	): Promise<PreludeSessionLease> {
		if (supplied) return new PreludeSessionLease(log, supplied, false)
		const lease = await log.claim({
			holder: `namzu:${process.pid}:${turnId}`,
			ttlMs: DEFAULT_TURN_LEASE_TTL_MS,
			repairTornTail: false,
		})
		if (lease === null) {
			const active = await log.activeTurn()
			if (active) {
				throw new TurnInProgressError({
					sessionId,
					activeTurnId: active.turnId,
					state: 'running',
				})
			}
			throw new NamzuError({
				code: 'invalid_config',
				message: `Session ${sessionId} is leased by another writer; wait for it to finish or pass the lease you hold.`,
				details: { sessionId },
			})
		}
		return new PreludeSessionLease(log, lease, true)
	}

	#queueRenewal(): void {
		this.#renewal = this.#renewal
			.then(async () => {
				if (this.#renewalError !== undefined) return
				const renewed = await this.#log.claim({
					holder: this.#holder,
					ttlMs: DEFAULT_TURN_LEASE_TTL_MS,
					repairTornTail: false,
				})
				if (renewed === null || renewed.fence !== this.#current.fence) {
					if (renewed !== null) await this.#log.release(renewed).catch(() => undefined)
					throw new NamzuError({
						code: 'invalid_config',
						message: `Session ${this.#log.sessionId} lost its writer lease during turn preparation.`,
						details: { sessionId: this.#log.sessionId },
					})
				}
				this.#current = renewed
			})
			.catch((error: unknown) => {
				this.#renewalError ??= error
			})
	}

	/** Confirm the holding before the next prelude side effect. */
	async assertCurrent(): Promise<void> {
		if (!this.ownsLease) {
			const held = await this.#log.lease()
			const now = Date.now()
			if (
				!isLeaseLive(this.#current, now) ||
				!isLeaseLive(held, now) ||
				held?.fence !== this.#current.fence ||
				held.holder !== this.#current.holder
			) {
				throw new NamzuError({
					code: 'invalid_config',
					message: `Session ${this.#log.sessionId} no longer holds the supplied writer lease.`,
					details: { sessionId: this.#log.sessionId },
				})
			}
			return
		}
		this.#queueRenewal()
		await this.#renewal
		if (this.#renewalError !== undefined) throw this.#renewalError
	}

	/** Hand the freshest token to TurnRecorder while this heartbeat covers open(). */
	async transfer(): Promise<SessionLease> {
		await this.assertCurrent()
		this.#transferred = true
		return this.#current
	}

	/** Stop once TurnRecorder has started its own owned-lease heartbeat. */
	async stop(): Promise<void> {
		this.#stop()
		await this.#renewal
	}

	/** Give back an owned lease when preparation failed before recorder.open. */
	async release(): Promise<void> {
		await this.stop()
		if (this.ownsLease && !this.#transferred) {
			await this.#log.release(this.#current).catch(() => undefined)
		}
	}

	#stop(): void {
		if (this.#timer !== undefined) clearInterval(this.#timer)
		this.#timer = undefined
	}
}
