import { existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DiskSessionStore, createUserMessage } from '@namzu/sdk'
import { afterEach, describe, expect, it } from 'vitest'

import { removeTempDir } from '../../../__fixtures__/temp-dir.js'
import { loadIdentity } from '../../state/identity.js'
import { inspectNamzuState } from '../../state/report.js'
import {
	appendMessages,
	findMappedConversation,
	loadConversation,
	openSessions,
	resolveConversation,
	startConversation,
} from '../store.js'

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

	it('shares one checkout Project, topic and conversation from a package or symlink', async () => {
		const root = await temp('namzu-checkout-')
		const stateRoot = await temp('namzu-checkout-home-')
		const nested = join(root, 'packages', 'cli')
		mkdirSync(join(root, '.git'))
		mkdirSync(nested, { recursive: true })
		const alias = join(await temp('namzu-checkout-alias-'), 'package')
		symlinkSync(nested, alias, process.platform === 'win32' ? 'junction' : 'dir')

		const fromPackage = await openSessions(nested, { stateRoot })
		const conversation = await startConversation(fromPackage)
		const message = createUserMessage('Keep this checkout history together')
		await appendMessages(fromPackage, conversation, [message])
		const fromRoot = await openSessions(root, { stateRoot })
		const fromAlias = await openSessions(alias, { stateRoot })

		expect(fromRoot.projectId).toBe(fromPackage.projectId)
		expect(fromAlias.projectId).toBe(fromPackage.projectId)
		expect(fromRoot.topicId).toBe(fromPackage.topicId)
		expect(await loadConversation(fromRoot, conversation)).toEqual([message])
		expect(await fromRoot.store.getProject(fromRoot.projectId, fromRoot.tenantId)).toMatchObject({
			rootPath: root,
			name: root.split(/[\\/]/).at(-1),
		})
		const report = await inspectNamzuState({ cwd: nested, env: { NAMZU_HOME: stateRoot } })
		expect(report.projectBinding).toMatchObject({ status: 'bound', projectId: fromRoot.projectId })
		expect(existsSync(join(nested, '.namzu'))).toBe(false)
	})

	it('preserves a previous exact-directory binding when the checkout also has history', async () => {
		const root = await temp('namzu-existing-checkout-')
		const stateRoot = await temp('namzu-existing-home-')
		const nested = join(root, 'packages', 'cli')
		mkdirSync(join(root, '.git'))
		mkdirSync(nested, { recursive: true })
		const tenantId = loadIdentity(stateRoot).tenantId
		const oldProject = await new DiskSessionStore({ rootDir: stateRoot }).createProject(
			{ tenantId, name: 'old package binding', rootPath: nested },
			tenantId,
		)
		const original = await openSessions(nested, { stateRoot })
		const id = await startConversation(original)
		const message = createUserMessage('Existing package conversation')
		await appendMessages(original, id, [message])
		const fromRoot = await openSessions(root, { stateRoot })
		const reopened = await openSessions(nested, { stateRoot })

		expect(reopened.projectId).toBe(oldProject.id)
		expect(reopened.projectId).not.toBe(fromRoot.projectId)
		expect(reopened.topicId).toBe(original.topicId)
		expect(await loadConversation(reopened, id)).toEqual([message])
		const report = await inspectNamzuState({ cwd: nested, env: { NAMZU_HOME: stateRoot } })
		expect(report.projectBinding).toMatchObject({ status: 'bound', projectId: oldProject.id })
	})

	it('keeps nested repositories and worktrees in separate Projects', async () => {
		const root = await temp('namzu-checkout-boundaries-')
		const stateRoot = await temp('namzu-boundaries-home-')
		mkdirSync(join(root, '.git'))
		const parent = await openSessions(root, { stateRoot })
		for (const kind of ['repository', 'worktree']) {
			const child = join(root, kind)
			const nested = join(child, 'src')
			mkdirSync(nested, { recursive: true })
			if (kind === 'repository') mkdirSync(join(child, '.git'))
			else writeFileSync(join(child, '.git'), 'gitdir: ../.git/worktrees/child\n')
			const sessions = await openSessions(nested, { stateRoot })
			expect(sessions.projectId).not.toBe(parent.projectId)
			expect(await sessions.store.getProject(sessions.projectId, sessions.tenantId)).toMatchObject({
				rootPath: child,
			})
		}
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
