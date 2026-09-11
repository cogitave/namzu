import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import { DiskRecordStore } from '../../store/kv/record-store.js'
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
	residentDecisionSchema,
	residentKeySegment,
	residentStateSchema,
	settleResidentState,
	wakeResidentState,
} from './store.js'

import {
	type ResidentFeedback,
	type ResidentObservation,
	freezeResidentFeedback,
	observeResidentStep,
	residentFeedbackSchema,
	residentObservationSchema,
} from './initiative.js'
import {
	type ResidentLearningEvidence,
	type ResidentLearningState,
	type ResidentProfileUpdate,
	type ResidentSkillCandidate,
	type ResidentSkillEvaluation,
	freezeResidentLearning,
	promoteResidentSkill,
	residentLearningEvidenceSchema,
	residentLearningSchema,
	restoreResidentSkill,
	reviseResidentProfile,
} from './learning.js'
import {
	type ResidentDeliveryOutcome,
	type ResidentMessageInput,
	type ResidentOutboxMessage,
	appendResidentMessage,
	claimResidentOutboxMessage,
	residentDeliveryOutcomeSchema,
	residentMessageInputSchema,
	residentOutboxMessageSchema,
	settleResidentOutboxMessage,
} from './outbox.js'
import {
	type ResidentProposal,
	type ResidentProposalLimits,
	type ResidentProposalOrigin,
	residentProposalLimitsSchema,
	residentProposalOriginSchema,
	residentProposalSchema,
	validateResidentProposal,
} from './proposal.js'

const agendaSchema = z
	.object({
		tenantId: z.string().uuid(),
		agentKey: z.string().min(1).max(200),
		identity: z.string().trim().min(1).max(8_000),
		revision: z.number().int().positive().safe(),
		paused: z.boolean(),
		archiveHead: z.number().int().min(2).safe().optional(),
		learning: residentLearningSchema.optional(),
		outbox: z.array(residentOutboxMessageSchema).max(128).optional(),
		pursuits: z
			.array(
				z.object({
					id: z.string().uuid(),
					state: residentStateSchema,
					feedback: residentFeedbackSchema.optional(),
					origin: residentProposalOriginSchema.optional(),
					retiredChildren: z.number().int().min(0).max(8).optional(),
				}),
			)
			.max(32),
	})
	.superRefine((agenda, context) => {
		const origins = agenda.pursuits.flatMap((p) => (p.origin ? [p.origin] : []))
		const outbox = agenda.outbox ?? []
		const invalid =
			(agenda.archiveHead !== undefined && agenda.archiveHead > agenda.revision) ||
			new Set(outbox.map((message) => message.id)).size !== outbox.length ||
			outbox.filter((message) => message.phase === 'sending').length > 1 ||
			outbox.some(
				(message) =>
					message.tenantId !== agenda.tenantId ||
					message.agentKey !== agenda.agentKey ||
					!agenda.pursuits.some((pursuit) => pursuit.id === message.pursuitId),
			) ||
			new Set(agenda.pursuits.map((p) => p.id)).size !== agenda.pursuits.length ||
			new Set(origins.map((origin) => origin.proposalId)).size !== origins.length ||
			agenda.pursuits.filter((p) => p.state.phase === 'running').length > 1 ||
			agenda.pursuits.some((p) => {
				if (!p.origin) return false
				const parent = agenda.pursuits.find((candidate) => candidate.id === p.origin?.parentId)
				return (
					!parent ||
					parent.id === p.id ||
					p.origin.parentRevision > parent.state.revision ||
					p.origin.depth !== (parent.origin?.depth ?? 0) + 1
				)
			}) ||
			agenda.pursuits.some((p) =>
				p.feedback?.observations.some(
					(item, index, all) =>
						item.step > p.state.stepsAdmitted ||
						(index > 0 && item.step <= (all[index - 1]?.step ?? 0)),
				),
			) ||
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
				message:
					'Invalid agenda identity, pursuit ancestry, observation order, outbox or overlapping claims.',
			})
	})

/** @experimental One pursuit shares its agent's identity, but has its own lifecycle. */
export interface ResidentPursuit {
	readonly id: string
	readonly state: ResidentState
	readonly feedback?: ResidentFeedback
	readonly origin?: ResidentProposalOrigin
	/** Archived direct children still consume the parent's lifetime admission bound. */
	readonly retiredChildren?: number
}

