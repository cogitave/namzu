/** Auto is a visible, selectable model choice: available with a routing block, default under model: auto. */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import type { RoutingConfig } from '../../config/schema.js'
import {
	type DetectedProvider,
	PROVIDER_REGISTRY,
	type Preferences,
} from '../../integrations/providers/index.js'
import {
	preferencesPath,
	readPreferences,
	writePreferences,
} from '../../integrations/providers/preferences.js'
import { fakeAgentSession } from '../__fixtures__/agent-session.js'
import type { AgentEvent, AgentSession, AgentSessionOptions } from '../agent.js'
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
const detected: readonly DetectedProvider[] = ['openai', 'deepseek', 'anthropic'].map((id) => ({
	entry: PROVIDER_REGISTRY[id as 'openai' | 'deepseek' | 'anthropic'],
	source: { kind: 'env', envName: 'FIXTURE_KEY' },
	apiKey: 'not-a-real-key',
	alternatives: [],
}))
let home = ''
let saveError: Error | undefined
let temporaryCredential = false
let activate: (prefs: Preferences) => Promise<AgentSession>
const constructed: Preferences[] = []
const constructedOptions: AgentSessionOptions[] = []
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
	// The /resume and /abandon paths ask for the parked turn first; none here.
	activeConversationTurn: async () => undefined,
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
		createAgentSession: async (
			prefs: Preferences,
			_detected: readonly DetectedProvider[],
			options: AgentSessionOptions,
		) => {
			constructed.push(prefs)
			constructedOptions.push(options)
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
	constructedOptions.length = 0
	sentBy.length = 0
	closeOld.mockClear()
	closeCandidate.mockClear()
	activate = async (prefs) => session(prefs.providers[0]?.model ?? '', closeCandidate)
})
afterEach(async () => {
	for (const screen of screens.splice(0)) await screen.unmount()
	rmSync(home, { recursive: true, force: true })
})

const routing: RoutingConfig = { default: { provider: 'openai', model: 'model-current' } }

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
const text = (screen: Screen) => screen.viewport().join('\n')
async function start(ctx: { routing?: RoutingConfig; autoDefault?: boolean }) {
	const screen = await renderToScreen(
		<App ctx={{ cwd: '/workspace/namzu', version: '0.0.0-test', ...ctx }} />,
		{ cols: 100, rows: 30 },
	)
	screens.push(screen)
	await until(screen, () => text(screen).includes('Type a message'), 'App not ready')
	return screen
}
async function openModels(screen: Screen) {
	await press(screen, '/model')
	await press(screen, '\r')
	await until(screen, () => text(screen).includes('Choose a model'), 'Models did not open')
	await until(screen, () => text(screen).includes('Next model'), 'Model list did not arrive')
}
/** The footer line, not the transcript: the last non-empty row on screen. */
const footer = (screen: Screen) =>
	screen
		.viewport()
		.filter((line) => line.trim() !== '')
		.slice(-3)
		.join('\n')

it('does not offer Auto without a routing block, and says why when it is asked for', async () => {
	const screen = await start({})
	await openModels(screen)
	expect(text(screen)).not.toContain('picks a model for each task')
	await press(screen, '\x1b')
	await until(screen, () => text(screen).includes('Type a message'), 'Composer did not return')
	await press(screen, '/model auto')
	await press(screen, '\r')
	await until(screen, () => text(screen).includes('Auto is not set up'), 'No plain refusal')
	expect(text(screen)).toContain('routing block')
	expect(text(screen)).not.toContain('No model called')
	expect(constructed).toHaveLength(1)
})

it('puts Auto first in the picker and turns it on without saving a model pick', async () => {
	const bytes = readFileSync(preferencesPath(home), 'utf8')
	const screen = await start({ routing })
	expect(constructedOptions[0]?.routing).toBeUndefined()
	await openModels(screen)
	const rows = screen.viewport().filter((line) => /^\s*│\s*[❯ ]\s*\d+\. /.test(line))
	expect(rows[0]).toContain('Auto')
	expect(rows[0]).toContain('picks a model for each task')
	// Auto is not the current choice, so the cursor starts on the model in force.
	expect(screen.viewport().find((line) => line.includes('❯'))).toContain('Current model')
	await press(screen, '1')
	await press(screen, '\r')
	await until(screen, () => constructed.length === 2, 'Auto did not rebuild the session')
	expect(constructedOptions[1]?.routing).toEqual(routing)
	await until(screen, () => text(screen).includes('Auto is on for this launch'), 'No confirmation')
	expect(text(screen)).toContain('model: auto')
	expect(footer(screen)).toContain('Auto')
	expect(readFileSync(preferencesPath(home), 'utf8')).toBe(bytes)
})

it('opens on Auto when it is the default, and a hand-picked model turns it off', async () => {
	const screen = await start({ routing, autoDefault: true })
	expect(constructedOptions[0]?.routing).toEqual(routing)
	expect(footer(screen)).toContain('Auto')
	await openModels(screen)
	expect(screen.viewport().find((line) => line.includes('❯'))).toContain('Auto')
	await press(screen, '4')
	await press(screen, '\r')
	await until(screen, () => constructed.length === 2, 'Pick did not rebuild the session')
	await until(screen, () => !footer(screen).includes('Auto'), 'Auto still shown')
	expect(constructedOptions[1]?.routing).toBeUndefined()
	expect(footer(screen)).toContain('model-next')
})

it('turns Auto back on with /model auto after a hand pick', async () => {
	const screen = await start({ routing, autoDefault: true })
	await press(screen, '/model model-next')
	await press(screen, '\r')
	await until(screen, () => constructed.length === 2, 'Pick did not rebuild the session')
	await until(screen, () => text(screen).includes('Auto is off'), 'No note that Auto turned off')
	expect(constructedOptions[1]?.routing).toBeUndefined()
	await press(screen, '/model AUTO')
	await press(screen, '\r')
	await until(screen, () => constructed.length === 3, 'Auto did not rebuild the session')
	expect(constructedOptions[2]?.routing).toEqual(routing)
	await until(screen, () => footer(screen).includes('Auto'), 'Footer does not say Auto')
})

it('says Auto is already on instead of rebuilding', async () => {
	const screen = await start({ routing, autoDefault: true })
	await press(screen, '/model auto')
	await press(screen, '\r')
	await until(screen, () => text(screen).includes('Auto is already on'), 'No notice')
	expect(constructed).toHaveLength(1)
})
