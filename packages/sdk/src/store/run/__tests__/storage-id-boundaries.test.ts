import { mkdtemp, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import type { CheckpointId, IterationCheckpoint } from '../../../types/hitl/index.js'
import type { RunId, TaskId, TenantId } from '../../../types/ids/index.js'
import {
	InvalidIdError,
	generateProjectId,
	generateRunId,
	generateSessionId,
	generateTenantId,
} from '../../../utils/id.js'
import { DiskTaskStore } from '../../task/disk.js'
import { DiskCheckpointStore } from '../checkpoint-disk.js'
import { RunDiskStore } from '../disk.js'

const roots: string[] = []
afterEach(async () => {
	await removeTempDirs(roots.splice(0))
})

async function fixture() {
	const baseDir = await mkdtemp(join(tmpdir(), 'namzu-run-storage-id-'))
	roots.push(baseDir)
	return baseDir
}

describe('run, checkpoint and task storage ID boundaries', () => {
	it.each(['../outside', 'run_/../../outside', 'run_a\\outside', 'run_a:stream', 'ses_wrongKind'])(
		'refuses run segment %s at initialization and claim boundaries',
		async (raw) => {
			const baseDir = await fixture()
			const run = new RunDiskStore({ baseDir })
			const scope = {
				tenantId: generateTenantId(),
				projectId: generateProjectId(),
				sessionId: generateSessionId(),
				runId: raw as RunId,
			}
			await expect(run.initRun(raw)).rejects.toThrow(InvalidIdError)
			await expect(run.initRun(generateRunId(), raw)).rejects.toThrow(InvalidIdError)
			expect(run.getRunDir()).toBeNull()
			const checkpoints = new DiskCheckpointStore({ baseDir })
			const options = { holder: 'worker', ttlMs: 1_000, now: 1 }
			await expect(checkpoints.claimRun(scope, options)).rejects.toThrow(InvalidIdError)
			await expect(
				checkpoints.claimRun(
					{ ...scope, runId: generateRunId(), parentRunId: raw as RunId },
					options,
				),
			).rejects.toThrow(InvalidIdError)
			expect(await readdir(baseDir)).toEqual([])
		},
	)

	it('rejects checkpoint path assertions before writing or reading checkpoint files', async () => {
		const baseDir = await fixture()
		const store = new RunDiskStore({ baseDir })
		const runDir = await store.initRun(generateRunId())
		const id = 'cp_/../../outside' as CheckpointId
		await expect(store.writeCheckpoint({ id } as IterationCheckpoint)).rejects.toThrow(
			InvalidIdError,
		)
		await expect(store.readCheckpoint(id)).rejects.toThrow(InvalidIdError)
		await expect(store.deleteCheckpoint(id)).rejects.toThrow(InvalidIdError)
		expect(await readdir(runDir)).toEqual([])
	})

	it('validates task, run and tenant IDs before resolving task paths', async () => {
		const baseDir = await fixture()
		const defaultRunId = generateRunId()
		expect(() => new DiskTaskStore({ baseDir, defaultRunId: '../outside' as RunId })).toThrow(
			InvalidIdError,
		)
		expect(
			() =>
				new DiskTaskStore({ baseDir, defaultRunId, tenantId: 'tnt_/../../outside' as TenantId }),
		).toThrow(InvalidIdError)
		const store = new DiskTaskStore({ baseDir, defaultRunId })
		await expect(
			store.create({ subject: 'unsafe', runId: 'run_/../../outside' as RunId }),
		).rejects.toThrow(InvalidIdError)
		await expect(store.get('task_/../../outside' as TaskId)).rejects.toThrow(InvalidIdError)
		expect(await readdir(baseDir)).toEqual([])
	})
})
