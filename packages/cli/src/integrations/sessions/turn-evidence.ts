/**
 * Durable correlation between one CLI conversation and the SDK runs that
 * carried its turns.
 *
 * The SDK already owns run events and the verified survivor snapshot. This
 * file deliberately does not copy either. It records the fact the SDK cannot
 * infer: which exact user message the operator submitted as this turn, and
 * which caller-chosen run id was reserved for it before execution began.
 */

import { randomUUID } from 'node:crypto'
import { open, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import {
	DefaultPathBuilder,
	type ProjectId,
	type RunId,
	type SessionId,
	type UserMessage,
	asGoalId,
	asProjectId,
	asRunId,
	asSessionId,
	isModelContentOmission,
	isProjectInstructionMessageSource,
	isRuntimeContextMessageSource,
} from '@namzu/sdk'

const FORMAT = 'namzu.cli-turn-evidence.v1' as const
const FILE = 'turns.jsonl'

export type ConversationOrigin =
	| { readonly kind: 'new' }
	| {
			/**
			 * Immutable turn boundary copied from the source conversation. The
			 * references are flattened, so later source turns and deeper fork chains
			 * cannot change what this conversation inherited.
			 */
			readonly kind: 'fork'
			readonly sourceSessionId: SessionId
			readonly copiedMessages: number
			readonly turns: readonly ConversationTurnReference[]
	  }
	| {
			/**
			 * The copied model history has no stable turn boundary yet. The source
			 * is kept so a later lineage migration has evidence to work from, while
			 * the current exporter refuses instead of guessing.
			 */
			readonly kind: 'fork-unresolved'
			readonly sourceSessionId: SessionId
			readonly copiedMessages: number
	  }

export interface ConversationTurnReference {
	readonly sessionId: SessionId
	readonly turnId: string
}

export type ConversationTurnOutcome = 'completed' | 'stopped' | 'failed' | 'cancelled'

export interface ConversationOriginRecord {
	readonly format: typeof FORMAT
	readonly type: 'conversation_started'
	readonly projectId: ProjectId
	readonly sessionId: SessionId
	readonly recordedAt: number
	readonly origin: ConversationOrigin
}

export interface ConversationTurnStartedRecord {
	readonly format: typeof FORMAT
	readonly type: 'turn_started'
	readonly projectId: ProjectId
	readonly sessionId: SessionId
	readonly turnId: string
	readonly runId: RunId
	readonly recordedAt: number
	/** What the operator saw, before `@file` mentions were expanded. */
	readonly displayText: string
	/** Exactly what the provider received, including expanded mentions. */
	readonly user: UserMessage
}

export interface ConversationTurnSettledRecord {
	readonly format: typeof FORMAT
	readonly type: 'turn_settled'
	readonly projectId: ProjectId
	readonly sessionId: SessionId
	readonly turnId: string
	readonly runId: RunId
	readonly recordedAt: number
	readonly outcome: ConversationTurnOutcome
	/** Raw assistant Markdown accumulated by the host; may be empty. */
	readonly assistantText: string
}

export type ConversationEvidenceRecord =
	| ConversationOriginRecord
	| ConversationTurnStartedRecord
	| ConversationTurnSettledRecord

export interface ConversationTurnEvidence {
	readonly started: ConversationTurnStartedRecord
	readonly settled?: ConversationTurnSettledRecord
}

export interface ConversationLineageTurn {
	readonly reference: ConversationTurnReference
	readonly evidence: ConversationTurnEvidence
}

export type ConversationEvidenceRead =
	| { readonly kind: 'not-recorded' }
	| {
			readonly kind: 'available'
			readonly origin: ConversationOriginRecord
			readonly turns: readonly ConversationTurnEvidence[]
	  }

export type ConversationLineageRead =
	| { readonly kind: 'unavailable'; readonly detail: string }
	| {
			readonly kind: 'available'
			readonly origin: ConversationOriginRecord
			/** Turns physically recorded in the requested conversation. */
			readonly localTurns: readonly ConversationTurnEvidence[]
			/** Inherited turns followed by local turns, at the immutable fork boundary. */
			readonly turns: readonly ConversationLineageTurn[]
	  }

export class ConversationEvidenceCorruptionError extends Error {
	constructor(message: string) {
		super(message)
		this.name = 'ConversationEvidenceCorruptionError'
	}
}

export interface DiskConversationEvidenceOptions {
	readonly root: string
	readonly projectId: ProjectId
	readonly now?: () => number
}

export class DiskConversationEvidence {
	private readonly paths: DefaultPathBuilder
	private readonly projectId: ProjectId
	private readonly now: () => number
	private tail: Promise<void> = Promise.resolve()

	constructor(options: DiskConversationEvidenceOptions) {
		this.paths = new DefaultPathBuilder(options.root)
		this.projectId = options.projectId
		this.now = options.now ?? Date.now
	}

	async recordOrigin(sessionId: SessionId, origin: ConversationOrigin): Promise<void> {
		return await this.serialize(async () => {
			const record: ConversationOriginRecord = {
				format: FORMAT,
				type: 'conversation_started',
				projectId: this.projectId,
				sessionId,
				recordedAt: this.now(),
				origin,
			}
			const path = this.path(sessionId)
			let handle: Awaited<ReturnType<typeof open>> | undefined
			try {
				handle = await open(path, 'wx', 0o600)
				await handle.writeFile(`${JSON.stringify(record)}\n`, 'utf-8')
				await handle.sync()
			} finally {
				await handle?.close()
			}

			const readBack = await this.readUnlocked(sessionId)
			if (readBack.kind !== 'available' || !isDeepStrictEqual(readBack.origin, record)) {
				throw new Error(`Conversation origin was not durably verified in ${path}.`)
			}
		})
	}

	async recordTurnStarted(input: {
		readonly sessionId: SessionId
		readonly runId: RunId
		readonly displayText: string
		readonly user: UserMessage
	}): Promise<ConversationTurnStartedRecord> {
		return await this.serialize(async () => {
			const before = await this.requireAvailable(input.sessionId)
			if (before.turns.some((turn) => turn.started.runId === input.runId)) {
				throw new ConversationEvidenceCorruptionError(
					`Run ${input.runId} is already bound in conversation ${input.sessionId}.`,
				)
			}

			const record: ConversationTurnStartedRecord = {
				format: FORMAT,
				type: 'turn_started',
				projectId: this.projectId,
				sessionId: input.sessionId,
				turnId: `turn_${randomUUID().replaceAll('-', '')}`,
				runId: input.runId,
				recordedAt: this.now(),
				displayText: input.displayText,
				user: input.user,
			}
			await this.append(input.sessionId, record)

			const readBack = await this.requireAvailable(input.sessionId)
			const persisted = readBack.turns.find(
				(turn) => turn.started.turnId === record.turnId,
			)?.started
			if (!isDeepStrictEqual(persisted, record)) {
				throw new Error(
					`Turn ${record.turnId} was not durably verified before run ${record.runId}.`,
				)
			}
			return record
		})
	}

	async recordTurnSettled(input: {
		readonly sessionId: SessionId
		readonly turnId: string
		readonly runId: RunId
		readonly outcome: ConversationTurnOutcome
		readonly assistantText: string
	}): Promise<ConversationTurnSettledRecord> {
		return await this.serialize(async () => {
			const before = await this.requireAvailable(input.sessionId)
			const turn = before.turns.find((candidate) => candidate.started.turnId === input.turnId)
			if (!turn || turn.started.runId !== input.runId) {
				throw new ConversationEvidenceCorruptionError(
					`Turn ${input.turnId} is not bound to run ${input.runId} in conversation ${input.sessionId}.`,
				)
			}
			if (turn.settled) {
				throw new ConversationEvidenceCorruptionError(
					`Turn ${input.turnId} already has a settlement record.`,
				)
			}

			const record: ConversationTurnSettledRecord = {
				format: FORMAT,
				type: 'turn_settled',
				projectId: this.projectId,
				sessionId: input.sessionId,
				turnId: input.turnId,
				runId: input.runId,
				recordedAt: this.now(),
				outcome: input.outcome,
				assistantText: input.assistantText,
			}
			await this.append(input.sessionId, record)

			const readBack = await this.requireAvailable(input.sessionId)
			const persisted = readBack.turns.find(
				(candidate) => candidate.started.turnId === record.turnId,
			)?.settled
			if (!isDeepStrictEqual(persisted, record)) {
				throw new Error(`Settlement for turn ${record.turnId} was not durably verified.`)
			}
			return record
		})
	}

	async read(sessionId: SessionId): Promise<ConversationEvidenceRead> {
		await this.tail
		return await this.readUnlocked(sessionId)
	}

	/** Resolve and verify the immutable turn sequence visible to one conversation. */
	async resolveLineage(sessionId: SessionId): Promise<ConversationLineageRead> {
		await this.tail
		const resolved = await this.resolveReferencesUnlocked(sessionId, new Set())
		if (resolved.kind === 'unavailable') return resolved

		const current = await this.readUnlocked(sessionId)
		if (current.kind !== 'available') {
			return {
				kind: 'unavailable',
				detail: `conversation ${sessionId} has no origin record`,
			}
		}
		const cache = new Map<SessionId, ConversationEvidenceRead>([[sessionId, current]])
		const turns: ConversationLineageTurn[] = []
		for (const reference of resolved.references) {
			let owner = cache.get(reference.sessionId)
			if (!owner) {
				owner = await this.readUnlocked(reference.sessionId)
				cache.set(reference.sessionId, owner)
			}
			if (owner.kind !== 'available') {
				throw new ConversationEvidenceCorruptionError(
					`Fork lineage for conversation ${sessionId} names missing conversation ${reference.sessionId}.`,
				)
			}
			const evidence = owner.turns.find((turn) => turn.started.turnId === reference.turnId)
			if (!evidence) {
				throw new ConversationEvidenceCorruptionError(
					`Fork lineage for conversation ${sessionId} names missing local turn ${reference.turnId} in ${reference.sessionId}.`,
				)
			}
			turns.push({ reference, evidence })
		}

		return {
			kind: 'available',
			origin: current.origin,
			localTurns: current.turns,
			turns,
		}
	}

	private async serialize<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.tail.then(operation)
		this.tail = result.then(
			() => undefined,
			() => undefined,
		)
		return await result
	}

	private path(sessionId: SessionId): string {
		return join(this.paths.sessionDir(this.projectId, sessionId), FILE)
	}

	private async append(sessionId: SessionId, record: ConversationEvidenceRecord): Promise<void> {
		const path = this.path(sessionId)
		let handle: Awaited<ReturnType<typeof open>> | undefined
		try {
			handle = await open(path, 'a', 0o600)
			await handle.writeFile(`${JSON.stringify(record)}\n`, 'utf-8')
			await handle.sync()
		} finally {
			await handle?.close()
		}
	}

	private async requireAvailable(
		sessionId: SessionId,
	): Promise<Extract<ConversationEvidenceRead, { kind: 'available' }>> {
		const evidence = await this.readUnlocked(sessionId)
		if (evidence.kind !== 'available') {
			throw new ConversationEvidenceCorruptionError(
				`Conversation ${sessionId} has no origin record.`,
			)
		}
		return evidence
	}

	private async readUnlocked(sessionId: SessionId): Promise<ConversationEvidenceRead> {
		const path = this.path(sessionId)
		let raw: string
		try {
			raw = await readFile(path, 'utf-8')
		} catch (error) {
			if (isMissing(error)) return { kind: 'not-recorded' }
			throw error
		}
		if (raw.length === 0 || !raw.endsWith('\n')) {
			throw new ConversationEvidenceCorruptionError(
				`Conversation evidence in ${path} is empty or has a torn final record.`,
			)
		}

		const records = raw
			.slice(0, -1)
			.split('\n')
			.map((line, index) => parseRecord(line, index + 1, path, this.projectId, sessionId))
		const origin = records[0]
		if (origin?.type !== 'conversation_started') {
			throw new ConversationEvidenceCorruptionError(
				`Conversation evidence in ${path} does not start with its origin.`,
			)
		}
		if (records.slice(1).some((record) => record.type === 'conversation_started')) {
			throw new ConversationEvidenceCorruptionError(
				`Conversation evidence in ${path} contains more than one origin.`,
			)
		}

		const turns: Array<{
			started: ConversationTurnStartedRecord
			settled?: ConversationTurnSettledRecord
		}> = []
		const byTurn = new Map<string, (typeof turns)[number]>()
		const runIds = new Set<string>()
		for (const record of records.slice(1)) {
			if (record.type === 'turn_started') {
				if (byTurn.has(record.turnId) || runIds.has(record.runId)) {
					throw new ConversationEvidenceCorruptionError(
						`Conversation evidence in ${path} reuses turn ${record.turnId} or run ${record.runId}.`,
					)
				}
				const turn = { started: record }
				turns.push(turn)
				byTurn.set(record.turnId, turn)
				runIds.add(record.runId)
				continue
			}
			if (record.type === 'turn_settled') {
				const turn = byTurn.get(record.turnId)
				if (!turn || turn.started.runId !== record.runId || turn.settled) {
					throw new ConversationEvidenceCorruptionError(
						`Conversation evidence in ${path} has an orphan, mismatched, or duplicate settlement for turn ${record.turnId}.`,
					)
				}
				turn.settled = record
			}
		}

		return { kind: 'available', origin, turns }
	}

	private async resolveReferencesUnlocked(
		sessionId: SessionId,
		visiting: Set<SessionId>,
	): Promise<
		| { readonly kind: 'unavailable'; readonly detail: string }
		| {
				readonly kind: 'available'
				readonly references: readonly ConversationTurnReference[]
		  }
	> {
		if (visiting.has(sessionId)) {
			throw new ConversationEvidenceCorruptionError(
				`Fork lineage contains a cycle through conversation ${sessionId}.`,
			)
		}
		visiting.add(sessionId)
		try {
			const evidence = await this.readUnlocked(sessionId)
			if (evidence.kind !== 'available') {
				return {
					kind: 'unavailable',
					detail: `conversation ${sessionId} has no origin record`,
				}
			}
			const local = evidence.turns.map((turn) => ({
				sessionId,
				turnId: turn.started.turnId,
			}))
			const origin = evidence.origin.origin
			if (origin.kind === 'new') return { kind: 'available', references: local }
			if (origin.kind === 'fork-unresolved') {
				return {
					kind: 'unavailable',
					detail: `conversation ${sessionId} has an unresolved copied prefix from ${origin.sourceSessionId}`,
				}
			}

			const source = await this.resolveReferencesUnlocked(origin.sourceSessionId, visiting)
			if (source.kind === 'unavailable') return source
			if (
				origin.turns.length > source.references.length ||
				origin.turns.some((reference, index) => !sameReference(reference, source.references[index]))
			) {
				throw new ConversationEvidenceCorruptionError(
					`Fork lineage for conversation ${sessionId} is not a prefix of source ${origin.sourceSessionId}.`,
				)
			}
			return { kind: 'available', references: [...origin.turns, ...local] }
		} finally {
			visiting.delete(sessionId)
		}
	}
}

