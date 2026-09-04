import { existsSync, writeFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { removeTempDir } from '../../../__fixtures__/temp-dir.js'
import { findMappedConversation, openSessions, resolveConversation } from '../store.js'

const dirs: string[] = []

afterEach(() => {
	for (const path of dirs.splice(0)) removeTempDir(path)
})

async function temp(prefix: string): Promise<string> {
	const path = await mkdtemp(join(tmpdir(), prefix))
	dirs.push(path)
	return path
}

describe('central CLI state routing', () => {
	it('reopens one central Project without generating state inside the workspace', async () => {
		const cwd = await temp('namzu-central-workspace-')
		const stateRoot = await temp('namzu-central-home-')

		const first = await openSessions(cwd, { stateRoot })
		const later = await openSessions(cwd, { stateRoot })

		expect(later.projectId).toBe(first.projectId)
		expect(first.root).toBe(stateRoot)
		expect(first.projectStateRoot).toBe(join(stateRoot, 'projects', first.projectId))
		expect(first.controlRoot).toBe(join(first.projectStateRoot, 'cli'))
		expect(existsSync(join(cwd, '.namzu'))).toBe(false)
	})

	it('keeps two working directories in distinct Projects below one application home', async () => {
		const stateRoot = await temp('namzu-shared-home-')
		const first = await openSessions(await temp('namzu-workspace-a-'), { stateRoot })
		const second = await openSessions(await temp('namzu-workspace-b-'), { stateRoot })

		expect(first.projectId).not.toBe(second.projectId)
		expect(first.projectStateRoot).not.toBe(second.projectStateRoot)
	})

	it('refuses a corrupt desktop map without replacing it or minting an orphan conversation', async () => {
		const sessions = await openSessions(await temp('namzu-desktop-corrupt-workspace-'), {
			stateRoot: await temp('namzu-desktop-corrupt-home-'),
		})
		writeFileSync(join(sessions.controlRoot, 'desktop-sessions.json'), '{broken')
		const before = await sessions.store.listSessionsByTopic(sessions.topicId, sessions.tenantId)

		await expect(resolveConversation(sessions, 'window-a')).rejects.toThrow(
			/refusing to replace an existing desktop-session map/i,
		)

		const after = await sessions.store.listSessionsByTopic(sessions.topicId, sessions.tenantId)
		expect(after).toHaveLength(before.length)
	})

	it('keeps every desktop binding when independent callers publish concurrently', async () => {
		const sessions = await openSessions(await temp('namzu-desktop-race-workspace-'), {
			stateRoot: await temp('namzu-desktop-race-home-'),
		})
		const keys = Array.from({ length: 12 }, (_, index) => `window-${index}`)

		const ids = await Promise.all(keys.map((key) => resolveConversation(sessions, key)))
		const reopened = await Promise.all(keys.map((key) => findMappedConversation(sessions, key)))

		expect(new Set(ids).size).toBe(keys.length)
		expect(reopened).toEqual(ids)
		expect(existsSync(join(sessions.controlRoot, 'desktop-sessions.json.lock'))).toBe(false)
	})
})