/** @experimental Bounded shared admission record; at most one pursuit may be running. */
export interface ResidentAgendaState {
	readonly tenantId: string
	readonly agentKey: string
	readonly identity: string
	readonly revision: number
	readonly paused: boolean
	readonly pursuits: readonly ResidentPursuit[]
	readonly outbox?: readonly ResidentOutboxMessage[]
	readonly archiveHead?: number
	readonly learning?: ResidentLearningState
}

/** @experimental Explicit terminal entries to retire from active capacity together. */
export interface ResidentArchiveRequest {
	readonly pursuitIds?: readonly string[]
	readonly messageIds?: readonly string[]
}

/** @experimental A committed removal, whose immutable predecessor preserves the full records. */
export interface ResidentArchiveEntry {
	readonly revision: number
	readonly pursuits: readonly ResidentPursuit[]
	readonly messages: readonly ResidentOutboxMessage[]
}

/** @experimental Pages count archive events; each event contains at most 32 pursuits and 128 messages. */
export interface ResidentArchivePage {
	readonly entries: readonly ResidentArchiveEntry[]
	readonly nextBeforeRevision: number | null
}

/** @experimental The cursor is the next archive-event revision returned by a previous page. */
export interface ResidentArchiveListOptions {
	readonly beforeRevision?: number
	/** Number of archive events to inspect; defaults to 8 and cannot exceed 32. */
	readonly limit?: number
}

const agendaRecordSchema = defineSchema({
	kind: 'resident-agenda',
	current: 4,
	migrations: { 1: (record) => record, 2: (record) => record, 3: (record) => record },
})

const archiveRequestSchema = z.object({
	pursuitIds: z.array(z.string().uuid()).max(32).default([]),
	messageIds: z.array(z.string().uuid()).max(128).default([]),
})

/** @experimental Atomic whole-agent admission plus independently addressable pursuits. */
export interface ResidentAgendaStore {
	read(): Promise<ResidentAgendaState | null>
	create(identity: string): Promise<ResidentAgendaState>
	add(expected: ResidentAgendaState, objective: string): Promise<ResidentPursuit>
	setPaused(expected: ResidentAgendaState, paused: boolean): Promise<ResidentAgendaState>
	wake(id: string, expected: ResidentState, reason: string, now: number): Promise<ResidentState>
	execution(id: string): ResidentExecutionStore
	/** Optional atomic extensions required by a configured resident initiative host. */
	executionAt?(id: string, expected: ResidentAgendaState): ResidentExecutionStore
	settleObserved?(
		id: string,
		expected: ResidentState,
		decision: ResidentDecision,
		observation: ResidentObservation,
		now: number,
	): Promise<ResidentState>
	/** Optional atomic settlement and outbound intent; no transport runs during persistence. */
	settleWithMessage?(
		id: string,
		expected: ResidentState,
		decision: ResidentDecision,
		message: ResidentMessageInput,
		now: number,
		observation?: ResidentObservation,
	): Promise<ResidentState>
	enqueueMessage?(
		expected: ResidentAgendaState,
		input: ResidentMessageInput,
	): Promise<ResidentOutboxMessage>
	claimMessage?(
		expected: ResidentAgendaState,
		id: string,
		now: number,
	): Promise<ResidentOutboxMessage>
	settleMessage?(
		expected: ResidentOutboxMessage,
		outcome: ResidentDeliveryOutcome,
		now: number,
	): Promise<ResidentOutboxMessage>
}

/**
 * @experimental One immutable revision contains identity, pause state and all
 * pursuits. Admission therefore serializes this agent even across processes
 * choosing different pursuits. Trusted local filesystems only; no lease expiry.
 */
