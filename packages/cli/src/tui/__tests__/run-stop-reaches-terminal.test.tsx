/** A resource stop must not look like the agent quietly forgot the conversation. */

import type { Message, StopReason } from '@namzu/sdk'
import { beforeEach, expect, it, vi } from 'vitest'

import type { Preferences } from '../../integrations/providers/index.js'
import { fakeAgentSession } from '../__fixtures__/agent-session.js'
import type { AgentEvent } from '../agent.js'
import { type Screen, renderToScreen } from './support/screen.js'

const preferences: Preferences = {
	version: 3,
	providers: [{ id: 'openai' }],
	subagents: { active: [] },
}
const partial = 'I inspected the package entry points.'
const followup = 'Continue from those findings.'
const sent: Message[][] = []
let stopReason: StopReason | undefined

vi.mock('../../integrations/trust/store.js', () => ({ isTrusted: () => true, trustDir: () => {} }))
vi.mock('../../integrations/updates.js', () => ({ checkUpdates: async () => [] }))
vi.mock('../../user-commands/store.js', () => ({ discoverUserCommands: () => [] }))
vi.mock('../../integrations/sessions/store.js', () => ({
	openSessions: async () => ({ tenantId: 'a3b15478-78be-44e8-ad59-f6e4cec8a1ec' }),
	startConversation: async () => 'f173a4b7-62d2-4705-878b-d15f52c8cde8',
	requireWritableConversation: async () => {},
	appendMessages: async () => {},
	listRecent: async () => [],
	loadConversation: async () => [],
}))
vi.mock('../agent.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../agent.js')>()
	return {
		...actual,
		probeAgentSession: async () => ({ preferences, needsRepickReason: null, detected: [] }),
		createAgentSession: async () =>
			fakeAgentSession({
				modelSummary: 'stop-fixture',
				send: async function* (messages): AsyncIterable<AgentEvent> {
					sent.push([...messages])
					if (sent.length === 1) {
						yield { kind: 'delta', text: partial }
						yield { kind: 'done', ...(stopReason ? { stopReason } : {}) }
					} else {
						yield { kind: 'delta', text: 'Continuing with the retained findings.' }
						yield { kind: 'done', stopReason: 'end_turn' }
					}
				},
			}),
	}
})

const { App } = await import('../App.js')

beforeEach(() => {
	sent.length = 0
	stopReason = undefined
})

async function until(screen: Screen, predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 160; attempt += 1) {
		await screen.waitForRender()
		if (predicate()) return
	}
	throw new Error(`The expected state did not reach the terminal:\n${screen.viewport().join('\n')}`)
}

async function submit(screen: Screen, text: string): Promise<void> {
	screen.press(text)
	await screen.waitForRender()
	screen.press('\r')
	await screen.waitForRender()
}

it.each([
	['token_budget', 'token allowance could not cover further work'],
	['max_iterations', 'step limit was reached'],
	['cost_unmeasurable', 'missing pricing prevented checking the cost limit'],
] as const)('shows %s with retained partial work and a usable composer', async (reason, notice) => {
	stopReason = reason
	const screen = await renderToScreen(
		<App ctx={{ cwd: '/workspace/namzu', version: '0.0.0-test' }} />,
		{ cols: 100, rows: 30 },
	)
	try {
		await until(screen, () => screen.viewport().join('\n').includes('stop-fixture default'))
		await submit(screen, 'Inspect this repository.')
		await until(screen, () => screen.viewport().join('\n').includes(notice))
		const stopped = screen.viewport().join('\n')
		expect(stopped).toContain(partial)
		expect(stopped).toContain('Run stopped:')
		expect(stopped).toContain('Type a message')
		expect(stopped).not.toContain('Working')
		expect(stopped).not.toContain('tokens spent')
		if (reason !== 'max_iterations') expect(stopped).toContain('/cost shows reported usage.')

		await submit(screen, followup)
		await until(screen, () => screen.viewport().join('\n').includes('Continuing with the retained'))
		expect(sent).toHaveLength(2)
		expect(JSON.stringify(sent[1])).toContain(partial)
		expect(JSON.stringify(sent[1])).toContain(followup)
		expect(screen.scrollback().join('\n').match(/Run stopped:/g)).toHaveLength(1)
	} finally {
		await screen.unmount()
	}
})

it.each([undefined, 'end_turn', 'cancelled'] as const)(
	'keeps %s endings quiet',
	async (reason) => {
		stopReason = reason
		const screen = await renderToScreen(
			<App ctx={{ cwd: '/workspace/namzu', version: '0.0.0-test' }} />,
			{ cols: 100, rows: 30 },
		)
		try {
			await until(screen, () => screen.viewport().join('\n').includes('stop-fixture default'))
			await submit(screen, 'Inspect this repository.')
			await until(screen, () => screen.viewport().join('\n').includes(partial))
			await submit(screen, followup)
			await until(screen, () => sent.length === 2)
			expect(screen.scrollback().join('\n')).not.toContain('Run stopped')
			expect(screen.scrollback().join('\n')).not.toContain('Run paused')
		} finally {
			await screen.unmount()
		}
	},
)
