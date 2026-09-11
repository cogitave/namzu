import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { SchemaVersionError, defineSchema, migrate } from '../../store/schema.js'
import { generateTenantId } from '../../utils/id.js'
import { DiskResidentAgenda, type ResidentAgendaState } from './agenda.js'
import { ResidentHost, type ResidentMessageFactory } from './host.js'
import {
	type ResidentDeliveryOutcome,
	type ResidentMessageInput,
	type ResidentOutboxMessage,
	type ResidentOutboxStore,
	appendResidentMessage,
	deliverResidentMessage,
} from './outbox.js'
import { ResidentConflictError, type ResidentDecision } from './store.js'

const roots: string[] = []
const signal = new AbortController().signal
const gate = () => ({ allow: true as const })
const now = () => 1_000
const ack = { kind: 'acknowledged', receiptId: 'local-receiver:1' } as const
afterEach(async () => {
	vi.restoreAllMocks()
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})
async function snapshot(store: DiskResidentAgenda) {
	const state = await store.read()
	if (!state) throw new Error('Missing fixture agenda')
	return state
}
async function fixture() {
	const root = await mkdtemp(join(tmpdir(), 'namzu-outbox-'))
	roots.push(root)
	const scope = { tenantId: generateTenantId(), agentKey: 'communication-test' }
	const agenda = new DiskResidentAgenda(root, scope)
	const pursuit = await agenda.add(await agenda.create('Synthetic resident'), 'Inspect a fixture')
	const input: ResidentMessageInput = {
		id: randomUUID(),
		pursuitId: pursuit.id,
		destination: 'local-inbox',
		body: 'The fixture is ready.',
		notBefore: 0,
	}
	return { root, scope, agenda, pursuit, input, reopen: () => new DiskResidentAgenda(root, scope) }
}
async function queued() {
	const f = await fixture()
	await f.agenda.enqueueMessage(await snapshot(f.agenda), f.input)
	return f
}

it('commits pursuit completion, observed progress and notification in one revision without sending', async () => {
	const f = await fixture()
	const before = await snapshot(f.agenda)
	const host = new ResidentHost(
		f.agenda,
		async () => ({ kind: 'complete', summary: 'Validated fixture' }),
		{
			observe: async () => ({
				evidenceKey: 'fixture:1',
				source: 'validator',
				progress: 1,
				costUnits: 2,
			}),
			prepareMessage: async (pursuit) => {
				expect(pursuit.state.phase).toBe('running')
				return f.input
			},
		},
	)
	expect(await host.run({ signal, maxSteps: 1 })).toMatchObject({
		status: 'limit',
		stepsSettled: 1,
	})
	const state = await snapshot(f.reopen())
	expect(state.revision).toBe(before.revision + 2) // claim, then a single combined settlement
	expect(state.pursuits[0]).toMatchObject({
		state: { phase: 'complete' },
		feedback: { bestProgress: 1 },
	})
	expect(state.outbox).toEqual([
		expect.objectContaining({
			...f.input,
			attempts: 0,
			phase: 'pending',
			sourceClaimId: expect.any(String),
		}),
	])
	expect(Object.isFrozen(state.outbox)).toBe(true)
	expect(Object.isFrozen(state.outbox?.[0])).toBe(true)
	const revisions = join(f.root, f.scope.tenantId, f.scope.agentKey, 'agenda', 'revisions')
	const admission = JSON.parse(
		await readFile(join(revisions, `${before.revision + 1}.json`), 'utf8'),
	)
	expect(admission.pursuits[0].state.phase).toBe('running')
	expect(admission.outbox).toBeUndefined()
	const raw = JSON.parse(await readFile(join(revisions, `${state.revision}.json`), 'utf8'))
	expect(raw.schemaVersion).toBe(3)
	expect(() =>
		migrate(
			defineSchema({ kind: 'resident-agenda', current: 2, migrations: { 1: (v) => v } }),
			raw,
		),
	).toThrow(SchemaVersionError)
})

