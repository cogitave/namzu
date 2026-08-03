import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { RunId } from '../../../types/ids/index.js'
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

const DEFAULT = 'run_default' as RunId
const OTHER = 'run_actual' as RunId

describe('a task created under a different run than the store default', () => {
	let dir: string
	let store: DiskTaskStore

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), 'namzu-tasks-'))
		store = new DiskTaskStore({ baseDir: dir, defaultRunId: DEFAULT })
	})

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true })
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
		expect(await store.get('task_nope' as never)).toBeUndefined()
	})

	it('is found under the default run too', async () => {
		const task = await store.create({ subject: 'ship it', runId: DEFAULT })

		expect(await store.get(task.id)).toMatchObject({ id: task.id, runId: DEFAULT })
	})
})
