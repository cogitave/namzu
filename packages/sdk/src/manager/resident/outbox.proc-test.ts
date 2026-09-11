import { type ChildProcess, fork } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it, vi } from 'vitest'
import { generateTenantId } from '../../utils/id.js'
import { DiskResidentAgenda } from './agenda.js'
import { deliverResidentMessage } from './outbox.js'
import { ResidentConflictError } from './store.js'

function receive(child: ChildProcess): Promise<unknown> {
	return new Promise((resolve, reject) => {
		const onExit = () => {
			cleanup()
			reject(new Error('Outbox worker exited before reporting.'))
		}
		const onError = (error: Error) => {
			cleanup()
			reject(error)
		}
		const onMessage = (message: unknown) => {
			cleanup()
			resolve(message)
		}
		const cleanup = () => {
			child.off('exit', onExit)
			child.off('error', onError)
			child.off('message', onMessage)
		}
		child.once('exit', onExit)
		child.once('error', onError)
		child.once('message', onMessage)
	})
}

it.each(['same-message', 'different-message'])(
	'admits one sender across %s and never repeats its effect after process death',
	async (scenario) => {
		const root = await mkdtemp(join(tmpdir(), 'namzu-outbox-process-'))
		const scope = { tenantId: generateTenantId(), agentKey: 'outbox-process-check' }
		const workers: ChildProcess[] = []
		try {
			const agenda = new DiskResidentAgenda(root, scope)
			const pursuit = await agenda.add(
				await agenda.create('Careful notifier'),
				'Report one result.',
			)
			const claim = await agenda.execution(pursuit.id).claim(pursuit.state, Date.now())
			const messageId = randomUUID()
			await agenda.settleWithMessage(
				pursuit.id,
				claim,
				{ kind: 'complete', summary: 'One verified result is ready.' },
				{
					id: messageId,
					pursuitId: pursuit.id,
					destination: 'fixture:operator',
					body: 'The verified result is ready.',
					notBefore: 0,
				},
				Date.now(),
			)
			const messageIds = [messageId, scenario === 'same-message' ? messageId : randomUUID()]
			if (scenario === 'different-message') {
				const current = await agenda.read()
				if (!current) throw new Error('The committed agenda is missing.')
				await agenda.enqueueMessage(current, {
					id: messageIds[1] ?? '',
					pursuitId: pursuit.id,
					destination: 'fixture:another-route',
					body: 'Another independently queued message.',
					notBefore: 0,
				})
			}
			const ready = messageIds.map((assignedId) => {
				const worker = fork(
					fileURLToPath(new URL('./__tests__/outbox-worker.mjs', import.meta.url)),
					[root, scope.tenantId, assignedId],
					{ execArgv: [], stdio: ['ignore', 'ignore', 'inherit', 'ipc'] },
				)
				workers.push(worker)
				return receive(worker)
			})
			// Both processes observe no sender before either may admit its assigned message.
			expect(await Promise.all(ready)).toEqual(messageIds.map((id) => ({ ready: id, sending: 0 })))
			const exits = workers.map(
				(worker) =>
					new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
						worker.once('exit', (code, signal) => resolve({ code, signal }))
					}),
			)
			const reports = workers.map((worker) => receive(worker))
			for (const worker of workers) worker.send('go')
			const outcomes = (await Promise.all(reports)) as {
				event: string
				id?: string
				reason?: string
			}[]
			expect(outcomes.map((outcome) => outcome.event).sort()).toEqual(['effect', 'idle'])
			const senderIndex = outcomes.findIndex((outcome) => outcome.event === 'effect')
			const otherIndex = 1 - senderIndex
			expect(outcomes[otherIndex]?.reason).toBe('contended')
			expect(outcomes[senderIndex]?.id).toBe(messageIds[senderIndex])
			const sender = workers[senderIndex]
			if (!sender) throw new Error('No process reported the effect.')
			sender.kill('SIGKILL')
			expect(await exits[senderIndex]).toMatchObject({ signal: 'SIGKILL' })
			expect(await exits[otherIndex]).toMatchObject({ code: 0 })

			const reopened = new DiskResidentAgenda(root, scope)
			const snapshot = await reopened.read()
			expect(snapshot?.outbox?.filter((message) => message.phase === 'sending')).toHaveLength(1)
			expect(snapshot?.outbox?.filter((message) => message.phase === 'pending')).toHaveLength(
				scenario === 'different-message' ? 1 : 0,
			)
			const uncertain = snapshot?.outbox?.find((message) => message.id === messageIds[senderIndex])
			if (!uncertain) throw new Error('The killed sender lost its durable message.')
			expect(uncertain).toMatchObject({ phase: 'sending', attempts: 1 })
			expect(uncertain.claimId).toEqual(expect.any(String))
			expect(snapshot?.pursuits[0]?.state.phase).toBe('complete')
			const transport = vi.fn()
			const options = {
				signal: new AbortController().signal,
				gate: () => ({ allow: true as const }),
			}
			expect(await deliverResidentMessage(reopened, transport, options)).toMatchObject({
				status: 'idle',
				reason: 'unresolved',
			})
			expect(transport).not.toHaveBeenCalled()

			// The executor is dead. Inspect the destination fixture before reconciling its receipt.
			const effects = (await readFile(join(root, 'delivered.jsonl'), 'utf8')).trim().split('\n')
			expect(effects).toHaveLength(1)
			const effect = JSON.parse(effects[0] ?? '') as { id: string; receiptId: string }
			expect(effect.id).toBe(messageIds[senderIndex])
			await reopened.settleMessage(
				uncertain,
				{ kind: 'acknowledged', receiptId: effect.receiptId },
				Date.now(),
			)
			await expect(
				reopened.settleMessage(
					uncertain,
					{ kind: 'not-accepted', retryAt: Date.now() + 1_000, reason: 'Stale sender response.' },
					Date.now(),
				),
			).rejects.toBeInstanceOf(ResidentConflictError)
			const afterReconciliation = await deliverResidentMessage(reopened, transport, {
				...options,
				gate: (message) =>
					message.id === uncertain.id
						? { allow: true }
						: {
								allow: false,
								nextCheckAt: null,
								reason: 'Other message stays pending for its owner.',
							},
			})
			expect(afterReconciliation).toMatchObject({
				status: 'idle',
				reason: scenario === 'different-message' ? 'window' : 'empty',
			})
			expect(transport).not.toHaveBeenCalled()
			const final = await new DiskResidentAgenda(root, scope).read()
			expect(final?.outbox?.find((message) => message.id === uncertain.id)).toMatchObject({
				phase: 'acknowledged',
				attempts: 1,
				receiptId: effect.receiptId,
			})
			if (scenario === 'different-message')
				expect(
					final?.outbox?.find((message) => message.id === messageIds[otherIndex]),
				).toMatchObject({
					phase: 'pending',
					attempts: 0,
					claimId: null,
				})
		} finally {
			await Promise.all(
				workers.map(async (worker) => {
					if (worker.exitCode !== null || worker.signalCode !== null) return
					const exited = new Promise<void>((resolve) => worker.once('exit', () => resolve()))
					worker.kill('SIGKILL')
					await exited
				}),
			)
			await rm(root, { recursive: true, force: true })
		}
	},
	30_000,
)
