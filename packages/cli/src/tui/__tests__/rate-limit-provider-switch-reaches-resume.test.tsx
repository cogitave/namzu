/** A paused GPT turn must continue on the provider chosen in the live TUI. */

import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import {
	type DetectedProvider,
	PROVIDER_REGISTRY,
	type Preferences,
	type ProviderId,
} from '../../integrations/providers/index.js'
import { fakeAgentSession } from '../__fixtures__/agent-session.js'
import type { AgentEvent, AgentSession, AgentSessionOptions } from '../agent.js'
import { type Screen, renderToScreen } from './support/screen.js'

const TURN_ID = 'dcc4e6b8-5dbe-453f-a4e4-61e076a09185'
const CHECKPOINT_ID = '02400658-7072-4cd3-b006-1e7c822072ac'
const CONVERSATION_ID = '535454a0-3284-474e-80c6-c0c73b5d8eb5'
const GPT_MODEL = 'gpt-5.6-sol'
const GEMINI_MODEL = 'gemini-2.5-flash'

const preferences: Preferences = {
	version: 3,
	providers: [{ id: 'openai', model: GPT_MODEL }],
	subagents: { active: [] },
}
const detected: readonly DetectedProvider[] = [
	{
		entry: PROVIDER_REGISTRY['openai'],
		source: { kind: 'env', envName: 'OPENAI_API_KEY' },
		apiKey: 'fixture-gpt-key',
		alternatives: [],
	},
	{
		entry: PROVIDER_REGISTRY.google,
		source: { kind: 'env', envName: 'GEMINI_API_KEY' },
		apiKey: 'fixture-gemini-key',
		alternatives: [],
	},
]

const world: {
	parked: boolean
	firstSendGate: Promise<void> | null
	constructed: Array<{
		providerId: ProviderId
		prefs: Preferences
		detected: readonly DetectedProvider[]
		options: AgentSessionOptions
	}>
	saved: Preferences[]
	requests: Array<{ providerId: ProviderId; operation: 'send' | 'resume'; turnId?: string }>
	closed: ProviderId[]
} = { parked: false, firstSendGate: null, constructed: [], saved: [], requests: [], closed: [] }

function sessionFor(providerId: ProviderId): AgentSession {
	return fakeAgentSession({
		providerSummary: providerId,
		modelSummary: providerId === 'google' ? GEMINI_MODEL : GPT_MODEL,
		close: async () => {
			world.closed.push(providerId)
		},
		send: async function* (): AsyncIterable<AgentEvent> {
			world.requests.push({ providerId, operation: 'send' })
			if (providerId === 'openai') {
				if (world.firstSendGate) await world.firstSendGate
				world.parked = true
				yield {
					kind: 'paused',
					turnId: TURN_ID,
					checkpointId: CHECKPOINT_ID,
					reason: 'GPT rate limit',
					failure: {
						code: 'provider_error',
						message: 'GPT rate limit',
						retryable: true,
						details: { providerCode: 'rate_limit', retryAfterMs: 3_000 },
					},
					providerError: {
						kind: 'throttle',
						providerId: 'openai',
						status: 429,
						retryAfterMs: 3_000,
						detail: 'quota exhausted',
					},
					explanation: {
						id: 'provider.rate_limit',
						message: 'The provider is rate limiting this turn.',
						hint: 'Choose another provider or wait.',
					},
				}
				return
			}
			yield { kind: 'done', stopReason: 'end_turn' }
		},
		resumePaused: (params) =>
			(async function* (): AsyncIterable<AgentEvent> {
				world.requests.push({ providerId, operation: 'resume', turnId: params.turnId })
				world.parked = false
				yield { kind: 'done', stopReason: 'end_turn' }
			})(),
	})
}

