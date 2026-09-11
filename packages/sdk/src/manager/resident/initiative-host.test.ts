import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { SchemaVersionError, defineSchema, migrate } from '../../store/schema.js'
import { generateTenantId } from '../../utils/id.js'
import { DiskResidentAgenda } from './agenda.js'
import { ResidentHost, type ResidentPursuitStep } from './host.js'
import { createResidentSelector } from './initiative.js'
import { ResidentConflictError, type ResidentExecutionStore } from './store.js'

const roots: string[] = []
const signal = new AbortController().signal
const select = createResidentSelector({
	progressValue: 10,
	initialExpectedCost: 1,
	initialExpectedProgress: 0.25,
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
	const root = await mkdtemp(join(tmpdir(), 'namzu-initiative-'))
	roots.push(root)
	const scope = { tenantId: generateTenantId(), agentKey: 'researcher' }
	const agenda = new DiskResidentAgenda(root, scope)
	const parent = await agenda.add(
		await agenda.create('Careful researcher'),
		'Validate one criterion',
	)
	return { root, scope, agenda, parent, reopen: () => new DiskResidentAgenda(root, scope) }
}

it('atomically persists host observations and reproduces selection explanations after reopen', async () => {
	const f = await fixture()
	const host = new ResidentHost(
		f.agenda,
		async () => ({
			kind: 'wait',
			wakeAt: Date.now() + 60_000,
			summary: 'Model claims perfect progress',
		}),
		{
			select,
			observe: async () => ({
				evidenceKey: 'artifact:v1',
				source: 'fixture validator',
				progress: 0.3,
				costUnits: 1,
			}),
		},
	)
	expect(await host.run({ signal, maxSteps: 1 })).toMatchObject({
		status: 'limit',
		stepsSettled: 1,
	})
	const state = await snapshot(f.agenda)
	expect(state.pursuits[0]).toMatchObject({
		state: { phase: 'waiting', claimId: null },
		feedback: { bestProgress: 0.3, observations: [{ step: 1, gain: 0.3, costUnits: 1 }] },
	})
	expect(select(state, Date.now() + 120_000)).toEqual(
		select(await snapshot(f.reopen()), Date.now() + 120_000),
	)
	expect(Object.isFrozen(state.pursuits[0]?.feedback?.observations[0])).toBe(true)
	// Revision 2 writes are refused by a schema-1 writer instead of dropping feedback.
	const path = join(
		f.root,
		f.scope.tenantId,
		f.scope.agentKey,
		'agenda',
		'revisions',
		`${state.revision}.json`,
	)
	const raw = JSON.parse(await readFile(path, 'utf8'))
	expect(raw.schemaVersion).toBe(2)
	expect(() =>
		migrate(defineSchema({ kind: 'resident-agenda', current: 1, migrations: {} }), raw),
	).toThrow(SchemaVersionError)
})

it('does not execute a selection after any agenda revision changes', async () => {
	const f = await fixture()
	const executionAt = f.agenda.executionAt.bind(f.agenda)
	vi.spyOn(f.agenda, 'executionAt').mockImplementationOnce((id, state) => {
		const execution = executionAt(id, state)
		return {
			...execution,
			read: async () => {
				await f.agenda.add(await snapshot(f.agenda), 'A newly arrived competing pursuit')
				return execution.read()
			},
		}
	})
	const callback = vi.fn()
	expect(
		await new ResidentHost(f.agenda, callback, { select }).run({ signal, maxSteps: 1 }),
	).toMatchObject({ status: 'contended', stepsSettled: 0 })
	expect(callback).not.toHaveBeenCalled()
	expect((await snapshot(f.agenda)).pursuits.every((p) => p.state.phase === 'waiting')).toBe(true)
})

it.each(['select', 'observe', 'both'])(
	'preserves prototype methods for alternative execution stores: %s',
	async (mode) => {
		const f = await fixture()
		class Execution implements ResidentExecutionStore {
			constructor(private readonly actual: ResidentExecutionStore) {}
			read() {
				return this.actual.read()
			}
			claim(...args: Parameters<ResidentExecutionStore['claim']>) {
				return this.actual.claim(...args)
			}
			settle(...args: Parameters<ResidentExecutionStore['settle']>) {
				return this.actual.settle(...args)
			}
		}
		const execution = f.agenda.execution.bind(f.agenda)
		vi.spyOn(f.agenda, 'execution').mockImplementation((id) => new Execution(execution(id)))
		const host = new ResidentHost(
			f.agenda,
			async () => ({ kind: 'complete', summary: 'Verified result' }),
			{
				...(mode !== 'observe' ? { select } : {}),
				observe:
					mode === 'select'
						? undefined
						: async () => ({
								evidenceKey: 'artifact:v1',
								source: 'validator',
								progress: 1,
								costUnits: 1,
							}),
			},
		)
		expect(await host.run({ signal, maxSteps: 1 })).toMatchObject({
			status: 'limit',
			stepsSettled: 1,
		})
		expect((await snapshot(f.agenda)).pursuits[0]?.feedback?.bestProgress).toBe(
			mode === 'select' ? undefined : 1,
		)
	},
)

it('keeps failed or aborted observation unresolved rather than partially settling work', async () => {
	for (const abort of [false, true]) {
		const f = await fixture()
		const controller = new AbortController()
		const host = new ResidentHost(
			f.agenda,
			async () => ({ kind: 'complete', summary: 'Model says done' }),
			{
				observe: async () => {
					if (!abort) throw new Error('Verifier failed')
					controller.abort()
					return { evidenceKey: 'artifact:v1', source: 'validator', progress: 1, costUnits: 1 }
				},
			},
		)
		const running = host.run({ signal: controller.signal, maxSteps: 1 })
		if (abort) expect(await running).toMatchObject({ status: 'cancelled', stepsSettled: 0 })
		else await expect(running).rejects.toThrow('Verifier failed')
		expect((await snapshot(f.reopen())).pursuits[0]).toMatchObject({ state: { phase: 'running' } })
		expect((await snapshot(f.reopen())).pursuits[0]?.feedback).toBeUndefined()
	}
})

it('never calls selector or verifier while paused, unresolved or not due', async () => {
	for (const phase of ['paused', 'running', 'waiting'] as const) {
		const f = await fixture()
		const execution = f.agenda.execution(f.parent.id)
		if (phase === 'paused') await f.agenda.setPaused(await snapshot(f.agenda), true)
		else {
			const claim = await execution.claim(f.parent.state, Date.now())
			if (phase === 'waiting')
				await execution.settle(claim, { kind: 'wait', wakeAt: null, summary: 'Rest' }, Date.now())
		}
		const selector = vi.fn(select)
		const observe = vi.fn()
		const step = vi.fn()
		await new ResidentHost(f.agenda, step, { select: selector, observe }).run({
			signal,
			maxSteps: 2,
		})
		expect(selector).not.toHaveBeenCalled()
		expect(observe).not.toHaveBeenCalled()
		expect(step).not.toHaveBeenCalled()
	}
})

it('atomically admits one duplicate proposal and retains its ancestry through settlement', async () => {
	const f = await fixture()
	const state = await snapshot(f.agenda)
	const proposal = {
		id: randomUUID(),
		parentId: f.parent.id,
		parentRevision: f.parent.state.revision,
		domain: 'fixture-review',
		objective: 'Investigate a missing field',
		reason: 'A specific gap was observed',
		evidenceKey: 'fixture:gap',
	}
	const limits = { domains: ['fixture-review'], maxChildrenPerParent: 1, maxDepth: 1 }
	const outcomes = await Promise.allSettled([
		f.agenda.admitProposal(state, proposal, limits),
		f.reopen().admitProposal(state, proposal, limits),
	])
	expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1)
	expect(outcomes.filter((outcome) => outcome.status === 'rejected')[0]).toMatchObject({
		reason: expect.any(ResidentConflictError),
	})
	const saved = await snapshot(f.reopen())
	expect(saved.pursuits).toHaveLength(2)
	const child = saved.pursuits[1]
	if (!child) throw new Error('Missing child')
	expect(child.origin).toMatchObject({ proposalId: proposal.id, parentId: f.parent.id, depth: 1 })
	expect(Object.isFrozen(child.origin)).toBe(true)
	await expect(f.agenda.admitProposal(saved, proposal, limits)).rejects.toThrow(
		'already been admitted',
	)
	const execution = f.agenda.execution(child.id)
	await execution.settle(
		await execution.claim(child.state, Date.now()),
		{ kind: 'complete', summary: 'Done' },
		Date.now(),
	)
	expect((await snapshot(f.reopen())).pursuits[1]?.origin).toEqual(child.origin)
})

