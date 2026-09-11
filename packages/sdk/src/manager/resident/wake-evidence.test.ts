import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { removeTempDirs } from '../../__fixtures__/temp-dir.js'
import { generateTenantId } from '../../utils/id.js'
import { DiskResidentAgenda } from './agenda.js'
import { stepResident } from './loop.js'
import { DiskResidentStore, ResidentConflictError, type ResidentStore } from './store.js'

async function readState(store: Pick<ResidentStore, 'read'>) {
	const state = await store.read()
	if (!state) throw new Error('Missing fixture state.')
	return state
}

const roots: string[] = []
const signal = new AbortController().signal
afterEach(async () => {
	await removeTempDirs(roots)
	roots.length = 0
})

describe.each(['standalone', 'agenda'] as const)('%s wake evidence', (kind) => {
	async function fixture() {
		const root = await mkdtemp(join(tmpdir(), 'namzu-wake-evidence-'))
		roots.push(root)
		const scope = { tenantId: generateTenantId(), agentKey: 'reviewer' }
		let reopen: () => Pick<ResidentStore, 'read' | 'claim' | 'settle' | 'wake'>
		if (kind === 'standalone') {
			await new DiskResidentStore(root, scope).create('Review evidence.', 'Check both results.')
			reopen = () => new DiskResidentStore(root, scope)
		} else {
			const agenda = new DiskResidentAgenda(root, scope)
			const pursuit = await agenda.add(
				await agenda.create('Review evidence.'),
				'Check both results.',
			)
			reopen = () => {
				const opened = new DiskResidentAgenda(root, scope)
				return {
					...opened.execution(pursuit.id),
					wake: (...args) => opened.wake(pursuit.id, ...args),
				}
			}
		}
		return reopen
	}

	it('retains every accepted input through reopening and admission; settlement consumes the batch', async () => {
		const reopen = await fixture()
		let store = reopen()
		await stepResident(
			store,
			async () => ({ kind: 'wait', wakeAt: null, summary: 'Need two reviews.' }),
			signal,
		)
		await store.wake(await readState(store), 'Build failed: BUILD-ALPHA.', 20)
		store = reopen()
		await store.wake(await readState(store), 'Security passed: SECURITY-BETA.', 10)
		const pending = await readState(reopen())
		expect(pending.summary).toBe('Need two reviews.')
		expect(pending.reason).toBe('Security passed: SECURITY-BETA.')
		expect(pending.wakeEvidence).toEqual([
			{ reason: 'Build failed: BUILD-ALPHA.', receivedAt: 20 },
			{ reason: 'Security passed: SECURITY-BETA.', receivedAt: 10 },
		])
		expect(Object.isFrozen(pending.wakeEvidence)).toBe(true)
		expect(Object.isFrozen(pending.wakeEvidence?.[0])).toBe(true)
		await stepResident(
			reopen(),
			async (claim) => {
				expect(claim.wakeEvidence).toEqual(pending.wakeEvidence)
				return {
					kind: 'wait',
					wakeAt: null,
					summary: 'Security passed; build failure remains unresolved.',
				}
			},
			signal,
		)
		const settled = await readState(reopen())
		expect(settled.wakeEvidence).toBeUndefined()
		expect(settled.summary).toContain('build failure')
		await store.wake(settled, 'Build repaired.', 30)
		expect((await reopen().read())?.wakeEvidence).toEqual([
			{ reason: 'Build repaired.', receivedAt: 30 },
		])
	})

	it('does not acknowledge inputs on failure or admit another executor to an unresolved claim', async () => {
		const reopen = await fixture()
		const store = reopen()
		let pending = await store.wake(await readState(store), 'First result.', 1)
		pending = await store.wake(pending, 'Second result.', 2)
		await expect(
			stepResident(
				store,
				async () => {
					throw new Error('Interrupted after inspection')
				},
				signal,
			),
		).rejects.toThrow('Interrupted')
		const unresolved = await readState(reopen())
		expect(unresolved.wakeEvidence).toEqual(pending.wakeEvidence)
		const result = await stepResident(
			reopen(),
			async () => {
				throw new Error('Must not repeat')
			},
			signal,
		)
		expect(result).toMatchObject({ status: 'idle', reason: 'unresolved' })
		await expect(store.wake(unresolved, 'Arrived during execution.', 3)).rejects.toThrow('waiting')
		await expect(
			store.settle(unresolved, { kind: 'wait', wakeAt: 2, summary: 'Invalid delay.' }, 3),
		).rejects.toThrow('future')
		expect((await reopen().read())?.wakeEvidence).toEqual(pending.wakeEvidence)
		await store.settle(
			unresolved,
			{ kind: 'complete', summary: 'Host inspected both results after stopping executor.' },
			3,
		)
		expect((await reopen().read())?.wakeEvidence).toBeUndefined()
		await expect(
			store.settle(unresolved, { kind: 'complete', summary: 'Late result.' }, 3),
		).rejects.toBeInstanceOf(ResidentConflictError)
	})

	it('surfaces concurrent stale writes so retry can append without losing an accepted input', async () => {
		const reopen = await fixture()
		const expected = await readState(reopen())
		const inputs = ['Build result.', 'Security result.']
		const outcomes = await Promise.allSettled(
			inputs.map((reason) => reopen().wake(expected, reason, 1)),
		)
		expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1)
		const loser = outcomes.findIndex((outcome) => outcome.status === 'rejected')
		expect(outcomes[loser]).toMatchObject({
			status: 'rejected',
			reason: expect.any(ResidentConflictError),
		})
		const current = await readState(reopen())
		const next = await reopen().wake(current, inputs[loser] ?? 'missing input', 2)
		expect(next.wakeEvidence?.map((entry) => entry.reason).sort()).toEqual([...inputs].sort())
	})

	it.each(['count', 'characters'] as const)(
		'refuses %s overflow without evicting evidence or advancing a revision',
		async (limit) => {
			const reopen = await fixture()
			const store = reopen()
			let pending = await readState(store)
			const count = limit === 'count' ? 16 : 2
			const reason = limit === 'count' ? 'A result.' : 'x'.repeat(8_000)
			for (let i = 0; i < count; i++) pending = await store.wake(pending, reason, i)
			await expect(store.wake(pending, 'Another result.', 20)).rejects.toThrow(/process/i)
			expect(await reopen().read()).toEqual(pending)
			await stepResident(
				store,
				async () => ({ kind: 'wait', wakeAt: null, summary: 'Processed this batch.' }),
				signal,
			)
			const next = await store.wake(await readState(store), 'Next batch.', 30)
			expect(next.wakeEvidence).toHaveLength(1)
		},
	)
})
