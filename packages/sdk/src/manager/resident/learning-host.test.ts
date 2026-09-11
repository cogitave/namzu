import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { generateTenantId } from '../../utils/id.js'
import { DiskResidentAgenda } from './agenda.js'
import { ResidentHost } from './host.js'
import { projectResidentLearning } from './learning.js'
import { ResidentConflictError } from './store.js'

const roots: string[] = []
const signal = new AbortController().signal
const evidence = (key: string) => ({
	key,
	source: 'host-confirmed preference',
	reason: 'Operator correction in fixture',
})
afterEach(async () => {
	vi.restoreAllMocks()
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
async function snapshot(agenda: DiskResidentAgenda) {
	const state = await agenda.read()
	if (!state) throw new Error('Missing fixture')
	return state
}
async function fixture() {
	const root = await mkdtemp(join(tmpdir(), 'namzu-learning-host-'))
	roots.push(root)
	const scope = { tenantId: generateTenantId(), agentKey: 'persistent-researcher' }
	const agenda = new DiskResidentAgenda(root, scope)
	const pursuit = await agenda.add(
		await agenda.create('Original host mandate'),
		'Retain a preference across work',
	)
	return { agenda, pursuit, reopen: () => new DiskResidentAgenda(root, scope) }
}

it('projects a corrected persistent profile only at the next authorized admission', async () => {
	const f = await fixture()
	const original = await f.agenda.updateProfile(await snapshot(f.agenda), {
		identity: 'A concise researcher',
		preferences: [{ key: 'language', value: 'English', supersedes: null }],
		evidence: evidence('first'),
	})
	const projected: string[] = []
	const step = vi.fn(async (pursuit, _signal, context) => {
		expect(pursuit.state.identity).toBe('Original host mandate')
		expect(Object.isFrozen(context.learning)).toBe(true)
		projected.push(
			projectResidentLearning(context.learning, { maxChars: 2_000, skillNames: [] }).text,
		)
		return { kind: 'wait' as const, summary: 'Saved the previous step', wakeAt: null }
	})
	await new ResidentHost(f.agenda, step, { learning: true }).run({ signal, maxSteps: 1 })
	const corrected = await f.reopen().updateProfile(await snapshot(f.agenda), {
		preferences: [{ key: 'language', value: 'Turkish', supersedes: 'first' }],
		evidence: evidence('correction'),
	})
	expect(corrected.learning?.revision).toBe(2)
	expect((await f.reopen().readRevision(original.revision))?.learning?.preferences[0]?.value).toBe(
		'English',
	)
	const host = new ResidentHost(f.reopen(), step, { learning: true })
	await host.wake(f.pursuit.id, 'Use the updated preference')
	await host.run({ signal, maxSteps: 1 })
	expect(projected[0]).toContain('English')
	expect(projected[1]).toContain('Turkish')
	expect(projected[1]).not.toContain('English')
	expect(step.mock.calls[1]?.[0].state.summary).toBe('Saved the previous step')
})

it('binds initially absent learning to its snapshot so a racing first activation cannot be missed', async () => {
	const f = await fixture()
	const executionAt = f.agenda.executionAt.bind(f.agenda)
	vi.spyOn(f.agenda, 'executionAt').mockImplementationOnce((id, state) => {
		const execution = executionAt(id, state)
		let changed = false
		return {
			...execution,
			read: async () => {
				if (!changed) {
					changed = true
					await f.agenda.updateProfile(await snapshot(f.agenda), {
						identity: 'New overlay',
						evidence: evidence('race'),
					})
				}
				return execution.read()
			},
		}
	})
	const step = vi.fn()
	expect(
		await new ResidentHost(f.agenda, step, { learning: true }).run({ signal, maxSteps: 1 }),
	).toMatchObject({ status: 'contended' })
	expect(step).not.toHaveBeenCalled()
})

it('rejects profile writes while a pursuit runs and refuses stale revisions after it settles', async () => {
	const f = await fixture()
	const before = await snapshot(f.agenda)
	const execution = f.agenda.execution(f.pursuit.id)
	const claim = await execution.claim(f.pursuit.state, Date.now())
	await expect(
		f.agenda.updateProfile(await snapshot(f.agenda), {
			identity: 'Changed',
			evidence: evidence('busy'),
		}),
	).rejects.toThrow('while a pursuit is running')
	await execution.settle(claim, { kind: 'complete', summary: 'Finished' }, Date.now())
	await expect(
		f.agenda.updateProfile(before, { identity: 'Stale change', evidence: evidence('stale') }),
	).rejects.toThrow(ResidentConflictError)
	expect((await snapshot(f.agenda)).learning).toBeUndefined()
})

it('does not inject learning into existing hosts unless the option is enabled', async () => {
	const f = await fixture()
	await f.agenda.updateProfile(await snapshot(f.agenda), {
		identity: 'Opt-in overlay',
		evidence: evidence('optional'),
	})
	const step = vi.fn(async (_pursuit, _signal, context) => {
		expect(context.learning).toBeUndefined()
		return { kind: 'complete' as const, summary: 'Original callback remains compatible' }
	})
	await new ResidentHost(f.agenda, step).run({ signal, maxSteps: 1 })
	expect(step).toHaveBeenCalledOnce()
})

it('requires snapshot-bound admission support when enabling learned context', async () => {
	const f = await fixture()
	Object.defineProperty(f.agenda, 'executionAt', { value: undefined })
	expect(() => new ResidentHost(f.agenda, vi.fn(), { learning: true })).toThrow(
		'atomic executionAt',
	)
})

it('copies a profile change before awaiting storage and persists only one concurrent revision', async () => {
	const f = await fixture()
	const state = await snapshot(f.agenda)
	const input = { identity: 'Original update', evidence: evidence('copy') }
	const first = f.agenda.updateProfile(state, input)
	input.identity = 'Mutated after method entry'
	const second = f
		.reopen()
		.updateProfile(state, { identity: 'Competing update', evidence: evidence('other') })
	const outcomes = await Promise.allSettled([first, second])
	expect(outcomes.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
	const saved = await snapshot(f.agenda)
	expect(saved.learning?.identity?.text).not.toBe('Mutated after method entry')
	expect(saved.learning?.revision).toBe(1)
})