function parseRecord(
	line: string,
	lineNumber: number,
	path: string,
	projectId: ProjectId,
	sessionId: SessionId,
): ConversationEvidenceRecord {
	let value: unknown
	try {
		value = JSON.parse(line)
	} catch (error) {
		throw new ConversationEvidenceCorruptionError(
			`Conversation evidence in ${path} has invalid JSON at line ${lineNumber}: ${error instanceof Error ? error.message : String(error)}`,
		)
	}
	if (!isObject(value) || value.format !== FORMAT) {
		throw new ConversationEvidenceCorruptionError(
			`Conversation evidence in ${path} has an unsupported record at line ${lineNumber}.`,
		)
	}

	let recordProjectId: ProjectId
	let recordSessionId: SessionId
	try {
		recordProjectId = asProjectId(requiredString(value.projectId, 'projectId'))
		recordSessionId = asSessionId(requiredString(value.sessionId, 'sessionId'))
	} catch (error) {
		throw invalidRecord(path, lineNumber, error)
	}
	if (recordProjectId !== projectId || recordSessionId !== sessionId) {
		throw new ConversationEvidenceCorruptionError(
			`Conversation evidence in ${path} is attributed to a different project or session at line ${lineNumber}.`,
		)
	}
	const recordedAt = requiredTimestamp(value.recordedAt)

	switch (value.type) {
		case 'conversation_started':
			return {
				format: FORMAT,
				type: 'conversation_started',
				projectId: recordProjectId,
				sessionId: recordSessionId,
				recordedAt,
				origin: parseOrigin(value.origin, path, lineNumber, recordSessionId),
			}
		case 'turn_started': {
			let runId: RunId
			try {
				runId = asRunId(requiredString(value.runId, 'runId'))
			} catch (error) {
				throw invalidRecord(path, lineNumber, error)
			}
			const turnId = requiredString(value.turnId, 'turnId')
			if (!/^turn_[a-z0-9]+$/.test(turnId)) throw invalidRecord(path, lineNumber, 'turnId')
			return {
				format: FORMAT,
				type: 'turn_started',
				projectId: recordProjectId,
				sessionId: recordSessionId,
				turnId,
				runId,
				recordedAt,
				displayText: requiredString(value.displayText, 'displayText'),
				user: parseUserMessage(value.user, path, lineNumber),
			}
		}
		case 'turn_settled': {
			let runId: RunId
			try {
				runId = asRunId(requiredString(value.runId, 'runId'))
			} catch (error) {
				throw invalidRecord(path, lineNumber, error)
			}
			const turnId = requiredString(value.turnId, 'turnId')
			if (!/^turn_[a-z0-9]+$/.test(turnId)) throw invalidRecord(path, lineNumber, 'turnId')
			const outcome = value.outcome
			if (!['completed', 'stopped', 'failed', 'cancelled'].includes(String(outcome))) {
				throw invalidRecord(path, lineNumber, 'outcome')
			}
			return {
				format: FORMAT,
				type: 'turn_settled',
				projectId: recordProjectId,
				sessionId: recordSessionId,
				turnId,
				runId,
				recordedAt,
				outcome: outcome as ConversationTurnOutcome,
				assistantText: requiredString(value.assistantText, 'assistantText'),
			}
		}
		default:
			throw new ConversationEvidenceCorruptionError(
				`Conversation evidence in ${path} has unknown record type ${String(value.type)} at line ${lineNumber}.`,
			)
	}
}