export class DiskResidentAgenda implements ResidentAgendaStore {
	private readonly records = new DiskRevisionRecordStore<ResidentAgendaState>(
		agendaRecordSchema,
		'resident agenda',
		(record) => record.revision,
	)
	private readonly history = new DiskRecordStore<ResidentAgendaState>(agendaRecordSchema)
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
			...(agenda.learning ? { learning: freezeResidentLearning(agenda.learning) } : {}),
			...(agenda.outbox
				? { outbox: Object.freeze(agenda.outbox.map((message) => Object.freeze(message))) }
				: {}),
			pursuits: Object.freeze(
				agenda.pursuits.map((p) =>
					Object.freeze({
						...p,
						state: Object.freeze(p.state),
						...(p.feedback ? { feedback: freezeResidentFeedback(p.feedback) } : {}),
						...(p.origin ? { origin: Object.freeze(p.origin) } : {}),
					}),
				),
			),
		})
	}

	async read(): Promise<ResidentAgendaState | null> {
		const record = await this.records.read(this.location)
		return record === null ? null : this.checked(record)
	}

	/** Read one authoritative immutable commit, never the compatibility projection. */
	async readRevision(revision: number): Promise<ResidentAgendaState | null> {
		z.number().int().positive().safe().parse(revision)
		const record = await this.history.read(join(this.location.revisionsDir, `${revision}.json`))
		if (record === null) return null
		const state = this.checked(record)
		if (state.revision !== revision) throw new Error('Agenda revision filename and body disagree.')
		return state
	}

	private retire(state: ResidentAgendaState, input: ResidentArchiveRequest): ResidentAgendaState {
		const request = archiveRequestSchema.parse(input)
		const pursuits = new Set(request.pursuitIds)
		const messages = new Set(request.messageIds)
		if (
			pursuits.size + messages.size === 0 ||
			pursuits.size !== request.pursuitIds.length ||
			messages.size !== request.messageIds.length
		)
			throw new Error('Archive requires a nonempty set of unique entry IDs.')
		const removed = state.pursuits.filter((pursuit) => pursuits.has(pursuit.id))
		const removedMessages = (state.outbox ?? []).filter((message) => messages.has(message.id))
		if (removed.length !== pursuits.size || removedMessages.length !== messages.size)
			throw new Error('Unknown active entry in resident archive request.')
		if (removed.some((p) => p.state.phase !== 'complete' && p.state.phase !== 'blocked'))
			throw new Error('Only terminal pursuits can be archived.')
		if (removedMessages.some((m) => m.phase !== 'acknowledged' && m.phase !== 'cancelled'))
			throw new Error('Only terminal messages can be archived.')
		const remaining = state.pursuits.filter((pursuit) => !pursuits.has(pursuit.id))
		const remainingMessages = state.outbox?.filter((message) => !messages.has(message.id))
		if (remaining.some((p) => p.origin && pursuits.has(p.origin.parentId)))
			throw new Error('Archive must retain the parents of remaining pursuits.')
		if (remainingMessages?.some((message) => pursuits.has(message.pursuitId)))
			throw new Error('Archive must retain pursuits referenced by remaining messages.')
		return {
			...state,
			archiveHead: state.revision + 1,
			pursuits: remaining.map((pursuit) => {
				const retired = removed.filter((child) => child.origin?.parentId === pursuit.id).length
				return retired
					? { ...pursuit, retiredChildren: (pursuit.retiredChildren ?? 0) + retired }
					: pursuit
			}),
			...(remainingMessages ? { outbox: remainingMessages } : {}),
		}
	}

	/** Free active slots while preserving full records in the immutable predecessor commit. */
	async archive(
		expected: ResidentAgendaState,
		input: ResidentArchiveRequest,
	): Promise<ResidentAgendaState> {
		const request = archiveRequestSchema.parse(input)
		return this.change(expected, (state) => this.retire(state, request))
	}

	private async archiveEntry(revision: number): Promise<{
		entry: ResidentArchiveEntry
		previous: number | null
	}> {
		const after = await this.readRevision(revision)
		const before = await this.readRevision(revision - 1)
		if (
			!before ||
			!after ||
			after.archiveHead !== revision ||
			(before.archiveHead !== undefined && before.archiveHead >= revision)
		)
			throw new Error('Resident archive history is missing or its chain is invalid.')
		const activePursuits = new Set(after.pursuits.map((p) => p.id))
		const activeMessages = new Set((after.outbox ?? []).map((m) => m.id))
		const pursuits = before.pursuits.filter((p) => !activePursuits.has(p.id))
		const messages = (before.outbox ?? []).filter((m) => !activeMessages.has(m.id))
		const derived = this.checked({
			...this.retire(before, {
				pursuitIds: pursuits.map((p) => p.id),
				messageIds: messages.map((m) => m.id),
			}),
			revision,
		})
		if (!isDeepStrictEqual(derived, after))
			throw new Error('Resident archive commit does not match its immutable predecessor.')
		return {
			entry: Object.freeze({
				revision,
				pursuits: Object.freeze(pursuits),
				messages: Object.freeze(messages),
			}),
			previous: before.archiveHead ?? null,
		}
	}

	/** Bounded archive-event pages; exact-ID deduplication may inspect the complete chain. */
	async listArchived(options: ResidentArchiveListOptions = {}): Promise<ResidentArchivePage> {
		const request = z
			.object({
				beforeRevision: z.number().int().min(2).safe().optional(),
				limit: z.number().int().min(1).max(32).default(8),
			})
			.parse(options)
		const state = await this.read()
		if (!state) throw new Error('Create the resident agenda first.')
		let revision = request.beforeRevision ?? state.archiveHead ?? null
		if (revision !== null && (state.archiveHead === undefined || revision > state.archiveHead))
			throw new Error('Archive cursor is ahead of committed archive history.')
		const entries: ResidentArchiveEntry[] = []
		while (revision !== null && entries.length < request.limit) {
			const archived = await this.archiveEntry(revision)
			entries.push(archived.entry)
			revision = archived.previous
		}
		return Object.freeze({ entries: Object.freeze(entries), nextBeforeRevision: revision })
	}

	private async archivedMatch<T>(
		state: ResidentAgendaState,
		match: (entry: ResidentArchiveEntry) => T | undefined,
	): Promise<T | undefined> {
		let revision = state.archiveHead ?? null
		while (revision !== null) {
			const archived = await this.archiveEntry(revision)
			const found = match(archived.entry)
			if (found !== undefined) return found
			revision = archived.previous
		}
		return undefined
	}

	private assertArchivedIntent(
		message: ResidentOutboxMessage,
		input: ResidentMessageInput,
		sourceClaimId: string | null,
	): void {
		if (
			message.pursuitId !== input.pursuitId ||
			message.destination !== input.destination ||
			message.body !== input.body ||
			message.notBefore !== input.notBefore ||
			message.sourceClaimId !== sourceClaimId
		)
			throw new Error('Outbox message ID already names a different immutable archived intent.')
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
		const snapshot = this.checked(expected)
		return this.records.transact(this.location, (record) => {
			if (record === null) throw new ResidentConflictError()
			const current = this.checked(record)
			if (current.revision !== snapshot.revision) throw new ResidentConflictError()
			const next = this.checked({ ...update(current), revision: current.revision + 1 })
			return { record: next, result: next }
		})
	}

	private pursuit(identity: string, objective: string): ResidentPursuit {
		const id = randomUUID()
		const pursuit = Object.freeze({
			id,
			state: Object.freeze(
				residentStateSchema.parse({
					tenantId: this.tenantId,
					agentKey: this.agentKey,
					pursuitId: id,
					identity,
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
		return pursuit
	}

	async add(expected: ResidentAgendaState, objective: string): Promise<ResidentPursuit> {
		const pursuit = this.pursuit(expected.identity, objective)
		await this.change(expected, (state) => ({ ...state, pursuits: [...state.pursuits, pursuit] }))
		return pursuit
	}

	/** Host-approved proposal admission is atomic and inert until a future invocation. */
	async admitProposal(
		expected: ResidentAgendaState,
		input: ResidentProposal,
		limits: ResidentProposalLimits,
	): Promise<ResidentPursuit> {
		const snapshot = this.checked(expected)
		const proposal = residentProposalSchema.parse(input)
		const policy = residentProposalLimitsSchema.parse(limits)
		const current = await this.read()
		if (!current || current.revision !== snapshot.revision) throw new ResidentConflictError()
		validateResidentProposal(current, proposal, policy)
		if (
			await this.archivedMatch(current, (entry) =>
				entry.pursuits.find((p) => p.origin?.proposalId === proposal.id),
			)
		)
			throw new Error('Resident proposal has already been admitted and archived.')
		let admitted: ResidentPursuit | undefined
		await this.change(snapshot, (state) => {
			const origin = validateResidentProposal(state, proposal, policy)
			admitted = Object.freeze({
				...this.pursuit(state.identity, proposal.objective),
				origin: Object.freeze(origin),
			})
			return { ...state, pursuits: [...state.pursuits, admitted] }
		})
		if (!admitted) throw new Error('Resident proposal was not admitted.')
		return admitted
	}

	async setPaused(expected: ResidentAgendaState, paused: boolean): Promise<ResidentAgendaState> {
		z.boolean().parse(paused)
		return this.change(expected, (state) => ({ ...state, paused }))
	}

	private async learn(
		expected: ResidentAgendaState,
		learning: ResidentLearningState,
	): Promise<ResidentAgendaState> {
		return this.change(expected, (state) => {
			if (state.pursuits.some((pursuit) => pursuit.state.phase === 'running'))
				throw new Error('Resident learning cannot change while a pursuit is running.')
			if (!isDeepStrictEqual(state.learning, expected.learning)) throw new ResidentConflictError()
			return { ...state, learning }
		})
	}

	/** Append a host-evidenced correction only while pursuit admission is idle. */
	async updateProfile(
		expected: ResidentAgendaState,
		input: ResidentProfileUpdate,
	): Promise<ResidentAgendaState> {
		const snapshot = this.checked(expected)
		const learning = reviseResidentProfile(snapshot.learning, input)
		return this.learn(snapshot, learning)
	}

	/** Bind evaluated guidance to the current learning version and an idle agenda. */
	async promoteSkill(
		expected: ResidentAgendaState,
		candidate: ResidentSkillCandidate,
		evaluation: ResidentSkillEvaluation,
		evidence: ResidentLearningEvidence,
	): Promise<ResidentAgendaState> {
		const snapshot = this.checked(expected)
		const learning = promoteResidentSkill(snapshot.learning, candidate, evaluation, evidence)
		return this.learn(snapshot, learning)
	}

	/** Restore one skill from an immutable agenda revision while retaining the current profile. */
	async rollbackSkill(
		expected: ResidentAgendaState,
		name: string,
		fromRevision: number,
		evidence: ResidentLearningEvidence,
	): Promise<ResidentAgendaState> {
		const snapshot = this.checked(expected)
		const checkedEvidence = residentLearningEvidenceSchema.parse(evidence)
		z.number().int().positive().safe().max(snapshot.revision).parse(fromRevision)
		z.string()
			.regex(/^[a-z0-9][a-z0-9_-]{0,63}$/)
			.parse(name)
		const historical = await this.readRevision(fromRevision)
		if (!historical) throw new Error('Resident skill rollback revision is missing.')
		const learning = restoreResidentSkill(
			snapshot.learning,
			historical.learning,
			name,
			checkedEvidence,
		)
		return this.learn(snapshot, learning)
	}

	private async updatePursuit(
		id: string,
		expected: ResidentState,
		update: (state: ResidentState) => ResidentState,
		admission = false,
		expectedAgendaRevision?: number,
		observation?: ResidentObservation,
		message?: ResidentMessageInput,
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
			if (expectedAgendaRevision !== undefined && agenda.revision !== expectedAgendaRevision)
				throw new ResidentConflictError()
			const current = validate(agenda)
			const archived =
				message && !agenda.outbox?.some((item) => item.id === message.id)
					? await this.archivedMatch(agenda, (entry) =>
							entry.messages.find((item) => item.id === message.id),
						)
					: undefined
			if (message && archived) this.assertArchivedIntent(archived, message, current.claimId)
			try {
				const next = await this.change(agenda, (state) => {
					const current = validate(state)
					const updated = residentStateSchema.parse({
						...update(current),
						revision: current.revision + 1,
					})
					return {
						...state,
						...(message && !archived
							? { outbox: appendResidentMessage(state, message, current.claimId) }
							: {}),
						pursuits: state.pursuits.map((p) =>
							p.id === id
								? {
										...p,
										state: updated,
										...(observation
											? {
													feedback: observeResidentStep(
														p.feedback,
														observation,
														current.stepsAdmitted,
													),
												}
											: {}),
									}
								: p,
						),
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

	async settleObserved(
		id: string,
		expected: ResidentState,
		decision: ResidentDecision,
		observation: ResidentObservation,
		now: number,
	): Promise<ResidentState> {
		const checked = residentObservationSchema.parse(observation)
		return this.updatePursuit(
			id,
			expected,
			(state) => settleResidentState(state, decision, now),
			false,
			undefined,
			checked,
		)
	}

	/** Commit the step, observation and message intent together; delivery is separate. */
	async settleWithMessage(
		id: string,
		expected: ResidentState,
		decision: ResidentDecision,
		message: ResidentMessageInput,
		now: number,
		observation?: ResidentObservation,
	): Promise<ResidentState> {
		const input = residentMessageInputSchema.parse(message)
		const disposition = residentDecisionSchema.parse(decision)
		if (input.pursuitId !== id) throw new Error('Message must belong to the settling pursuit.')
		const current = residentStateSchema.parse(expected)
		const checked =
			observation === undefined ? undefined : residentObservationSchema.parse(observation)
		return this.updatePursuit(
			id,
			current,
			(state) => settleResidentState(state, disposition, now),
			false,
			undefined,
			checked,
			input,
		)
	}

	/** Enqueue host-authorized intent without invoking a transport or changing pursuit state. */
	async enqueueMessage(
		expected: ResidentAgendaState,
		input: ResidentMessageInput,
	): Promise<ResidentOutboxMessage> {
		const snapshot = this.checked(expected)
		const message = residentMessageInputSchema.parse(input)
		const current = await this.read()
		if (!current || current.revision !== snapshot.revision) throw new ResidentConflictError()
		const archived = current.outbox?.some((item) => item.id === message.id)
			? undefined
			: await this.archivedMatch(current, (entry) =>
					entry.messages.find((item) => item.id === message.id),
				)
		if (archived) this.assertArchivedIntent(archived, message, null)
		const next = await this.change(snapshot, (state) => ({
			...state,
			...(!archived ? { outbox: appendResidentMessage(state, message) } : {}),
		}))
		const saved = archived ?? next.outbox?.find((candidate) => candidate.id === message.id)
		if (!saved) throw new Error('Committed resident message is missing.')
		return saved
	}

	/** Admit one delivery against the same agenda snapshot used by the host's gate. */
	async claimMessage(
		expected: ResidentAgendaState,
		id: string,
		now: number,
	): Promise<ResidentOutboxMessage> {
		z.string().uuid().parse(id)
		const next = await this.change(expected, (state) => {
			const outbox = state.outbox ?? []
			if (state.paused || outbox.some((message) => message.phase === 'sending'))
				throw new ResidentConflictError()
			const message = outbox.find((candidate) => candidate.id === id)
			if (!message) throw new Error('Unknown resident message.')
			const admitted = claimResidentOutboxMessage(message, now)
			return {
				...state,
				outbox: outbox.map((candidate) => (candidate.id === id ? admitted : candidate)),
			}
		})
		const claim = next.outbox?.find((message) => message.id === id)
		if (!claim) throw new Error('Claimed resident message is missing.')
		return claim
	}

	/** Settle the exact delivery claim; unrelated agenda writes never repeat the transport. */
	async settleMessage(
		expected: ResidentOutboxMessage,
		outcome: ResidentDeliveryOutcome,
		now: number,
	): Promise<ResidentOutboxMessage> {
		const claim = residentOutboxMessageSchema.parse(expected)
		const checked = residentDeliveryOutcomeSchema.parse(outcome)
		if (claim.tenantId !== this.tenantId || claim.agentKey !== this.agentKey)
			throw new ResidentConflictError()
		const validate = (state: ResidentAgendaState): ResidentOutboxMessage => {
			const message = state.outbox?.find((candidate) => candidate.id === claim.id)
			if (!message || message.revision !== claim.revision || message.claimId !== claim.claimId)
				throw new ResidentConflictError()
			return message
		}
		for (let attempt = 0; attempt < 8; attempt++) {
			const agenda = await this.read()
			if (agenda === null) throw new Error('Create the resident agenda first.')
			validate(agenda)
			try {
				const next = await this.change(agenda, (state) => {
					const current = validate(state)
					const settled = settleResidentOutboxMessage(current, checked, now)
					return {
						...state,
						outbox: (state.outbox ?? []).map((message) =>
							message.id === claim.id ? settled : message,
						),
					}
				})
				const settled = next.outbox?.find((message) => message.id === claim.id)
				if (!settled) throw new Error('Settled resident message is missing.')
				return settled
			} catch (error) {
				if (!(error instanceof ResidentConflictError) || attempt === 7) throw error
			}
		}
		throw new ResidentConflictError()
	}

	executionAt(id: string, expected: ResidentAgendaState): ResidentExecutionStore {
		const state = this.checked(expected)
		const pursuit = state.pursuits.find((p) => p.id === id)
		if (!pursuit) throw new Error('Unknown resident pursuit.')
		const execution = this.execution(id)
		return {
			read: async () => pursuit.state,
			settle: (...args) => execution.settle(...args),
			claim: (current, now) =>
				this.updatePursuit(
					id,
					current,
					(saved) => claimResidentState(saved, now),
					true,
					state.revision,
				),
		}
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
