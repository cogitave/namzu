import { mkdtemp, rename, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { removeTempDirAsync } from '../../../__fixtures__/temp-dir.js'

import type { RunId } from '../../../types/ids/index.js'
import { asTaskId, generateRunId, generateTenantId } from '../../../utils/id.js'
import { DiskTaskStore } from '../disk.js'

/**
 * A task is WRITTEN under the run that created it and was READ under the
 * store's default run, so every lookup missed as soon as the two differed
 * — which is the normal case, not an edge one: the tools are built with
 * the live run id (`buildTaskTools(store, ctx.runId)`) while a long-lived
 * host constructs the store once with a fixed default.
 *
 * The symptom is that `create` succeeds, `list` succeeds — it takes the
 * run id as a filter and falls back to the same default — and then
 * `update`, `delete`, `claim` and every dependency link answer "not
 * found" for a task the caller can see.
 *
 * The in-memory store keys by task id alone, so nothing caught it.
 */

const DEFAULT = '1f405a99-8132-4449-9570-ebaa191ec909' as RunId
const OTHER = '1415ce5b-c47e-41ab-8308-f187097fdb47' as RunId

describe('a task created under a different run than the store default', () => {
	let dir: string
	let store: DiskTaskStore

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), 'namzu-tasks-'))
		store = new DiskTaskStore({ baseDir: dir, defaultRunId: DEFAULT })
	})

	afterEach(async () => {
		await removeTempDirAsync(dir)
	})

	it('can be fetched by id', async () => {
		const task = await store.create({ subject: 'ship it', runId: OTHER })

		expect(await store.get(task.id)).toMatchObject({ id: task.id, runId: OTHER })
	})

	it('can be updated', async () => {
		const task = await store.create({ subject: 'ship it', runId: OTHER })

		const updated = await store.update(task.id, { status: 'in_progress' })
		expect(updated).toMatchObject({ id: task.id, status: 'in_progress' })
	})

	it('can be claimed', async () => {
		const task = await store.create({ subject: 'ship it', runId: OTHER })

		expect(await store.claim(task.id, 'worker-1')).toMatchObject({ owner: 'worker-1' })
	})

	it('can be deleted', async () => {
		const task = await store.create({ subject: 'ship it', runId: OTHER })

		expect(await store.delete(task.id)).toBe(true)
		expect(await store.get(task.id)).toBeUndefined()
	})

	it('is still not found when it genuinely does not exist', async () => {
		// The lookup widened to every run; it must not start inventing
		// tasks, or "not found" stops meaning anything.
		expect(await store.get('cba0e01f-b5a4-4b3a-9895-8beeaf637aa8' as never)).toBeUndefined()
	})

	it('is found under the default run too', async () => {
		const task = await store.create({ subject: 'ship it', runId: DEFAULT })

		expect(await store.get(task.id)).toMatchObject({ id: task.id, runId: DEFAULT })
	})

	it.each([false, true])(
		'reopens generated and caller-assigned UUIDs across runs (tenant scoped: %s)',
		async (scoped) => {
			const tenantId = scoped ? generateTenantId() : undefined
			const config = { baseDir: dir, defaultRunId: DEFAULT, tenantId }
			const writer = new DiskTaskStore(config)
			const opaqueRun = generateRunId()
			const current = await writer.create({ subject: 'current task', runId: opaqueRun })
			const existing = await writer.create({ subject: 'existing task', runId: OTHER })
			const suppliedId = asTaskId('7d9b63d8-3b4f-4569-af4f-969629c6fed1')
			const runDir = tenantId
				? join(dir, 'tenants', tenantId, 'tasks', OTHER)
				: join(dir, 'tasks', OTHER)
			await rename(join(runDir, `${existing.id}.json`), join(runDir, `${suppliedId}.json`))
			await writeFile(
				join(runDir, `${suppliedId}.json`),
				JSON.stringify({ ...existing, id: suppliedId }),
			)

			const cold = () => new DiskTaskStore(config)
			expect(await cold().get(current.id)).toMatchObject({ id: current.id, runId: opaqueRun })
			expect(await cold().get(suppliedId)).toMatchObject({ id: suppliedId, runId: OTHER })
			expect(await cold().claim(current.id, 'worker')).toMatchObject({ owner: 'worker' })
			expect(await cold().update(suppliedId, { status: 'in_progress' })).toMatchObject({
				id: suppliedId,
				status: 'in_progress',
			})
			expect(await cold().delete(current.id)).toBe(true)
			expect(await cold().get(current.id)).toBeUndefined()
		},
	)
})
