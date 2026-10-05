import { mkdtemp, readFile, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import { SessionPaths } from '../../../session/paths.js'
import type { TaskId } from '../../../types/ids/index.js'
import type { Task, TaskEvent, TaskStore } from '../../../types/task/index.js'
import { generateSessionId, generateTaskId, generateTurnId } from '../../../utils/id.js'
import { DiskRecordStore } from '../../kv/record-store.js'
import { DiskTaskStore } from '../disk.js'
import { InMemoryTaskStore } from '../memory.js'

vi.mock('node:fs/promises', async (importOriginal) => {
	const fs = await importOriginal<typeof import('node:fs/promises')>()
	return { ...fs, unlink: vi.fn(fs.unlink) }
})

const dirs: string[] = []
afterEach(async () => {
	vi.restoreAllMocks()
	await removeTempDirs(dirs)
	dirs.length = 0
})

async function fixture(kind: 'memory' | 'disk') {
	const sessionId = generateSessionId()
	const turnId = generateTurnId()
	let paths: SessionPaths | undefined
	let store: TaskStore
	if (kind === 'disk') {
		const home = await mkdtemp(join(tmpdir(), 'namzu-delete-graph-'))
		dirs.push(home)
		paths = new SessionPaths({ home, slug: '-work' })
		store = new DiskTaskStore({ paths, session: { sessionId } })
	} else store = new InMemoryTaskStore()
	const create = (subject: string, blockedBy?: TaskId[]) =>
		store.create({ sessionId, turnId, subject, blockedBy })
	const change = async (id: TaskId, apply: (task: Task) => void) => {
		if (paths) {
			const file = paths.taskFile({ sessionId }, id)
			const record = JSON.parse(await readFile(file, 'utf8')) as Task
			apply(record)
			await writeFile(file, JSON.stringify(record))
		} else {
			const task = await store.get(id)
			if (!task) throw new Error('Missing fixture task')
			apply(task)
		}
	}
	return { store, create, paths, sessionId, change }
}
function graph(tasks: Iterable<Task>) {
	return [...tasks]
		.map(({ id, subject, status, blocks, blockedBy }) => ({
			id,
			subject,
			status,
			blocks,
			blockedBy,
		}))
		.sort((a, b) => a.id.localeCompare(b.id))
}
async function observe(store: TaskStore) {
	const live = new Map((await store.list()).map((task) => [task.id, structuredClone(task)]))
	const events: TaskEvent[] = []
	store.on((event) => {
		const copy = structuredClone(event)
		events.push(copy)
		if (copy.type === 'task.deleted') live.delete(copy.taskId)
		else live.set(copy.taskId, copy.task)
	})
	return { live, events }
}
async function chain(f: Awaited<ReturnType<typeof fixture>>) {
	const blocker = await f.create('Blocker')
	const target = await f.create('Delete me')
	const blocked = await f.create('Blocked')
	const unrelated = await f.create('Unrelated dependency')
	await f.store.block(blocker.id, target.id)
	await f.store.block(target.id, blocked.id)
	await f.store.block(blocker.id, unrelated.id)
	return { blocker, target, blocked, unrelated }
}

describe.each(['memory', 'disk'] as const)(
	'creating a task updates its live dependency graph (%s)',
	(kind) => {
		it('announces the changed blocker before creation and preserves its other dependencies', async () => {
			const f = await fixture(kind)
			const blocker = await f.create('Blocker')
			const unrelated = await f.create('Existing dependent')
			await f.store.block(blocker.id, unrelated.id)
			const seen = await observe(f.store)
			const target = await f.create('New dependent', [blocker.id])
			expect(seen.events.map(({ type, taskId }) => [type, taskId])).toEqual([
				['task.updated', blocker.id],
				['task.created', target.id],
			])
			expect(seen.live.get(blocker.id)?.blocks).toEqual([unrelated.id, target.id])
			expect(graph(seen.live.values())).toEqual(graph(await f.store.list()))
			if (f.paths) {
				const reopened = new DiskTaskStore({ paths: f.paths, session: { sessionId: f.sessionId } })
				expect(graph(seen.live.values())).toEqual(graph(await reopened.listStrict()))
			}
		})

		it('announces a duplicate blocker once while preserving duplicate and missing input references', async () => {
			const f = await fixture(kind)
			const blocker = await f.create('Blocker')
			const missing = generateTaskId()
			const seen = await observe(f.store)
			const target = await f.create('Duplicate and dangling references', [
				blocker.id,
				blocker.id,
				missing,
			])
			expect(seen.events.map(({ type, taskId }) => [type, taskId])).toEqual([
				['task.updated', blocker.id],
				['task.created', target.id],
			])
			expect(target.blockedBy).toEqual([blocker.id, blocker.id, missing])
			expect((await f.store.get(blocker.id))?.blocks).toEqual([target.id])
			expect(await f.store.get(missing)).toBeUndefined()
			expect(graph(seen.live.values())).toEqual(graph(await f.store.list()))
		})

		it('does not announce a blocker update for a missing reference', async () => {
			const f = await fixture(kind)
			const missing = generateTaskId()
			const seen = await observe(f.store)
			const target = await f.create('Dangling reference', [missing])
			expect(seen.events.map(({ type, taskId }) => [type, taskId])).toEqual([
				['task.created', target.id],
			])
			expect(target.blockedBy).toEqual([missing])
			expect(graph(seen.live.values())).toEqual(graph(await f.store.list()))
		})
	},
)

describe('persisted blocker changes remain announced when a later disk create step fails', () => {
	it('keeps the first confirmed blocker update if the second blocker write fails', async () => {
		const f = await fixture('disk')
		const first = await f.create('First blocker')
		const second = await f.create('Second blocker')
		const seen = await observe(f.store)
		const write = DiskRecordStore.prototype.write
		const secondPath = f.paths?.taskFile({ sessionId: f.sessionId }, second.id)
		const failure = new Error('Second blocker write refused')
		vi.spyOn(DiskRecordStore.prototype, 'write').mockImplementation(function (
			this: DiskRecordStore<unknown>,
			path,
			value,
		) {
			if (path === secondPath) return Promise.reject(failure)
			return write.call(this, path, value)
		})
		await expect(f.create('Not created', [first.id, second.id])).rejects.toBe(failure)
		expect(seen.events.map(({ type, taskId }) => [type, taskId])).toEqual([
			['task.updated', first.id],
		])
		const targetId = seen.events[0]?.task.blocks[0]
		expect(targetId).toBeDefined()
		expect(targetId && (await f.store.get(targetId))).toBeUndefined()
		expect((await f.store.get(second.id))?.blocks).toEqual([])
		expect(graph(seen.live.values())).toEqual(graph(await f.store.list()))
	})

	it('keeps confirmed blocker updates without announcing creation if the new record write fails', async () => {
		const f = await fixture('disk')
		const first = await f.create('First blocker')
		const second = await f.create('Second blocker')
		const seen = await observe(f.store)
		const write = DiskRecordStore.prototype.write
		const subject = 'New task write refused'
		const failure = new Error(subject)
		vi.spyOn(DiskRecordStore.prototype, 'write').mockImplementation(function (
			this: DiskRecordStore<unknown>,
			path,
			value,
		) {
			if ((value as Task).subject === subject) return Promise.reject(failure)
			return write.call(this, path, value)
		})
		await expect(f.create(subject, [first.id, second.id])).rejects.toBe(failure)
		expect(seen.events.map(({ type, taskId }) => [type, taskId])).toEqual([
			['task.updated', first.id],
			['task.updated', second.id],
		])
		const targetId = seen.events[0]?.task.blocks[0]
		expect(targetId).toBeDefined()
		expect(seen.events[1]?.task.blocks).toEqual([targetId])
		expect(targetId && (await f.store.get(targetId))).toBeUndefined()
		expect(graph(seen.live.values())).toEqual(graph(await f.store.list()))
	})
})

describe.each(['memory', 'disk'] as const)(
	'deleting a task updates its live dependency graph (%s)',
	(kind) => {
		it('announces actual changed neighbors before deletion and leaves the reducer equal to the store', async () => {
			const f = await fixture(kind)
			const { blocker, target, blocked, unrelated } = await chain(f)
			// Duplicate references can occur in older/corrupt records. Removing a
			// relation must not announce a second, unchanged neighbor row.
			await f.change(target.id, (task) => {
				task.blockedBy.push(blocker.id)
				task.blocks.push(blocked.id)
			})
			const seen = await observe(f.store)
			expect(await f.store.delete(target.id)).toBe(true)
			expect(seen.events.map(({ type, taskId }) => [type, taskId])).toEqual([
				['task.updated', blocker.id],
				['task.updated', blocked.id],
				['task.deleted', target.id],
			])
			expect(graph(seen.live.values())).toEqual(graph(await f.store.list()))
			expect(seen.live.get(blocker.id)?.blocks).toEqual([unrelated.id])
			expect(seen.live.get(blocked.id)?.blockedBy).toEqual([])
			if (f.paths) {
				const reopened = new DiskTaskStore({ paths: f.paths, session: { sessionId: f.sessionId } })
				expect(graph(seen.live.values())).toEqual(graph(await reopened.listStrict()))
			}
		})

		it('does not announce unchanged reciprocal rows that already lack the deleted relation', async () => {
			const f = await fixture(kind)
			const { blocker, target, blocked, unrelated } = await chain(f)
			await f.change(blocker.id, (task) => {
				task.blocks = [unrelated.id]
			})
			await f.change(blocked.id, (task) => {
				task.blockedBy = []
			})
			const seen = await observe(f.store)
			expect(await f.store.delete(target.id)).toBe(true)
			expect(seen.events.map(({ type, taskId }) => [type, taskId])).toEqual([
				['task.deleted', target.id],
			])
			expect(graph(seen.live.values())).toEqual(graph(await f.store.list()))
		})

		it('does not announce the deleted task as its own surviving neighbor', async () => {
			const f = await fixture(kind)
			const target = await f.create('Self edge')
			await f.store.block(target.id, target.id)
			const seen = await observe(f.store)
			expect(await f.store.delete(target.id)).toBe(true)
			expect(seen.events.map(({ type, taskId }) => [type, taskId])).toEqual([
				['task.deleted', target.id],
			])
			expect(graph(seen.live.values())).toEqual([])
		})
	},
)

describe('persisted neighbor changes remain announced when a later disk delete step fails', () => {
	it('keeps the first confirmed neighbor update if the second neighbor write fails', async () => {
		const f = await fixture('disk')
		const { blocker, target, blocked } = await chain(f)
		const seen = await observe(f.store)
		const write = DiskRecordStore.prototype.write
		const blockedPath = f.paths?.taskFile({ sessionId: f.sessionId }, blocked.id)
		const failure = new Error('Second neighbor write refused')
		vi.spyOn(DiskRecordStore.prototype, 'write').mockImplementation(function (
			this: DiskRecordStore<unknown>,
			path,
			value,
		) {
			if (path === blockedPath) return Promise.reject(failure)
			return write.call(this, path, value)
		})
		await expect(f.store.delete(target.id)).rejects.toBe(failure)
		expect(seen.events.map(({ type, taskId }) => [type, taskId])).toEqual([
			['task.updated', blocker.id],
		])
		expect(graph(seen.live.values())).toEqual(graph(await f.store.list()))
		expect(await f.store.get(target.id)).toBeDefined()
		expect((await f.store.get(blocked.id))?.blockedBy).toEqual([target.id])
	})

	it('keeps both confirmed updates if unlinking the target fails', async () => {
		const f = await fixture('disk')
		const { blocker, target, blocked } = await chain(f)
		const seen = await observe(f.store)
		const targetPath = f.paths?.taskFile({ sessionId: f.sessionId }, target.id)
		const failure = Object.assign(new Error('Target unlink refused'), { code: 'EACCES' })
		const fs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
		vi.mocked(unlink).mockImplementation((path) =>
			path === targetPath ? Promise.reject(failure) : fs.unlink(path),
		)
		await expect(f.store.delete(target.id)).rejects.toBe(failure)
		expect(seen.events.map(({ type, taskId }) => [type, taskId])).toEqual([
			['task.updated', blocker.id],
			['task.updated', blocked.id],
		])
		expect(graph(seen.live.values())).toEqual(graph(await f.store.list()))
		expect(await f.store.get(target.id)).toBeDefined()
	})
})