vi.mock('../../integrations/trust/store.js', () => ({ isTrusted: () => true, trustDir: () => {} }))
vi.mock('../../integrations/updates.js', () => ({ checkUpdates: async () => [] }))
vi.mock('../../user-commands/store.js', () => ({ discoverUserCommands: () => [] }))
vi.mock('../../integrations/sessions/store.js', () => ({
	activeConversationTurn: async () => (world.parked ? { turnId: TURN_ID, paused: true } : undefined),
	openSessions: async () => ({ tenantId: '29b3a0cc-469e-4536-8e4d-ac3301a586a6' }),
	startConversation: async () => CONVERSATION_ID,
	requireWritableConversation: async () => {},
	appendMessages: async () => {},
	listRecent: async () => [],
	loadConversation: async () => [],
}))
vi.mock('../../integrations/providers/index.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../integrations/providers/index.js')>()
	return { ...actual, writePreferences: (prefs: Preferences) => world.saved.push(prefs) }
})
vi.mock('../agent.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../agent.js')>()
	return {
		...actual,
		probeAgentSession: async () => ({ preferences, detected, needsRepickReason: null }),
		describeProviderModels: async (providerId: ProviderId) => ({
			kind: 'ok' as const,
			models:
				providerId === 'google'
					? [{ id: GEMINI_MODEL, name: 'Gemini Flash' }]
					: [{ id: GPT_MODEL, name: 'GPT Sol' }],
		}),
		createAgentSession: async (
			prefs: Preferences,
			detectedNow: readonly DetectedProvider[],
			options: AgentSessionOptions,
		) => {
			const providerId = prefs.providers[0]?.id
			if (!providerId) throw new Error('A provider must be selected')
			world.constructed.push({ providerId, prefs, detected: detectedNow, options })
			return sessionFor(providerId)
		},
	}
})

const { App } = await import('../App.js')
const screens: Screen[] = []

beforeEach(() => {
	world.parked = false
	world.firstSendGate = null
	world.constructed.length = 0
	world.saved.length = 0
	world.requests.length = 0
	world.closed.length = 0
})
afterEach(async () => {
	for (const screen of screens.splice(0)) await screen.unmount()
})

async function until(screen: Screen, predicate: () => boolean, description: string) {
	await vi.waitFor(async () => {
		await screen.waitForRender()
		expect(predicate(), `${description}\n${screen.viewport().join('\n')}`).toBe(true)
	})
}

async function press(screen: Screen, input: string) {
	screen.press(input)
	await screen.waitForRender()
}

async function submit(screen: Screen, input: string) {
	await press(screen, input)
	await press(screen, '\r')
}

it('resumes a rate-limited GPT checkpoint and sends the next turn through the selected Google session', async () => {
	const screen = await renderToScreen(
		<App ctx={{ cwd: '/workspace/namzu', version: '0.0.0-test' }} />,
		{ cols: 100, rows: 40 },
	)
	screens.push(screen)
	await until(screen, () => screen.viewport().join('\n').includes('Type a message'), 'App not ready')
	await submit(screen, 'Help me with this task')
	await until(
		screen,
		() => world.parked && screen.scrollback().join('\n').includes('Turn paused [provider.rate_limit]'),
		'GPT turn did not pause with a rate limit',
	)
	expect(world.requests).toEqual([{ providerId: 'openai', operation: 'send' }])

	await submit(screen, '/model')
	await until(screen, () => screen.viewport().join('\n').includes('p change provider'), 'Model picker did not open')
	await press(screen, 'p')
	await until(screen, () => screen.viewport().join('\n').includes('Choose a provider'), 'Provider list did not open')
	for (let position = 0; position < 12; position += 1) {
		const highlighted = screen.viewport().find((line) => line.includes('›')) ?? ''
		if (highlighted.includes(PROVIDER_REGISTRY.google.label)) break
		await press(screen, '\x1b[B')
	}
	expect(screen.viewport().find((line) => line.includes('›'))).toContain(PROVIDER_REGISTRY.google.label)
	await press(screen, '\r')
	await until(
		screen,
		() => screen.viewport().join('\n').includes(`Choose a model · ${PROVIDER_REGISTRY.google.label}`),
		'Gemini model list did not open',
	)
	await until(screen, () => screen.viewport().join('\n').includes('Gemini Flash'), 'Gemini model was not listed')
	await press(screen, '\r')
	await until(screen, () => world.constructed.length === 2 && world.closed.includes('openai'), 'Google session was not activated')
	expect(world.constructed.map(({ providerId }) => providerId)).toEqual(['openai', 'google'])
	expect(world.constructed[1]?.prefs.providers[0]).toEqual({ id: 'google', model: GEMINI_MODEL })
	expect(world.constructed[1]?.detected.find((provider) => provider.entry.id === 'google')?.apiKey).toBe('fixture-gemini-key')
	expect(world.constructed[1]?.options.scope?.sessionId).toBe(world.constructed[0]?.options.scope?.sessionId)
	expect(world.saved.at(-1)?.providers[0]?.id).toBe('google')

	await until(screen, () => screen.viewport().join('\n').includes('Type a message'), 'Composer did not return')
	await submit(screen, '/resume')
	await until(screen, () => world.requests.some((request) => request.operation === 'resume'), 'Paused turn was not resumed')
	expect(world.requests[1]).toEqual({ providerId: 'google', operation: 'resume', turnId: TURN_ID })
	await until(screen, () => !world.parked && screen.viewport().join('\n').includes('Type a message'), 'Resumed turn did not settle')
	await submit(screen, 'Continue the task')
	await until(screen, () => world.requests.length === 3, 'Next turn was not sent')
	expect(world.requests.map(({ providerId, operation }) => `${providerId}:${operation}`)).toEqual([
		'openai:send',
		'google:resume',
		'google:send',
	])
})

