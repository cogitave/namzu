/**
 * "Press Enter to try again, or type a new message": a reply that stopped on a
 * provider failure is closed by the next message, which runs on the model
 * chosen at that moment. A pause that waits for a person is not closed this way.
 */

import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import {
	type DetectedProvider,
	PROVIDER_REGISTRY,
	type Preferences,
} from '../../integrations/providers/index.js'
import { fakeAgentSession } from '../__fixtures__/agent-session.js'
import type { AgentEvent } from '../agent.js'
import { type Screen, renderToScreen } from './support/screen.js'

const TURN_ID = 'dcc4e6b8-5dbe-453f-a4e4-61e076a09185'
const CONVERSATION_ID = '535454a0-3284-474e-80c6-c0c73b5d8eb5'

const preferences: Preferences = {
	version: 3,
	providers: [{ id: 'openai', model: 'gpt-5.6-sol' }],
	subagents: { active: [] },
}
const detected: readonly DetectedProvider[] = [
	{
		entry: PROVIDER_REGISTRY['openai'],
		source: { kind: 'env', envName: 'OPENAI_API_KEY' },
		apiKey: 'fixture-key',
		alternatives: [],
	},
]

const world: {
	closable: boolean
	parked: boolean
	calls: string[]
} = { closable: true, parked: false, calls: [] }

vi.mock('../../integrations/trust/store.js', () => ({ isTrusted: () => true, trustDir: () => {} }))
vi.mock('../../integrations/updates.js', () => ({ checkUpdates: async () => [] }))
vi.mock('../../user-commands/store.js', () => ({ discoverUserCommands: () => [] }))
vi.mock('../../integrations/sessions/store.js', () => ({
	activeConversationTurn: async () =>
		world.parked ? { turnId: TURN_ID, paused: true } : undefined,
	unansweredReviewPark: async () => undefined,
	closableProviderPause: async () =>
		world.parked && world.closable ? { turnId: TURN_ID } : undefined,
	openSessions: async () => ({ tenantId: '29b3a0cc-469e-4536-8e4d-ac3301a586a6' }),
	startConversation: async () => CONVERSATION_ID,
	requireWritableConversation: async () => {},
	appendMessages: async () => {},
	listRecent: async () => [],
	loadConversation: async () => [],
}))
vi.mock('../agent.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../agent.js')>()
	return {
		...actual,
		probeAgentSession: async () => ({ preferences, detected, needsRepickReason: null }),
		createAgentSession: async () =>
			fakeAgentSession({
				providerSummary: 'openai',
				modelSummary: 'gpt-5.6-sol',
				send: async function* (): AsyncIterable<AgentEvent> {
					if (world.parked) {
						world.calls.push('send:refused')
						yield {
							kind: 'error',
							message: 'This conversation already has a paused turn.',
							turnInProgress: { sessionId: CONVERSATION_ID, activeTurnId: '', state: 'paused' },
						}
						return
					}
					world.calls.push('send')
					if (world.calls.filter((c) => c === 'send').length === 1) {
						world.parked = true
						yield {
							kind: 'paused',
							turnId: TURN_ID,
							checkpointId: '02400658-7072-4cd3-b006-1e7c822072ac',
							reason: 'rate limit',
							failure: {
								code: 'provider_error',
								message: 'rate limit',
								retryable: true,
								details: { providerCode: 'rate_limit' },
							},
							providerError: {
								kind: 'throttle',
								providerId: 'openai',
								status: 429,
								detail: 'slow',
							},
						}
						return
					}
					yield { kind: 'done', stopReason: 'end_turn' }
				},
				abandonTurn: async () => {
					world.calls.push('abandon')
					world.parked = false
				},
			}),
	}
})

const { App } = await import('../App.js')
const screens: Screen[] = []

beforeEach(() => {
	world.closable = true
	world.parked = false
	world.calls.length = 0
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

async function submit(screen: Screen, input: string) {
	screen.press(input)
	await screen.waitForRender()
	screen.press('\r')
	await screen.waitForRender()
}

async function startPaused(): Promise<Screen> {
	const screen = await renderToScreen(
		<App ctx={{ cwd: '/workspace/namzu', version: '0.0.0-test' }} />,
		{ cols: 100, rows: 40 },
	)
	screens.push(screen)
	await until(screen, () => screen.viewport().join('\n').includes('Type a message'), 'not ready')
	await submit(screen, 'first')
	await until(screen, () => screen.scrollback().join('\n').includes('Paused.'), 'did not pause')
	return screen
}

it('closes a reply that stopped on a provider failure and sends the new message, with no error line', async () => {
	const screen = await startPaused()
	await submit(screen, 'second')
	await until(screen, () => world.calls.length === 3, 'new message was not sent')
	expect(world.calls).toEqual(['send', 'abandon', 'send'])
	const text = [...screen.scrollback(), ...screen.viewport()].join('\n')
	expect(text).not.toContain('already has')
	expect(text).not.toContain('/abandon')
})

it('leaves a pause that waits for a person alone and says so in words', async () => {
	world.closable = false
	const screen = await startPaused()
	await submit(screen, 'second')
	await until(screen, () => world.calls.includes('send:refused'), 'message was not refused')
	expect(world.calls).toEqual(['send', 'send:refused'])
	const text = [...screen.scrollback(), ...screen.viewport()].join('\n')
	expect(text).toContain('The last reply is paused and waiting for you.')
	expect(text).not.toContain('()')
})
