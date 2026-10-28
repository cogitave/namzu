/**
 * Alt+P opens the model chooser and Alt+T switches thinking, both without
 * submitting anything: the draft typed beside the key survives the chooser
 * (closed with Esc or with Enter), and no key press adds a line to history.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Message } from '@namzu/sdk'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import {
	type DetectedProvider,
	PROVIDER_REGISTRY,
	type Preferences,
} from '../../integrations/providers/index.js'
import { writePreferences } from '../../integrations/providers/preferences.js'
import { fakeAgentSession } from '../__fixtures__/agent-session.js'
import type { AgentSession, AgentSessionOptions, SendOptions } from '../agent.js'
import { type Screen, renderToScreen } from './support/screen.js'

const OLD = 'gpt-5.6-sol'
const NEXT = 'gpt-5.6-luna'
const original: Preferences = {
	version: 3,
	providers: [{ id: 'codex', model: OLD }],
	subagents: { active: [] },
	allowCapabilityMismatch: true,
}
const detected: readonly DetectedProvider[] = [
	{
		entry: PROVIDER_REGISTRY.codex,
		source: { kind: 'codex-file', path: '/fixture/auth.json' },
		apiKey: 'fixture-token',
		codex: { accountId: 'fixture-account', origin: 'codex-file' },
		alternatives: [],
	},
]
const constructed: Array<{ prefs: Preferences; options: AgentSessionOptions }> = []
const sent: Array<{ model: string; messages: readonly Message[]; options?: SendOptions }> = []
const closeOld = vi.fn(async () => {})
const closeCandidate = vi.fn(async () => {})
const screens: Screen[] = []
let home: string
let candidateLevels: AgentSession['reasoningEffortLevels']
let oldLevels: AgentSession['reasoningEffortLevels']
let sendOld: AgentSession['send']
let activate: (model: string) => Promise<AgentSession>

function deferred<T>() {
	let resolve: (value: T) => void = () => {}
	const promise = new Promise<T>((r) => {
		resolve = r
	})
	return { promise, resolve }
}

function makeSession(model: string): AgentSession {
	return fakeAgentSession({
		providerSummary: 'Codex',
		modelSummary: model,
		// The model listing carries no effort metadata. Only session construction
		// reveals this menu, which deliberately differs from the old session.
		reasoningEffortLevels: model === OLD ? oldLevels : candidateLevels,
		close: model === OLD ? closeOld : closeCandidate,
		send: async function* (messages, options) {
			sent.push({ model, messages, options })
			if (model === OLD) yield* sendOld(messages, options)
			else yield { kind: 'done', stopReason: 'end_turn' }
		},
	})
}

vi.mock('../../integrations/trust/store.js', () => ({ isTrusted: () => true, trustDir: () => {} }))
vi.mock('../../integrations/updates.js', () => ({ checkUpdates: async () => [] }))
vi.mock('../../user-commands/store.js', () => ({ discoverUserCommands: () => [] }))
vi.mock('../../integrations/sessions/store.js', () => ({
	// The /resume and /abandon paths ask for the parked turn first; none here.
	activeConversationTurn: async () => undefined,
	openSessions: async () => ({ tenantId: '29b3a0cc-469e-4536-8e4d-ac3301a586a6' }),
	startConversation: async () => '535454a0-3284-474e-80c6-c0c73b5d8eb5',
	requireWritableConversation: async () => {},
	appendMessages: async () => {},
	replaceConversation: async () => {},
	listRecent: async () => [],
	loadConversation: async () => [],
}))
vi.mock('../../integrations/providers/index.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../integrations/providers/index.js')>()
	return {
		...actual,
		writePreferences: (prefs: Preferences) => actual.writePreferences(prefs, home),
	}
})
vi.mock('../agent.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../agent.js')>()
	return {
		...actual,
		probeAgentSession: async () => ({ preferences: original, detected, needsRepickReason: null }),
		describeProviderModels: async () => ({
			kind: 'ok',
			models: [OLD, NEXT].map((id) => ({ id, name: id })),
		}),
		createAgentSession: async (
			prefs: Preferences,
			_detected: readonly DetectedProvider[],
			options: AgentSessionOptions,
		) => {
			constructed.push({ prefs, options })
			return constructed.length === 1 ? makeSession(OLD) : activate(prefs.providers[0]?.model ?? '')
		},
	}
})
const { App } = await import('../App.js')

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), 'namzu-chooser-keys-'))
	writePreferences(original, home)
	constructed.length = 0
	sent.length = 0
	closeOld.mockClear()
	closeCandidate.mockClear()
	candidateLevels = undefined
	oldLevels = ['none', 'low', 'high']
	activate = async (model) => makeSession(model)
	sendOld = async function* () {
		yield { kind: 'done', stopReason: 'end_turn' }
	}
})
afterEach(async () => {
	for (const screen of screens.splice(0)) await screen.unmount()
	removeTempDir(home)
})

async function until(screen: Screen, predicate: () => boolean, message: string) {
	await vi.waitFor(async () => {
		await screen.waitForRender()
		expect(predicate(), `${message}\n${screen.viewport().join('\n')}`).toBe(true)
	})
}
async function shows(screen: Screen, text: string) {
	await until(screen, () => screen.viewport().join('\n').includes(text), `Missing ${text}`)
}
async function press(screen: Screen, input: string) {
	screen.press(input)
	await screen.waitForRender()
}
async function submit(screen: Screen, text: string) {
	await press(screen, text)
	await press(screen, '\r')
}
async function open(cols = 100) {
	const screen = await renderToScreen(
		<App ctx={{ cwd: '/workspace/namzu', version: '0.0.0-test' }} />,
		{ cols, rows: 30 },
	)
	screens.push(screen)
	await shows(screen, 'Type a message')
	return screen
}
async function chooseNextModel(screen: Screen) {
	await submit(screen, '/model')
	await shows(screen, 'Choose a model')
	await shows(screen, NEXT)
	await press(screen, '\x1b[F')
	await press(screen, '\r')
	await until(screen, () => constructed.length === 2, 'Replacement construction did not start')
	expect(constructed[1]?.prefs.providers[0]?.model).toBe(NEXT)
}

const ALT_P = '\x1bp'
const ALT_T = '\x1bt'

async function pickNextModel(screen: Screen) {
	await shows(screen, 'Choose a model')
	await shows(screen, NEXT)
	await press(screen, '\x1b[F')
	await press(screen, '\r')
	await until(screen, () => constructed.length === 2, 'Replacement construction did not start')
}

it('keeps the typed draft when the model chooser a key opened is closed with Esc', async () => {
	const screen = await open()
	await press(screen, 'half-written')
	await press(screen, ALT_P)
	await shows(screen, 'Choose a model')
	await press(screen, '\x1b')
	await shows(screen, 'half-written')
	expect(screen.viewport().join('\n')).not.toContain('Choose a model')
})

it('keeps the typed draft when a model is chosen from the chooser a key opened', async () => {
	const screen = await open()
	await press(screen, 'half-written')
	await press(screen, ALT_P)
	await pickNextModel(screen)
	await shows(screen, 'half-written')
	expect(screen.viewport().join('\n')).not.toContain('Choose a model')
	await press(screen, '\r')
	await until(screen, () => sent.length === 1, 'The restored draft was not sent')
	expect(sent[0]?.model).toBe(NEXT)
})

it('leaves no history line behind when a key opens the model chooser', async () => {
	const screen = await open()
	await submit(screen, 'earlier message')
	await until(screen, () => sent.length === 1, 'The first message was not sent')
	await press(screen, ALT_P)
	await shows(screen, 'Choose a model')
	await press(screen, '\x1b')
	await shows(screen, 'Type a message')
	await press(screen, '\x1b[A')
	await shows(screen, 'earlier message')
	expect(screen.viewport().join('\n')).not.toContain('/model')
})

it('switches thinking off and back on with a footer note and no transcript line', async () => {
	const screen = await open()
	await press(screen, ALT_T)
	await shows(screen, 'Thinking off')
	await submit(screen, 'with thinking off')
	await until(screen, () => sent.length === 1, 'The message was not sent')
	expect(sent[0]?.options?.effort).toBe('none')
	await press(screen, ALT_T)
	await shows(screen, 'Thinking on')
	await submit(screen, 'with thinking on')
	await until(screen, () => sent.length === 2, 'The second message was not sent')
	expect(sent[1]?.options?.effort).toBeUndefined()
	// One footer note at a time: the earlier one is gone, and none became a transcript row.
	const everything = screen.scrollback().join('\n')
	expect(everything.match(/Thinking on/gu)).toHaveLength(1)
	expect(everything).not.toContain('Thinking off')
})

it('puts back the effort level that was set before thinking was switched off', async () => {
	const screen = await open()
	await submit(screen, '/effort high')
	await shows(screen, 'Reasoning: high (this conversation).')
	await press(screen, ALT_T)
	await shows(screen, 'Thinking off')
	await press(screen, ALT_T)
	await shows(screen, 'Thinking on')
	await submit(screen, 'back on')
	await until(screen, () => sent.length === 1, 'The message was not sent')
	expect(sent[0]?.options?.effort).toBe('high')
})

it('says so in the footer when the model has no thinking switch', async () => {
	oldLevels = ['low', 'high']
	const screen = await open()
	await press(screen, ALT_T)
	await shows(screen, 'Thinking cannot be switched off for this model')
	expect(
		screen
			.scrollback()
			.join('\n')
			.match(/Thinking cannot/gu),
	).toHaveLength(1)
	await submit(screen, 'plain')
	await until(screen, () => sent.length === 1, 'The message was not sent')
	expect(sent[0]?.options?.effort).toBeUndefined()
})