it('holds a dependent queued prompt through provider switch until the paused turn completes on Google', async () => {
	let releaseFirstSend = () => {}
	world.firstSendGate = new Promise<void>((resolve) => {
		releaseFirstSend = resolve
	})
	const screen = await renderToScreen(
		<App ctx={{ cwd: '/workspace/namzu', version: '0.0.0-test' }} />,
		{ cols: 100, rows: 40 },
	)
	screens.push(screen)
	await until(screen, () => screen.viewport().join('\n').includes('Type a message'), 'App not ready')
	await submit(screen, 'Rate-limited premise')
	await until(screen, () => world.requests.length === 1, 'First turn did not start')
	await press(screen, 'Dependent queued work')
	await press(screen, '\t')
	await until(screen, () => screen.viewport().join('\n').includes('message queued'), 'Dependent prompt was not queued')
	releaseFirstSend()
	await until(
		screen,
		() => world.parked && screen.viewport().join('\n').includes('held after a resumable turn paused'),
		'Rate limit did not hold the dependent queue',
	)
	expect(world.requests).toEqual([{ providerId: 'openai', operation: 'send' }])

	await submit(screen, '/model')
	await until(screen, () => screen.viewport().join('\n').includes('p change provider'), 'Model picker did not open')
	await press(screen, 'p')
	await until(screen, () => screen.viewport().join('\n').includes('Choose a provider'), 'Provider list did not open')
	for (let position = 0; position < 12; position += 1) {
		const highlighted = screen.viewport().find((line) => line.includes('›')) ?? ''
		if (highlighted.includes(PROVIDER_REGISTRY.google.label)) break
		await press(screen, '\x1b[B')
	}
	expect(screen.viewport().find((line) => line.includes('›'))).toContain(PROVIDER_REGISTRY.google.label)
	await press(screen, '\r')
	await until(screen, () => screen.viewport().join('\n').includes('Gemini Flash'), 'Gemini model was not listed')
	await press(screen, '\r')
	await until(screen, () => world.constructed.length === 2 && world.closed.includes('openai'), 'Google session was not activated')
	await until(screen, () => screen.viewport().join('\n').includes('held after a resumable turn paused'), 'Queue was released before the checkpoint resumed')
	expect(world.requests).toEqual([{ providerId: 'openai', operation: 'send' }])

	await submit(screen, '/resume')
	await until(screen, () => world.requests.length === 3, 'Resumed turn did not release the dependent prompt')
	expect(world.requests).toEqual([
		{ providerId: 'openai', operation: 'send' },
		{ providerId: 'google', operation: 'resume', turnId: TURN_ID },
		{ providerId: 'google', operation: 'send' },
	])
})
