import { z } from 'zod'
import { type LearningLeakGuard, assertNoLearningLeak } from './leak-tripwire.js'
import {
	type LearningSkillCandidate,
	hashLearningSkill,
	learningEvidenceSchema,
	normalizeLearningSkill,
} from './skill.js'

/**
 * The experience library: what an earlier cycle tried and what came of it,
 * kept beside the observations so a later generator can read it. Three rules
 * hold throughout. An entry stores the adopted or rejected artefact whole,
 * never a summary of it. Retrieval is limited to one domain and to entries
 * recorded before a stated point. And a verdict never claims more than the
 * evidence can separate: when a candidate changed several components at once,
 * the result belongs to the whole change, so each row says `confounded`.
 */

const label = z.string().trim().min(1).max(256)
const text = z.string().trim().min(1).max(2_000)
const domainLabel = z.string().regex(/^[a-z0-9][a-z0-9_.-]{0,63}$/)

export const LEARNING_EDIT_VERDICTS = [
	'helped',
	'hurt',
	'no observed effect',
	'confounded',
] as const
/** @experimental What one edit did, as far as the evidence can separate it from the others. */
export type LearningEditVerdict = (typeof LEARNING_EDIT_VERDICTS)[number]

export const LEARNING_CONFIDENCE_LEVELS = ['high', 'medium', 'low'] as const
/** @experimental How far a lesson can be trusted. */
export type LearningConfidence = (typeof LEARNING_CONFIDENCE_LEVELS)[number]

const editSchema = z.object({
	/** The part of the harness the edit touched, such as `instruction-skill`. */
	component: label,
	/** What changed, in a sentence. */
	change: text,
	verdict: z.enum(LEARNING_EDIT_VERDICTS),
	/**
	 * True only when this edit was tried alone (an ablation), so its verdict is
	 * separable even though the candidate changed several components.
	 */
	isolated: z.boolean().optional(),
})

const lessonSchema = z.object({
	/** The shape of the situation the lesson applies to, not the incident itself. */
	cue: text,
	lesson: text,
	/** References into the observations, session log or verification receipts. */
	evidence: z.array(learningEvidenceSchema).min(1).max(16),
	confidence: z.enum(LEARNING_CONFIDENCE_LEVELS),
	confidenceReason: text,
	/** Indexes into the entry's edits that the lesson rests on. */
	edits: z.array(z.number().int().min(0).max(63)).max(64).optional(),
})

/** @experimental One edit row of the typed ledger. */
export type LearningEditRow = Readonly<z.infer<typeof editSchema>>
/** @experimental A lesson, with the confidence the evidence supports. */
export type LearningLesson = Readonly<
	Omit<z.infer<typeof lessonSchema>, 'evidence' | 'edits'> & {
		readonly evidence: readonly Readonly<z.infer<typeof learningEvidenceSchema>>[]
		readonly edits?: readonly number[]
	}
>

/** What a host passes when it records one finished cycle. */
export interface LearningExperienceInput {
	/** The kind of task the cycle was about; retrieval never crosses domains. */
	readonly domain: string
	/** The cycle that produced the entry; one entry per cycle. */
	readonly cycleId: string
	/** The evaluator that judged the candidate. Lessons are only comparable under the same revision. */
	readonly evaluatorRevision: string
	readonly decision: 'adopted' | 'rejected'
	/** Why, as the verification recorded it. */
	readonly reason: string
	/** The whole artefact, as proposed. */
	readonly candidate: LearningSkillCandidate
	readonly edits: readonly LearningEditRow[]
	readonly lessons?: readonly LearningLesson[]
	/** Evaluator-side material to refuse in anything the entry would keep. */
	readonly leakGuard?: LearningLeakGuard
}

const inputSchema = z.object({
	domain: domainLabel,
	cycleId: z.string().uuid(),
	evaluatorRevision: label,
	decision: z.enum(['adopted', 'rejected']),
	reason: text,
	edits: z.array(editSchema).min(1).max(64),
	lessons: z.array(lessonSchema).max(32).optional(),
})

/** @experimental A stored entry. `ordinal` is its position in recording order. */
export interface LearningExperienceEntry {
	readonly ordinal: number
	readonly domain: string
	readonly cycleId: string
	readonly evaluatorRevision: string
	readonly decision: 'adopted' | 'rejected'
	readonly reason: string
	/** The full artefact as proposed, unabridged. */
	readonly candidate: LearningSkillCandidate
	readonly candidateRevision: string
	readonly edits: readonly LearningEditRow[]
	readonly lessons: readonly LearningLesson[]
}

