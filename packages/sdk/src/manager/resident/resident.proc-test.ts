import { type ChildProcess, fork } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it, vi } from 'vitest'
import { generateTenantId } from '../../utils/id.js'
import { stepResident } from './loop.js'
import { DiskResidentStore } from './store.js'

function receive(child: ChildProcess): Promise<unknown> {
	return new Promise((resolve, reject) => {
		const onExit = () => {
			cleanup()
			reject(new Error('Worker exited before reporting.'))
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

it('admits one real process and retains its unresolved claim after the process exits', async () => {
	const root = await mkdtemp(join(tmpdir(), 'namzu-resident-proc-'))
	const tenantId = generateTenantId()
	const store = new DiskResidentStore(root, { tenantId, agentKey: 'process-check' })
	const workers: ChildProcess[] = []
	try {
		await store.create('Process test', 'One admitted effect only.')
		const ready = [0, 1].map(() => {
			const worker = fork(
				fileURLToPath(new URL('./__tests__/worker.mjs', import.meta.url)),
				[root, tenantId],
				{ execArgv: [], stdio: ['ignore', 'ignore', 'inherit', 'ipc'] },
			)
			workers.push(worker)
			return receive(worker)
		})
		expect(await Promise.all(ready)).toEqual(['ready', 'ready'])
		const exits = workers.map(
			(worker) => new Promise<void>((resolve) => worker.once('exit', () => resolve())),
		)
		const outcomes = workers.map((worker) => {
			const result = receive(worker)
			worker.send('go')
			return result
		})
		expect((await Promise.all(outcomes)).sort()).toEqual(['ResidentConflictError', 'claimed'])
		await Promise.all(exits)
		const callback = vi.fn()
		const reopened = new DiskResidentStore(root, { tenantId, agentKey: 'process-check' })
		expect(await stepResident(reopened, callback, new AbortController().signal)).toMatchObject({
			status: 'idle',
			reason: 'unresolved',
			state: { stepsAdmitted: 1 },
		})
		expect(callback).not.toHaveBeenCalled()
	} finally {
		for (const worker of workers) if (worker.exitCode === null) worker.kill()
		await rm(root, { recursive: true, force: true })
	}
}, 30_000)