function parseOrigin(
	value: unknown,
	path: string,
	line: number,
	sessionId: SessionId,
): ConversationOrigin {
	if (!isObject(value)) throw invalidRecord(path, line, 'origin')
	if (value.kind === 'new') return { kind: 'new' }
	if (value.kind !== 'fork' && value.kind !== 'fork-unresolved') {
		throw invalidRecord(path, line, 'origin.kind')
	}
	let sourceSessionId: SessionId
	try {
		sourceSessionId = asSessionId(requiredString(value.sourceSessionId, 'sourceSessionId'))
	} catch (error) {
		throw invalidRecord(path, line, error)
	}
	if (!Number.isSafeInteger(value.copiedMessages) || Number(value.copiedMessages) < 0) {
		throw invalidRecord(path, line, 'copiedMessages')
	}
	if (sourceSessionId === sessionId) throw invalidRecord(path, line, 'sourceSessionId')
	if (value.kind === 'fork') {
		if (!Array.isArray(value.turns)) throw invalidRecord(path, line, 'turns')
		const seen = new Set<string>()
		const turns = value.turns.map((entry) => {
			if (!isObject(entry)) throw invalidRecord(path, line, 'turn reference')
			let owner: SessionId
			try {
				owner = asSessionId(requiredString(entry.sessionId, 'turn.sessionId'))
			} catch (error) {
				throw invalidRecord(path, line, error)
			}
			const turnId = requiredString(entry.turnId, 'turn.turnId')
			if (!/^turn_[a-z0-9]+$/.test(turnId)) throw invalidRecord(path, line, 'turn.turnId')
			const key = `${owner}\0${turnId}`
			if (seen.has(key)) throw invalidRecord(path, line, 'duplicate turn reference')
			seen.add(key)
			return { sessionId: owner, turnId }
		})
		return {
			kind: 'fork',
			sourceSessionId,
			copiedMessages: Number(value.copiedMessages),
			turns,
		}
	}
	return {
		kind: 'fork-unresolved',
		sourceSessionId,
		copiedMessages: Number(value.copiedMessages),
	}
}

