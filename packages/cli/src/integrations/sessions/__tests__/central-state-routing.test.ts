import {
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { asSessionId, createUserMessage } from '@namzu/sdk'
import { afterEach, describe, expect, it } from 'vitest'

import { recordTurn } from '../../../__fixtures__/session-log.js'
import { removeTempDir } from '../../../__fixtures__/temp-dir.js'
import {
	conversationLogPath,
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

describe('the conversation layout under NAMZU_HOME', () => {
	it('files a conversation as projects/<slug>/<session-id>.jsonl, never inside the workspace', async () => {
		const cwd = await temp('namzu-central-workspace-')
		const stateRoot = await temp('namzu-central-home-')

		const first = await openSessions(cwd, { stateRoot })
		const id = await startConversation(first)
		const later = await openSessions(cwd, { stateRoot })

		expect(later.projectId).toBe(first.projectId)
		expect(first.root).toBe(stateRoot)
		expect(first.slug.startsWith('-') || /^[A-Za-z]-/.test(first.slug)).toBe(true)
		const projectFile = join(stateRoot, 'projects', first.slug, 'project.json')
		expect(JSON.parse(readFileSync(projectFile, 'utf8'))).toMatchObject({
			v: 1,
			kind: 'project',
			projectId: first.projectId,
		})
		expect(conversationLogPath(first, id)).toBe(
			join(stateRoot, 'projects', first.slug, `${id}.jsonl`),
		)
		expect(existsSync(conversationLogPath(first, id))).toBe(true)
		expect(existsSync(join(cwd, '.namzu'))).toBe(false)
		for (const legacy of ['sessions', 'state', 'goals', 'cli']) {
			expect(existsSync(join(stateRoot, legacy)), legacy).toBe(false)
		}
	})

	it('keeps two working directories in distinct projects below one home', async () => {
		const stateRoot = await temp('namzu-shared-home-')
		const first = await openSessions(await temp('namzu-workspace-a-'), { stateRoot })
		const second = await openSessions(await temp('namzu-workspace-b-'), { stateRoot })

		expect(first.projectId).not.toBe(second.projectId)
		expect(first.slug).not.toBe(second.slug)
		expect(readdirSync(join(stateRoot, 'projects')).sort()).toEqual(
			[first.slug, second.slug].sort(),
		)
	})

	it('shares one checkout project and conversation from a package or symlink', async () => {
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
		await recordTurn(fromPackage, conversation, [message])
		const fromRoot = await openSessions(root, { stateRoot })
		const fromAlias = await openSessions(alias, { stateRoot })

		expect(fromRoot.projectId).toBe(fromPackage.projectId)
		expect(fromAlias.projectId).toBe(fromPackage.projectId)
		expect(fromRoot.topicId).toBe(fromPackage.topicId)
		expect(fromRoot.projectRoot).toBe(root)
		// `recordTurn` writes `message` under a fresh id without stamping it
		// back onto this object, the way the real turn recorder does.
		const [loadedMessage] = await loadConversation(fromRoot, conversation)
		expect(loadedMessage).toMatchObject(message)
		expect(existsSync(join(nested, '.namzu'))).toBe(false)
	})

	it('keeps nested repositories and worktrees in separate projects', async () => {
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
			expect(sessions.projectRoot).toBe(child)
		}
	})
})

describe('desktop session keys', () => {
	it('reopens a desktop key through the index, including after a rebuild', async () => {
		const workspace = await temp('namzu-desktop-workspace-')
		const stateRoot = await temp('namzu-desktop-home-')
		const sessions = await openSessions(workspace, { stateRoot })
		const id = await resolveConversation(sessions, 'window-a')
		const message = createUserMessage('Keep the exact conversation binding')
		await recordTurn(sessions, id, [message])
		sessions.index.close()

		const reopened = await openSessions(workspace, { stateRoot, indexBackend: 'scan' })
		expect(await findMappedConversation(reopened, 'window-a')).toBe(id)
		expect(await resolveConversation(reopened, 'window-a')).toBe(id)
		// `recordTurn` writes `message` under a fresh id without stamping it
		// back onto this object, the way the real turn recorder does.
		const [loadedMessage] = await loadResumableConversation(reopened, id)
		expect(loadedMessage).toMatchObject(message)
		expect(await reopened.index.listExternalRefs(id)).toEqual([
			expect.objectContaining({ protocol: 'desktop', kind: 'session', sessionId: id }),
		])
	})

	it('scopes a desktop key to its project', async () => {
		const stateRoot = await temp('namzu-desktop-scope-home-')
		const first = await openSessions(await temp('namzu-desktop-a-'), { stateRoot })
		const second = await openSessions(await temp('namzu-desktop-b-'), { stateRoot })

		const a = await resolveConversation(first, 'window')
		const b = await resolveConversation(second, 'window')

		expect(a).not.toBe(b)
		expect(await findMappedConversation(first, 'window')).toBe(a)
		expect(await findMappedConversation(second, 'window')).toBe(b)
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
	})

	it('refuses a second conversation under an id that already has a log', async () => {
		const sessions = await openSessions(await temp('namzu-duplicate-workspace-'), {
			stateRoot: await temp('namzu-duplicate-home-'),
		})
		const id = asSessionId('c9e2190e-7298-4132-a0d7-f7d1ebc2341b')
		await startConversation(sessions, id)

		await expect(startConversation(sessions, id)).rejects.toThrow(/already exists/i)
	})
})
