import { describe, expect, it } from 'vitest'
import type { ResidentAgendaState, ResidentPursuit } from './agenda.js'
import {
	type ResidentFeedback,
	type ResidentObservation,
	type ResidentSelectionConfig,
	createResidentSelector,
	observeResidentStep,
	residentFeedbackSchema,
} from './initiative.js'
import type { ResidentState } from './store.js'

const scope = {
	tenantId: '00000000-0000-4000-8000-000000000001',
	agentKey: 'initiative-test',
	identity: 'A careful research assistant.',
}
const policy: ResidentSelectionConfig = {
	progressValue: 10,
	initialExpectedProgress: 0.25,
	initialExpectedCost: 1,
}

function observation(
	evidenceKey: string,
	progress = 0,
	costUnits: number | null = 1,
): ResidentObservation {
	return { evidenceKey, progress, costUnits, source: 'host-validator' }
}

function pursuit(
	index: number,
	state: Partial<ResidentState> = {},
	feedback?: ResidentFeedback,
): ResidentPursuit {
	const id = `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`
	return Object.freeze({
		id,
		state: Object.freeze({
			...scope,
			pursuitId: id,
			objective: `Check objective ${index}.`,
			revision: 1,
			stepsAdmitted: 0,
			phase: 'waiting',
			wakeAt: 0,
			reason: 'Initial pursuit',
			summary: null,
			claimId: null,
			...state,
		}),
		...(feedback ? { feedback } : {}),
	})
}

function agenda(...pursuits: ResidentPursuit[]): ResidentAgendaState {
	return Object.freeze({
		...scope,
		revision: 23,
		paused: false,
		pursuits: Object.freeze(pursuits),
	})
}

describe('resident observations', () => {
	it('does not credit a repeated evidence key but includes its measured cost', () => {
		const first = observeResidentStep(undefined, observation('receipt-a', 0.4, 0.1), 1)
		const repeated = observeResidentStep(
			first,
			{ ...observation('receipt-a', 0.9, 0.3), source: 'renamed-validator' },
			2,
		)

		expect(repeated).toMatchObject({ bestProgress: 0.4, stagnantSteps: 1 })
		expect(repeated.observations.map(({ gain, costUnits }) => ({ gain, costUnits }))).toEqual([
			{ gain: 0.4, costUnits: 0.1 },
			{ gain: 0, costUnits: 0.3 },
		])
		const selection = createResidentSelector(policy)(
			agenda(pursuit(1, { stepsAdmitted: 2 }, repeated)),
			0,
		)
		expect(selection.candidates[0]).toMatchObject({
			expectedGain: (0.4 + 0.25) / 3,
			expectedCost: 0.2,
		})
		expect(first).toMatchObject({ bestProgress: 0.4, stagnantSteps: 0 })
		expect(first.observations).toHaveLength(1)
	})

	it('credits only progress beyond the historical best after regression and recovery', () => {
		const initial = observeResidentStep(undefined, observation('initial', 0.75), 1)
		const regression = observeResidentStep(initial, observation('regression', 0.25), 2)
		const recovery = observeResidentStep(regression, observation('recovery', 0.75), 3)
		const improvement = observeResidentStep(recovery, observation('improvement', 0.875), 4)

		expect(regression).toMatchObject({ bestProgress: 0.75, stagnantSteps: 1 })
		expect(recovery).toMatchObject({ bestProgress: 0.75, stagnantSteps: 2 })
		expect(improvement).toMatchObject({ bestProgress: 0.875, stagnantSteps: 0 })
		expect(improvement.observations.map(({ gain }) => gain)).toEqual([0.75, 0, 0, 0.125])
	})

	it('retains the best progress and stagnation count after evicting old observations', () => {
		const initial = observeResidentStep(undefined, observation('best', 0.875), 1)
		let feedback = initial
		for (let step = 2; step <= 10; step++) {
			feedback = observeResidentStep(feedback, observation(`noise-${step}`, 0.5), step)
		}

		expect(feedback).toMatchObject({ bestProgress: 0.875, stagnantSteps: 9 })
		expect(feedback.observations.map(({ step }) => step)).toEqual([3, 4, 5, 6, 7, 8, 9, 10])
		expect(feedback.observations.every(({ gain }) => gain === 0)).toBe(true)
		const recovery = observeResidentStep(feedback, observation('old-best-again', 0.875), 11)
		expect(recovery).toMatchObject({ bestProgress: 0.875, stagnantSteps: 10 })
		expect(recovery.observations.at(-1)?.gain).toBe(0)
		const improvement = observeResidentStep(recovery, observation('new-best', 1), 12)
		expect(improvement).toMatchObject({ bestProgress: 1, stagnantSteps: 0 })
		expect(improvement.observations.at(-1)?.gain).toBe(0.125)
		expect(improvement.observations).toHaveLength(8)
		expect(initial.observations).toHaveLength(1)
		expect(initial.bestProgress).toBe(0.875)
	})

	it('copies and freezes the observation, history and aggregate', () => {
		const input = { ...observation('receipt', 0.5) }
		const feedback = observeResidentStep(undefined, input, 1)
		input.progress = 1
		input.evidenceKey = 'rewritten'

		expect(Object.isFrozen(feedback)).toBe(true)
		expect(Object.isFrozen(feedback.observations)).toBe(true)
		expect(Object.isFrozen(feedback.observations[0])).toBe(true)
		expect(Reflect.set(feedback, 'bestProgress', 1)).toBe(false)
		expect(feedback.observations[0]).toMatchObject({
			evidenceKey: 'receipt',
			progress: 0.5,
			gain: 0.5,
		})
	})

	it.each([
		{ progress: -0.1 },
		{ progress: 1.1 },
		{ progress: Number.NaN },
		{ progress: Number.POSITIVE_INFINITY },
		{ costUnits: -1 },
		{ costUnits: Number.NaN },
		{ costUnits: Number.POSITIVE_INFINITY },
		{ evidenceKey: ' ' },
		{ source: '' },
	])('rejects an invalid host observation: %j', (invalid) => {
		expect(() =>
			observeResidentStep(undefined, { ...observation('receipt'), ...invalid }, 1),
		).toThrow()
	})

	it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
		'requires a positive safe integer observation step: %s',
		(step) => {
			expect(() => observeResidentStep(undefined, observation('receipt'), step)).toThrow()
		},
	)
})

