import { join } from 'node:path'
import { type LearningModel, SqliteLearningExperienceStore } from '@namzu/sdk'
import { afterEach, describe, expect, it } from 'vitest'
import {
	GOOD_BODY,
	NOW,
	project,
	proposalText,
	removeLearningProjects,
	scripted,
} from '../../__fixtures__/learning-generator.js'
import { GENERATOR_DOMAIN, describeSkip, runGeneratorCycle } from './generator-run.js'
import { resolveGeneratorSettings } from './generator-settings.js'
import { acquireGeneratorLock, readGeneratorState } from './generator-state.js'
import { readProjectGuidance } from './project-guidance.js'
import {
	SCENARIO_EVALUATOR_REVISION,
	scenarioPlan,
	scenarioProtectedContents,
} from './scenarios.js'
import { SESSION_AGENT_KEY } from './session-feed.js'

afterEach(removeLearningProjects)

const run = (
	p: Awaited<ReturnType<typeof project>>,
	model: LearningModel,
	extra: Partial<Parameters<typeof runGeneratorCycle>[0]> = {},
) =>
	runGeneratorCycle({
		target: p.target,
		model,
		route: 'test/route',
		settings: resolveGeneratorSettings(undefined),
		mode: 'automatic',
		signal: new AbortController().signal,
		now: () => NOW,
		...extra,
	})

describe('built-in generator cycle', () => {
	it('learns from kept failures, checks the revision, and activates it for conversations', async () => {
		const p = await project()
		const { model, calls } = scripted()
		const outcome = await run(p, model)
		expect(outcome.status).toBe('ran')
		if (outcome.status !== 'ran') return
		expect(outcome.cycle.status).toBe('activated')
		expect(outcome.cycle.auditComplete).toBe(true)
		// One proposal, then 5 tasks x 2 trials x (2 answers + 1 grade) in each of two rounds.
		expect(calls).toEqual({ proposals: 1, answers: 40, grades: 20 })
		expect(outcome.tokens).toBe(610)
		const guidance = await readProjectGuidance(p.paths, p.tenantId)
		expect(guidance).toContain(GOOD_BODY)
		// The experience library keeps the edit, adopted, with the whole artefact.
		const library = new SqliteLearningExperienceStore({
			databasePath: join(p.dir, 'experience.sqlite'),
			scope: { tenantId: p.tenantId, projectId: p.projectId, agentKey: SESSION_AGENT_KEY },
			readOnly: true,
		})
		const [entry] = await library.retrieve({
			domain: GENERATOR_DOMAIN,
			evaluatorRevision: SCENARIO_EVALUATOR_REVISION,
			leakGuard: {},
			beforeOrdinal: await library.nextOrdinal(),
		})
		expect(entry).toMatchObject({ decision: 'adopted', candidate: { body: GOOD_BODY } })
		expect(entry?.edits).toEqual([
			{ surface: 'instruction-skill', change: 'Added a recovery rule.', verdict: 'helped' },
		])
		// What it spent is remembered.
		expect(readGeneratorState(p.dir)).toMatchObject({ dayTokens: 610, lastCycleAt: NOW })
	})

	it('rejects a revision that changes nothing the evaluation can see, and keeps the old guidance', async () => {
		const p = await project()
		const { model } = scripted({ helps: false })
		const outcome = await run(p, model)
		if (outcome.status !== 'ran') throw new Error('expected a cycle')
		expect(outcome.cycle.status).toBe('rejected')
		expect(await readProjectGuidance(p.paths, p.tenantId)).toBeNull()
		const library = new SqliteLearningExperienceStore({
			databasePath: join(p.dir, 'experience.sqlite'),
			scope: { tenantId: p.tenantId, projectId: p.projectId, agentKey: SESSION_AGENT_KEY },
			readOnly: true,
		})
		const [entry] = await library.retrieve({
			domain: GENERATOR_DOMAIN,
			evaluatorRevision: SCENARIO_EVALUATOR_REVISION,
			leakGuard: {},
			beforeOrdinal: await library.nextOrdinal(),
		})
		expect(entry).toMatchObject({ decision: 'rejected' })
		expect(entry?.edits[0]?.verdict).toBe('no observed effect')
	})

	it('refuses an off-surface proposal after one correction and never evaluates it', async () => {
		const p = await project()
		const { model, calls } = scripted({ proposal: proposalText(GOOD_BODY, 'permission-review') })
		const outcome = await run(p, model)
		if (outcome.status !== 'ran') throw new Error('expected a cycle')
		expect(outcome.cycle.status).toBe('failed')
		expect(outcome.cycle.reason).toMatch(/outside the editable surface/)
		expect(calls).toEqual({ proposals: 2, answers: 0, grades: 0 })
		expect(await readProjectGuidance(p.paths, p.tenantId)).toBeNull()
	})

	it('hands later cycles what earlier ones learned, within this domain only', async () => {
		const p = await project()
		await run(p, scripted({ helps: false }).model)
		const second = scripted({ helps: false })
		await run(p, second.model, { now: () => NOW + 7 * 3_600_000, mode: 'manual' })
		const proposal = second.requests.find((r) =>
			r.system.includes('You revise the working guidance'),
		)
		expect(proposal?.prompt).toContain('A revision was rejected')
		expect(proposal?.prompt).toContain('edit (no observed effect)')
	})

	it('never shows the generator a scenario or a rubric', async () => {
		const p = await project()
		const { model, requests } = scripted()
		await run(p, model)
		const sent = requests
			.filter((r) => r.system.includes('You revise the working guidance'))
			.map((r) => `${r.system}\n${r.prompt}`)
			.join('\n')
		for (const text of scenarioProtectedContents(scenarioPlan())) expect(sent).not.toContain(text)
	})

	it('stays within the cycle allowance and says so when the evaluation cannot finish', async () => {
		const p = await project()
		const { model } = scripted()
		const outcome = await run(p, model, {
			settings: resolveGeneratorSettings({ cycleTokens: 200, dailyTokens: 300_000 }),
		})
		if (outcome.status !== 'ran') throw new Error('expected a cycle')
		expect(outcome.cycle.status).not.toBe('activated')
		expect(outcome.tokens).toBeLessThanOrEqual(250)
		expect(await readProjectGuidance(p.paths, p.tenantId)).toBeNull()
	})
})

