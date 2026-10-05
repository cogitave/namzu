import { mkdtemp, rename, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import { SessionPaths } from '../../../session/paths.js'
import { generateSessionId, generateTurnId } from '../../../utils/id.js'
import { DiskTaskStore } from '../disk.js'

const dirs: string[] = []
afterEach(async () => {
	await removeTempDirs(dirs)
	dirs.length = 0
})
async function fixture() {
	const home = await mkdtemp(join(tmpdir(), 'namzu-strict-tasks-'))
	dirs.push(home)
	const paths = new SessionPaths({ home, slug: '-work' })
	const sessionId = generateSessionId()
	const turnId = generateTurnId()
	const store = new DiskTaskStore({ paths, session: { sessionId } })
	return { paths, sessionId, turnId, store }
}
it('accepts a legitimate empty session and a complete list opened later', async () => {
	const { paths, sessionId, turnId, store } = await fixture()
	expect(await store.listStrict()).toEqual([])
	const task = await store.create({ sessionId, turnId, subject: 'Still pending' })
	expect(await new DiskTaskStore({ paths, session: { sessionId } }).listStrict()).toMatchObject([
		{ id: task.id, subject: task.subject, status: 'pending' },
	])
})
it('rejects corrupt records without changing the existing tolerant-list policy', async () => {
	const { paths, sessionId, turnId, store } = await fixture()
	const valid = await store.create({ sessionId, turnId, subject: 'Valid item' })
	const broken = await store.create({ sessionId, turnId, subject: 'Unreadable item' })
	await writeFile(paths.taskFile({ sessionId }, broken.id), '{broken json')
	expect((await store.list()).map((task) => task.id)).toEqual([valid.id])
	await expect(store.listStrict()).rejects.toThrow()
})
it('rejects an invalid directory rather than replacing the projection with an empty list', async () => {
	const { paths, sessionId, turnId, store } = await fixture()
	const task = await store.create({ sessionId, turnId, subject: 'Tracked work' })
	// A directory occupied by a file is a deterministic scan failure on both
	// Windows and POSIX, without relying on host permission privileges.
	const dir = paths.tasks({ sessionId })
	await rename(dir, `${dir}.saved`)
	await writeFile(dir, 'not a directory')
	await expect(store.listStrict()).rejects.toThrow()
	expect(task.status).toBe('pending')
})
