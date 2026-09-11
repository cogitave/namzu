import { createHash } from 'node:crypto'
import { z } from 'zod'
import {
	type HarnessVerificationBatch,
	reviewHarnessCandidate,
} from '../../eval/harness-verification.js'

const label = z.string().trim().min(1).max(256)
const name = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/)
const digest = z.string().regex(/^[a-f0-9]{64}$/)
export const residentLearningEvidenceSchema = z.object({
	key: label,
	source: label,
	reason: z.string().trim().min(1).max(1_000),
})

/** @experimental Host provenance for a correction, evaluated activation or rollback. */
export type ResidentLearningEvidence = Readonly<z.infer<typeof residentLearningEvidenceSchema>>

const candidateSchema = z.object({
	name,
	description: z.string().trim().min(1).max(1_000),
	body: z.string().trim().min(1).max(4_000),
})

/** @experimental Instructional guidance only; never executable assets or tool permissions. */
export type ResidentSkillCandidate = Readonly<z.infer<typeof candidateSchema>>

const learnedSkillSchema = candidateSchema.extend({
	hash: digest,
	evidence: residentLearningEvidenceSchema,
	verification: z.object({
		baselineHash: z.union([digest, z.literal('none')]),
		candidateHash: digest,
		evidenceDigest: digest,
		verificationTasks: z.number().int().min(5).max(64),
		confirmationTasks: z.number().int().min(5).max(64),
	}),
})

/** @experimental Immutable evaluated content and evidence identity. */
export type ResidentLearnedSkill = Readonly<z.infer<typeof learnedSkillSchema>>

export const residentLearningSchema = z
	.object({
		revision: z.number().int().positive().safe(),
		identity: z
			.object({
				text: z.string().trim().min(1).max(4_000),
				evidence: residentLearningEvidenceSchema,
			})
			.optional(),
		preferences: z
			.array(
				z.object({
					key: name,
					value: z.string().trim().min(1).max(1_000),
					evidence: residentLearningEvidenceSchema,
				}),
			)
			.max(32),
		skills: z.array(learnedSkillSchema).max(16),
		lastChange: residentLearningEvidenceSchema,
	})
	.superRefine((state, context) => {
		if (
			new Set(state.preferences.map((p) => p.key)).size !== state.preferences.length ||
			new Set(state.skills.map((s) => s.name)).size !== state.skills.length ||
			state.skills.some(
				(skill) =>
					skill.hash !== hashResidentSkill(skill) ||
					skill.verification.candidateHash !== skill.hash,
			)
		)
			context.addIssue({
				code: z.ZodIssueCode.custom,
				message: 'Invalid resident learning identity or content digest.',
			})
	})

/** @experimental Versioned behavioral overlay; the original resident mandate remains unchanged. */
export interface ResidentLearningState {
	readonly revision: number
	readonly identity?: { readonly text: string; readonly evidence: ResidentLearningEvidence }
	readonly preferences: readonly {
		readonly key: string
		readonly value: string
		readonly evidence: ResidentLearningEvidence
	}[]
	readonly skills: readonly ResidentLearnedSkill[]
	readonly lastChange: ResidentLearningEvidence
}

/** @experimental Corrections name the current preference evidence they supersede. */
export interface ResidentProfileUpdate {
	readonly identity?: string
	readonly preferences?: readonly {
		readonly key: string
		readonly value: string
		readonly supersedes: string | null
	}[]
	readonly evidence: ResidentLearningEvidence
}

/** @experimental Recorded paired runs; hosts own execution, scoring and independent attribution. */
export interface ResidentSkillEvaluation {
	readonly verification: HarnessVerificationBatch
	readonly confirmation?: HarnessVerificationBatch
}

/** Internal immutable snapshot used by storage and admitted context. */
export function freezeResidentLearning(input: ResidentLearningState): ResidentLearningState {
	const state = residentLearningSchema.parse(input)
	return Object.freeze({
		...state,
		...(state.identity
			? {
					identity: Object.freeze({
						...state.identity,
						evidence: Object.freeze(state.identity.evidence),
					}),
				}
			: {}),
		preferences: Object.freeze(
			state.preferences.map((p) => Object.freeze({ ...p, evidence: Object.freeze(p.evidence) })),
		),
		skills: Object.freeze(
			state.skills.map((skill) =>
				Object.freeze({
					...skill,
					evidence: Object.freeze(skill.evidence),
					verification: Object.freeze(skill.verification),
				}),
			),
		),
		lastChange: Object.freeze(state.lastChange),
	})
}

