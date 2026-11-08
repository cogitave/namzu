import { createHash } from 'node:crypto'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import { DiskRecordStore } from '../store/kv/record-store.js'
import { DiskRevisionRecordStore, revisionFileSegment } from '../store/kv/revision-record-store.js'
import { defineSchema } from '../store/schema.js'
import type { TenantId } from '../types/ids/index.js'
import { asTenantId } from '../utils/id.js'
import {
	type LearningEvidence,
	type LearningProfileUpdate,
	type LearningSkillCandidate,
	type LearningSkillEvaluation,
	type LearningState,
	freezeLearning,
	learningEvidenceSchema,
	learningSchema,
	promoteLearningSkill,
	restoreLearningSkill,
	reviseLearningProfile,
} from './skill.js'

/**
 * @experimental One immutable revision of the guidance a learning target has
 * earned. `learning` is absent until the first profile change or activation.
 */
export interface LearningGuidanceState {
	readonly tenantId: string
	readonly agentKey: string
	readonly revision: number
	readonly learning?: LearningState
}

/** @experimental A competing writer advanced the guidance revision; read it again before retrying. */
export class LearningGuidanceConflictError extends Error {
	constructor() {
		super('Learning guidance changed; read the current guidance before retrying.')
		this.name = 'LearningGuidanceConflictError'
	}
}

const guidanceSchema = z.object({
	tenantId: z.string().uuid(),
	agentKey: z.string().min(1).max(200),
	revision: z.number().int().positive().safe(),
	learning: learningSchema.optional(),
})

const guidanceRecordSchema = defineSchema({
	kind: 'learning-guidance',
	current: 1,
	migrations: {},
})

/**
 * The record format learning guidance was kept in before it had a store of its
 * own. Its `kind` is the identifier stamped into those files, so it keeps its
 * spelling; only the fields learning used are read from it.
 */
const earlierRecordSchema = defineSchema({
	kind: 'resident-agenda',
	current: 6,
	migrations: {
		1: (record) => record,
		2: (record) => record,
		3: (record) => record,
		4: (record) => record,
		5: (record) => record,
	},
})

const earlierFieldsSchema = z.object({
	tenantId: z.string().uuid(),
	agentKey: z.string().min(1).max(200),
	revision: z.number().int().positive().safe(),
	learning: learningSchema.optional(),
})

/** Marker written beside the revisions once an earlier store has been carried over. */
const ADOPTED_MARKER = 'adopted.json'
const REVISION_FILE = /^([1-9][0-9]{0,15})\.json$/

/** A key as one bounded path segment, the way the earlier store addressed it. */
function keySegment(key: string): string {
	const encoded = revisionFileSegment(key)
	return encoded.length <= 255
		? encoded
		: `~sha256-${createHash('sha256').update(encoded).digest('hex')}`
}

/**
 * Where guidance was kept before it had a store of its own, for one scope:
 * `<root>/<tenant>/<key>/agenda`. Pass the result as `adoptFrom` to carry it over.
 */
export function earlierGuidanceDirectory(
	root: string,
	scope: { readonly tenantId: string; readonly agentKey: string },
): string {
	return join(root, asTenantId(scope.tenantId), keySegment(scope.agentKey), 'agenda')
}

/** @experimental Where a guidance store lives and what it may carry over on first use. */
export interface DiskLearningGuidanceOptions {
	/**
	 * A directory holding guidance in the earlier record format
	 * (see {@link earlierGuidanceDirectory}). On the first use of this store,
	 * every revision found there is copied into it with its revision number, and
	 * a marker is written beside them. The earlier files are only read, never
	 * changed or removed, so an older version keeps working on them.
	 */
	readonly adoptFrom?: string
}

/**
 * @experimental Revisioned, evaluated guidance for one tenant and one scope key,
 * on a trusted local filesystem. Every change is an immutable revision published
 * exclusively, so two processes cannot both commit the same one, and an older
 * revision stays readable to roll one skill back.
 */
export class DiskLearningGuidance {
	private readonly records = new DiskRevisionRecordStore<LearningGuidanceState>(
		guidanceRecordSchema,
		'learning guidance',
		(record) => record.revision,
	)
	private readonly historyRecords = new DiskRecordStore<LearningGuidanceState>(guidanceRecordSchema)
	private readonly location
	private readonly tenantId: TenantId
	private readonly agentKey: string
	private readonly directory: string
	private readonly adoptFrom: string | undefined
	private adopting: Promise<void> | undefined

	constructor(
		directory: string,
		scope: { tenantId: TenantId | string; agentKey: string },
		options: DiskLearningGuidanceOptions = {},
	) {
		this.tenantId = asTenantId(scope.tenantId)
		this.agentKey = z.string().min(1).max(200).parse(scope.agentKey)
		this.directory = directory
		this.adoptFrom = options.adoptFrom
		this.location = {
			legacyPath: join(directory, 'state.json'),
			revisionsDir: join(directory, 'revisions'),
			publishLegacyProjection: false,
		}
	}

	private checked(record: LearningGuidanceState): LearningGuidanceState {
		const state = guidanceSchema.parse(record)
		if (state.tenantId !== this.tenantId || state.agentKey !== this.agentKey)
			throw new Error('Guidance does not match the bound tenant and scope key.')
		return Object.freeze({
			...state,
			...(state.learning ? { learning: freezeLearning(state.learning) } : {}),
		})
	}

	/** Carry an earlier store over once per process, and once ever per directory. */
	private ready(): Promise<void> {
		if (!this.adoptFrom) return Promise.resolve()
		this.adopting ??= this.adopt(this.adoptFrom).catch((error) => {
			this.adopting = undefined
			throw error
		})
		return this.adopting
	}

