import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PalEnvironmentLease } from '@namzu/sdk'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { removeTempDir } from '../__fixtures__/temp-dir.js'
import { claimPalConversation, newPalSessionId } from './conversations.js'
import { createPal, updatePal } from './store.js'
import {
	tuiPalDefinition,
	tuiPalEnvironment,
	tuiPalOwner,
	tuiPalPreferences,
} from './tui-session.js'

const startComputer = vi.hoisted(() => vi.fn())
const admit = vi.hoisted(() => vi.fn())
const admitConversation = vi.hoisted(() => vi.fn())
const computer = vi.hoisted(() => vi.fn())
const computerControl = vi.hoisted(() => vi.fn())
vi.mock('./environment.js', () => ({
	getCliPalRuntime: async () => ({
		startComputer,
		admit,
		admitConversation,
		computer,
		computerControl,
	}),
}))
let home = ''
beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), 'namzu-pal-terminal-'))
	mkdirSync(join(home, 'state'), { mode: 0o700 })
	vi.stubEnv('NAMZU_HOME', join(home, 'state'))
	startComputer.mockReset()
	admit.mockReset()
	admitConversation.mockReset()
	computer.mockReset().mockReturnValue(null)
	computerControl.mockReset().mockReturnValue({ supported: false, mode: 'unavailable' })
})
afterEach(() => {
	vi.unstubAllEnvs()
	removeTempDir(home)
})

it('restores the conversation’s immutable profile after the Pal is edited', async () => {
	const pal = createPal({
		name: 'Researcher',
		purpose: 'First purpose',
		model: { provider: 'openai', model: 'first-model' },
	})
	const firstId = newPalSessionId()
	await claimPalConversation(pal.workspace, pal.id, firstId)
	const edited = updatePal(pal.id, pal.revision, {
		purpose: 'New purpose',
		model: { provider: 'anthropic', model: 'new-model' },
	})
	const first = await tuiPalDefinition(pal.workspace, firstId, pal.id)
	expect(first).toMatchObject({
		revision: 1,
		purpose: 'First purpose',
		model: { provider: 'openai', model: 'first-model' },
	})
	const secondId = newPalSessionId()
	await claimPalConversation(pal.workspace, pal.id, secondId)
	expect(await tuiPalDefinition(pal.workspace, secondId, pal.id)).toMatchObject({
		revision: edited.revision,
		purpose: 'New purpose',
	})
	expect(
		tuiPalPreferences(first!, {
			version: 3,
			providers: [{ id: 'ollama' }],
			subagents: { active: [] },
		})?.providers,
	).toEqual([{ id: 'openai', model: 'first-model' }])
})

it('refuses another Pal’s conversation and an unclaimed conversation id', async () => {
	const one = createPal({ name: 'One' })
	const two = createPal({ name: 'Two' })
	const ownedId = newPalSessionId()
	await claimPalConversation(one.workspace, one.id, ownedId)
	await expect(tuiPalDefinition(two.workspace, ownedId, two.id)).rejects.toThrow('not claimed')
	await expect(tuiPalDefinition(one.workspace, newPalSessionId(), one.id)).rejects.toThrow(
		'not claimed',
	)
	expect(() => tuiPalOwner(one.workspace, two.id)).toThrow('requested Pal')
})

it('checks current pause state while retaining the historical profile', async () => {
	const pal = createPal({ name: 'One' })
	const id = newPalSessionId()
	await claimPalConversation(pal.workspace, pal.id, id)
	updatePal(pal.id, pal.revision, { paused: true })
	await expect(tuiPalDefinition(pal.workspace, id, pal.id)).rejects.toThrow('paused')
})

it('pins conversation admission without requiring or starting a computer', async () => {
	const pal = createPal({ name: 'One' })
	const id = newPalSessionId()
	admitConversation.mockResolvedValue({ definition: pal })
	const signal = new AbortController().signal
	const binding = await tuiPalEnvironment(pal, id, signal)
	expect(binding.lease).toBeUndefined()
	expect(binding.readyComputer?.()).toBeUndefined()
	await binding.admitConversation?.(signal)
	await binding.admitConversation?.()
	expect(admitConversation.mock.calls).toEqual([
		[{ palId: pal.id, revision: pal.revision, conversationId: id, signal }],
		[{ palId: pal.id, revision: pal.revision, conversationId: id }],
	])
	expect(startComputer).not.toHaveBeenCalled()
	expect(admit).not.toHaveBeenCalled()
})

it('observes newly ready guest authority at each turn and excludes operator-held guests', async () => {
	const pal = createPal({ name: 'One' })
	const binding = await tuiPalEnvironment(pal, newPalSessionId())
	expect(binding.readyComputer?.()).toBeUndefined()
	const lease = { palId: pal.id, environmentId: 'guest-one' } as PalEnvironmentLease
	computer.mockReturnValue(lease)
	computerControl.mockReturnValue({ supported: true, mode: 'pal' })
	expect(binding.readyComputer?.()).toBe(lease)
	computerControl.mockReturnValue({ supported: true, mode: 'operator' })
	expect(binding.readyComputer?.()).toBeUndefined()
	computerControl.mockReturnValue({ supported: true, mode: 'transitioning' })
	expect(binding.readyComputer?.()).toBeUndefined()
	computerControl.mockReturnValue({ supported: true, mode: 'pal' })
	expect(binding.readyComputer?.()).toBe(lease)
	expect(startComputer).not.toHaveBeenCalled()
})
