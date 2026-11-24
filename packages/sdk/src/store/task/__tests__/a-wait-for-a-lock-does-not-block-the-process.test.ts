import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { removeTempDir } from '../../../__fixtures__/temp-dir.js'
import { lockPathFor, withFileLock } from '../../../utils/file-lock.js'
import { generateSessionId, generateTurnId } from '../../../utils/id.js'
import { FileTaskStore } from '../file.js'

// A terminal and a team's teammates share one process. A change that has to wait for a lock another
// process holds waits without stopping the event loop, so the terminal keeps drawing and the other
// teammates keep running. Nothing here measures time: the wait yields once per try and the test says
// when the holder lets go.

const roots: string[] = []
afterEach(() => {
	for (const root of roots.splice(0)) removeTempDir(root)
})

const yieldOnce = () => new Promise<void>((resolve) => setImmediate(resolve))

it('waits for a held lock while the event loop keeps turning', async () => {
	const rootDir = mkdtempSync(join(tmpdir(), 'namzu-task-wait-'))
	roots.push(rootDir)
	const store = new FileTaskStore({ listId: 'team-a', rootDir, lockWait: yieldOnce })
	mkdirSync(store.directory, { recursive: true })
	let release!: () => void
	const gate = new Promise<void>((resolve) => {
		release = resolve
	})
	// Another holder of the list's lock, standing in for another process.
	const holding = withFileLock(lockPathFor(join(store.directory, '.list')), () => gate)
	let settled = false
	const creating = store
		.create({ sessionId: generateSessionId(), turnId: generateTurnId(), subject: 'waits' })
		.then((task) => {
			settled = true
			return task
		})
	// The loop is free: other work runs between the tries, and the change has not happened.
	let others = 0
	for (let i = 0; i < 5; i++) {
		await yieldOnce()
		others++
	}
	expect(others).toBe(5)
	expect(settled).toBe(false)
	release()
	await holding
	const task = await creating
	expect(task.subject).toBe('waits')
	expect((await store.list()).map((t) => t.subject)).toEqual(['waits'])
})

it('gives up with a plain refusal when the lock never frees', async () => {
	const rootDir = mkdtempSync(join(tmpdir(), 'namzu-task-wait-'))
	roots.push(rootDir)
	const store = new FileTaskStore({ listId: 'team-b', rootDir, lockWait: async () => undefined })
	mkdirSync(store.directory, { recursive: true })
	let release!: () => void
	const gate = new Promise<void>((resolve) => {
		release = resolve
	})
	const holding = withFileLock(lockPathFor(join(store.directory, '.list')), () => gate)
	await expect(
		store.create({ sessionId: generateSessionId(), turnId: generateTurnId(), subject: 'never' }),
	).rejects.toThrow(/in use by another process/)
	release()
	await holding
})