it.each(['null', 'invalid', 'throw', 'abort'] as const)(
	'handles a message factory returning %s without partial settlement',
	async (mode) => {
		const f = await fixture()
		const controller = new AbortController()
		const host = new ResidentHost(f.agenda, async () => ({ kind: 'complete', summary: 'Ready' }), {
			prepareMessage: async () => {
				if (mode === 'throw') throw new Error('No valid destination')
				if (mode === 'abort') controller.abort()
				if (mode === 'null') return null
				return { ...f.input, pursuitId: randomUUID() }
			},
		})
		if (mode === 'null') await host.run({ signal, maxSteps: 1 })
		else if (mode === 'abort')
			expect(await host.run({ signal: controller.signal, maxSteps: 1 })).toMatchObject({
				status: 'cancelled',
			})
		else await expect(host.run({ signal, maxSteps: 1 })).rejects.toThrow()
		const state = await snapshot(f.agenda)
		expect(state.outbox).toBeUndefined()
		expect(state.pursuits[0]?.state.phase).toBe(mode === 'null' ? 'complete' : 'running')
	},
)

it('requires atomic storage support before enabling the host message factory', async () => {
	const f = await fixture()
	Object.defineProperty(f.agenda, 'settleWithMessage', { value: undefined })
	expect(() => new ResidentHost(f.agenda, vi.fn(), { prepareMessage: vi.fn() })).toThrow(
		'atomic settleWithMessage',
	)
})

it('retains acknowledged identities for deduplication and refuses changed payloads', async () => {
	const f = await queued()
	const transport = vi.fn(async () => ack)
	expect(await deliverResidentMessage(f.agenda, transport, { signal, gate, now })).toMatchObject({
		status: 'settled',
		message: { phase: 'acknowledged', receiptId: ack.receiptId },
	})
	const duplicate = await f.agenda.enqueueMessage(await snapshot(f.agenda), f.input)
	expect(duplicate.phase).toBe('acknowledged')
	expect((await snapshot(f.agenda)).outbox).toHaveLength(1)
	await expect(
		f.agenda.enqueueMessage(await snapshot(f.agenda), { ...f.input, body: 'Different intent' }),
	).rejects.toThrow('different immutable intent')
	expect(await deliverResidentMessage(f.reopen(), transport, { signal, gate, now })).toMatchObject({
		status: 'idle',
		reason: 'empty',
	})
	expect(transport).toHaveBeenCalledTimes(1)
})

it.each(['paused', 'not-due', 'window', 'empty'] as const)(
	'does not claim or invoke transport when %s',
	async (reason) => {
		const f = await fixture()
		if (reason !== 'empty')
			await f.agenda.enqueueMessage(await snapshot(f.agenda), {
				...f.input,
				notBefore: reason === 'not-due' ? 2_000 : 0,
			})
		if (reason === 'paused') await f.agenda.setPaused(await snapshot(f.agenda), true)
		const before = await snapshot(f.agenda)
		const transport = vi.fn()
		const permission = vi.fn(
			reason === 'window'
				? () => ({ allow: false as const, nextCheckAt: 3_000, reason: 'Quiet hours' })
				: gate,
		)
		expect(
			await deliverResidentMessage(f.agenda, transport, { signal, gate: permission, now }),
		).toMatchObject({ status: 'idle', reason })
		expect(await snapshot(f.agenda)).toEqual(before)
		expect(transport).not.toHaveBeenCalled()
		if (reason !== 'window') expect(permission).not.toHaveBeenCalled()
	},
)

it('skips a closed destination and sends other due work', async () => {
	const f = await queued()
	const second = { ...f.input, id: randomUUID(), destination: 'another-inbox' }
	await f.agenda.enqueueMessage(await snapshot(f.agenda), second)
	const transport = vi.fn(async () => ack)
	expect(
		await deliverResidentMessage(f.agenda, transport, {
			signal,
			now,
			gate: (message) =>
				message.destination === 'local-inbox'
					? { allow: false, nextCheckAt: null, reason: 'Muted' }
					: { allow: true },
		}),
	).toMatchObject({ status: 'settled', message: { id: second.id } })
	expect(transport).toHaveBeenCalledTimes(1)
})

