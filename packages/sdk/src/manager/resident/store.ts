import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { z } from 'zod'
import {
	DiskRevisionRecordStore,
	revisionFileSegment,
} from '../../store/kv/revision-record-store.js'
import { defineSchema } from '../../store/schema.js'
import type { TenantId } from '../../types/ids/index.js'
import { asTenantId } from '../../utils/id.js'

const text = z.string().trim().min(1).max(8_000)
const time = z.number().int().nonnegative().safe()
const decisionSchema = z.discriminatedUnion('kind', [
	z.object({ kind: z.literal('wait'), summary: text, wakeAt: time.nullable() }),
	z.object({ kind: z.literal('complete'), summary: text }),
	z.object({ kind: z.literal('blocked'), summary: text }),
])

/** @experimental One bounded step's durable disposition; silence is not completion. */
export type ResidentDecision = z.infer<typeof decisionSchema>

export const residentStateSchema = z
	.object({
		tenantId: z.string().uuid(),
		agentKey: z.string().min(1).max(200),
		pursuitId: z.string().uuid().optional(),
		identity: text,
		objective: text,
		revision: z.number().int().positive().safe(),
		stepsAdmitted: time,
		phase: z.enum(['waiting', 'running', 'complete', 'blocked']),
		wakeAt: time.nullable(),
		reason: text,
		summary: text.nullable(),
		claimId: z.string().uuid().nullable(),
	})
	.superRefine((state, context) => {
		if ((state.phase === 'running') !== (state.claimId !== null)) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				message: 'Running state requires a claim.',
			})
		}
		if (state.phase !== 'waiting' && state.wakeAt !== null) {
			context.addIssue({
				code: z.ZodIssueCode.custom,
				message: 'Only waiting state may have a wake time.',
			})
		}
	})

/** @experimental Persisted identity and one pursuit, independent of a conversation. */
export type ResidentState = Readonly<z.infer<typeof residentStateSchema>>

/** Bounded addressing for local resident state. Stored scope is still validated. */
export function residentKeySegment(key: string): string {
	const encoded = revisionFileSegment(key)
	return encoded.length <= 255
		? encoded
		: `~sha256-${createHash('sha256').update(encoded).digest('hex')}`
}

/** @experimental Minimal atomic contract needed to execute an existing pursuit. */
export type ResidentExecutionStore = Pick<ResidentStore, 'read' | 'claim' | 'settle'>

/** @experimental Backends must atomically compare revisions and publish admission before work. */
export interface ResidentStore {
	read(): Promise<ResidentState | null>
	create(identity: string, objective: string): Promise<ResidentState>
	claim(expected: ResidentState, now: number): Promise<ResidentState>
	settle(expected: ResidentState, decision: ResidentDecision, now: number): Promise<ResidentState>
	wake(expected: ResidentState, reason: string, now: number): Promise<ResidentState>
}

/** A competing owner advanced this resident's immutable revision. */
export class ResidentConflictError extends Error {
	constructor() {
		super('Resident state changed; read the current state before retrying.')
		this.name = 'ResidentConflictError'
	}
}

/**
 * @experimental Local-filesystem state for one tenant/agent key and one pursuit.
 * A running claim never expires automatically: a crashed step may have effects.
 * Uses exclusive immutable revision publication, not a read/rename lock.
 */
export class DiskResidentStore implements ResidentStore {
	private readonly records = new DiskRevisionRecordStore<ResidentState>(
		defineSchema({ kind: 'resident', current: 1, migrations: {} }),
		'resident store',
		(record) => record.revision,
	)
	private readonly location
	private readonly tenantId: TenantId
	private readonly agentKey: string

	constructor(root: string, scope: { tenantId: TenantId; agentKey: string }) {
		this.tenantId = asTenantId(scope.tenantId)
		this.agentKey = z.string().min(1).max(200).parse(scope.agentKey)
		const directory = join(root, this.tenantId, residentKeySegment(this.agentKey))
		this.location = {
			legacyPath: join(directory, 'state.json'),
			revisionsDir: join(directory, 'revisions'),
			publishLegacyProjection: false,
		}
	}