describe('resident initiative selection', () => {
	it('stops changing evidence with no progress after the finite default bootstrap allowance', () => {
		const select = createResidentSelector(policy)
		let feedback: ResidentFeedback | undefined
		let admitted = 0
		for (let tick = 0; tick < 12; tick++) {
			const selection = select(agenda(pursuit(1, { stepsAdmitted: admitted }, feedback)), tick)
			if (selection.pursuitId !== null) {
				admitted++
				feedback = observeResidentStep(feedback, observation(`changing-noise-${tick}`), admitted)
			} else {
				expect(selection).toMatchObject({ reason: 'no-useful-work' })
				expect(selection.candidates[0]?.reason).toBe('stalled')
			}
		}

		expect(admitted).toBe(2)
		expect(feedback).toMatchObject({ bestProgress: 0, stagnantSteps: 2 })
	})

	it('exposes the delayed third-step payoff tradeoff between allowances of two and four', () => {
		function run(maxStagnantSteps?: number) {
			const select = createResidentSelector({ ...policy, maxStagnantSteps })
			let feedback: ResidentFeedback | undefined
			let admitted = 0
			for (const progress of [0, 0, 0.75]) {
				const choice = select(agenda(pursuit(1, { stepsAdmitted: admitted }, feedback)), 0)
				if (choice.pursuitId === null) break
				admitted++
				feedback = observeResidentStep(
					feedback,
					observation(`receipt-${admitted}`, progress),
					admitted,
				)
			}
			return { admitted, feedback }
		}

		expect(run()).toMatchObject({
			admitted: 2,
			feedback: { bestProgress: 0, stagnantSteps: 2 },
		})
		expect(run(4)).toMatchObject({
			admitted: 3,
			feedback: { bestProgress: 0.75, stagnantSteps: 0 },
		})
	})

	it('abstains when any retained observation has unknown cost, including after a known cost', () => {
		const unknown = observeResidentStep(undefined, observation('unknown', 0.25, null), 1)
		const feedback = observeResidentStep(unknown, observation('known', 0.5, 0), 2)
		const selection = createResidentSelector({ ...policy, initialExpectedCost: 0 })(
			agenda(pursuit(1, { stepsAdmitted: 2 }, feedback)),
			0,
		)

		expect(selection).toMatchObject({ pursuitId: null, reason: 'no-useful-work' })
		expect(selection.candidates).toEqual([
			{
				pursuitId: pursuit(1).id,
				reason: 'unknown-cost',
				expectedGain: null,
				expectedCost: null,
				score: null,
			},
		])
	})

	it('does not reuse bootstrap estimates when a previously admitted step has no feedback', () => {
		const selection = createResidentSelector(policy)(agenda(pursuit(1, { stepsAdmitted: 1 })), 0)

		expect(selection).toMatchObject({ pursuitId: null, reason: 'no-useful-work' })
		expect(selection.candidates[0]).toMatchObject({
			reason: 'missing-observation',
			expectedGain: null,
			expectedCost: null,
			score: null,
		})
	})

	it('keeps an unobserved admission visible after a later observed step', () => {
		const first = observeResidentStep(undefined, observation('first', 0.25), 1)
		const afterGap = observeResidentStep(first, observation('third', 0.75), 3)
		const selection = createResidentSelector(policy)(
			agenda(pursuit(1, { stepsAdmitted: 3 }, afterGap)),
			0,
		)

		expect(first.hasUnobservedSteps).toBe(false)
		expect(afterGap.hasUnobservedSteps).toBe(true)
		expect(afterGap.observations.map(({ step }) => step)).toEqual([1, 3])
		expect(selection).toMatchObject({ pursuitId: null, reason: 'no-useful-work' })
		expect(selection.candidates[0]).toMatchObject({
			reason: 'missing-observation',
			expectedGain: null,
			expectedCost: null,
			score: null,
		})
	})

	it('preserves an observation gap through history eviction and serialization', () => {
		let feedback = observeResidentStep(undefined, observation('first', 1 / 16, 0.1), 1)
		feedback = observeResidentStep(feedback, observation('third', 3 / 16, 0.1), 3)
		for (let step = 4; step <= 11; step++) {
			feedback = observeResidentStep(feedback, observation(`receipt-${step}`, step / 16, 0.1), step)
		}
		const reopened = residentFeedbackSchema.parse(JSON.parse(JSON.stringify(feedback)))
		const selection = createResidentSelector(policy)(
			agenda(pursuit(1, { stepsAdmitted: 11 }, reopened)),
			0,
		)

		expect(reopened.observations.map(({ step }) => step)).toEqual([4, 5, 6, 7, 8, 9, 10, 11])
		expect(reopened).toMatchObject({ hasUnobservedSteps: true, stagnantSteps: 0 })
		expect(selection).toMatchObject({ pursuitId: null, reason: 'no-useful-work' })
		expect(selection.candidates[0]?.reason).toBe('missing-observation')
	})

	it('selects useful measured progress over expensive low-yield work', () => {
		const expensive = pursuit(
			1,
			{ stepsAdmitted: 1 },
			observeResidentStep(undefined, observation('expensive', 0.1, 2), 1),
		)
		const productive = pursuit(
			2,
			{ stepsAdmitted: 1 },
			observeResidentStep(undefined, observation('productive', 0.5, 1), 1),
		)
		const selection = createResidentSelector(policy)(agenda(expensive, productive), 0)

		expect(selection).toMatchObject({ pursuitId: productive.id, reason: 'selected' })
		expect(selection.candidates).toEqual([
			{
				pursuitId: expensive.id,
				reason: 'nonpositive-value',
				expectedGain: 0.175,
				expectedCost: 2,
				score: -0.25,
			},
			{
				pursuitId: productive.id,
				reason: 'eligible',
				expectedGain: 0.375,
				expectedCost: 1,
				score: 2.75,
			},
		])
	})

	it('abstains from a paused agenda even when a pursuit is due', () => {
		const selection = createResidentSelector(policy)({ ...agenda(pursuit(1)), paused: true }, 0)
		expect(selection).toEqual({
			agendaRevision: 23,
			pursuitId: null,
			reason: 'paused',
			candidates: [],
		})
	})

	it('abstains from every pursuit while one admitted claim is unresolved', () => {
		const running = pursuit(2, {
			phase: 'running',
			stepsAdmitted: 1,
			wakeAt: null,
			claimId: '00000000-0000-4000-8000-000000000003',
		})
		const selection = createResidentSelector(policy)(agenda(pursuit(1), running), 0)
		expect(selection).toMatchObject({ pursuitId: null, reason: 'unresolved', candidates: [] })
	})

	it.each<Partial<ResidentState>>([
		{ wakeAt: null },
		{ wakeAt: 101 },
		{ phase: 'complete', wakeAt: null },
		{ phase: 'blocked', wakeAt: null },
	])('does not propose work for a pursuit that is not due: %j', (state) => {
		const selection = createResidentSelector(policy)(agenda(pursuit(1, state)), 100)
		expect(selection).toMatchObject({ pursuitId: null, reason: 'no-useful-work' })
		expect(selection.candidates[0]?.reason).toBe('not-due')
	})

	it('abstains from an empty agenda', () => {
		expect(createResidentSelector(policy)(agenda(), 0)).toMatchObject({
			pursuitId: null,
			reason: 'no-useful-work',
			candidates: [],
		})
	})

	it.each([2.5, 3])(
		'abstains when expected cost %s makes value zero or negative',
		(initialExpectedCost) => {
			const selection = createResidentSelector({ ...policy, initialExpectedCost })(
				agenda(pursuit(1)),
				0,
			)
			expect(selection).toMatchObject({ pursuitId: null, reason: 'no-useful-work' })
			expect(selection.candidates[0]).toMatchObject({
				reason: 'nonpositive-value',
				score: 2.5 - initialExpectedCost,
			})
		},
	)

	it('returns reproducible immutable explanations without changing the agenda or policy', () => {
		const config = { ...policy }
		const select = createResidentSelector(config)
		const snapshot = agenda(pursuit(2), pursuit(1))
		const before = JSON.stringify(snapshot)
		const selection = select(snapshot, 0)
		config.progressValue = 0.01

		expect(selection.pursuitId).toBe(pursuit(1).id)
		expect(selection.agendaRevision).toBe(snapshot.revision)
		expect(select(snapshot, 0)).toEqual(selection)
		expect(JSON.stringify(snapshot)).toBe(before)
		expect(Object.isFrozen(selection)).toBe(true)
		expect(Object.isFrozen(selection.candidates)).toBe(true)
		expect(selection.candidates.every((candidate) => Object.isFrozen(candidate))).toBe(true)
	})

	it.each([
		{ progressValue: 0 },
		{ progressValue: -1 },
		{ progressValue: Number.POSITIVE_INFINITY },
		{ progressValue: Number.NaN },
		{ initialExpectedProgress: 0 },
		{ initialExpectedProgress: 1.1 },
		{ initialExpectedProgress: Number.POSITIVE_INFINITY },
		{ initialExpectedProgress: Number.NaN },
		{ initialExpectedCost: -1 },
		{ initialExpectedCost: Number.POSITIVE_INFINITY },
		{ initialExpectedCost: Number.NaN },
		{ maxStagnantSteps: 0 },
		{ maxStagnantSteps: 1.5 },
		{ maxStagnantSteps: 33 },
		{ maxStagnantSteps: Number.POSITIVE_INFINITY },
	])('rejects invalid selection parameters: %j', (invalid) => {
		expect(() => createResidentSelector({ ...policy, ...invalid })).toThrow()
	})

	it('accepts the configured allowance bounds and an explicitly known zero cost', () => {
		for (const maxStagnantSteps of [1, 32]) {
			const selection = createResidentSelector({
				...policy,
				initialExpectedProgress: 1,
				initialExpectedCost: 0,
				maxStagnantSteps,
			})(agenda(pursuit(1)), 0)
			expect(selection.reason).toBe('selected')
			expect(selection.candidates[0]?.expectedCost).toBe(0)
		}
	})

	it.each([-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
		'requires a nonnegative safe integer clock value: %s',
		(now) => {
			expect(() => createResidentSelector(policy)(agenda(pursuit(1)), now)).toThrow()
		},
	)
})
