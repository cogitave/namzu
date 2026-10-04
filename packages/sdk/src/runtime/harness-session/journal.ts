import { createHash, randomUUID } from 'node:crypto'
import { assertSessionLogAttribution } from '../../manager/session/attribution.js'
import type { SessionLease, SessionLog, SessionRecordDraft } from '../../store/session-log/index.js'
import {
	HarnessBindingSchema,
	HarnessJournalTransitionSchema,
	harnessSnapshot,
} from '../../types/harness/schema.js'
import type {
	HarnessBinding,
	HarnessJournalTransition,
	HarnessScope,
} from '../../types/harness/session.js'
import { type SessionEvent, isEphemeralEvent } from '../../types/session/events.js'

export class HarnessSessionError extends Error {
	override readonly name = 'HarnessSessionError'
	constructor(
		readonly code: string,
		message: string,
	) {
		super(message)
	}
}

/** Stable hash for captured JSON; object insertion order never changes authority. */
export function harnessDigest(value: unknown): string {
	const canonical = (v: unknown): unknown => {
		if (Array.isArray(v)) return v.map(canonical)
		if (!v || typeof v !== 'object') return v
		return Object.fromEntries(
			Object.entries(v)
				.sort(([a], [b]) => a.localeCompare(b))
				.map(([k, entry]) => [k, canonical(entry)]),
		)
	}
	return createHash('sha256')
		.update(JSON.stringify(canonical(value)))
		.digest('hex')
}

export class HarnessJournal {
	private leaseToken?: SessionLease
	private heartbeat?: ReturnType<typeof setInterval>
	private renewals: Promise<void> = Promise.resolve()
	private failure?: unknown
	private readonly holder = `harness:${process.pid}:${randomUUID()}`
	private readonly ttlMs = 60000
	constructor(
		readonly log: SessionLog,
		readonly scope: HarnessScope,
		readonly engineId: string,
		readonly profileRef: string,
	) {}

	async inspect(): Promise<{ binding?: HarnessBinding; transitions: HarnessJournalTransition[] }> {
		const opened = await assertSessionLogAttribution(this.log, this.scope)
		if (!opened) return { transitions: [] }
		const { entries } = await this.log.readAll()
		const start = entries[0]?.record
		if (
			start?.type !== 'session_started' ||
			!start.harness ||
			start.parent ||
			start.forkedFrom ||
			start.cwd !== this.scope.cwd
		) {
			throw new HarnessSessionError(
				'binding-mismatch',
				'Only an ordinary session with an exact immutable harness binding may be reopened.',
			)
		}
		const binding = harnessSnapshot(HarnessBindingSchema.parse(start.harness))
		this.validateBinding(binding)
		const transitions = entries.flatMap(({ record }) =>
			record.type === 'session_updated' && record.harness
				? [HarnessJournalTransitionSchema.parse(record.harness)]
				: [],
		)
		return { binding, transitions }
	}

	validateBinding(binding: HarnessBinding): void {
		if (
			binding.engineId !== this.engineId ||
			binding.profileRef !== this.profileRef ||
			binding.cwd !== this.scope.cwd
		) {
			throw new HarnessSessionError(
				'binding-mismatch',
				'The engine, profile or canonical execution directory differs from this session binding.',
			)
		}
	}

	async claim(): Promise<void> {
		await this.inspect() // never repair a foreign journal before validating ownership
		if (this.leaseToken) {
			await this.current()
			return
		}
		const lease = await this.log.claim({
			holder: this.holder,
			ttlMs: this.ttlMs,
			repairTornTail: false,
		})
		if (!lease) throw new HarnessSessionError('writer-busy', 'Another writer owns this session.')
		this.leaseToken = lease
		try {
			await this.inspect()
		} catch (error) {
			await this.release()
			throw error
		}
		this.heartbeat = setInterval(() => {
			this.renewals = this.renewals
				.then(() => this.renew())
				.catch((error: unknown) => {
					this.failure ??= error
				})
		}, this.ttlMs / 2)
		this.heartbeat.unref()
	}

	private async renew(): Promise<void> {
		if (!this.leaseToken || this.failure) return
		const previous = this.leaseToken
		const next = await this.log.claim({
			holder: this.holder,
			ttlMs: this.ttlMs,
			repairTornTail: false,
		})
		if (!next || next.fence !== previous.fence)
			throw new HarnessSessionError('writer-lost', 'The harness session writer lease was lost.')
		this.leaseToken = next
	}

	async current(): Promise<SessionLease> {
		await this.renewals
		if (this.failure) throw this.failure
		if (!this.leaseToken)
			throw new HarnessSessionError('writer-missing', 'The harness session has no writer lease.')
		if (this.leaseToken.expiresAt - Date.now() < this.ttlMs / 2) await this.renew()
		const lease = await this.log.lease()
		if (!lease || lease.fence !== this.leaseToken.fence || lease.holder !== this.holder)
			throw new HarnessSessionError('writer-lost', 'The harness session writer lease was lost.')
		return this.leaseToken
	}

	async start(binding: HarnessBinding): Promise<void> {
		this.validateBinding(binding)
		const previous = await this.inspect()
		if (previous.binding) {
			if (harnessDigest(previous.binding) !== harnessDigest(binding))
				throw new HarnessSessionError(
					'binding-mismatch',
					'Native session binding changed on reconnect.',
				)
			return
		}
		await this.append({
			type: 'session_started',
			projectId: this.scope.projectId,
			tenantId: this.scope.tenantId,
			topicId: this.scope.topicId,
			cwd: this.scope.cwd,
			agent: { id: `harness:${binding.engineId}`, name: binding.engineId, type: 'harness' },
			harness: binding,
			origin: { protocol: 'sdk' },
		})
	}
	async append(draft: SessionRecordDraft) {
		return this.log.append(await this.current(), draft)
	}
	async transition(harness: HarnessJournalTransition): Promise<void> {
		await this.append({
			type: 'session_updated',
			harness: HarnessJournalTransitionSchema.parse(harness),
		})
	}
	async event(
		event: SessionEvent,
		publish: (event: SessionEvent) => void | Promise<void>,
	): Promise<void> {
		if (isEphemeralEvent(event)) {
			await this.current()
			await publish(event)
			return
		}
		const {
			sessionId: _session,
			v: _v,
			seq: _seq,
			generation: _gen,
			lineage: _lineage,
			...draft
		} = event
		const entry = await this.append(draft as SessionRecordDraft)
		await publish({ ...event, v: 1, seq: entry.record.seq, generation: entry.record.gen })
	}
	async release(): Promise<void> {
		if (this.heartbeat) clearInterval(this.heartbeat)
		this.heartbeat = undefined
		await this.renewals
		if (!this.leaseToken) return
		await this.log.release(this.leaseToken)
		this.leaseToken = undefined
	}
}