const CAP: Record<LearningConfidence, number> = { low: 0, medium: 1, high: 2 }
const BY_RANK: readonly LearningConfidence[] = ['low', 'medium', 'high']

/**
 * Apply the rules that keep a record honest. Several components in one
 * candidate share a single outcome, so unless a row was tried alone its
 * verdict becomes `confounded`. A lesson that rests on a confounded edit is
 * capped at medium; one that rests only on confounded edits is low, and its
 * reason says why.
 */
export function normalizeLearningExperience(
	input: LearningExperienceInput,
): Omit<LearningExperienceEntry, 'ordinal'> {
	const { leakGuard: _guard, candidate: rawCandidate, ...rest } = input
	const parsed = inputSchema.parse(rest)
	const candidate = normalizeLearningSkill(rawCandidate)
	const several = new Set(parsed.edits.map((edit) => edit.component)).size > 1
	const edits: LearningEditRow[] = parsed.edits.map((edit) => {
		const { isolated, ...row } = edit
		if (several && isolated !== true) return { ...row, verdict: 'confounded' as const }
		return isolated === true ? { ...row, isolated } : row
	})
	const lessons: LearningLesson[] = (parsed.lessons ?? []).map((lesson) => {
		const refs = lesson.edits ?? []
		for (const index of refs)
			if (index >= edits.length) throw new Error(`Lesson refers to edit ${index}, which is absent.`)
		const confounded = refs.filter((index) => edits[index]?.verdict === 'confounded').length
		if (confounded === 0) return lesson
		const all = confounded === refs.length
		const cap = all ? 'low' : 'medium'
		if (CAP[lesson.confidence] <= CAP[cap]) {
			return {
				...lesson,
				confidenceReason: `${lesson.confidenceReason} (Stands on confounded edits.)`,
			}
		}
		return {
			...lesson,
			confidence: BY_RANK[CAP[cap]] as LearningConfidence,
			confidenceReason: `${lesson.confidenceReason} (Narrowed to ${cap}: ${
				all ? 'every' : 'some'
			} edit it rests on changed together with others.)`,
		}
	})
	return {
		domain: parsed.domain,
		cycleId: parsed.cycleId.toLowerCase(),
		evaluatorRevision: parsed.evaluatorRevision,
		decision: parsed.decision,
		reason: parsed.reason,
		candidate,
		candidateRevision: hashLearningSkill(candidate),
		edits,
		lessons,
	}
}

/** Refuse an entry that would keep evaluator-side material. Throws {@link LearningLeakError}. */
export function assertExperienceHasNoLeak(
	entry: Omit<LearningExperienceEntry, 'ordinal'>,
	guard: LearningLeakGuard | undefined,
): void {
	assertNoLearningLeak(guard, [
		{ subject: 'experience.reason', text: entry.reason },
		{ subject: 'experience.candidate.description', text: entry.candidate.description },
		{ subject: 'experience.candidate.body', text: entry.candidate.body },
		...(entry.candidate.sources
			? [
					{
						subject: 'experience.candidate.sources',
						paths: entry.candidate.sources.map((s) => s.key),
					},
				]
			: []),
		...entry.edits.map((edit, i) => ({ subject: `experience.edits[${i}]`, text: edit.change })),
		...entry.lessons.flatMap((lesson, i) => [
			{
				subject: `experience.lessons[${i}]`,
				text: `${lesson.cue}\n${lesson.lesson}\n${lesson.confidenceReason}\n${lesson.evidence
					.map((e) => `${e.key} ${e.source} ${e.reason}`)
					.join('\n')}`,
			},
		]),
	])
}

/** @experimental Where retrieval may look. */
export interface LearningExperienceQuery {
	readonly domain: string
	/** The evaluator the reader is judged by; entries from another revision are not comparable. */
	readonly evaluatorRevision: string
	/** Only entries recorded before this ordinal. The reader's own entry is never among them. */
	readonly beforeOrdinal: number
	readonly decision?: 'adopted' | 'rejected'
	/** Newest first; default 20. */
	readonly limit?: number
}

/** The retrieval rule, shared by every store: same domain, same evaluator, strictly earlier. */
export function selectLearningExperience(
	entries: readonly LearningExperienceEntry[],
	query: LearningExperienceQuery,
): LearningExperienceEntry[] {
	const limit = Math.max(1, Math.min(query.limit ?? 20, 200))
	return entries
		.filter(
			(entry) =>
				entry.domain === query.domain &&
				entry.evaluatorRevision === query.evaluatorRevision &&
				entry.ordinal < query.beforeOrdinal &&
				(query.decision === undefined || entry.decision === query.decision),
		)
		.sort((a, b) => b.ordinal - a.ordinal)
		.slice(0, limit)
}