	private checked(record: ResidentState): ResidentState {
		const state = residentStateSchema.parse(record)
		if (
			state.pursuitId !== undefined ||
			state.tenantId !== this.tenantId ||
			state.agentKey !== this.agentKey
		) {
			throw new Error('Resident record does not match the bound tenant and agent.')
		}
		return Object.freeze(state)
	}

	async read(): Promise<ResidentState | null> {
		const state = await this.records.read(this.location)
		return state === null ? null : this.checked(state)
	}

	async create(identity: string, objective: string): Promise<ResidentState> {
		const initial = this.checked({
			tenantId: this.tenantId,
			agentKey: this.agentKey,
			identity,
			objective,
			revision: 1,
			stepsAdmitted: 0,
			phase: 'waiting',
			wakeAt: 0,
			reason: 'Initial pursuit',
			summary: null,
			claimId: null,
		})
		return this.records.transact(this.location, (current) => {
			if (current !== null) throw new ResidentConflictError()
			return { record: initial, result: initial }
		})
	}

	private async change(
		expected: ResidentState,
		mutate: (current: ResidentState) => ResidentState,
	): Promise<ResidentState> {
		this.checked(expected)
		return this.records.transact(this.location, (record) => {
			if (record === null) throw new ResidentConflictError()
			const current = this.checked(record)
			if (current.revision !== expected.revision || current.claimId !== expected.claimId) {
				throw new ResidentConflictError()
			}
			const next = this.checked({
				...mutate(current),
				revision: current.revision + 1,
			})
			return { record: next, result: next }
		})
	}

	/** Persist admission before invoking a model, tool or developer callback. */
	async claim(expected: ResidentState, now: number): Promise<ResidentState> {
		return this.change(expected, (state) => claimResidentState(state, now))
	}

	/** Only the exact admitted revision may settle; late owners cannot overwrite recovery. */
	async settle(
		expected: ResidentState,
		decision: ResidentDecision,
		now: number,
	): Promise<ResidentState> {
		return this.change(expected, (state) => settleResidentState(state, decision, now))
	}

	/** Host-supplied new evidence can wake a waiting pursuit; terminal work stays terminal. */
	async wake(expected: ResidentState, reason: string, now: number): Promise<ResidentState> {
		return this.change(expected, (state) => wakeResidentState(state, reason, now))
	}
}

/** Internal transitions shared by single-pursuit and whole-agent admission. */
export function claimResidentState(state: ResidentState, now: number): ResidentState {
	time.parse(now)
	if (state.phase !== 'waiting' || state.wakeAt === null || state.wakeAt > now)
		throw new Error('Resident is not due.')
	return {
		...state,
		phase: 'running',
		wakeAt: null,
		claimId: randomUUID(),
		stepsAdmitted: state.stepsAdmitted + 1,
	}
}

export function settleResidentState(
	state: ResidentState,
	decision: ResidentDecision,
	now: number,
): ResidentState {
	time.parse(now)
	const outcome = decisionSchema.parse(decision)
	if (outcome.kind === 'wait' && outcome.wakeAt !== null && outcome.wakeAt <= now)
		throw new Error('A scheduled continuation must be in the future.')
	if (state.phase !== 'running') throw new Error('Resident has no admitted step to settle.')
	return {
		...state,
		phase: outcome.kind === 'wait' ? 'waiting' : outcome.kind,
		wakeAt: outcome.kind === 'wait' ? outcome.wakeAt : null,
		summary: outcome.summary,
		reason: 'Scheduled continuation',
		claimId: null,
	}
}

export function wakeResidentState(
	state: ResidentState,
	reason: string,
	now: number,
): ResidentState {
	time.parse(now)
	const evidence = text.parse(reason)
	if (state.phase !== 'waiting') throw new Error('Only a waiting resident can be woken.')
	return { ...state, wakeAt: now, reason: evidence }
}
