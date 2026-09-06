/** Model changes commit a usable replacement without erasing unrelated preferences. */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import {
	PROVIDER_REGISTRY,
	type DetectedProvider,
	type Preferences,
} from '../../integrations/providers/index.js'
import {
	preferencesPath,
	readPreferences,
	writePreferences,
} from '../../integrations/providers/preferences.js'
import { fakeAgentSession } from '../__fixtures__/agent-session.js'
import type { AgentEvent, AgentSession } from '../agent.js'
import { type Screen, renderToScreen } from './support/screen.js'

const original: Preferences = {
	version: 3,
	providers: [
		{ id: 'openai', model: 'model-current' },
		{ id: 'deepseek', model: 'fallback-pin' },
	],
	subagents: { active: ['reviewer-instance'] },
	allowCapabilityMismatch: true,
}
const detected: readonly DetectedProvider[] = ['openai', 'deepseek'].map((id) => ({
	entry: PROVIDER_REGISTRY[id as 'openai' | 'deepseek'],
	source: { kind: 'env', envName: 'FIXTURE_KEY' },
	apiKey: 'not-a-real-key',
	alternatives: [],
}))
let home = ''
let saveError: Error | undefined
let temporaryCredential = false
let activate: (prefs: Preferences) => Promise<AgentSession>
const constructed: Preferences[] = []
const sentBy: string[] = []
const closeOld = vi.fn(async () => {})
const closeCandidate = vi.fn(async () => {})
const screens: Screen[] = []

function session(model: string, close = closeOld): AgentSession {
	return fakeAgentSession({
		providerSummary: 'fixture-provider',
		modelSummary: model,
		close,
		send: async function* (): AsyncIterable<AgentEvent> {
			sentBy.push(model)
			yield { kind: 'done', stopReason: 'end_turn' }
		},
	})
}

vi.mock('../../integrations/trust/store.js', () => ({
	isTrusted: () => true,
	trustDir: () => {},
}))
vi.mock('../../integrations/updates.js', () => ({
	checkUpdates: async () => [],
}))
vi.mock('../../user-commands/store.js', () => ({
	discoverUserCommands: () => [],
}))
vi.mock('../../integrations/sessions/store.js', () => ({
	openSessions: async () => ({
		tenantId: '29b3a0cc-469e-4536-8e4d-ac3301a586a6',
	}),
	startConversation: async () => '535454a0-3284-474e-80c6-c0c73b5d8eb5',
	requireWritableConversation: async () => {},
	appendMessages: async () => {},
	listRecent: async () => [],
	loadConversation: async () => [],
}))
vi.mock('../../integrations/providers/index.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../integrations/providers/index.js')>()
	return {
		...actual,
		writePreferences: (prefs: Preferences) => {
			if (saveError) throw saveError
			actual.writePreferences(prefs, home)
		},
	}
})
vi.mock('../agent.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../agent.js')>()
	return {
		...actual,
		probeAgentSession: async () => {
			const saved = readPreferences(home)
			if (saved.status !== 'ok') throw new Error('Fixture preferences were not readable')
			return {
				preferences: saved.prefs,
				detected: temporaryCredential
					? detected.map((provider) =>
							provider.entry.id === 'openai'
								? { ...provider, source: { kind: 'session' as const } }
								: provider,
						)
					: detected,
				needsRepickReason: null,
			}
		},
		describeProviderModels: async () => ({
			kind: 'ok' as const,
			models: [
				{ id: 'model-current', name: 'Current model' },
				{ id: 'model-next', name: 'Next model' },
			],
		}),
		createAgentSession: async (prefs: Preferences) => {
			constructed.push(prefs)
			return constructed.length === 1 ? session('model-current') : activate(prefs)
		},
	}
})

const { App } = await import('../App.js')

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), 'namzu-model-selection-'))
	writePreferences(original, home)
	saveError = undefined
	temporaryCredential = false
	constructed.length = 0
	sentBy.length = 0
	closeOld.mockClear()
	closeCandidate.mockClear()
	activate = async (prefs) => session(prefs.providers[0]?.model ?? '', closeCandidate)
})
afterEach(async () => {
	for (const screen of screens.splice(0)) await screen.unmount()
	rmSync(home, { recursive: true, force: true })
})

async function until(screen: Screen, predicate: () => boolean, message: string) {
	await vi.waitFor(async () => {
		await screen.waitForRender()
		expect(predicate(), `${message}\n${screen.viewport().join('\n')}`).toBe(true)
	})
}
async function press(screen: Screen, input: string) {
	screen.press(input)
	await screen.waitForRender()
}
async function openModels() {
	const screen = await renderToScreen(
		<App ctx={{ cwd: '/workspace/namzu', version: '0.0.0-test' }} />,
		{ cols: 100, rows: 30 },
	)
	screens.push(screen)
	await until(
		screen,
		() => screen.viewport().join('\n').includes('Type a message'),
		'App not ready',
	)
	await press(screen, '/model')
	await press(screen, '\r')
	await until(
		screen,
		() => screen.viewport().join('\n').includes('Choose a model'),
		'Models did not open directly',
	)
	return screen
}
async function chooseNext(screen: Screen) {
	await until(
		screen,
		() => screen.viewport().join('\n').includes('Next model'),
		'Model list did not arrive',
	)
	await press(screen, '\x1b[B')
	await press(screen, '\r')
	await until(screen, () => constructed.length === 2, 'Replacement was not constructed')
}
async function expectOldSessionUsable(screen: Screen) {
	await until(
		screen,
		() => screen.viewport().join('\n').includes('Type a message'),
		'Old composer did not return',
	)
	await press(screen, 'Continue the original work')
	await press(screen, '\r')
	await until(screen, () => sentBy.length === 1, 'Old session could not run')
	expect(sentBy).toEqual(['model-current'])
	expect(closeOld).not.toHaveBeenCalled()
}

