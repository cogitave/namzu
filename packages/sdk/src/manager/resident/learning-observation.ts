import { z } from 'zod'
import { residentLearningEvidenceSchema } from './learning.js'

const label = z.string().trim().min(1).max(256)
export const learningTargetSchema = z.object({
	skillName: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
	evaluatorRevision: label,
	baselineRevision: z.union([z.literal('none'), z.string().regex(/^[a-f0-9]{64}$/)]),
})

export const learningObservationSchema = learningTargetSchema.extend({
	runId: z
		.string()
		.uuid()
		.transform((id) => id.toLowerCase()),
	/** Stable task identity, including input/source revision; retries keep the same key. */
	taskKey: label,
	outcome: z.enum(['passed', 'failed', 'execution-error', 'unresolved']),
	/** Host verified all execution receipts have settled. This is not a model assertion. */
	usageComplete: z.boolean(),
	evidence: residentLearningEvidenceSchema,
	trace: z.string().trim().min(1).max(32_000),
})

/** @experimental Host-scored observation; failures need retained traces and a versioned evaluator. */
export type ResidentLearningObservation = Readonly<
	Omit<z.infer<typeof learningObservationSchema>, 'evidence'>
> & {
	readonly evidence: Readonly<z.infer<typeof learningObservationSchema>['evidence']>
}

/** @experimental Current evaluator and installed skill revision authorized for one experiment. */
export type ResidentLearningTarget = Readonly<z.infer<typeof learningTargetSchema>>

/** @experimental Stable insertion order; a claimed cycle may have no live executor. */
export interface ResidentLearningObservationRecord extends ResidentLearningObservation {
	readonly ordinal: number
	readonly attemptedCycleId: string | null
}
