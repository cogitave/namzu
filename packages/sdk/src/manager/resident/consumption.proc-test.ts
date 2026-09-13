import { type ChildProcess, fork } from 'node:child_process'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { removeTempDirs } from '../../__fixtures__/temp-dir.js'
import { generateTenantId } from '../../utils/id.js'
import { DiskResidentAgenda } from './agenda.js'
import type { ResidentConsumptionReport } from './consumption.js'
import type { ResidentState } from './store.js'

function receive(child: ChildProcess): Promise<unknown> {
	return new Promise((resolve, reject) => {
		const cleanup = () => {
			child.off('message', message)
			child.off('error', error)
			child.off('exit', exit)
		}
		const message = (value: unknown) => {
			cleanup()
			resolve(value)
		}
		const error = (value: Error) => {
			cleanup()
			reject(value)
		}
		const exit = () => {
			cleanup()
			reject(new Error('Consumption worker exited without a report.'))
		}
		child.once('message', message)
		child.once('error', error)
		child.once('exit', exit)
	})
}

it('retains provisional spend after abrupt death, inspected settlement and archive in fresh processes', async () => {
	const root = await mkdtemp(join(tmpdir(), 'resident-consumption-process-'))
	const scope = { tenantId: generateTenantId(), agentKey: 'consumption-process' }
	const agenda = new DiskResidentAgenda(root, scope)
	const workers: ChildProcess[] = []
	try {
		const pursuit = await agenda.add(
			await agenda.create('Inspected continuity only.'),
			'Read one file.',
		)
		const worker = (mode: string) => {
			const child = fork(
				fileURLToPath(new URL('./__tests__/consumption-worker.mjs', import.meta.url)),
				[root, scope.tenantId, pursuit.id, mode],
				{ execArgv: [], stdio: ['ignore', 'ignore', 'inherit', 'ipc'] },
			)
			workers.push(child)
			return child
		}
		const producer = worker('admit')
		expect(await receive(producer)).toBe('ready')
		const admitted = receive(producer)
		producer.send('go')
		const { claim } = (await admitted) as { claim: ResidentState }
		expect(claim.claimId).toBeTruthy()
		const killed = new Promise<void>((resolve) => producer.once('exit', () => resolve()))
		producer.kill('SIGKILL')
		await killed
		const inspect = async () => {
			const reader = worker('inspect')
			expect(await receive(reader)).toBe('ready')
			const report = receive(reader)
			const exited = new Promise<number | null>((resolve) => reader.once('exit', resolve))
			reader.send('go')
			const result = (await report) as { report: ResidentConsumptionReport }
			expect(await exited).toBe(0)
			return result.report
		}
		const before = await inspect()
		expect(before.recorded).toMatchObject({ ownTokens: 120, treeTokens: 180, ownCostUsd: 0 })
		expect(before.unknown.ownPriceAttempts).toBe(1)
		expect(before.usageComplete).toBe(false)
		expect(before.attempts[0]?.settlement).toBeNull()
		// The fixture executor is confirmed dead; no effect is replayed or usage fabricated.
		await agenda
			.execution(pursuit.id)
			.settle(claim, { kind: 'complete', summary: 'Inspected fixture interruption.' }, Date.now())
		const state = await agenda.read()
		if (!state) throw new Error('Missing settled agenda.')
		await agenda.archive(state, { pursuitIds: [pursuit.id] })
		const after = await inspect()
		expect(after.recorded).toEqual(before.recorded)
		expect(after.unknown).toEqual(before.unknown)
		expect(after.archivedPursuits).toEqual([pursuit.id])
		expect(after.attempts[0]?.settlement?.outcome).toBe('complete')
		expect(after.usageComplete).toBe(false)
	} finally {
		await Promise.all(
			workers.map(async (child) => {
				if (child.exitCode !== null || child.signalCode !== null) return
				const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
				child.kill('SIGKILL')
				await exited
			}),
		)
		await removeTempDirs([root])
	}
}, 30_000)