it('opens the active models and commits only the selected primary after activation', async () => {
	let complete: (value: AgentSession) => void = () => {}
	activate = () =>
		new Promise((resolve) => {
			complete = resolve
		})
	const bytes = readFileSync(preferencesPath(home), 'utf8')
	const screen = await openModels()
	expect(screen.viewport().join('\n')).toContain('this session and future launches')
	expect(screen.viewport().find((line) => line.includes('❯'))).toContain('Current model')
	await chooseNext(screen)
	expect(readFileSync(preferencesPath(home), 'utf8')).toBe(bytes)
	expect(closeOld).not.toHaveBeenCalled()
	expect(constructed[1]).toEqual({
		...original,
		providers: [{ id: 'openai', model: 'model-next' }, original.providers[1]],
	})
	complete(session('model-next', closeCandidate))
	await until(
		screen,
		() => screen.viewport().join('\n').includes('Type a message'),
		'New session not published',
	)
	expect(readPreferences(home)).toEqual({
		status: 'ok',
		prefs: constructed[1],
	})
	expect(closeOld).toHaveBeenCalledTimes(1)
	expect(closeCandidate).not.toHaveBeenCalled()
})

it('cancels a pending activation without saving and closes its late candidate', async () => {
	let complete: (value: AgentSession) => void = () => {}
	activate = () =>
		new Promise((resolve) => {
			complete = resolve
		})
	const bytes = readFileSync(preferencesPath(home), 'utf8')
	const screen = await openModels()
	await chooseNext(screen)
	await press(screen, '\x1b')
	await expectOldSessionUsable(screen)
	complete(session('model-next', closeCandidate))
	await until(screen, () => closeCandidate.mock.calls.length === 1, 'Cancelled candidate leaked')
	expect(readFileSync(preferencesPath(home), 'utf8')).toBe(bytes)
})

it.each(['activation', 'save'] as const)(
	'preserves the old session and preferences when %s fails',
	async (failure) => {
		if (failure === 'activation')
			activate = async () => {
				throw new Error('Candidate unavailable')
			}
		else saveError = new Error('Preference file is read-only')
		const bytes = readFileSync(preferencesPath(home), 'utf8')
		const screen = await openModels()
		await chooseNext(screen)
		await until(
			screen,
			() => screen.viewport().join('\n').includes('Could not start the selected provider'),
			'Failure not shown',
		)
		expect(readFileSync(preferencesPath(home), 'utf8')).toBe(bytes)
		expect(closeCandidate).toHaveBeenCalledTimes(failure === 'save' ? 1 : 0)
		await press(screen, '\x1b')
		await expectOldSessionUsable(screen)
	},
)

it('offers provider changes explicitly and preserves remaining fallback settings', async () => {
	const screen = await openModels()
	expect(screen.viewport().join('\n')).toContain('p change provider')
	await press(screen, 'p')
	await until(
		screen,
		() => screen.viewport().join('\n').includes('Choose a provider'),
		'Provider action did not open',
	)
	await press(screen, '\x1b[B')
	await press(screen, '\r')
	await until(
		screen,
		() => screen.viewport().join('\n').includes('Choose a model'),
		'Fallback models did not open',
	)
	await until(
		screen,
		() => screen.viewport().join('\n').includes('Next model'),
		'Fallback models did not arrive',
	)
	await press(screen, '\r')
	await until(
		screen,
		() => constructed.length === 2 && closeOld.mock.calls.length === 1,
		'Provider did not switch',
	)
	expect(constructed[1]).toMatchObject({
		subagents: original.subagents,
		allowCapabilityMismatch: true,
	})
	expect(constructed[1]?.providers).toHaveLength(2)
	expect(constructed[1]?.providers[0]?.id).toBe('deepseek')
	expect(constructed[1]?.providers[1]).toEqual(original.providers[1])
})

it('removes only an exact primary duplicate from the fallback chain', async () => {
	writePreferences(
		{
			...original,
			providers: [
				{ id: 'openai', model: 'model-current' },
				{ id: 'openai', model: 'model-next' },
				{ id: 'deepseek', model: 'fallback-pin' },
			],
		},
		home,
	)
	const screen = await openModels()
	await chooseNext(screen)
	await until(screen, () => closeOld.mock.calls.length === 1, 'Replacement not published')
	expect(constructed[1]?.providers).toEqual([
		{ id: 'openai', model: 'model-next' },
		{ id: 'deepseek', model: 'fallback-pin' },
	])
})

it('keeps a temporary credential model change session-only as advertised', async () => {
	temporaryCredential = true
	const bytes = readFileSync(preferencesPath(home), 'utf8')
	const screen = await openModels()
	expect(screen.viewport().join('\n')).toContain('this session only (temporary credential)')
	await chooseNext(screen)
	await until(
		screen,
		() => screen.viewport().join('\n').includes('Type a message'),
		'Session-only model did not activate',
	)
	expect(readFileSync(preferencesPath(home), 'utf8')).toBe(bytes)
	await press(screen, 'Use the selected temporary model')
	await press(screen, '\r')
	await until(screen, () => sentBy.length === 1, 'Temporary model could not run')
	expect(sentBy).toEqual(['model-next'])
})
