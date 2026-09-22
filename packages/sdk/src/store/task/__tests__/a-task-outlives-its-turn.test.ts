import { mkdtemp, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { removeTempDirAsync } from '../../../__fixtures__/temp-dir.js'

import { SessionPaths } from '../../../session/paths.js'
import type { SessionId, TurnId } from '../../../types/ids/index.js'
import type { Task } from '../../../types/task/index.js'
import { generateSessionId, generateTurnId } from '../../../utils/id.js'
import { selectTaskContext } from '../context.js'
import { DiskTaskStore, TaskSessionMismatchError } from '../disk.js'
import { InMemoryTaskStore } from '../memory.js'

/**
 * The task list is durable per session (spec §1.1 decision 8): a task lives
 * at `<session-id>/tasks/<task-id>.json`, records the turn that created it,
 * and is still there for the next turn and the next process.
 *
 * It replaces "a task created under a different run than the store default":
 * a store now keeps exactly one session's directory, so there is no second
 * key a lookup could miss under.
 */

describe('a task outlives the turn and the process that created it', () => {
	let home: string
	let paths: SessionPaths
	let sessionId: SessionId
	let first: TurnId
	let second: TurnId

	beforeEach(async () => {
		home = await mkdtemp(join(tmpdir(), 'namzu-tasks-'))
		paths = new SessionPaths({ home, slug: '-work' })
		sessionId = generateSessionId()
		first = generateTurnId()
		second = generateTurnId()
	})

	afterEach(async () => {
		await removeTempDirAsync(home)
	})

	const open = () => new DiskTaskStore({ paths, session: { sessionId } })

	it('is written under the session, naming its creating turn', async () => {
		const task = await open().create({ sessionId, turnId: first, subject: 'ship it' })

		expect(await readdir(paths.tasks({ sessionId }))).toEqual([`${task.id}.json`])
		expect(task).toMatchObject({ sessionId, turnId: first, status: 'pending' })
	})

	it('is found, updated, claimed and deleted by a store opened later', async () => {
		const a = await open().create({ sessionId, turnId: first, subject: 'a' })
		const b = await open().create({ sessionId, turnId: first, subject: 'b' })

		expect(await open().get(a.id)).toMatchObject({ id: a.id, turnId: first })
		expect(await open().update(a.id, { status: 'in_progress' })).toMatchObject({
			status: 'in_progress',
		})
		expect(await open().claim(b.id, 'worker')).toMatchObject({ owner: 'worker' })
		expect((await open().list()).map((t) => t.id)).toEqual([a.id, b.id])
		expect(await open().delete(a.id)).toBe(true)
		expect(await open().get(a.id)).toBeUndefined()
	})

	it('keeps a child session in its own directory under the parent', async () => {
		const child = generateSessionId()
		const store = new DiskTaskStore({
			paths,
			session: { sessionId: child, ancestors: [sessionId] },
		})
		const task = await store.create({ sessionId: child, turnId: first, subject: 'nested' })

		expect(await readdir(paths.tasks({ sessionId: child, ancestors: [sessionId] }))).toEqual([
			`${task.id}.json`,
		])
		expect(await open().list()).toEqual([])
	})

	it('refuses a task for another session instead of filing it here', async () => {
		const other = generateSessionId()
		await expect(open().create({ sessionId: other, turnId: first, subject: 'x' })).rejects.toThrow(
			TaskSessionMismatchError,
		)
		expect(await open().list({ sessionId: other })).toEqual([])
	})

	it('is still not found when it genuinely does not exist', async () => {
		expect(await open().get('cba0e01f-b5a4-4b3a-9895-8beeaf637aa8' as never)).toBeUndefined()
	})

	it.each([
		['on disk', () => open()],
		['in memory', () => new InMemoryTaskStore()],
	] as const)('stamps the closing time on a failure too (%s)', async (_name, build) => {
		const store = build()
		const task = await store.create({ sessionId, turnId: first, subject: 'x' })
		const failed = await store.update(task.id, { status: 'failed' })
		expect(failed?.completedAt).toBeTypeOf('number')
	})

	it('shows the next turn its open tasks and none it closed before', async () => {
		const store = open()
		const open1 = await store.create({ sessionId, turnId: first, subject: 'still open' })
		const done1 = await store.create({ sessionId, turnId: first, subject: 'done in turn 1' })
		const closeLater = await store.create({ sessionId, turnId: first, subject: 'closed in 2' })
		await store.update(done1.id, { status: 'completed' })

		const secondStartedAt = Date.now() + 1
		await new Promise((resolve) => setTimeout(resolve, 5))
		const reopened = open()
		await reopened.update(closeLater.id, { status: 'completed' })
		const new2 = await reopened.create({ sessionId, turnId: second, subject: 'new in 2' })
		await reopened.update(new2.id, { status: 'failed' })

		const shown = selectTaskContext(await reopened.list(), {
			turnId: second,
			turnStartedAt: secondStartedAt,
		})
		expect(shown.map((t: Task) => t.subject)).toEqual(['still open', 'closed in 2', 'new in 2'])
		expect(shown.some((t) => t.id === open1.id)).toBe(true)
	})
})