it('reports the earliest check across gated and future messages without changing either', async () => {
	const f = await queued()
	await f.agenda.enqueueMessage(await snapshot(f.agenda), {
		...f.input,
		id: randomUUID(),
		notBefore: 1_500,
	})
	expect(
		await deliverResidentMessage(f.agenda, vi.fn(), {
			signal,
			now,
			gate: () => ({ allow: false, nextCheckAt: 2_000, reason: 'Quiet' }),
		}),
	).toEqual({ status: 'idle', reason: 'window', nextCheckAt: 1_500 })
})

it('permits only evidence-backed retries and preserves the message ID across claims', async () => {
	const f = await queued()
	const transport = vi
		.fn()
		.mockResolvedValueOnce({
			kind: 'not-accepted',
			retryAt: 2_000,
			reason: 'Connection refused before send',
		})
		.mockResolvedValueOnce(ack)
	const first = await deliverResidentMessage(f.agenda, transport, { signal, gate, now })
	expect(first).toMatchObject({
		status: 'settled',
		message: { phase: 'pending', attempts: 1, nextAttemptAt: 2_000 },
	})
	expect(await deliverResidentMessage(f.reopen(), transport, { signal, gate, now })).toMatchObject({
		status: 'idle',
		reason: 'not-due',
	})
	expect(
		await deliverResidentMessage(f.reopen(), transport, { signal, gate, now: () => 2_000 }),
	).toMatchObject({
		status: 'settled',
		message: { id: f.input.id, phase: 'acknowledged', attempts: 2 },
	})
	expect(transport.mock.calls.map(([message]) => message.id)).toEqual([f.input.id, f.input.id])
	expect(transport.mock.calls[0]?.[0].claimId).not.toBe(transport.mock.calls[1]?.[0].claimId)
})

it('records explicit non-acceptance without retry as cancelled, never acknowledged', async () => {
	const f = await queued()
	expect(
		await deliverResidentMessage(
			f.agenda,
			async () => ({ kind: 'not-accepted', retryAt: null, reason: 'Destination rejected intent' }),
			{ signal, gate, now },
		),
	).toMatchObject({ status: 'settled', message: { phase: 'cancelled', receiptId: null } })
})

it.each(['throw', 'invalid', 'abort', 'past-retry'] as const)(
	'retains uncertain delivery after %s and does not blindly resend',
	async (failure) => {
		const f = await queued()
		const controller = new AbortController()
		const transport = vi.fn(async (): Promise<ResidentDeliveryOutcome> => {
			if (failure === 'throw') throw new Error('Connection lost after writing')
			if (failure === 'abort') controller.abort()
			if (failure === 'past-retry')
				return { kind: 'not-accepted', retryAt: 999, reason: 'bad scheduling' }
			return { kind: 'acknowledged', receiptId: '' }
		})
		await expect(
			deliverResidentMessage(f.agenda, transport, { signal: controller.signal, gate, now }),
		).rejects.toThrow()
		expect((await snapshot(f.agenda)).outbox?.[0]).toMatchObject({
			phase: 'sending',
			attempts: 1,
			receiptId: null,
		})
		expect(
			await deliverResidentMessage(f.reopen(), transport, { signal, gate, now }),
		).toMatchObject({ status: 'idle', reason: 'unresolved' })
		expect(transport).toHaveBeenCalledTimes(1)
	},
)

it('pre-abort makes no durable admission', async () => {
	const f = await queued()
	const before = await snapshot(f.agenda)
	await expect(
		deliverResidentMessage(f.agenda, vi.fn(), { signal: AbortSignal.abort(), gate, now }),
	).rejects.toThrow()
	expect(await snapshot(f.agenda)).toEqual(before)
})