it('reads a schema-1 agenda without inventing feedback or proposal ancestry', async () => {
	const f = await fixture()
	const state = await snapshot(f.agenda)
	const path = join(
		f.root,
		f.scope.tenantId,
		f.scope.agentKey,
		'agenda',
		'revisions',
		`${state.revision}.json`,
	)
	await writeFile(path, JSON.stringify({ ...state, schemaVersion: 1 }))
	expect(await snapshot(f.reopen())).toEqual(state)
	await f.reopen().setPaused(state, true)
	const raw = JSON.parse(
		await readFile(
			join(
				f.root,
				f.scope.tenantId,
				f.scope.agentKey,
				'agenda',
				'revisions',
				`${state.revision + 1}.json`,
			),
			'utf8',
		),
	)
	expect(raw.schemaVersion).toBe(2)
})

it('refuses corrupt persisted ancestry instead of treating it as a valid proposal', async () => {
	const f = await fixture()
	const state = await snapshot(f.agenda)
	const path = join(
		f.root,
		f.scope.tenantId,
		f.scope.agentKey,
		'agenda',
		'revisions',
		`${state.revision}.json`,
	)
	await writeFile(
		path,
		JSON.stringify({
			...state,
			schemaVersion: 2,
			pursuits: [
				{
					...state.pursuits[0],
					origin: {
						proposalId: randomUUID(),
						parentId: randomUUID(),
						parentRevision: 1,
						domain: 'fixture-review',
						reason: 'Missing parent',
						evidenceKey: 'fixture:gap',
						depth: 1,
					},
				},
			],
		}),
	)
	await expect(f.reopen().read()).rejects.toThrow('pursuit ancestry')
})