function parseUserMessage(value: unknown, path: string, line: number): UserMessage {
	if (!isObject(value) || value.role !== 'user' || typeof value.content !== 'string') {
		throw invalidRecord(path, line, 'user')
	}
	if (value.timestamp !== undefined && !Number.isFinite(value.timestamp)) {
		throw invalidRecord(path, line, 'user.timestamp')
	}
	if (value.attachments !== undefined) {
		if (!Array.isArray(value.attachments)) throw invalidRecord(path, line, 'user.attachments')
		for (const attachment of value.attachments) validateAttachment(attachment, path, line)
	}
	if (value.source !== undefined) {
		if (isObject(value.source) && value.source.type === 'project-instructions') {
			if (!isProjectInstructionMessageSource(value.source)) {
				throw invalidRecord(path, line, 'user.source')
			}
		} else if (isObject(value.source) && value.source.type === 'runtime-context') {
			if (!isRuntimeContextMessageSource(value.source)) {
				throw invalidRecord(path, line, 'user.source')
			}
		} else if (
			!isObject(value.source) ||
			value.source.type !== 'goal-round' ||
			typeof value.source.goalId !== 'string' ||
			typeof value.source.objective !== 'string' ||
			!Number.isSafeInteger(value.source.goalRevision) ||
			Number(value.source.goalRevision) < 1 ||
			!Number.isSafeInteger(value.source.round) ||
			Number(value.source.round) < 1 ||
			!Number.isSafeInteger(value.source.maxGoalRounds) ||
			Number(value.source.maxGoalRounds) < 1
		) {
			throw invalidRecord(path, line, 'user.source')
		} else {
			try {
				asGoalId(value.source.goalId)
			} catch {
				throw invalidRecord(path, line, 'user.source.goalId')
			}
		}
	}
	return value as unknown as UserMessage
}

