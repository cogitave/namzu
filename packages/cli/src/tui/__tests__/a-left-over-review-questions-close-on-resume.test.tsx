/**
 * A session that ended while tool calls were waiting for approval leaves a
 * turn nobody can answer. Those calls did not run and are not asked about
 * again: /resume and the next message close the turn, and /resume says so.
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

const world: { left: boolean; calls: string[] } = { left: false, calls: [] }

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
	activeConversationTurn: async () => (world.left ? { turnId: TURN_ID, paused: false } : undefined),
	closableProviderPause: async () => undefined,
	unansweredReviewPark: async () => (world.left ? { turnId: TURN_ID } : undefined),
	openSessions: async () => ({
		tenantId: '29b3a0cc-469e-4536-8e4d-ac3301a586a6',
	}),
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
		probeAgentSession: async () => ({
			preferences,
			detected,
			needsRepickReason: null,
		}),
		createAgentSession: async () =>
			fakeAgentSession({
				providerSummary: 'openai',
				modelSummary: 'gpt-5.6-sol',
				send: async function* (): AsyncIterable<AgentEvent> {
					world.calls.push('send')
					yield { kind: 'done', stopReason: 'end_turn' }
				},
				abandonTurn: async () => {
					world.calls.push('abandon')
					world.left = false
				},
			}),
	}
})

const { App } = await import('../App.js')
const screens: Screen[] = []

beforeEach(() => {
	world.left = false
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

async function startConversation(): Promise<Screen> {
	const screen = await renderToScreen(
		<App ctx={{ cwd: '/workspace/namzu', version: '0.0.0-test' }} />,
		{ cols: 100, rows: 40 },
	)
	screens.push(screen)
	await until(screen, () => screen.viewport().join('\n').includes('Type a message'), 'not ready')
	await submit(screen, 'first')
	await until(screen, () => world.calls.includes('send'), 'first message was not sent')
	return screen
}

const textOf = (screen: Screen) => [...screen.scrollback(), ...screen.viewport()].join('\n')

it('/resume closes the left-over questions without asking again and says the calls did not run', async () => {
	const screen = await startConversation()
	world.left = true
	await submit(screen, '/resume')
	await until(screen, () => world.calls.includes('abandon'), 'the turn was not closed')
	await until(screen, () => textOf(screen).includes('did not run'), 'no plain line')
	expect(world.calls).toEqual(['send', 'abandon'])
	expect(textOf(screen)).not.toContain('only a person can answer')
	expect(textOf(screen)).not.toContain('Do you want')
})

it('the next message closes the left-over questions and is sent', async () => {
	const screen = await startConversation()
	world.left = true
	await submit(screen, 'second')
	await until(screen, () => world.calls.length === 3, 'new message was not sent')
	expect(world.calls).toEqual(['send', 'abandon', 'send'])
})