it('rejects invalid selector targets without widening due-time admission', async () => {
	const f = await fixture()
	const step = vi.fn()
	const host = new ResidentHost(f.agenda, step, {
		select: (state) => ({
			agendaRevision: state.revision,
			pursuitId: randomUUID(),
			reason: 'selected',
			candidates: [],
		}),
	})
	await expect(host.run({ signal, maxSteps: 1 })).rejects.toThrow('ineligible pursuit')
	expect(step).not.toHaveBeenCalled()
	expect((await snapshot(f.agenda)).pursuits[0]?.state.phase).toBe('waiting')
})

it('retains future wakes and racing notifications when the policy abstains on due work', async () => {
	for (const notifyDuringRead of [false, true]) {
		const f = await fixture()
		// Legacy, unobserved due work is deliberately deferred by measured selection.
		const execution = f.agenda.execution(f.parent.id)
		const claim = await execution.claim(f.parent.state, Date.now())
		const waiting = await execution.settle(
			claim,
			{ kind: 'wait', wakeAt: null, summary: 'No measured outcome' },
			Date.now(),
		)
		await f.agenda.wake(f.parent.id, waiting, 'Check again', Date.now())
		if (!notifyDuringRead) {
			const later = await f.agenda.add(await snapshot(f.agenda), 'Later useful work')
			const futureAt = Date.now() + 60_000
			// Host may set a waiting pursuit's next evidence time explicitly.
			await f.agenda.wake(later.id, later.state, 'Future evidence', futureAt)
			const step = vi.fn()
			expect(
				await new ResidentHost(f.agenda, step, { select }).run({
					signal,
					maxSteps: 1,
					maxIdleMs: 0,
				}),
			).toMatchObject({ status: 'idle', nextWakeAt: futureAt, selection: { pursuitId: null } })
			expect(step).not.toHaveBeenCalled()
		} else {
			const step = vi.fn<ResidentPursuitStep>(async () => ({
				kind: 'complete',
				summary: 'New work completed',
			}))
			const host = new ResidentHost(f.agenda, step, { select })
			const original = f.agenda.read.bind(f.agenda)
			vi.spyOn(f.agenda, 'read').mockImplementationOnce(async () => {
				const state = await original()
				await f.reopen().add(await snapshot(f.reopen()), 'New evidence-based work')
				host.notify()
				return state
			})
			expect(await host.run({ signal, maxSteps: 1 })).toMatchObject({
				status: 'limit',
				stepsSettled: 1,
			})
			expect(step).toHaveBeenCalledTimes(1)
			expect(step.mock.calls[0]?.[0]?.state.objective).toBe('New evidence-based work')
		}
	}
})
