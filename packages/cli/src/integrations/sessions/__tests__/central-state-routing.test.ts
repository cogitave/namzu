import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DiskSessionStore, asSessionId, createUserMessage } from '@namzu/sdk'
import { afterEach, describe, expect, it } from 'vitest'

import { removeTempDir } from '../../../__fixtures__/temp-dir.js'
import { loadIdentity } from '../../state/identity.js'
import { inspectNamzuState } from '../../state/report.js'
import {
	appendMessages,
	findMappedConversation,
	loadConversation,
	loadResumableConversation,
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

	it('uses only the checkout root even when an older directory binding exists', async () => {
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

		expect(reopened.projectId).not.toBe(oldProject.id)
		expect(reopened.projectId).toBe(fromRoot.projectId)
		expect(reopened.topicId).toBe(original.topicId)
		expect(await loadConversation(reopened, id)).toEqual([message])
		const report = await inspectNamzuState({ cwd: nested, env: { NAMZU_HOME: stateRoot } })
		expect(report.projectBinding).toMatchObject({ status: 'bound', projectId: fromRoot.projectId })
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

	it.each([
		'{broken',
		JSON.stringify({ window: 'ses_retired-format' }),
		JSON.stringify({ window: 'ses_../escape' }),
		JSON.stringify({ window: 'ses_' }),
		JSON.stringify({ window: '8b48f83e-8461-48b2-a0f5-95f4cb' }),
	])('refuses a corrupt desktop map without minting an orphan: %s', async (contents) => {
		const sessions = await openSessions(await temp('namzu-desktop-corrupt-workspace-'), {
			stateRoot: await temp('namzu-desktop-corrupt-home-'),
		})
		const mapPath = join(sessions.controlRoot, 'desktop-sessions.json')
		writeFileSync(mapPath, contents)
		const before = await sessions.store.listSessionsByTopic(sessions.topicId, sessions.tenantId)

		await expect(resolveConversation(sessions, 'window-a')).rejects.toThrow(
			/refusing to replace.*map/i,
		)

		const after = await sessions.store.listSessionsByTopic(sessions.topicId, sessions.tenantId)
		expect(after).toHaveLength(before.length)
		expect(readFileSync(mapPath, 'utf8')).toBe(contents)
	})

	it('reopens desktop mappings and resumes transcripts for generated and legacy session ids', async () => {
		const workspace = await temp('namzu-desktop-mixed-workspace-')
		const stateRoot = await temp('namzu-desktop-mixed-home-')
		const sessions = await openSessions(workspace, { stateRoot })
		const generated = await startConversation(sessions)
		const legacy = await startConversation(
			sessions,
			asSessionId('c9e2190e-7298-4132-a0d7-f7d1ebc2341b'),
		)
		const message = createUserMessage('Keep the exact conversation binding')
		for (const id of [generated, legacy]) await appendMessages(sessions, id, [message])
		const mappings = { generated, legacy }
		writeFileSync(join(sessions.controlRoot, 'desktop-sessions.json'), JSON.stringify(mappings))

		const reopened = await openSessions(workspace, { stateRoot })
		for (const [key, id] of Object.entries(mappings)) {
			expect(await findMappedConversation(reopened, key)).toBe(id)
			expect(await resolveConversation(reopened, key)).toBe(id)
			expect(await loadResumableConversation(reopened, id)).toEqual([message])
		}
		expect(
			await reopened.store.listSessionsByTopic(reopened.topicId, reopened.tenantId),
		).toHaveLength(2)
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