function evidenceFor(
	current: ResidentLearningState | undefined,
	input: ResidentLearningEvidence,
): ResidentLearningEvidence {
	const evidence = residentLearningEvidenceSchema.parse(input)
	const used = [
		current?.lastChange,
		current?.identity?.evidence,
		...(current?.preferences.map((p) => p.evidence) ?? []),
		...(current?.skills.map((s) => s.evidence) ?? []),
	]
	if (used.some((old) => old?.key === evidence.key))
		throw new Error('A learning change requires a fresh evidence key.')
	return evidence
}

function base(
	current: ResidentLearningState | undefined,
	evidence: ResidentLearningEvidence,
): ResidentLearningState {
	const checked = current ? freezeResidentLearning(current) : undefined
	return {
		...checked,
		revision: (checked?.revision ?? 0) + 1,
		preferences: checked?.preferences ?? [],
		skills: checked?.skills ?? [],
		lastChange: evidence,
	}
}

/** Internal pure profile transition; storage owns exact agenda CAS and idle admission. */
export function reviseResidentProfile(
	current: ResidentLearningState | undefined,
	input: ResidentProfileUpdate,
): ResidentLearningState {
	const checked = z
		.object({
			identity: z.string().trim().min(1).max(4_000).optional(),
			preferences: z
				.array(
					z.object({
						key: name,
						value: z.string().trim().min(1).max(1_000),
						supersedes: label.nullable(),
					}),
				)
				.max(32)
				.optional(),
			evidence: residentLearningEvidenceSchema,
		})
		.parse(input)
	if (checked.identity === undefined && !checked.preferences?.length)
		throw new Error('A profile change must change identity or preferences.')
	if (
		new Set(checked.preferences?.map((p) => p.key)).size !== checked.preferences?.length &&
		checked.preferences !== undefined
	)
		throw new Error('Duplicate preference corrections are not allowed.')
	const evidence = evidenceFor(current, checked.evidence)
	const next = base(current, evidence)
	const preferences = [...next.preferences]
	for (const change of checked.preferences ?? []) {
		const index = preferences.findIndex((p) => p.key === change.key)
		const previous = index >= 0 ? preferences[index] : undefined
		if (change.supersedes !== (previous?.evidence.key ?? null))
			throw new Error('Preference correction does not supersede its current evidence.')
		const updated = { key: change.key, value: change.value, evidence }
		if (index < 0) preferences.push(updated)
		else preferences[index] = updated
	}
	return freezeResidentLearning({
		...next,
		preferences,
		...(checked.identity !== undefined ? { identity: { text: checked.identity, evidence } } : {}),
	})
}

/** @experimental Bind evaluation to the exact normalized name, description and body. */
export function hashResidentSkill(input: ResidentSkillCandidate): string {
	const candidate = candidateSchema.parse(input)
	return createHash('sha256')
		.update(JSON.stringify([candidate.name, candidate.description, candidate.body]))
		.digest('hex')
}

