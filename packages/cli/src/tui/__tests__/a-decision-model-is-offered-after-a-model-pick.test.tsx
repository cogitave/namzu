/** After a model pick, the app offers a decision model once, and connects one in a few fields. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
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
		reasoningEffortLevels: candidateLevels,
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
	home = mkdtempSync(join(tmpdir(), 'namzu-decision-offer-'))
	writePreferences(original, home)
	constructed.length = 0
	sent.length = 0
	closeOld.mockClear()
	closeCandidate.mockClear()
	candidateLevels = undefined
	askedFor.length = 0
	clock = Date.parse('2030-06-01T12:00:00Z')
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
let clock = Date.parse('2030-06-01T12:00:00Z')
const askedFor: string[] = []
const fakeServer = (async (url: string, init?: RequestInit) => {
	if (url.includes('output_modalities=decisions')) {
		return new Response(
			JSON.stringify({
				data: [
					{
						id: 'typesafe/jev-1.14',
						name: 'Typesafe: JEV',
						pricing: { prompt: '0.000000042' },
						context_length: 32768,
					},
					{
						id: 'microsoft/microsoft-decision-1',
						name: 'Microsoft: Decision 1',
						pricing: { prompt: '0.000000042' },
						context_length: 1000000,
					},
					{
						id: 'parallel/decisions-fast:free',
						name: 'Parallel: Fast',
						pricing: { prompt: '0' },
						context_length: 8000,
					},
				],
			}),
		)
	}
	askedFor.push(`${url} ${new Headers(init?.headers).get('authorization') ?? 'no key'}`)
	return new Response(JSON.stringify({ answers: { q: { noul: 0.9 } } }))
}) as unknown as typeof fetch
async function open(cols = 100, ready = 'Type a message', env: NodeJS.ProcessEnv = {}) {
	const screen = await renderToScreen(
		<App
			ctx={{ cwd: '/workspace/namzu', version: '0.0.0-test' }}
			decisionSetup={{ home, env, now: () => clock, fetch: fakeServer }}
		/>,
		{ cols, rows: 30 },
	)
	screens.push(screen)
	await shows(screen, ready)
	return screen
}
async function pickModel(screen: Screen, model: string, nth: number) {
	await submit(screen, '/model')
	await shows(screen, 'Choose a model')
	await shows(screen, NEXT)
	await press(screen, model === NEXT ? '\x1b[F' : '\x1b[H')
	await press(screen, '\r')
	await until(screen, () => constructed.length === nth, 'Replacement construction did not start')
}
const OFFER = 'make Namzu'
const offerFile = () => join(home, '.namzu', 'decision-offer.json')

it('makes no offer until a model is picked', async () => {
	const screen = await open()
	expect(screen.viewport().join('\n')).not.toContain(OFFER)
	expect(existsSync(offerFile())).toBe(false)
})

it('offers a decision model after a model pick, and Dont ask again is never asked again', async () => {
	const screen = await open()
	await pickModel(screen, NEXT, 2)
	await shows(screen, OFFER)
	const text = screen.viewport().join('\n')
	expect(text).toContain('Not now')
	expect(text).toContain("Don't ask again")
	await press(screen, '\x1b[B')
	await press(screen, '\x1b[B')
	await press(screen, '\r')
	await shows(screen, 'Type a message')
	expect(JSON.parse(readFileSync(offerFile(), 'utf8')).answer).toBe('never')
	// A later pick, days later: nothing.
	clock += 30 * 24 * 60 * 60 * 1000
	await pickModel(screen, OLD, 3)
	await shows(screen, 'Type a message')
	expect(screen.viewport().join('\n')).not.toContain(OFFER)
})

it('Not now asks again only after a day', async () => {
	const screen = await open()
	await pickModel(screen, NEXT, 2)
	await shows(screen, OFFER)
	await press(screen, '\x1b[B')
	await press(screen, '\r')
	await shows(screen, 'Type a message')
	expect(JSON.parse(readFileSync(offerFile(), 'utf8')).answer).toBe('later')
	await pickModel(screen, OLD, 3)
	await shows(screen, 'Type a message')
	expect(screen.viewport().join('\n')).not.toContain(OFFER)
	clock += 25 * 60 * 60 * 1000
	await pickModel(screen, NEXT, 4)
	await shows(screen, OFFER)
})

it('connects my own server in three fields, keeps the key out of the config, and reports Connected', async () => {
	const screen = await open()
	await pickModel(screen, NEXT, 2)
	await shows(screen, OFFER)
	await press(screen, '\r')
	await shows(screen, 'My own server (HTTP)')
	await press(screen, '\x1b[B')
	await press(screen, '\x1b[B')
	await press(screen, '\r')
	await shows(screen, 'Server address')
	await submit(screen, 'http://127.0.0.1:8080/decide')
	await shows(screen, 'Key (optional)')
	await submit(screen, 'SECRET-SERVER-KEY-0123456789')
	await shows(screen, 'Model name (optional)')
	await press(screen, '\r')
	await shows(screen, 'Connected · ')
	await shows(screen, 'notify and skill are on')
	expect(askedFor).toEqual(['http://127.0.0.1:8080/decide Bearer SECRET-SERVER-KEY-0123456789'])
	const config = readFileSync(join(home, '.namzu', 'config.yaml'), 'utf8')
	expect(config).toContain('http://127.0.0.1:8080/decide')
	expect(config).not.toContain('SECRET-SERVER-KEY')
	expect(readFileSync(join(home, '.namzu', 'api-keys.json'), 'utf8')).toContain('SECRET-SERVER-KEY')
	expect(screen.viewport().join('\n')).not.toContain('SECRET-SERVER-KEY')
	// It is answered: no more offers.
	await pickModel(screen, OLD, 3)
	await shows(screen, 'Type a message')
	expect(screen.viewport().join('\n')).not.toContain(OFFER)
})

it('connects OpenRouter first: reuses the key, lists the models, starts on Microsoft Decision 1, reports Connected', async () => {
	const screen = await open(100, 'Type a message', {
		OPENROUTER_API_KEY: 'sk-or-FIXTURE-0123456789',
	})
	await pickModel(screen, NEXT, 2)
	await shows(screen, OFFER)
	await press(screen, '\r')
	await shows(screen, 'OpenRouter')
	await press(screen, '\r')
	await shows(screen, 'Using your OpenRouter key from OPENROUTER_API_KEY.')
	await shows(screen, 'Which OpenRouter decision model?')
	await shows(screen, 'Microsoft: Decision 1')
	await shows(screen, 'free')
	await press(screen, '\r')
	await shows(screen, 'Connected · ')
	expect(askedFor.at(-1)).toBe(
		'https://openrouter.ai/api/v1/systemone Bearer sk-or-FIXTURE-0123456789',
	)
	const config = readFileSync(join(home, '.namzu', 'config.yaml'), 'utf8')
	expect(config).toContain('model: microsoft/microsoft-decision-1')
	expect(config).not.toContain('sk-or-FIXTURE')
	expect(screen.viewport().join('\n')).not.toContain('sk-or-FIXTURE')
})

it('shows one line of decision status in /status', async () => {
	const screen = await open()
	await submit(screen, '/status')
	await shows(screen, 'Decision')
	expect(screen.viewport().join('\n')).toContain('Not connected')
})

function chooseConnectAtStart(answer?: 'later' | 'never', at = clock) {
	mkdirSync(join(home, '.namzu'), { recursive: true })
	writeFileSync(join(home, '.namzu', 'config.yaml'), 'decision: true\n')
	if (answer) {
		writeFileSync(offerFile(), `${JSON.stringify({ answer, at: new Date(at).toISOString() })}\n`)
	}
}

it('opens the connect picker at start for decision: true, and leaving it counts as Not now', async () => {
	chooseConnectAtStart()
	const screen = await open(100, 'Connect a decision model')
	await press(screen, '\x1b')
	await shows(screen, 'Type a message')
	expect(JSON.parse(readFileSync(offerFile(), 'utf8')).answer).toBe('later')
})

it('does not open the connect picker at start after Not now within a day, or after never', async () => {
	chooseConnectAtStart('later', clock - 60 * 60 * 1000)
	const soon = await open()
	expect(soon.viewport().join('\n')).not.toContain('Connect a decision model')
	chooseConnectAtStart('never', clock - 400 * 24 * 60 * 60 * 1000)
	const never = await open()
	expect(never.viewport().join('\n')).not.toContain('Connect a decision model')
})
