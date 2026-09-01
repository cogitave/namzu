import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { DiskSessionStore, UNKNOWN_TENANT_ID } from '@namzu/sdk'

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

async function seedLegacyProject(cwd: string, rootPath?: string): Promise<string> {
	const root = join(cwd, '.namzu')
	mkdirSync(root, { recursive: true })
	const store = new DiskSessionStore({ rootDir: root })
	const project = await store.createProject(
		{
			tenantId: UNKNOWN_TENANT_ID,
			name: 'legacy CLI project',
			...(rootPath === undefined ? {} : { rootPath }),
		},
		UNKNOWN_TENANT_ID,
	)
	writeFileSync(join(root, 'cli.json'), `${JSON.stringify({ projectId: project.id })}\n`)
	return project.id
}

describe('central CLI state routing', () => {
	it('reopens one central Project without generating state inside the workspace', async () => {
		const cwd = await temp('namzu-central-workspace-')
		const stateRoot = await temp('namzu-central-home-')

		const first = await openSessions(cwd, { stateRoot })
		const later = await openSessions(cwd, { stateRoot })

		expect(first.backend).toBe('central')
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

	it('recognizes authored local inputs without classifying them as legacy generated state', async () => {
		const cwd = await temp('namzu-authored-workspace-')
		const stateRoot = await temp('namzu-authored-home-')
		const commands = join(cwd, '.namzu', 'commands')
		mkdirSync(commands, { recursive: true })
		writeFileSync(join(commands, 'review.md'), 'Review the current change.\n')

		const sessions = await openSessions(cwd, { stateRoot })

		expect(sessions.backend).toBe('central')
		expect(readdirSync(join(cwd, '.namzu'))).toEqual(['commands'])
		expect(existsSync(join(cwd, '.namzu', 'projects'))).toBe(false)
	})

	it('keeps a valid legacy Project authoritative without mutating the central home', async () => {
		const cwd = await temp('namzu-legacy-workspace-')
		const stateRoot = await temp('namzu-unused-central-home-')
		const projectId = await seedLegacyProject(cwd)

		const sessions = await openSessions(cwd, { stateRoot })

		expect(sessions.backend).toBe('legacy')
		expect(sessions.root).toBe(join(cwd, '.namzu'))
		expect(sessions.projectId).toBe(projectId)
		expect(readdirSync(stateRoot)).toEqual([])
	})

	it('still recognizes a legacy pointer when the workspace-local root is the application home', async () => {
		const cwd = await temp('namzu-overlap-workspace-')
		const stateRoot = join(cwd, '.namzu')
		const projectId = await seedLegacyProject(cwd)

		const sessions = await openSessions(cwd, { stateRoot })

		expect(sessions.backend).toBe('legacy')
		expect(sessions.root).toBe(stateRoot)
		expect(sessions.projectId).toBe(projectId)
	})

	it('allows an application-home overlap with ordinary state and no legacy pointer', async () => {
		const cwd = await temp('namzu-overlap-central-')
		const stateRoot = join(cwd, '.namzu')
		mkdirSync(stateRoot, { recursive: true })
		writeFileSync(join(stateRoot, 'preferences.json'), '{}\n')

		const sessions = await openSessions(cwd, { stateRoot })

		expect(sessions.backend).toBe('central')
		expect(sessions.root).toBe(stateRoot)
		expect(existsSync(join(stateRoot, 'projects', sessions.projectId, 'project.json'))).toBe(true)
	})

	it('refuses a malformed legacy pointer even when the two roots overlap', async () => {
		const cwd = await temp('namzu-overlap-corrupt-')
		const stateRoot = join(cwd, '.namzu')
		mkdirSync(stateRoot, { recursive: true })
		writeFileSync(join(stateRoot, 'cli.json'), '{broken')

		await expect(openSessions(cwd, { stateRoot })).rejects.toThrow(/not valid JSON/i)
		expect(existsSync(join(stateRoot, 'projects'))).toBe(false)
	})

	it('refuses split legacy and central histories for the same workspace', async () => {
		const cwd = await temp('namzu-split-workspace-')
		const stateRoot = await temp('namzu-split-home-')
		await openSessions(cwd, { stateRoot })
		await seedLegacyProject(cwd)

		await expect(openSessions(cwd, { stateRoot })).rejects.toThrow(/split histories/i)
	})

	it('refuses a legacy pointer whose Project declares a different workspace root', async () => {
		const cwd = await temp('namzu-misdirected-workspace-')
		const other = await temp('namzu-actual-workspace-')
		const stateRoot = await temp('namzu-misdirected-home-')
		await seedLegacyProject(cwd, other)

		await expect(openSessions(cwd, { stateRoot })).rejects.toThrow(/bound to .* instead of/i)
		expect(readdirSync(stateRoot)).toEqual([])
	})

	it('refuses unknown local generated state without creating a central Project', async () => {
		const cwd = await temp('namzu-unknown-workspace-')
		const stateRoot = await temp('namzu-unknown-home-')
		mkdirSync(join(cwd, '.namzu'), { recursive: true })
		writeFileSync(join(cwd, '.namzu', 'orphan.json'), '{}\n')

		await expect(openSessions(cwd, { stateRoot })).rejects.toThrow(/no cli\.json binding/i)
		expect(readdirSync(stateRoot)).toEqual([])
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