it.each(['pause', 'window'] as const)(
	'rechecks %s after claim and safely releases an unstarted send',
	async (condition) => {
		const f = await queued()
		const claim = f.agenda.claimMessage.bind(f.agenda)
		vi.spyOn(f.agenda, 'claimMessage').mockImplementationOnce(async (...args) => {
			const admitted = await claim(...args)
			if (condition === 'pause') await f.agenda.setPaused(await snapshot(f.agenda), true)
			return admitted
		})
		const permission = vi
			.fn()
			.mockReturnValueOnce({ allow: true })
			.mockReturnValue({ allow: false, nextCheckAt: 2_000, reason: 'Window closed while claiming' })
		const transport = vi.fn()
		expect(
			await deliverResidentMessage(f.agenda, transport, { signal, now, gate: permission }),
		).toMatchObject({ status: 'idle', reason: condition === 'pause' ? 'paused' : 'window' })
		expect((await snapshot(f.agenda)).outbox?.[0]?.phase).toBe('pending')
		expect(transport).not.toHaveBeenCalled()
	},
)

it('rejects stale selection before dispatch if unrelated state changed', async () => {
	const f = await queued()
	const claim = f.agenda.claimMessage.bind(f.agenda)
	vi.spyOn(f.agenda, 'claimMessage').mockImplementationOnce(async (...args) => {
		await f.agenda.add(await snapshot(f.agenda), 'Another pursuit')
		return claim(...args)
	})
	const transport = vi.fn()
	expect(await deliverResidentMessage(f.agenda, transport, { signal, now, gate })).toMatchObject({
		status: 'idle',
		reason: 'contended',
	})
	expect(transport).not.toHaveBeenCalled()
})

it('preserves unrelated writes and fences foreign, stale and reconciled delivery claims', async () => {
	const f = await queued()
	const claim = await f.agenda.claimMessage(await snapshot(f.agenda), f.input.id, 1_000)
	await f.agenda.add(await snapshot(f.agenda), 'An unrelated result arrived')
	await expect(
		f.agenda.settleMessage({ ...claim, agentKey: 'foreign' }, ack, 1_000),
	).rejects.toThrow(ResidentConflictError)
	const saved = await f.agenda.settleMessage(claim, ack, 1_000)
	expect(saved.phase).toBe('acknowledged')
	expect((await snapshot(f.agenda)).pursuits).toHaveLength(2)
	await expect(f.agenda.settleMessage(claim, ack, 1_000)).rejects.toThrow(ResidentConflictError)
})

it('refuses a full outbox atomically without recording completion or observations', async () => {
	const f = await fixture()
	const claim = await f.agenda.execution(f.pursuit.id).claim(f.pursuit.state, 1_000)
	let state = await snapshot(f.agenda)
	for (let index = 0; index < 128; index++)
		state = { ...state, outbox: appendResidentMessage(state, { ...f.input, id: randomUUID() }) }
	const path = join(
		f.root,
		f.scope.tenantId,
		f.scope.agentKey,
		'agenda',
		'revisions',
		`${state.revision}.json`,
	)
	// Own synthetic fixture, before a writer starts. No public bulk-insert shortcut.
	await writeFile(path, JSON.stringify({ ...state, schemaVersion: 3 }))
	await expect(
		f.agenda.settleWithMessage(
			f.pursuit.id,
			claim,
			{ kind: 'complete', summary: 'Ready' },
			f.input,
			1_000,
			{ evidenceKey: 'fixture', source: 'validator', progress: 1, costUnits: 0 },
		),
	).rejects.toThrow('capacity')
	const after = await snapshot(f.agenda)
	expect(after.revision).toBe(state.revision)
	expect(after.pursuits[0]).toMatchObject({ state: { phase: 'running' } })
	expect(after.pursuits[0]?.feedback).toBeUndefined()
})