	private async adopt(from: string): Promise<void> {
		const marker = new DiskRecordStore<unknown>(guidanceRecordSchema)
		if ((await marker.read(join(this.directory, ADOPTED_MARKER))) !== null) return
		const earlier = new DiskRecordStore<unknown>(earlierRecordSchema)
		let names: string[]
		try {
			names = await readdir(join(from, 'revisions'))
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
			throw error
		}
		const revisions = names
			.flatMap((name) => {
				const match = REVISION_FILE.exec(name)
				return match ? [Number(match[1])] : []
			})
			.sort((a, b) => a - b)
		if (!revisions.length) return
		const head = revisions[revisions.length - 1] as number
		if (revisions.length !== head)
			throw new Error(
				`Earlier guidance in ${from} has gaps between revisions 1 and ${head}; it was not carried over.`,
			)
		for (const revision of revisions) {
			const current = await this.records.read(this.location)
			if ((current?.revision ?? 0) >= revision) continue
			const raw = await earlier.read(join(from, 'revisions', `${revision}.json`))
			const fields = earlierFieldsSchema.parse(raw)
			if (
				fields.revision !== revision ||
				fields.tenantId !== this.tenantId ||
				fields.agentKey !== this.agentKey
			)
				throw new Error(
					`Earlier guidance revision ${revision} in ${from} does not match this tenant and scope key; it was not carried over.`,
				)
			const record = this.checked({
				tenantId: fields.tenantId,
				agentKey: fields.agentKey,
				revision,
				...(fields.learning ? { learning: fields.learning } : {}),
			})
			try {
				await this.records.transact(this.location, (latest) => {
					if ((latest?.revision ?? 0) !== revision - 1) throw new LearningGuidanceConflictError()
					return { record, result: undefined }
				})
			} catch (error) {
				// A concurrent process carrying over the same revision wins identically.
				const after = await this.records.read(this.location)
				if ((after?.revision ?? 0) < revision) throw error
			}
		}
		await marker.write(join(this.directory, ADOPTED_MARKER), {
			from,
			revisions: head,
			adoptedAt: new Date().toISOString(),
		})
	}

	async read(): Promise<LearningGuidanceState | null> {
		await this.ready()
		const record = await this.records.read(this.location)
		return record === null ? null : this.checked(record)
	}

	/** One immutable revision, as it was committed. */
	async readRevision(revision: number): Promise<LearningGuidanceState | null> {
		z.number().int().positive().safe().parse(revision)
		await this.ready()
		const record = await this.historyRecords.read(
			join(this.location.revisionsDir, `${revision}.json`),
		)
		if (record === null) return null
		const state = this.checked(record)
		if (state.revision !== revision)
			throw new Error('Guidance revision filename and body disagree.')
		return state
	}

	/** Create the empty first revision. A second creator gets a conflict. */
	async create(): Promise<LearningGuidanceState> {
		await this.ready()
		const record = this.checked({
			tenantId: this.tenantId,
			agentKey: this.agentKey,
			revision: 1,
		})
		return this.records.transact(this.location, (current) => {
			if (current !== null) throw new LearningGuidanceConflictError()
			return { record, result: record }
		})
	}

	/** The current guidance, created empty when none exists yet. Safe to race. */
	async open(): Promise<LearningGuidanceState> {
		const existing = await this.read()
		if (existing) return existing
		try {
			return await this.create()
		} catch (error) {
			const raced = await this.read()
			if (!raced) throw error
			return raced
		}
	}

	private async learn(
		expected: LearningGuidanceState,
		learning: LearningState,
	): Promise<LearningGuidanceState> {
		await this.ready()
		const snapshot = this.checked(expected)
		return this.records.transact(this.location, (record) => {
			if (record === null) throw new LearningGuidanceConflictError()
			const current = this.checked(record)
			if (current.revision !== snapshot.revision) throw new LearningGuidanceConflictError()
			if (!isDeepStrictEqual(current.learning, snapshot.learning))
				throw new LearningGuidanceConflictError()
			const next = this.checked({ ...current, learning, revision: current.revision + 1 })
			return { record: next, result: next }
		})
	}

	/** Append a host-evidenced correction to identity or preferences. */
	async updateProfile(
		expected: LearningGuidanceState,
		input: LearningProfileUpdate,
	): Promise<LearningGuidanceState> {
		const snapshot = this.checked(expected)
		return this.learn(snapshot, reviseLearningProfile(snapshot.learning, input))
	}

	/** Bind evaluated guidance to the current learning version. */
	async promoteSkill(
		expected: LearningGuidanceState,
		candidate: LearningSkillCandidate,
		evaluation: LearningSkillEvaluation,
		evidence: LearningEvidence,
	): Promise<LearningGuidanceState> {
		const snapshot = this.checked(expected)
		return this.learn(
			snapshot,
			promoteLearningSkill(snapshot.learning, candidate, evaluation, evidence),
		)
	}

	/** Restore one skill from an immutable earlier revision while keeping the current profile. */
	async rollbackSkill(
		expected: LearningGuidanceState,
		name: string,
		fromRevision: number,
		evidence: LearningEvidence,
	): Promise<LearningGuidanceState> {
		const snapshot = this.checked(expected)
		const checkedEvidence = learningEvidenceSchema.parse(evidence)
		z.number().int().positive().safe().max(snapshot.revision).parse(fromRevision)
		z.string()
			.regex(/^[a-z0-9][a-z0-9_-]{0,63}$/)
			.parse(name)
		const historical = await this.readRevision(fromRevision)
		if (!historical) throw new Error('Skill rollback revision is missing.')
		return this.learn(
			snapshot,
			restoreLearningSkill(snapshot.learning, historical.learning, name, checkedEvidence),
		)
	}
}
