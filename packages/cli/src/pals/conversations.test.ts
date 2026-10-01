import { mkdirSync, mkdtempSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createUserMessage, generateSessionId } from '@namzu/sdk'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { recordTurn } from '../__fixtures__/session-log.js'
import { removeTempDir } from '../__fixtures__/temp-dir.js'
import {
	closeSessions,
	openSessions,
	setTitle,
	startConversation,
} from '../integrations/sessions/store.js'
import {
	claimPalConversation,
	listPalConversations,
	palConversationBinding,
} from './conversations.js'
import { createPal, palAtWorkspace, updatePal } from './store.js'

let root: string
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), 'namzu-pal-ownership-'))
	mkdirSync(join(root, '.git'))
	mkdirSync(join(root, 'state'))
	vi.stubEnv('NAMZU_HOME', join(root, 'state'))
})
afterEach(() => {
	vi.unstubAllEnvs()
	vi.useRealTimers()
	removeTempDir(root)
})
it('retains empty claimed conversations after reopening and pins the original revision', async () => {
	const pal = createPal({ name: 'Research', purpose: 'Original' })
	const id = generateSessionId()
	expect(await claimPalConversation(pal.workspace, pal.id, id)).toMatchObject({ revision: 1 })
	updatePal(pal.id, 1, { purpose: 'Changed' })
	expect(await claimPalConversation(pal.workspace, pal.id, id)).toMatchObject({ revision: 1 })
	expect((await palConversationBinding(pal.workspace, id))?.definition.purpose).toBe('Original')
	const state = await openSessions(pal.workspace)
	expect(state.projectRoot).toBe(pal.workspace)
	closeSessions(state)
	expect(await listPalConversations(pal.workspace, pal.id)).toEqual([
		expect.objectContaining({ id, hasPrompted: false, named: false, count: 0 }),
	])
})
it('creates a new route at an explicit prior revision and refuses another revision on that root', async () => {
	const pal = createPal({ name: 'Pinned', purpose: 'Original route purpose.' })
	updatePal(pal.id, 1, { purpose: 'Current route purpose.' })
	const id = generateSessionId()
	expect(await claimPalConversation(pal.workspace, pal.id, id, 1)).toMatchObject({ revision: 1 })
	expect((await palConversationBinding(pal.workspace, id))?.definition.purpose).toBe(
		'Original route purpose.',
	)
	await expect(claimPalConversation(pal.workspace, pal.id, id, 2)).rejects.toThrow(
		'another Pal profile revision',
	)
	expect((await palConversationBinding(pal.workspace, id))?.definition.revision).toBe(1)
})
it('refuses ordinary logs, a foreign Pal and new claims while paused', async () => {
	const one = createPal({ name: 'One' })
	const two = createPal({ name: 'Two' })
	const state = await openSessions(one.workspace)
	const ordinary = await startConversation(state)
	closeSessions(state)
	await expect(claimPalConversation(one.workspace, one.id, ordinary)).rejects.toThrow('not claimed')
	const id = generateSessionId()
	await claimPalConversation(one.workspace, one.id, id)
	await expect(palConversationBinding(two.workspace, id)).rejects.toThrow('not claimed')
	await expect(claimPalConversation(one.workspace, two.id, id)).rejects.toThrow('does not own')
	updatePal(one.id, 1, { paused: true })
	await expect(claimPalConversation(one.workspace, one.id, generateSessionId())).rejects.toThrow(
		'paused',
	)
	expect((await palConversationBinding(one.workspace, id))?.pal.paused).toBe(true)
})
it('filters ownership before applying the recent-conversation cap', async () => {
	const pal = createPal({ name: 'Research' })
	vi.useFakeTimers({ toFake: ['Date'] })
	vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
	const id = generateSessionId()
	await claimPalConversation(pal.workspace, pal.id, id)
	const state = await openSessions(pal.workspace)
	try {
		await recordTurn(state, id, [createUserMessage('Read primary sources')])
		await setTitle(state, id, 'Named research')
		vi.setSystemTime(new Date('2026-01-02T00:00:00Z'))
		for (let index = 0; index < 101; index++) await startConversation(state)
	} finally {
		closeSessions(state)
	}
	expect(await listPalConversations(pal.workspace, pal.id)).toEqual([
		expect.objectContaining({
			id,
			title: 'Named research',
			named: true,
			count: 1,
			hasPrompted: true,
		}),
	])
})
it('ordinary absent directories are not Pal workspaces', () => {
	expect(palAtWorkspace(join(root, 'ordinary-absent'))).toBeNull()
})
it.skipIf(process.platform === 'win32')('rejects symlink aliases instead of trusting them', () => {
	const pal = createPal({ name: 'Owned' })
	const alias = join(root, 'alias')
	symlinkSync(pal.workspace, alias)
	expect(() => palAtWorkspace(alias)).toThrow('alias')
})

it('rejects reserved-root descendants and aliases before host or provider initialization', async () => {
	const pal = createPal({ name: 'Owned' })
	const child = join(pal.workspace, 'child')
	mkdirSync(child)
	const { ProviderRegistry } = await import('@namzu/sdk')
	const construct = vi.spyOn(ProviderRegistry, 'create')
	const { createAgentSession } = await import('../tui/agent.js')
	const preferences = { version: 3, providers: [{ id: 'openai' as const }] } as const
	for (const cwd of [pal.workspace, child, join(child, 'missing')]) {
		await expect(createAgentSession(preferences, [], { cwd })).rejects.toThrow()
	}
	expect(construct).not.toHaveBeenCalled()
	expect(palAtWorkspace(pal.workspace)?.id).toBe(pal.id)
	expect(() => palAtWorkspace(join(root, 'state-workspaces', 'pals'))).toThrow('Reserved Pal')
	expect(() => palAtWorkspace(child)).toThrow('Reserved Pal')
	if (process.platform !== 'win32') {
		const alias = join(root, 'aliased-child')
		symlinkSync(child, alias)
		await expect(createAgentSession(preferences, [], { cwd: alias })).rejects.toThrow('alias')
	}
	expect(construct).not.toHaveBeenCalled()
	construct.mockRestore()
})