function validateAttachment(value: unknown, path: string, line: number): void {
	if (!isObject(value) || typeof value.mediaType !== 'string') {
		throw invalidRecord(path, line, 'attachment')
	}
	if (value.type === 'stored') {
		if (
			typeof value.ref !== 'string' ||
			(value.kind !== 'image' && value.kind !== 'document') ||
			(value.name !== undefined && typeof value.name !== 'string') ||
			(value.citations !== undefined && typeof value.citations !== 'boolean')
		) {
			throw invalidRecord(path, line, 'stored attachment')
		}
		return
	}
	if (typeof value.data !== 'string') throw invalidRecord(path, line, 'inline attachment')
	if (value.type === 'document') {
		if (
			(value.name !== undefined && typeof value.name !== 'string') ||
			(value.citations !== undefined && typeof value.citations !== 'boolean')
		) {
			throw invalidRecord(path, line, 'document attachment')
		}
		return
	}
	if (value.type !== undefined && value.type !== 'image') {
		throw invalidRecord(path, line, 'attachment.type')
	}
	if (value.modelOmission !== undefined && !isModelContentOmission(value.modelOmission)) {
		throw invalidRecord(path, line, 'attachment.modelOmission')
	}
}

function requiredString(value: unknown, field: string): string {
	if (typeof value !== 'string') throw new TypeError(`${field} must be a string`)
	return value
}

function requiredTimestamp(value: unknown): number {
	if (!Number.isFinite(value) || Number(value) < 0)
		throw new TypeError('recordedAt must be a timestamp')
	return Number(value)
}

function invalidRecord(
	path: string,
	line: number,
	detail: unknown,
): ConversationEvidenceCorruptionError {
	return new ConversationEvidenceCorruptionError(
		`Conversation evidence in ${path} has an invalid record at line ${line}: ${detail instanceof Error ? detail.message : String(detail)}.`,
	)
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function sameReference(
	left: ConversationTurnReference,
	right: ConversationTurnReference | undefined,
): boolean {
	return left.sessionId === right?.sessionId && left.turnId === right?.turnId
}

function isMissing(error: unknown): boolean {
	return isObject(error) && error.code === 'ENOENT'
}
