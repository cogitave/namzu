import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { z } from 'zod'
import { DiskRevisionRecordStore } from '../../store/kv/revision-record-store.js'
import { defineSchema } from '../../store/schema.js'
import type { TenantId } from '../../types/ids/index.js'
import { asTenantId } from '../../utils/id.js'
import {
	ResidentConflictError,
	type ResidentDecision,
	type ResidentExecutionStore,
	type ResidentState,
	claimResidentState,
	residentKeySegment,
	residentStateSchema,
	settleResidentState,
	wakeResidentState,
} from './store.js'

const agendaSchema = z
	.object({
		tenantId: z.string().uuid(),
		agentKey: z.string().min(1).max(200),
		identity: z.string().trim().min(1).max(8_000),
		revision: z.number().int().positive().safe(),
		paused: z.boolean(),
		pursuits: z.array(z.object({ id: z.string().uuid(), state: residentStateSchema })).max(32),
	})
	.superRefine((agenda, context) => {
		const invalid =
			new Set(agenda.pursuits.map((p) => p.id)).size !== agenda.pursuits.length ||
			agenda.pursuits.filter((p) => p.state.phase === 'running').length > 1 ||
			agenda.pursuits.some(
				({ id, state }) =>
					state.pursuitId !== id ||
					state.tenantId !== agenda.tenantId ||
					state.agentKey !== agenda.agentKey ||
					state.identity !== agenda.identity,
			)
		if (invalid)
			context.addIssue({
				code: z.ZodIssueCode.custom,
				message: 'Invalid agenda identity, duplicate pursuit or overlapping claims.',
			})
	})

/** @experimental One pursuit shares its agent's identity, but has its own lifecycle. */
export interface ResidentPursuit {
	readonly id: string
	readonly state: ResidentState
}

/** @experimental Bounded shared admission record; at most one pursuit may be running. */
export interface ResidentAgendaState {
	readonly tenantId: string
	readonly agentKey: string
	readonly identity: string
	readonly revision: number
	readonly paused: boolean
	readonly pursuits: readonly ResidentPursuit[]
}

/** @experimental Atomic whole-agent admission plus independently addressable pursuits. */
export interface ResidentAgendaStore {
	read(): Promise<ResidentAgendaState | null>
	create(identity: string): Promise<ResidentAgendaState>
	add(expected: ResidentAgendaState, objective: string): Promise<ResidentPursuit>
	setPaused(expected: ResidentAgendaState, paused: boolean): Promise<ResidentAgendaState>
	wake(id: string, expected: ResidentState, reason: string, now: number): Promise<ResidentState>
	execution(id: string): ResidentExecutionStore
}

/**
 * @experimental One immutable revision contains identity, pause state and all
 * pursuits. Admission therefore serializes this agent even across processes
 * choosing different pursuits. Trusted local filesystems only; no lease expiry.
 */
export class DiskResidentAgenda implements ResidentAgendaStore {
	private readonly records = new DiskRevisionRecordStore<ResidentAgendaState>(
		defineSchema({ kind: 'resident-agenda', current: 1, migrations: {} }),
		'resident agenda',
		(record) => record.revision,
	)
	private readonly location
	private readonly tenantId: TenantId
	private readonly agentKey: string

	constructor(root: string, scope: { tenantId: TenantId; agentKey: string }) {
		this.tenantId = asTenantId(scope.tenantId)
		this.agentKey = z.string().min(1).max(200).parse(scope.agentKey)
		const directory = join(root, this.tenantId, residentKeySegment(this.agentKey), 'agenda')
		this.location = {
			legacyPath: join(directory, 'state.json'),
			revisionsDir: join(directory, 'revisions'),
			publishLegacyProjection: false,
		}
	}

	private checked(record: ResidentAgendaState): ResidentAgendaState {
		const agenda = agendaSchema.parse(record)
		if (agenda.tenantId !== this.tenantId || agenda.agentKey !== this.agentKey)
			throw new Error('Agenda does not match the bound tenant and agent.')
		return Object.freeze({
			...agenda,
			pursuits: Object.freeze(
				agenda.pursuits.map((p) => Object.freeze({ id: p.id, state: Object.freeze(p.state) })),
			),
		})
	}

	async read(): Promise<ResidentAgendaState | null> {
		const record = await this.records.read(this.location)
		return record === null ? null : this.checked(record)
	}

