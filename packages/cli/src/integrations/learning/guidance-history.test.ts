import type { SessionPaths } from '@namzu/sdk'
import { afterEach, describe, expect, it } from 'vitest'
import {
	GOOD_BODY,
	NOW,
	project,
	proposalText,
	removeLearningProjects,
	scripted,
} from '../../__fixtures__/learning-generator.js'
import { runGeneratorCycle } from './generator-run.js'
import { resolveGeneratorSettings } from './generator-settings.js'
import {
	describeUndoRefusal,
	listLearnedGuidance,
	undoLearnedGuidance,
} from './guidance-history.js'
import { openProjectGuidance, readProjectGuidance } from './project-guidance.js'

afterEach(removeLearningProjects)

type Fixture = Awaited<ReturnType<typeof project>>
const SECOND_BODY =
	'When a tool call fails, read the error and change one thing before the next attempt (BETA), because identical retries fail the same way.'

async function learn(p: Fixture, options: Parameters<typeof scripted>[0], hoursLater = 0) {
	const outcome = await runGeneratorCycle({
		target: p.target,
		model: scripted(options).model,
		route: 'test/route',
		settings: resolveGeneratorSettings(undefined),
		mode: 'manual',
		signal: new AbortController().signal,
		now: () => NOW + hoursLater * 3_600_000,
	})
	if (outcome.status !== 'ran') throw new Error('expected a cycle')
	return outcome.cycle
}
const second = (p: Fixture) =>
	learn(p, { markers: ['BETA'], proposal: proposalText(SECOND_BODY) }, 30)
const handle = async (p: Fixture) => ({
	store: p.target,
	agenda: await openProjectGuidance(p.paths as SessionPaths, p.tenantId),
})

describe('what Namzu learned, and undoing it', () => {
	it('lists an activation as the active revision', async () => {
		const p = await project()
		const cycle = await learn(p, {})
		const { store, agenda } = await handle(p)
		const { active, revisions } = await listLearnedGuidance(store, agenda)
		expect(cycle.status).toBe('activated')
		expect(active).toBe(cycle.candidateRevision)
		expect(revisions).toHaveLength(1)
		expect(revisions[0]).toMatchObject({
			cycleId: cycle.cycleId,
			active: true,
			replaced: 'none',
			body: GOOD_BODY,
		})
	})

	it('restores the guidance an activation replaced, by exact revision', async () => {
		const p = await project()
		await learn(p, {})
		const newest = await second(p)
		expect(newest.status).toBe('activated')
		expect(await readProjectGuidance(p.paths, p.tenantId)).toContain('BETA')
		const { store, agenda } = await handle(p)
		const undone = await undoLearnedGuidance(store, agenda)
		expect(undone).toMatchObject({ status: 'undone', revision: { cycleId: newest.cycleId } })
		const guidance = await readProjectGuidance(p.paths, p.tenantId)
		expect(guidance).toContain(GOOD_BODY)
		expect(guidance).not.toContain('BETA')
		// The undo is a revision of its own: the history still lists both activations.
		const { revisions } = await listLearnedGuidance(store, agenda)
		expect(revisions.map((r) => r.active)).toEqual([false, true])
	})

	it('undoes the only activation back to no learned guidance', async () => {
		const p = await project()
		await learn(p, {})
		const { store, agenda } = await handle(p)
		expect(await undoLearnedGuidance(store, agenda)).toMatchObject({
			status: 'undone',
			restored: 'none',
		})
		expect(await readProjectGuidance(p.paths, p.tenantId)).toBeNull()
		expect(await undoLearnedGuidance(store, agenda)).toEqual({
			status: 'refused',
			reason: 'nothing-active',
		})
	})

	it('refuses to undo a revision a later one replaced, and an id it does not know', async () => {
		const p = await project()
		const first = await learn(p, {})
		await second(p)
		const { store, agenda } = await handle(p)
		expect(await undoLearnedGuidance(store, agenda, first.cycleId)).toEqual({
			status: 'refused',
			reason: 'not-active',
		})
		expect(await undoLearnedGuidance(store, agenda, 'nope')).toEqual({
			status: 'refused',
			reason: 'unknown-cycle',
		})
		expect(await readProjectGuidance(p.paths, p.tenantId)).toContain('BETA')
		expect(describeUndoRefusal('not-active')).toMatch(/undo that one first/)
	})
})
