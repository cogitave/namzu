import { z } from 'zod'
import { learningEvidenceSchema } from './skill.js'

const label = z.string().trim().min(1).max(256)
export const learningTargetSchema = z.object({
	skillName: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
	evaluatorRevision: label,
	baselineRevision: z.union([z.literal('none'), z.string().regex(/^[a-f0-9]{64}$/)]),
})

const lowerUuid = z
	.string()
	.uuid()
	.transform((id) => id.toLowerCase())

export const learningObservationSchema = learningTargetSchema.extend({
	/** The session whose log holds the observed turn. */
	sessionId: lowerUuid,
	/** The observed turn; one observation per (session, turn, evaluator, skill). */
	turnId: lowerUuid,
	/** Stable task identity, including input/source revision; retries keep the same key. */
	taskKey: label,
	outcome: z.enum(['passed', 'failed', 'execution-error', 'unresolved']),
	/** Host verified all execution receipts have settled. This is not a model assertion. */
	usageComplete: z.boolean(),
	evidence: learningEvidenceSchema,
	trace: z.string().trim().min(1).max(32_000),
})

/** @experimental Host-scored observation; failures need retained traces and a versioned evaluator. */
export type LearningObservation = Readonly<
	Omit<z.infer<typeof learningObservationSchema>, 'evidence'>
> & {
	readonly evidence: Readonly<z.infer<typeof learningObservationSchema>['evidence']>
}

/** @experimental Current evaluator and installed skill revision authorized for one experiment. */
export type LearningTarget = Readonly<z.infer<typeof learningTargetSchema>>

/** @experimental Stable insertion order; a claimed cycle may have no live executor. */
export interface LearningObservationRecord extends LearningObservation {
	readonly ordinal: number
	readonly attemptedCycleId: string | null
}