/** Internal pure activation; reuse the kernel's conservative two-round verification gate. */
export function promoteResidentSkill(
	current: ResidentLearningState | undefined,
	input: ResidentSkillCandidate,
	evaluation: ResidentSkillEvaluation,
	inputEvidence: ResidentLearningEvidence,
): ResidentLearningState {
	const candidate = candidateSchema.parse(input)
	const hash = hashResidentSkill(candidate)
	const baselineHash = current?.skills.find((s) => s.name === candidate.name)?.hash ?? 'none'
	const evidence = evidenceFor(current, inputEvidence)
	for (const batch of [evaluation.verification, evaluation.confirmation]) {
		if (!batch) continue
		if (batch.baselineRevision !== baselineHash || batch.candidateRevision !== hash)
			throw new Error('Skill evaluation does not match the active baseline and candidate digests.')
		if (
			batch.baseline.length > 128 ||
			batch.candidate.length > 128 ||
			batch.attributions.length > 128
		)
			throw new Error('Resident skill evaluation is bounded to 64 tasks per round.')
		// Recorded evidence must consistently identify success and complete measurements.
		for (const trial of [...batch.baseline, ...batch.candidate]) {
			if (
				trial.result.passed !== (trial.result.status === 'passed') ||
				(trial.result.status === 'passed' && trial.result.failedGates?.length)
			)
				throw new Error('Inconsistent recorded skill evaluation outcome.')
		}
	}
	const review = reviewHarnessCandidate(evaluation.verification, evaluation.confirmation)
	if (review.decision !== 'accept')
		throw new Error(`Resident skill promotion ${review.decision}: ${review.reason}`)
	const skill: ResidentLearnedSkill = {
		...candidate,
		hash,
		evidence,
		verification: {
			baselineHash,
			candidateHash: hash,
			evidenceDigest: createHash('sha256').update(JSON.stringify(evaluation)).digest('hex'),
			verificationTasks: review.verification.tasks.length,
			confirmationTasks: review.confirmation?.tasks.length ?? 0,
		},
	}
	const next = base(current, evidence)
	return freezeResidentLearning({
		...next,
		skills: [...next.skills.filter((s) => s.name !== candidate.name), skill],
	})
}

/** Internal rollback appends a new learning version while preserving current profile values. */
export function restoreResidentSkill(
	current: ResidentLearningState | undefined,
	historical: ResidentLearningState | undefined,
	skillName: string,
	inputEvidence: ResidentLearningEvidence,
): ResidentLearningState {
	name.parse(skillName)
	if (!current?.skills.some((s) => s.name === skillName))
		throw new Error('No active resident skill to roll back.')
	const next = base(current, evidenceFor(current, inputEvidence))
	const previous = historical
		? freezeResidentLearning(historical).skills.find((s) => s.name === skillName)
		: undefined
	return freezeResidentLearning({
		...next,
		skills: [...next.skills.filter((s) => s.name !== skillName), ...(previous ? [previous] : [])],
	})
}

/** @experimental Exact skill selection and a character cap, independent of provider token budgets. */
export interface ResidentLearningProjectionOptions {
	readonly maxChars: number
	readonly skillNames: readonly string[]
}

/** @experimental Omitted entries are counted; no partial skill instruction is emitted. */
export interface ResidentLearningProjection {
	readonly text: string
	readonly revision: number | null
	readonly includedSkills: readonly string[]
	readonly omitted: number
}

/** @experimental Bounded context data; never registers tools, loads files or executes a skill. */
export function projectResidentLearning(
	current: ResidentLearningState | undefined,
	options: ResidentLearningProjectionOptions,
): ResidentLearningProjection {
	if (!Number.isSafeInteger(options.maxChars) || options.maxChars < 0 || options.maxChars > 64_000)
		throw new TypeError('Resident learning context requires maxChars between 0 and 64000.')
	const selected = z.array(name).max(16).parse(options.skillNames)
	if (new Set(selected).size !== selected.length) throw new Error('Duplicate selected skill names.')
	if (!current)
		return Object.freeze({
			text: '',
			revision: null,
			includedSkills: Object.freeze([]),
			omitted: selected.length,
		})
	const state = freezeResidentLearning(current)
	const pieces: string[] = []
	const includedSkills: string[] = []
	let omitted = 0
	let length = 0
	const add = (value: unknown): boolean => {
		const part = JSON.stringify(value)
		const size = part.length + (pieces.length ? 1 : 0)
		if (length + size > options.maxChars) {
			omitted++
			return false
		}
		pieces.push(part)
		length += size
		return true
	}
	if (state.identity) add({ kind: 'self-description', ...state.identity })
	for (const preference of state.preferences) add({ kind: 'preference', ...preference })
	for (const skillName of selected) {
		const skill = state.skills.find((s) => s.name === skillName)
		if (!skill) {
			omitted++
			continue
		}
		if (
			add({
				kind: 'evaluated-guidance',
				name: skill.name,
				description: skill.description,
				body: skill.body,
				hash: skill.hash,
				evidence: skill.evidence,
			})
		)
			includedSkills.push(skill.name)
	}
	return Object.freeze({
		text: pieces.join('\n'),
		revision: state.revision,
		includedSkills: Object.freeze(includedSkills),
		omitted,
	})
}
