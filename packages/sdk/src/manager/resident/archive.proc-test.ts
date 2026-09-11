import { type ChildProcess, fork } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { generateTenantId } from '../../utils/id.js'
import { DiskResidentAgenda } from './agenda.js'

function receive(child: ChildProcess): Promise<unknown> {
	return new Promise((resolve, reject) => {
		const cleanup = () => {
			child.off('exit', onExit)
			child.off('error', onError)
			child.off('message', onMessage)
		}
		const onExit = () => {
			cleanup()
			reject(new Error('Archive worker exited before reporting.'))
		}
		const onError = (error: Error) => {
			cleanup()
			reject(error)
		}
		const onMessage = (message: unknown) => {
			cleanup()
			resolve(message)
		}
		child.once('exit', onExit)
		child.once('error', onError)
		child.once('message', onMessage)
	})
}

it('serializes distinct archive requests and retains dedup after reopening in a new process', async () => {
	const root = await mkdtemp(join(tmpdir(), 'namzu-archive-process-'))
	const scope = { tenantId: generateTenantId(), agentKey: 'archive-process-check' }
	const agenda = new DiskResidentAgenda(root, scope)
	const workers: ChildProcess[] = []
	const snapshot = async () => {
		const current = await agenda.read()
		if (!current) throw new Error('Missing process fixture agenda')
		return current
	}
	const worker = (messageId: string, mode = 'archive') => {
		const child = fork(
			fileURLToPath(new URL('./__tests__/archive-worker.mjs', import.meta.url)),
			[root, scope.tenantId, messageId, mode],
			{ execArgv: [], stdio: ['ignore', 'ignore', 'inherit', 'ipc'] },
		)
		workers.push(child)
		return child
	}
	try {
		const pursuit = await agenda.add(await agenda.create('Careful resident'), 'One verified result')
		const execution = agenda.execution(pursuit.id)
		const claimed = await execution.claim(pursuit.state, 1_000)
		await execution.settle(claimed, { kind: 'complete', summary: 'Verified' }, 1_000)
		const ids = [randomUUID(), randomUUID()]
		for (const id of ids) {
			await agenda.enqueueMessage(await snapshot(), {
				id,
				pursuitId: pursuit.id,
				destination: 'local',
				body: 'Verified',
				notBefore: 0,
			})
			const send = await agenda.claimMessage(await snapshot(), id, 1_000)
			await agenda.settleMessage(send, { kind: 'acknowledged', receiptId: `receipt:${id}` }, 1_000)
		}
		const contenders = ids.map((id) => worker(id))
		expect(await Promise.all(contenders.map(receive))).toEqual(['ready', 'ready'])
		const exits = contenders.map(
			(child) => new Promise<number | null>((resolve) => child.once('exit', resolve)),
		)
		const reports = contenders.map(receive)
		for (const child of contenders) child.send('go')
		const results = (await Promise.all(reports)) as { result: string }[]
		expect(results.map((result) => result.result).sort()).toEqual([
			'ResidentConflictError',
			'archived',
		])
		expect(await Promise.all(exits)).toEqual([0, 0])
		const remaining = (await snapshot()).outbox?.[0]
		if (!remaining) throw new Error('Expected one retained message after archive contention')
		await agenda.archive(await snapshot(), { pursuitIds: [pursuit.id], messageIds: [remaining.id] })
		expect((await agenda.listArchived()).entries).toHaveLength(2)
		const retry = worker(ids[0] ?? '', 'duplicate')
		expect(await receive(retry)).toBe('ready')
		const exited = new Promise<number | null>((resolve) => retry.once('exit', resolve))
		const response = receive(retry)
		retry.send('go')
		expect(await response).toEqual({ result: 'acknowledged', active: 0 })
		expect(await exited).toBe(0)
		expect((await snapshot()).pursuits).toEqual([])
	} finally {
		await Promise.all(
			workers.map(async (child) => {
				if (child.exitCode !== null || child.signalCode !== null) return
				const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
				child.kill('SIGKILL')
				await exited
			}),
		)
		await rm(root, { recursive: true, force: true })
	}
}, 30_000)
