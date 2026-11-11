/**
 * An answer that says a check passed, under a record that says it did not, is
 * followed by one plain line from the kernel. No line in any other case.
 */

import type { AnswerClaimMismatch, Message, TurnOutcome } from '@namzu/sdk'
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

const failing: TurnOutcome = {
	verdict: 'failing',
	basis: 'calls',
	changes: { total: 1, paths: ['a.ts'], outsideKnownTools: false },
	checks: [{ command: 'pnpm test', step: 2, result: 'failed', exitCode: 1 }],
}

const mismatch: AnswerClaimMismatch = {
	claim: 'tests',
	said: 'the tests pass',
	quote: 'All tests pass',
	record: 'check-failed',
	recordSays: 'pnpm test failed',
}

const sent: Message[][] = []
let done: Extract<AgentEvent, { kind: 'done' }>

vi.mock('../../integrations/trust/store.js', () => ({ isTrusted: () => true, trustDir: () => {} }))
vi.mock('../../integrations/updates.js', () => ({ checkUpdates: async () => [] }))
vi.mock('../../user-commands/store.js', () => ({ discoverUserCommands: () => [] }))
vi.mock('../../integrations/sessions/store.js', () => ({
	activeConversationTurn: async () => undefined,
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
				modelSummary: 'claim-fixture',
				send: async function* (messages): AsyncIterable<AgentEvent> {
					sent.push([...messages])
					yield { kind: 'delta', text: 'All tests pass.' }
					yield done
				},
			}),
	}
})

const { App } = await import('../App.js')

beforeEach(() => {
	sent.length = 0
})

async function until(screen: Screen, predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 160; attempt += 1) {
		await screen.waitForRender()
		if (predicate()) return
	}
	throw new Error(`The expected state did not reach the terminal:\n${screen.viewport().join('\n')}`)
}

async function turnShows(event: typeof done): Promise<string> {
	done = event
	const screen = await renderToScreen(
		<App ctx={{ cwd: '/workspace/namzu', version: '0.0.0-test' }} />,
		{ cols: 120, rows: 30 },
	)
	try {
		await until(screen, () => screen.viewport().join('\n').includes('claim-fixture'))
		screen.press('Fix it')
		await screen.waitForRender()
		screen.press('\r')
		await screen.waitForRender()
		await until(screen, () => screen.viewport().join('\n').includes('pnpm test failed'))
		return screen.viewport().join('\n')
	} finally {
		await screen.unmount()
	}
}

it('says what the answer claimed and what the record holds, under the outcome line', async () => {
	const shown = await turnShows({
		kind: 'done',
		stopReason: 'end_turn',
		outcome: failing,
		claimMismatch: mismatch,
	})
	const lines = shown.split('\n')
	const outcomeAt = lines.findIndex((l) => l.includes('Changed 1 file · pnpm test failed'))
	const claimAt = lines.findIndex((l) =>
		l.includes('The answer says the tests pass. The record: pnpm test failed.'),
	)
	expect(outcomeAt).toBeGreaterThanOrEqual(0)
	expect(claimAt).toBeGreaterThan(outcomeAt)
})

it('says nothing more when the answer contradicts nothing', async () => {
	const shown = await turnShows({ kind: 'done', stopReason: 'end_turn', outcome: failing })
	expect(shown).toContain('Changed 1 file · pnpm test failed')
	expect(shown).not.toContain('The answer says')
})
