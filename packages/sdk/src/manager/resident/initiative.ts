import { z } from 'zod'
import type { ResidentAgendaState } from './agenda.js'

const boundedText = z.string().trim().min(1).max(256)
const cost = z.number().finite().nonnegative()
export const residentObservationSchema = z.object({
	evidenceKey: boundedText,
	source: boundedText,
	progress: z.number().finite().min(0).max(1),
	/** All observations and policy costs use the same host-defined resource unit. */
	costUnits: cost.nullable(),
})

/** @experimental Host-validated outcome and measured resource use, never model self-confidence. */
export type ResidentObservation = Readonly<z.infer<typeof residentObservationSchema>>

export const residentFeedbackSchema = z.object({
	bestProgress: z.number().finite().min(0).max(1),
	hasUnobservedSteps: z.boolean().default(false),
	stagnantSteps: z.number().int().nonnegative().safe(),
	observations: z
		.array(
			residentObservationSchema.extend({
				gain: z.number().finite().min(0).max(1),
				step: z.number().int().positive().safe(),
			}),
		)
		.min(1)
		.max(8),
})

/** @experimental Last eight observations; best progress and stagnation survive eviction. */
export type ResidentFeedback = Readonly<
	Omit<z.infer<typeof residentFeedbackSchema>, 'observations'>
> & {
	readonly observations: readonly Readonly<
		z.infer<typeof residentFeedbackSchema>['observations'][number]
	>[]
}

export function observeResidentStep(
	previous: ResidentFeedback | undefined,
	input: ResidentObservation,
	step: number,
): ResidentFeedback {
	const observation = residentObservationSchema.parse(input)
	const best = previous?.bestProgress ?? 0
	const duplicate = previous?.observations.some(
		(item) => item.evidenceKey === observation.evidenceKey,
	)
	// Rewording evidence, regression and recovery to an old best earn no credit.
	const gain = duplicate ? 0 : Math.max(0, observation.progress - best)
	return freezeResidentFeedback(
		residentFeedbackSchema.parse({
			bestProgress: best + gain,
			hasUnobservedSteps:
				(previous?.hasUnobservedSteps ?? false) ||
				step !== (previous?.observations.at(-1)?.step ?? 0) + 1,
			stagnantSteps: gain > 0 ? 0 : (previous?.stagnantSteps ?? 0) + 1,
			observations: [...(previous?.observations ?? []), { ...observation, gain, step }].slice(-8),
		}),
	)
}

export function freezeResidentFeedback(value: ResidentFeedback): ResidentFeedback {
	return Object.freeze({
		...value,
		observations: Object.freeze(value.observations.map((item) => Object.freeze({ ...item }))),
	})
}

/** @experimental Policy units are chosen by the host; scores are heuristics, not probabilities. */
export interface ResidentSelectionConfig {
	readonly progressValue: number
	readonly initialExpectedProgress: number
	readonly initialExpectedCost: number
	readonly maxStagnantSteps?: number
}

/** @experimental Explainable inputs for a single selection; unknown cost is not zero. */
export interface ResidentCandidate {
	readonly pursuitId: string
	readonly reason:
		| 'eligible'
		| 'not-due'
		| 'missing-observation'
		| 'stalled'
		| 'unknown-cost'
		| 'nonpositive-value'
	readonly expectedGain: number | null
	readonly expectedCost: number | null
	readonly score: number | null
}

/** @experimental Choice is bound to the whole agenda revision used to compute it. */
export interface ResidentSelection {
	readonly agendaRevision: number
	readonly pursuitId: string | null
	readonly reason: 'selected' | 'paused' | 'unresolved' | 'no-useful-work'
	readonly candidates: readonly ResidentCandidate[]
}

/** @experimental Pure local selection; perform inference inside budgeted steps, not here. */
export type ResidentSelector = (agenda: ResidentAgendaState, now: number) => ResidentSelection

/**
 * @experimental Cost-aware continuation with an explicit abstention choice.
 * This is a measured-progress heuristic, not Bayesian value of computation.
 * A finite bootstrap allowance permits delayed payoffs but may stop too early.
 */
export function createResidentSelector(config: ResidentSelectionConfig): ResidentSelector {
	const policy = z
		.object({
			progressValue: z.number().finite().positive(),
			initialExpectedProgress: z.number().finite().positive().max(1),
			initialExpectedCost: cost,
			maxStagnantSteps: z.number().int().min(1).max(32).default(2),
		})
		.parse(config)
	return (agenda, now) => {
		z.number().int().nonnegative().safe().parse(now)
		const finish = (
			pursuitId: string | null,
			reason: ResidentSelection['reason'],
			candidates: ResidentCandidate[],
		): ResidentSelection =>
			Object.freeze({
				agendaRevision: agenda.revision,
				pursuitId,
				reason,
				candidates: Object.freeze(candidates.map((candidate) => Object.freeze(candidate))),
			})
		if (agenda.paused) return finish(null, 'paused', [])
		if (agenda.pursuits.some((p) => p.state.phase === 'running'))
			return finish(null, 'unresolved', [])
		const candidates = agenda.pursuits.map((p): ResidentCandidate => {
			const reject = (reason: ResidentCandidate['reason']): ResidentCandidate => ({
				pursuitId: p.id,
				reason,
				expectedGain: null,
				expectedCost: null,
				score: null,
			})
			if (p.state.phase !== 'waiting' || p.state.wakeAt === null || p.state.wakeAt > now)
				return reject('not-due')
			if (
				p.state.stepsAdmitted > 0 &&
				(!p.feedback ||
					p.feedback.hasUnobservedSteps ||
					p.feedback.observations.at(-1)?.step !== p.state.stepsAdmitted)
			)
				return reject('missing-observation')
			const feedback = p.feedback
			if (feedback && feedback.stagnantSteps >= policy.maxStagnantSteps) return reject('stalled')
			if (feedback?.observations.some((item) => item.costUnits === null))
				return reject('unknown-cost')
			const recent = feedback?.observations ?? []
			const totalGain = recent.reduce((total, item) => total + item.gain, 0)
			const bootstrap = p.state.stepsAdmitted < policy.maxStagnantSteps && totalGain === 0
			const expectedGain =
				recent.length === 0 || bootstrap
					? policy.initialExpectedProgress
					: (totalGain + policy.initialExpectedProgress) / (recent.length + 1)
			const expectedCost =
				recent.length === 0
					? policy.initialExpectedCost
					: recent.reduce((total, item) => total + (item.costUnits ?? 0), 0) / recent.length
			const score = policy.progressValue * expectedGain - expectedCost
			return {
				pursuitId: p.id,
				reason: score > 0 ? 'eligible' : 'nonpositive-value',
				expectedGain,
				expectedCost,
				score,
			}
		})
		const eligible = candidates.filter((candidate) => candidate.reason === 'eligible')
		eligible.sort((a, b) => {
			const left = agenda.pursuits.find((p) => p.id === a.pursuitId)
			const right = agenda.pursuits.find((p) => p.id === b.pursuitId)
			if (!left || !right) throw new Error('Resident candidate is missing.')
			return (
				(b.score ?? 0) - (a.score ?? 0) ||
				left.state.stepsAdmitted - right.state.stepsAdmitted ||
				(left.state.wakeAt ?? 0) - (right.state.wakeAt ?? 0) ||
				a.pursuitId.localeCompare(b.pursuitId)
			)
		})
		return finish(
			eligible[0]?.pursuitId ?? null,
			eligible.length ? 'selected' : 'no-useful-work',
			candidates,
		)
	}
}
