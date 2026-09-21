import type { SessionId } from '../../types/ids/index.js'
import {
	type LogMedium,
	SessionLogConflictError,
	SessionLogCore,
	type SessionLogCoreOptions,
} from './core.js'
import { InMemorySessionLeaseStore, type SessionLeaseStore } from './lease.js'
import { InMemorySpillStore, type SpillStore } from './spill.js'

/**
 * A session log held in process: the same bytes, chain, turn rules, lease and
 * spills as the disk log, so the conformance suite holds both to one
 * contract. An in-memory session keeps its whole log, lease and spills in
 * this process and loses them with it.
 */

/** A log's bytes in memory. Exposed so a test can tear or corrupt them. */
export class InMemoryLogMedium implements LogMedium {
	#bytes: Buffer = Buffer.alloc(0)

	async size(): Promise<number> {
		return this.#bytes.byteLength
	}

	async read(offset: number, length: number): Promise<Uint8Array> {
		return Uint8Array.prototype.slice.call(this.#bytes, offset, offset + length)
	}

	async *stream(offset: number): AsyncIterable<Uint8Array> {
		if (offset < this.#bytes.byteLength) {
			yield Uint8Array.prototype.slice.call(this.#bytes, offset)
		}
	}

	async append(bytes: Uint8Array, expectedOffset: number): Promise<void> {
		if (this.#bytes.byteLength !== expectedOffset) {
			throw new SessionLogConflictError(
				`The log is ${this.#bytes.byteLength} bytes; this writer verified it at ${expectedOffset}.`,
			)
		}
		this.#bytes = Buffer.concat([this.#bytes, bytes])
	}

	async truncate(size: number, expectedSize: number): Promise<void> {
		if (this.#bytes.byteLength !== expectedSize) {
			throw new SessionLogConflictError(
				`The log is ${this.#bytes.byteLength} bytes, not the ${expectedSize} measured before repairing its tail.`,
			)
		}
		this.#bytes = this.#bytes.subarray(0, size)
	}

	/** A copy of the log's bytes. */
	bytes(): Buffer {
		return Buffer.from(this.#bytes)
	}

	/** Replace the log's bytes wholesale (tests: tear a tail, flip a byte). */
	overwrite(bytes: Uint8Array): void {
		this.#bytes = Buffer.from(bytes)
	}
}

export interface InMemorySessionLogOptions
	extends Pick<SessionLogCoreOptions, 'now' | 'spillAboveBytes'> {
	readonly sessionId: SessionId
	/**
	 * Share storage with another instance, as a second process would see one
	 * disk log. Each defaults to a fresh store.
	 */
	readonly medium?: InMemoryLogMedium
	readonly leases?: SessionLeaseStore
	readonly spills?: SpillStore
}

export class InMemorySessionLog extends SessionLogCore {
	readonly medium: InMemoryLogMedium
	readonly leaseStore: SessionLeaseStore
	readonly spillStore: SpillStore
	readonly #options: InMemorySessionLogOptions

	constructor(options: InMemorySessionLogOptions) {
		const medium = options.medium ?? new InMemoryLogMedium()
		const leases = options.leases ?? new InMemorySessionLeaseStore()
		const spills = options.spills ?? new InMemorySpillStore()
		super({
			sessionId: options.sessionId,
			medium,
			leases,
			spills,
			now: options.now,
			spillAboveBytes: options.spillAboveBytes,
			sync: 'none',
		})
		this.medium = medium
		this.leaseStore = leases
		this.spillStore = spills
		this.#options = options
	}

	/** Another instance over the same log, lease and spills: what a second process would open. */
	reopen(): InMemorySessionLog {
		return new InMemorySessionLog({
			...this.#options,
			medium: this.medium,
			leases: this.leaseStore,
			spills: this.spillStore,
		})
	}
}