it.each(['scope', 'reference', 'duplicate', 'lifecycle'] as const)(
	'refuses corrupted persisted outbox %s',
	async (corruption) => {
		const f = await queued()
		const state = await snapshot(f.agenda)
		const message = state.outbox?.[0]
		if (!message) throw new Error('Missing fixture message')
		const changed =
			corruption === 'scope'
				? { ...message, tenantId: randomUUID() }
				: corruption === 'reference'
					? { ...message, pursuitId: randomUUID() }
					: corruption === 'lifecycle'
						? { ...message, phase: 'acknowledged' }
						: message
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
				schemaVersion: 3,
				outbox: corruption === 'duplicate' ? [message, message] : [changed],
			}),
		)
		await expect(f.reopen().read()).rejects.toThrow()
	},
)

it('supports class-based custom delivery backends without dropping prototype methods', async () => {
	const f = await queued()
	class Backend implements ResidentOutboxStore {
		read() {
			return f.agenda.read()
		}
		claimMessage(state: ResidentAgendaState, id: string, at: number) {
			return f.agenda.claimMessage(state, id, at)
		}
		settleMessage(message: ResidentOutboxMessage, outcome: ResidentDeliveryOutcome, at: number) {
			return f.agenda.settleMessage(message, outcome, at)
		}
	}
	expect(
		await deliverResidentMessage(new Backend(), async () => ack, { signal, gate, now }),
	).toMatchObject({ status: 'settled' })
})

it.each([undefined, false, 0, ''])(
	'rejects malformed silent factory result %s before settling',
	async (value) => {
		const f = await fixture()
		const host = new ResidentHost(f.agenda, async () => ({ kind: 'complete', summary: 'Ready' }), {
			prepareMessage: (async () => value) as unknown as ResidentMessageFactory,
		})
		await expect(host.run({ signal, maxSteps: 1 })).rejects.toThrow()
		expect((await snapshot(f.agenda)).pursuits[0]?.state.phase).toBe('running')
		expect((await snapshot(f.agenda)).outbox).toBeUndefined()
	},
)

it('snapshots observed facts and decisions before later host callbacks can mutate their source objects', async () => {
	const f = await fixture()
	const decision: ResidentDecision = { kind: 'complete', summary: 'Original verified disposition' }
	const observation = { evidenceKey: 'original', source: 'validator', progress: 0.5, costUnits: 2 }
	const host = new ResidentHost(f.agenda, async () => decision, {
		observe: async (_pursuit, observedDecision) => {
			expect(Object.isFrozen(observedDecision)).toBe(true)
			decision.summary = 'Mutated by an earlier callback'
			return observation
		},
		prepareMessage: async (_pursuit, observedDecision) => {
			expect(observedDecision.summary).toBe('Original verified disposition')
			observation.progress = 1
			observation.evidenceKey = 'unverified replacement'
			return f.input
		},
	})
	await host.run({ signal, maxSteps: 1 })
	expect((await snapshot(f.agenda)).pursuits[0]).toMatchObject({
		state: { summary: 'Original verified disposition' },
		feedback: { bestProgress: 0.5, observations: [{ evidenceKey: 'original', costUnits: 2 }] },
	})
})

it('snapshots the public atomic settlement decision before asynchronous persistence', async () => {
	const f = await fixture()
	const claim = await f.agenda.execution(f.pursuit.id).claim(f.pursuit.state, 1_000)
	const decision: ResidentDecision = { kind: 'complete', summary: 'Before await' }
	const input = { ...f.input }
	const settling = f.agenda.settleWithMessage(f.pursuit.id, claim, decision, input, 1_000)
	decision.summary = 'Changed after method entry'
	input.body = 'Changed outgoing content'
	await settling
	expect((await snapshot(f.agenda)).pursuits[0]?.state.summary).toBe('Before await')
	expect((await snapshot(f.agenda)).outbox?.[0]?.body).toBe(f.input.body)
})

it('rejects an invalid gate reason without claiming a send', async () => {
	const f = await queued()
	const before = await snapshot(f.agenda)
	await expect(
		deliverResidentMessage(f.agenda, vi.fn(), {
			signal,
			now,
			gate: () => ({ allow: false, nextCheckAt: null, reason: 'x'.repeat(1_001) }),
		}),
	).rejects.toThrow('Invalid resident delivery gate')
	expect(await snapshot(f.agenda)).toEqual(before)
})