describe('a cycle that never reached the model', () => {
	it('leaves its observations unread, keeps the pause and spends nothing', async () => {
		const p = await project()
		const down: LearningModel = async () => {
			throw new Error('connection refused')
		}
		const outcome = await run(p, down)
		if (outcome.status !== 'ran') throw new Error('expected a cycle')
		expect(outcome.cycle.status).toBe('failed')
		expect(readGeneratorState(p.dir)).toMatchObject({
			lastOrdinal: 0,
			lastCycleAt: NOW,
			dayTokens: 0,
		})
		// Inside the pause nothing starts; after it, the same observations are tried again.
		expect(await run(p, scripted().model, { now: () => NOW + 60_000 })).toEqual({
			status: 'skipped',
			reason: 'cooldown',
		})
		const later = await run(p, scripted().model, { now: () => NOW + 7 * 3_600_000 })
		expect(later.status).toBe('ran')
	})
})

describe('when a cycle starts', () => {
	it('does nothing while the setting is off, and a manual run is still allowed', async () => {
		const p = await project()
		const off = resolveGeneratorSettings(false)
		const { model, calls } = scripted()
		expect(await run(p, model, { settings: off })).toEqual({
			status: 'skipped',
			reason: 'disabled',
		})
		expect(calls.proposals).toBe(0)
		const manual = await run(p, model, { settings: off, mode: 'manual' })
		expect(manual.status).toBe('ran')
	})

	it('waits for enough new observations', async () => {
		const p = await project(4)
		expect(await run(p, scripted().model)).toEqual({
			status: 'skipped',
			reason: 'few-observations',
		})
		expect(describeSkip('few-observations')).toMatch(/Fewer than 5/)
	})

	it('has nothing to do in a folder with no kept observations', async () => {
		const p = await project(0)
		expect(await run(p, scripted().model)).toEqual({ status: 'skipped', reason: 'no-observations' })
	})

	it('pauses after a cycle and uses the observations only once', async () => {
		const p = await project()
		const { model } = scripted()
		await run(p, model)
		// More failures arrive, but inside the pause nothing starts.
		expect(await run(p, model, { now: () => NOW + 60_000 })).toMatchObject({ status: 'skipped' })
		// After the pause the already-read observations do not count again.
		expect(await run(p, model, { now: () => NOW + 7 * 3_600_000 })).toEqual({
			status: 'skipped',
			reason: 'few-observations',
		})
	})

	it('stops at the daily allowance, and a new day starts a new one', async () => {
		const p = await project()
		const settings = resolveGeneratorSettings({ dailyTokens: 25_000 })
		const first = scripted()
		await run(p, first.model, { settings })
		// 610 tokens were spent; allowance left is 24,390, above the floor for a cycle but
		// the cap itself is reached once the state says it is.
		const exhausted = await run(p, first.model, {
			settings: resolveGeneratorSettings({ dailyTokens: 600 }),
			mode: 'manual',
			now: () => NOW + 1000,
		})
		expect(exhausted).toEqual({ status: 'skipped', reason: 'daily-cap' })
		const later = await run(p, scripted().model, {
			settings: resolveGeneratorSettings({ dailyTokens: 600 }),
			mode: 'manual',
			now: () => NOW + 36 * 3_600_000,
		})
		expect(later.status).toBe('ran')
	})

	it('runs one cycle at a time', async () => {
		const p = await project()
		const release = acquireGeneratorLock(p.dir, NOW)
		expect(release).not.toBeNull()
		expect(await run(p, scripted().model)).toEqual({ status: 'skipped', reason: 'busy' })
		release?.()
		expect((await run(p, scripted().model)).status).toBe('ran')
	})
})
