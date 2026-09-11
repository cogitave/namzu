import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { DiskResidentAgenda, type ResidentAgendaStore, generateTenantId } from '@namzu/sdk'
import { afterEach, expect, it, vi } from 'vitest'
import { runResidentForeground } from './foreground.js'

const roots: string[] = []
afterEach(async () => {
	vi.restoreAllMocks()
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function deferred() {
	let resolve!: () => void
	const promise = new Promise<void>((done) => {
		resolve = done
	})
	return { promise, resolve }
}

async function fixture() {
	const root = await mkdtemp(join(tmpdir(), 'namzu-foreground-'))
	roots.push(root)
	const scope = { tenantId: generateTenantId(), agentKey: 'foreground-unit' }
	const agenda = new DiskResidentAgenda(root, scope)
	const pursuit = await agenda.add(await agenda.create('Careful resident'), 'Inspect one fixture')
	return { agenda, pursuit, reopen: () => new DiskResidentAgenda(root, scope) }
}

function withRead(
	agenda: DiskResidentAgenda,
	read: ResidentAgendaStore['read'],
): ResidentAgendaStore {
	return {
		read,
		create: (...args) => agenda.create(...args),
		add: (...args) => agenda.add(...args),
		setPaused: (...args) => agenda.setPaused(...args),
		wake: (...args) => agenda.wake(...args),
		execution: (...args) => agenda.execution(...args),
		executionAt: (...args) => agenda.executionAt(...args),
	}
}

it('drains a non-cooperative callback before reporting cancellation', async () => {
	const f = await fixture()
	const entered = deferred()
	const aborted = deferred()
	const release = deferred()
	let settled = false
	const pending = runResidentForeground({
		agenda: f.agenda,
		signal: new AbortController().signal,
		maxSteps: 2,
		pollIntervalMs: 1,
		step: async (_pursuit, signal) => {
			signal.addEventListener('abort', aborted.resolve, { once: true })
			entered.resolve()
			await release.promise
			return { kind: 'complete', summary: 'An effect may have happened' }
		},
	}).finally(() => {
		settled = true
	})
	try {
		await entered.promise
		const remote = f.reopen()
		const current = await remote.read()
		if (!current) throw new Error('Missing running agenda')
		await remote.setPaused(current, true)
		await aborted.promise
		await sleep(10)
		expect(settled).toBe(false)
		expect((await remote.execution(f.pursuit.id).read())?.phase).toBe('running')
	} finally {
		release.resolve()
		await pending
	}
	expect(await pending).toMatchObject({ status: 'cancelled', stepsSettled: 0 })
	expect((await f.agenda.execution(f.pursuit.id).read())?.claimId).not.toBeNull()
})

it.each([2, 3, 4])('stops on a failed control read at admission boundary %i', async (failAt) => {
	const f = await fixture()
	let reads = 0
	const agenda = withRead(f.agenda, async () => {
		if (++reads === failAt) throw new Error('Resident control read failed')
		return f.agenda.read()
	})
	const step = vi.fn(async () => ({ kind: 'complete' as const, summary: 'Never reached' }))
	await expect(
		runResidentForeground({
			agenda,
			step,
			signal: new AbortController().signal,
			maxSteps: 1,
			pollIntervalMs: 60_000,
		}),
	).rejects.toThrow('Resident control read failed')
	expect(step).not.toHaveBeenCalled()
	expect((await f.reopen().execution(f.pursuit.id).read())?.phase).toBe(
		failAt === 4 ? 'running' : 'waiting',
	)
})

it('aborts and drains active work when the control monitor cannot read durable state', async () => {
	const f = await fixture()
	const entered = deferred()
	const failure = new Error('Resident storage became unreadable')
	let failRead = false
	let drained = false
	const agenda = withRead(f.agenda, async () => {
		if (failRead) throw failure
		return f.agenda.read()
	})
	const pending = runResidentForeground({
		agenda,
		signal: new AbortController().signal,
		maxSteps: 2,
		pollIntervalMs: 1,
		step: async (_pursuit, signal) => {
			const abort = new Promise<void>((resolve) => {
				signal.addEventListener('abort', () => resolve(), { once: true })
			})
			entered.resolve()
			await abort
			await sleep(5)
			drained = true
			return { kind: 'complete', summary: 'Must remain unresolved' }
		},
	})
	// Attach the rejection observer before triggering the asynchronous failure.
	const result = expect(pending).rejects.toBe(failure)
	await entered.promise
	failRead = true
	await result
	expect(drained).toBe(true)
	expect((await f.reopen().execution(f.pursuit.id).read())?.phase).toBe('running')
})
