import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { removeTempDir } from '../../../__fixtures__/temp-dir.js'
import { buildTaskTools } from '../../../tools/task/index.js'
import { asTaskId, generateSessionId, generateTurnId } from '../../../utils/id.js'
import { FileTaskStore, TaskListError, isClaimableTaskStore } from '../file.js'

const roots: string[] = []
afterEach(() => {
	for (const root of roots.splice(0)) removeTempDir(root)
})

const sessionId = generateSessionId()
const turnId = generateTurnId()

function open(listId = 'team-a') {
	const rootDir = mkdtempSync(join(tmpdir(), 'namzu-file-tasks-'))
	roots.push(rootDir)
	return { rootDir, store: new FileTaskStore({ listId, rootDir, sleep: () => undefined }) }
}

const make = (store: FileTaskStore, subject: string, blockedBy?: string[]) =>
	store.create({
		sessionId,
		turnId,
		subject,
		blockedBy: blockedBy?.map(asTaskId),
	})

describe('FileTaskStore', () => {
	it('keeps one JSON file per task and lists them in the order they were made', async () => {
		const { store } = open()
		const a = await make(store, 'one')
		const b = await make(store, 'two')
		expect((await store.list()).map((t) => t.id)).toEqual([a.id, b.id])
		expect(
			readdirSync(store.directory)
				.filter((n) => n.endsWith('.json'))
				.sort(),
		).toEqual([`${a.id}.json`, `${b.id}.json`].sort())
		expect(isClaimableTaskStore(store)).toBe(true)
	})

	it('refuses a list id that could leave its directory', () => {
		expect(() => new FileTaskStore({ listId: '../x', rootDir: tmpdir() })).toThrow(TaskListError)
		expect(() => new FileTaskStore({ listId: 'a/b', rootDir: tmpdir() })).toThrow(TaskListError)
	})

	it('never reuses a place, even after the task is deleted or the mark is lost', async () => {
		const { store } = open()
		const a = await make(store, 'one')
		const b = await make(store, 'two')
		await store.delete(b.id)
		await store.delete(a.id)
		const mark = join(store.directory, '.highwatermark')
		expect(readFileSync(mark, 'utf8').trim()).toBe('2')
		const c = await make(store, 'three')
		expect(readFileSync(mark, 'utf8').trim()).toBe('3')
		// A mark that is lost is raised again from what is on disk.
		writeFileSync(mark, 'junk')
		const d = await make(store, 'four')
		expect(readFileSync(mark, 'utf8').trim()).toBe('4')
		expect((await store.list()).map((t) => t.id)).toEqual([c.id, d.id])
	})

	describe('claim', () => {
		it('gives a pending task to one owner and refuses the second', async () => {
			const { store } = open()
			const t = await make(store, 'one')
			const first = await store.claimTask(t.id, 'ann')
			expect(first.ok && first.task.status).toBe('in_progress')
			expect(first.ok && first.task.owner).toBe('ann')
			const second = await store.claimTask(t.id, 'bob')
			expect(second).toMatchObject({ ok: false, code: 'already_claimed' })
			// The owner claiming again changes nothing.
			expect(await store.claimTask(t.id, 'ann')).toMatchObject({ ok: true })
		})

		it('says not_found and already_resolved', async () => {
			const { store } = open()
			expect(await store.claimTask(asTaskId('01900000-0000-7000-8000-000000000000'), 'a')).toEqual({
				ok: false,
				code: 'not_found',
			})
			const t = await make(store, 'one')
			await store.claimTask(t.id, 'ann')
			await store.update(t.id, { status: 'completed' })
			expect(await store.claimTask(t.id, 'ann')).toMatchObject({
				ok: false,
				code: 'already_resolved',
			})
		})

		it('refuses a blocked task until its blocker is completed, with no write needed to unblock', async () => {
			const { store } = open()
			const a = await make(store, 'first')
			const b = await make(store, 'second', [a.id])
			expect((await store.get(a.id))?.blocks).toEqual([b.id])
			const refused = await store.claimTask(b.id, 'bob')
			expect(refused).toMatchObject({ ok: false, code: 'blocked', blockedBy: [a.id] })
			expect((await store.nextClaimable())?.id).toBe(a.id)

			await store.claimTask(a.id, 'ann')
			// In progress still blocks.
			expect(await store.claimTask(b.id, 'bob')).toMatchObject({ ok: false, code: 'blocked' })
			await store.update(a.id, { status: 'completed' })
			expect(await store.claimTask(b.id, 'bob')).toMatchObject({ ok: true })
		})

		it('a failed blocker keeps its dependent waiting', async () => {
			const { store } = open()
			const a = await make(store, 'first')
			const b = await make(store, 'second', [a.id])
			await store.claimTask(a.id, 'ann')
			await store.update(a.id, { status: 'failed' })
			expect(await store.claimTask(b.id, 'bob')).toMatchObject({ ok: false, code: 'blocked' })
		})

		it('nextClaimable is the lowest pending unowned unblocked task', async () => {
			const { store } = open()
			const a = await make(store, 'a')
			const b = await make(store, 'b')
			const c = await make(store, 'c')
			await store.claimTask(a.id, 'ann')
			expect((await store.nextClaimable())?.id).toBe(b.id)
			await store.update(b.id, { owner: 'zed' })
			expect((await store.nextClaimable())?.id).toBe(c.id)
		})
	})

	describe('dependencies', () => {
		it('keeps both directions and ignores a repeated edge', async () => {
			const { store } = open()
			const a = await make(store, 'a')
			const b = await make(store, 'b')
			await store.block(a.id, b.id)
			await store.block(a.id, b.id)
			expect((await store.get(a.id))?.blocks).toEqual([b.id])
			expect((await store.get(b.id))?.blockedBy).toEqual([a.id])
		})

		it('refuses a cycle, direct or through other tasks, and a self edge', async () => {
			const { store } = open()
			const a = await make(store, 'a')
			const b = await make(store, 'b')
			const c = await make(store, 'c')
			await store.block(a.id, b.id)
			await store.block(b.id, c.id)
			await expect(store.block(b.id, a.id)).rejects.toMatchObject({ code: 'cycle' })
			await expect(store.block(c.id, a.id)).rejects.toMatchObject({ code: 'cycle' })
			await expect(store.block(a.id, a.id)).rejects.toMatchObject({ code: 'cycle' })
			expect((await store.get(a.id))?.blockedBy).toEqual([])
		})

		it('refuses an edge to a task that is not there', async () => {
			const { store } = open()
			const a = await make(store, 'a')
			await expect(
				store.block(a.id, asTaskId('01900000-0000-7000-8000-000000000000')),
			).rejects.toMatchObject({ code: 'not_found' })
		})

		it('deleting a task removes its edges from both neighbours', async () => {
			const { store } = open()
			const a = await make(store, 'a')
			const b = await make(store, 'b', [a.id])
			expect(await store.delete(a.id)).toBe(true)
			expect((await store.get(b.id))?.blockedBy).toEqual([])
			expect(await store.claimTask(b.id, 'bob')).toMatchObject({ ok: true })
			expect(await store.delete(a.id)).toBe(false)
		})
	})

	it('reset empties the list only when every task is completed', async () => {
		const { store } = open()
		const a = await make(store, 'a')
		const b = await make(store, 'b')
		await store.claimTask(a.id, 'ann')
		await store.update(a.id, { status: 'completed' })
		await expect(store.reset()).rejects.toMatchObject({ code: 'not_all_completed' })
		expect(await store.list()).toHaveLength(2)
		await store.claimTask(b.id, 'ann')
		await store.update(b.id, { status: 'completed' })
		await store.reset()
		expect(await store.list()).toEqual([])
		expect((await make(store, 'next')).id).not.toBe(a.id)
		expect(readFileSync(join(store.directory, '.highwatermark'), 'utf8').trim()).toBe('3')
	})

	it('emits created, claimed, updated and deleted to listeners of this process', async () => {
		const { store } = open()
		const seen: string[] = []
		store.on((e) => seen.push(e.type))
		const t = await make(store, 'one')
		await store.claimTask(t.id, 'ann')
		await store.update(t.id, { status: 'completed' })
		await store.delete(t.id)
		expect(seen).toEqual(['task.created', 'task.claimed', 'task.updated', 'task.deleted'])
	})

	it('takes over a lock left by a process that exited', async () => {
		const { store } = open()
		const t = await make(store, 'one')
		// A pid far above any real one: the owner is gone.
		writeFileSync(join(store.directory, `${t.id}.json.lock`), `2147483646:${Date.now()}:dead`)
		expect(await store.claimTask(t.id, 'ann')).toMatchObject({ ok: true })
	})

	describe('the task tools on a shared list', () => {
		function tools(store: FileTaskStore, member?: string) {
			const map = new Map(
				buildTaskTools(store, { sessionId, turnId, member }).map((t) => [t.name, t]),
			)
			const run = (name: string, input: unknown) => {
				const tool = map.get(name)
				if (!tool) throw new Error(`no tool ${name}`)
				return tool.execute(tool.inputSchema.parse(input), {} as never)
			}
			return { map, run }
		}

		it('adds task_get only for a shared list', () => {
			const { store } = open()
			expect(tools(store).map.has('task_get')).toBe(true)
		})

		it('task_update to in_progress claims under the member name and reports why a claim fails', async () => {
			const { store } = open()
			const t = await make(store, 'one')
			const blocked = await make(store, 'two', [t.id])
			const ann = tools(store, 'ann')
			const bob = tools(store, 'bob')

			expect(await ann.run('task_update', { id: t.id, status: 'in_progress' })).toMatchObject({
				success: true,
			})
			expect((await store.get(t.id))?.owner).toBe('ann')
			const taken = await bob.run('task_update', { id: t.id, status: 'in_progress' })
			expect(taken).toMatchObject({ success: false, data: { code: 'already_claimed' } })
			expect(taken.output).toContain('ann')
			const waiting = await bob.run('task_update', { id: blocked.id, status: 'in_progress' })
			expect(waiting).toMatchObject({ success: false, data: { code: 'blocked' } })

			await ann.run('task_update', { id: t.id, status: 'completed' })
			expect(await bob.run('task_update', { id: blocked.id, status: 'in_progress' })).toMatchObject(
				{
					success: true,
				},
			)
		})

		it('task_update reports a cycle as a refusal and task_get shows what a task waits on', async () => {
			const { store } = open()
			const a = await make(store, 'a')
			const b = await make(store, 'b', [a.id])
			const { run } = tools(store, 'ann')
			const refused = await run('task_update', { id: a.id, addBlockedBy: [b.id] })
			expect(refused).toMatchObject({ success: false })
			expect(refused.output).toMatch(/wait on each other/)
			const got = await run('task_get', { id: b.id })
			expect(got).toMatchObject({ success: true, data: { waitingOn: [a.id], owner: null } })
		})

		it('task_list shows every task of the list, including ones closed in other turns', async () => {
			const { store } = open()
			const a = await make(store, 'a')
			await store.claimTask(a.id, 'ann')
			await store.update(a.id, { status: 'completed' })
			const { run } = tools(store, 'bob')
			const listed = await run('task_list', {})
			expect(listed.data).toMatchObject({ stats: { total: 1, completed: 1 } })
		})
	})
})
