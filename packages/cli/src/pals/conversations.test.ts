import { appendFileSync, mkdirSync, mkdtempSync, renameSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
	ScanSessionIndex,
	type SessionIndex,
	SqliteSessionIndex,
	createUserMessage,
	generateProjectId,
	generateSessionId,
	generateTenantId,
} from '@namzu/sdk'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { recordTurn } from '../__fixtures__/session-log.js'
import { removeTempDir } from '../__fixtures__/temp-dir.js'
import {
	archiveConversation,
	closeSessions,
	conversationLogPath,
	loadConversation,
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
	vi.restoreAllMocks()
	vi.unstubAllEnvs()
	vi.useRealTimers()
	removeTempDir(root)
})

/** Keep actual SDK index rows, then change their backing state before membership reads. */
function afterCandidateSnapshot(mutate: () => void | Promise<void>): void {
	let mutated = false
	for (const prototype of [ScanSessionIndex.prototype, SqliteSessionIndex.prototype]) {
		const original = prototype.listSessions
		vi.spyOn(prototype, 'listSessions').mockImplementation(async function (
			this: SessionIndex,
			options,
		) {
			const rows = await original.call(this, options)
			if (!mutated) {
				mutated = true
				await mutate()
			}
			return rows
		})
	}
}
it('retains empty claimed conversations after reopening and pins the original revision', async () => {
	const pal = createPal({ name: 'Research', purpose: 'Original' })
	const id = generateSessionId()
	const first = await claimPalConversation(pal.workspace, pal.id, id)
	expect(first).toMatchObject({ revision: 1 })
	expect(first.palGreeting.text).toContain("I'm Research.")
	updatePal(pal.id, 1, { purpose: 'Changed', name: 'Renamed' })
	const reopened = await claimPalConversation(pal.workspace, pal.id, id)
	expect(reopened).toMatchObject({ revision: 1, palGreeting: first.palGreeting })
	expect((await palConversationBinding(pal.workspace, id))?.definition.purpose).toBe('Original')
	const state = await openSessions(pal.workspace)
	expect(state.projectRoot).toBe(pal.workspace)
	expect(await loadConversation(state, id)).toEqual([])
	closeSessions(state)
	expect(await listPalConversations(pal.workspace, pal.id)).toEqual([
		expect.objectContaining({
			id,
			hasPrompted: false,
			named: false,
			count: 0,
			palGreeting: first.palGreeting,
		}),
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
		expect(await state.index.listSessions({ slug: state.slug, rootsOnly: true })).toHaveLength(102)
	} finally {
		closeSessions(state)
	}
	const scanLoad = vi.spyOn(ScanSessionIndex, 'load')
	const sqliteOpen = vi.spyOn(SqliteSessionIndex, 'open')
	const scanSync = vi.spyOn(ScanSessionIndex.prototype, 'sync')
	const sqliteSync = vi.spyOn(SqliteSessionIndex.prototype, 'sync')
	expect(await listPalConversations(pal.workspace, pal.id)).toEqual([
		expect.objectContaining({
			id,
			title: 'Named research',
			named: true,
			count: 1,
			hasPrompted: true,
		}),
	])
	expect(scanLoad.mock.calls.length + sqliteOpen.mock.calls.length).toBe(1)
	expect(scanSync.mock.calls.length + sqliteSync.mock.calls.length).toBe(1)
})

it('rejects actual stranger, foreign, malformed and mismatched ownership logs with one shared scope', async () => {
	const pal = createPal({ name: 'Pinned', purpose: 'Original identity' })
	const foreign = createPal({ name: 'Foreign' })
	const owned = generateSessionId()
	const greeting = (await claimPalConversation(pal.workspace, pal.id, owned)).palGreeting
	updatePal(pal.id, 1, { name: 'Updated', purpose: 'Current identity', paused: true })
	const state = await openSessions(pal.workspace)
	try {
		const stranger = await startConversation(state)
		const wrongOwner = await startConversation(state, {
			origin: {
				protocol: 'desktop',
				externalSessionId: JSON.stringify(['namzu-pal', foreign.id, 1, generateSessionId()]),
			},
		})
		const malformed = await startConversation(state, {
			origin: { protocol: 'desktop', externalSessionId: '["namzu-pal"]' },
		})
		const mismatched = [stranger, wrongOwner, malformed]
		for (const mismatch of ['foreign-owner', 'project', 'tenant', 'cwd', 'revision'] as const) {
			const id = generateSessionId()
			await startConversation(
				{
					...state,
					...(mismatch === 'project' ? { projectId: generateProjectId() } : {}),
					...(mismatch === 'tenant' ? { tenantId: generateTenantId() } : {}),
					...(mismatch === 'cwd' ? { projectRoot: foreign.workspace } : {}),
				},
				{
					id,
					origin: {
						protocol: 'desktop',
						externalSessionId: JSON.stringify([
							'namzu-pal',
							mismatch === 'foreign-owner' ? foreign.id : pal.id,
							mismatch === 'revision' ? 999 : 1,
							id,
						]),
					},
				},
			)
			mismatched.push(id)
		}
		for (const id of mismatched) {
			await expect(palConversationBinding(pal.workspace, id)).rejects.toThrow()
		}
		expect(await listPalConversations(pal.workspace, pal.id)).toEqual([
			expect.objectContaining({ id: owned, palGreeting: greeting }),
		])
	} finally {
		closeSessions(state)
	}
})

it('rechecks strict journals, titles and archives after the index snapshot and on later calls', async () => {
	const pal = createPal({ name: 'Fresh reads' })
	const owned = generateSessionId()
	const archived = generateSessionId()
	const broken = generateSessionId()
	for (const id of [owned, archived, broken]) await claimPalConversation(pal.workspace, pal.id, id)
	const writer = await openSessions(pal.workspace)
	try {
		await setTitle(writer, owned, 'Before snapshot')
		afterCandidateSnapshot(async () => {
			await setTitle(writer, owned, 'After snapshot')
			await archiveConversation(writer, archived)
			appendFileSync(conversationLogPath(writer, broken), '{"broken":"journal"}\n')
		})
		expect(await listPalConversations(pal.workspace, pal.id)).toEqual([
			expect.objectContaining({ id: owned, title: 'After snapshot', named: true }),
		])
		await setTitle(writer, owned, 'Later invocation')
		expect(await listPalConversations(pal.workspace, pal.id)).toEqual([
			expect.objectContaining({ id: owned, title: 'Later invocation', named: true }),
		])
	} finally {
		closeSessions(writer)
	}
})

it('pins the authenticated home across awaited listing without caching it for later calls', async () => {
	const pal = createPal({ name: 'Original home' })
	const owned = generateSessionId()
	await claimPalConversation(pal.workspace, pal.id, owned)
	const otherHome = join(root, 'other-home')
	mkdirSync(otherHome)
	afterCandidateSnapshot(() => {
		vi.stubEnv('NAMZU_HOME', otherHome)
	})
	expect(await listPalConversations(pal.workspace, pal.id)).toEqual([
		expect.objectContaining({ id: owned }),
	])
	await expect(listPalConversations(pal.workspace, pal.id)).rejects.toThrow('does not own')
	vi.stubEnv('NAMZU_HOME', join(root, 'state'))
	expect(await listPalConversations(pal.workspace, pal.id)).toEqual([
		expect.objectContaining({ id: owned }),
	])
})

it('refuses a workspace alias before index initialization and rechecks a swap after its snapshot', async () => {
	const pal = createPal({ name: 'Canonical only' })
	const owned = generateSessionId()
	await claimPalConversation(pal.workspace, pal.id, owned)
	const alias = join(root, 'alias')
	symlinkSync(pal.workspace, alias, process.platform === 'win32' ? 'junction' : 'dir')
	const scanLoad = vi.spyOn(ScanSessionIndex, 'load')
	const sqliteOpen = vi.spyOn(SqliteSessionIndex, 'open')
	await expect(palConversationBinding(alias, owned)).rejects.toThrow('alias')
	await expect(listPalConversations(alias, pal.id)).rejects.toThrow('alias')
	expect(await palConversationBinding(join(root, 'ordinary-absent'), owned)).toBeNull()
	expect(scanLoad).not.toHaveBeenCalled()
	expect(sqliteOpen).not.toHaveBeenCalled()
	afterCandidateSnapshot(() => {
		const original = `${pal.workspace}-original`
		renameSync(pal.workspace, original)
		symlinkSync(original, pal.workspace, process.platform === 'win32' ? 'junction' : 'dir')
	})
	expect(await listPalConversations(pal.workspace, pal.id)).toEqual([])
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