	async create(identity: string): Promise<ResidentAgendaState> {
		const record = this.checked({
			tenantId: this.tenantId,
			agentKey: this.agentKey,
			identity,
			revision: 1,
			paused: false,
			pursuits: [],
		})
		return this.records.transact(this.location, (current) => {
			if (current !== null) throw new ResidentConflictError()
			return { record, result: record }
		})
	}

	private async change(
		expected: ResidentAgendaState,
		update: (state: ResidentAgendaState) => ResidentAgendaState,
	): Promise<ResidentAgendaState> {
		this.checked(expected)
		return this.records.transact(this.location, (record) => {
			if (record === null) throw new ResidentConflictError()
			const current = this.checked(record)
			if (current.revision !== expected.revision) throw new ResidentConflictError()
			const next = this.checked({ ...update(current), revision: current.revision + 1 })
			return { record: next, result: next }
		})
	}

	async add(expected: ResidentAgendaState, objective: string): Promise<ResidentPursuit> {
		const id = randomUUID()
		const pursuit = Object.freeze({
			id,
			state: Object.freeze(
				residentStateSchema.parse({
					tenantId: this.tenantId,
					agentKey: this.agentKey,
					pursuitId: id,
					identity: expected.identity,
					objective,
					revision: 1,
					stepsAdmitted: 0,
					phase: 'waiting',
					wakeAt: 0,
					reason: 'Initial pursuit',
					summary: null,
					claimId: null,
				}),
			),
		})
		await this.change(expected, (state) => ({ ...state, pursuits: [...state.pursuits, pursuit] }))
		return pursuit
	}

	async setPaused(expected: ResidentAgendaState, paused: boolean): Promise<ResidentAgendaState> {
		z.boolean().parse(paused)
		return this.change(expected, (state) => ({ ...state, paused }))
	}

	private async updatePursuit(
		id: string,
		expected: ResidentState,
		update: (state: ResidentState) => ResidentState,
		admission = false,
	): Promise<ResidentState> {
		const validate = (state: ResidentAgendaState): ResidentState => {
			const pursuit = state.pursuits.find((p) => p.id === id)
			if (!pursuit) throw new Error('Unknown resident pursuit.')
			const current = pursuit.state
			if (
				expected.pursuitId !== id ||
				expected.tenantId !== state.tenantId ||
				expected.agentKey !== state.agentKey ||
				current.revision !== expected.revision ||
				current.claimId !== expected.claimId
			)
				throw new ResidentConflictError()
			if (admission && (state.paused || state.pursuits.some((p) => p.state.phase === 'running')))
				throw new ResidentConflictError()
			return current
		}
		// Retry persistence contention only. The caller's exact pursuit revision
		// and claim must survive every retry; a callback is never re-executed here.
		for (let attempt = 0; attempt < 8; attempt++) {
			const agenda = await this.read()
			if (agenda === null) throw new Error('Create the resident agenda first.')
			validate(agenda)
			try {
				const next = await this.change(agenda, (state) => {
					const current = validate(state)
					const updated = residentStateSchema.parse({
						...update(current),
						revision: current.revision + 1,
					})
					return {
						...state,
						pursuits: state.pursuits.map((p) => (p.id === id ? { id, state: updated } : p)),
					}
				})
				const result = next.pursuits.find((p) => p.id === id)
				if (!result) throw new Error('Committed pursuit is missing.')
				return result.state
			} catch (error) {
				if (!(error instanceof ResidentConflictError) || attempt === 7) throw error
			}
		}
		throw new ResidentConflictError()
	}

	async wake(
		id: string,
		expected: ResidentState,
		reason: string,
		now: number,
	): Promise<ResidentState> {
		return this.updatePursuit(id, expected, (state) => wakeResidentState(state, reason, now))
	}

	execution(id: string): ResidentExecutionStore {
		z.string().uuid().parse(id)
		return {
			read: async () => (await this.read())?.pursuits.find((p) => p.id === id)?.state ?? null,
			claim: (expected, now) =>
				this.updatePursuit(id, expected, (state) => claimResidentState(state, now), true),
			settle: (expected, decision: ResidentDecision, now) =>
				this.updatePursuit(id, expected, (state) => settleResidentState(state, decision, now)),
		}
	}
}
