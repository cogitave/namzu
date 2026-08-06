import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import type { RunId } from '../../../types/ids/index.js'
import type { TaskEvent, TaskStore } from '../../../types/task/index.js'
import { DiskTaskStore } from '../disk.js'
import { InMemoryTaskStore } from '../memory.js'

/**
 * The two stores disagreed about what `task.updated` means.
 *
 * `block()` is idempotent on both — it guards each array against a duplicate
 * entry — but only the disk store guarded the *announcement*. Calling
 * `block(a, b)` twice emitted two `task.updated` events from the in-memory
 * store and one from the disk store, which is the one a host runs in
 * production. So a host rebuilding a dependency graph from the stream did
 * redundant work against the reference implementation and not the durable one,
 * and a host counting events to detect change saw change where there was none.
 *
 * The disk store's behaviour is the correct one and the in-memory store now
 * matches it: an edge that already existed is not news.
 *
 * Both are driven from the same cases here, because a reference implementation
 * that disagrees with the durable one is worse than having only one — the
 * disagreement is invisible until a host swaps stores in production.
 */

const RUN = 'run_edge' as RunId

const dirs: string[] = []
afterEach(async () => {
	await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })))
	dirs.length = 0
})

async function diskStore(): Promise<TaskStore> {
	const dir = await mkdtemp(join(tmpdir(), 'namzu-edge-'))
	dirs.push(dir)
	return new DiskTaskStore({ baseDir: dir, defaultRunId: RUN })
}

const IMPLEMENTATIONS: ReadonlyArray<readonly [string, () => Promise<TaskStore>]> = [
	['in memory', async () => new InMemoryTaskStore()],
	['on disk', diskStore],
]

describe.each(IMPLEMENTATIONS)('an edge that already exists is not news (%s)', (_n, build) => {
	async function twoTasks(store: TaskStore) {
		const blocker = await store.create({ runId: RUN, subject: 'blocker' })
		const blocked = await store.create({ runId: RUN, subject: 'blocked' })
		return { blocker, blocked }
	}

	function recordUpdates(store: TaskStore): TaskEvent[] {
		const seen: TaskEvent[] = []
		store.on((event) => {
			if (event.type === 'task.updated') seen.push(event)
		})
		return seen
	}

	it('announces both ends when the edge is written', async () => {
		// The control: without it, "no second announcement" could be passing
		// because nothing announces at all.
		const store = await build()
		const { blocker, blocked } = await twoTasks(store)
		const seen = recordUpdates(store)

		await store.block(blocker.id, blocked.id)

		expect(seen.map((e) => e.taskId)).toEqual([blocker.id, blocked.id])
	})

	it('says nothing the second time', async () => {
		const store = await build()
		const { blocker, blocked } = await twoTasks(store)
		await store.block(blocker.id, blocked.id)
		const seen = recordUpdates(store)

		await store.block(blocker.id, blocked.id)

		expect(seen).toEqual([])
	})

	it('still records the edge exactly once after a repeated call', async () => {
		// Suppressing the event must not become suppressing the write, and the
		// arrays must not grow a duplicate.
		const store = await build()
		const { blocker, blocked } = await twoTasks(store)

		await store.block(blocker.id, blocked.id)
		await store.block(blocker.id, blocked.id)

		expect((await store.get(blocker.id))?.blocks).toEqual([blocked.id])
		expect((await store.get(blocked.id))?.blockedBy).toEqual([blocker.id])
	})

	it('announces a repair when only one side of the edge was missing', async () => {
		// A half-edge is the case the early return must not swallow: one array
		// already names the other and its counterpart does not. Both ends are
		// one fact, so both are announced even though only one array grew.
		const store = await build()
		const { blocker, blocked } = await twoTasks(store)
		await store.block(blocker.id, blocked.id)
		// Reverse direction: `blocked` has not yet been recorded as blocking
		// `blocker`, so this is a new edge, not the existing one.
		const seen = recordUpdates(store)

		await store.block(blocked.id, blocker.id)

		expect(seen.map((e) => e.taskId)).toEqual([blocked.id, blocker.id])
	})
})
