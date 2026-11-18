import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
	BashTool,
	type Message,
	MockLLMProvider,
	type MockTurn,
	type ProjectId,
	type SessionId,
	type TenantId,
	type TopicId,
	createUserMessage,
	drainQuery,
	registerMock,
	toolset,
} from '@namzu/sdk'
import { afterEach, describe, expect, it } from 'vitest'

import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import { createCliReminderSource } from '../index.js'
import { QUIET_STRETCH_CALLS, QUIET_STRETCH_MS, QuietStretch } from '../quiet-stretch.js'

/**
 * A real kernel turn with the terminal's reminder source and a clock the tool
 * advances by hand. A long quiet run is nudged once; the nudge does not end
 * the turn; a sentence from the model resets the stretch.
 */

registerMock()

const dirs: string[] = []
afterEach(() => {
	for (const dir of dirs.splice(0)) removeTempDir(dir)
})

const probe = (id: string, text?: string): MockTurn => ({
	...(text ? { text } : {}),
	toolCalls: [{ id, name: 'probe', args: { command: 'x' } }],
	finishReason: 'tool_calls',
})

async function run(turns: readonly MockTurn[], options: { watched: boolean }) {
	const cwd = await mkdtemp(join(tmpdir(), 'namzu-quiet-stretch-'))
	dirs.push(cwd)
	let clock = 0
	const stretch = options.watched ? new QuietStretch({ now: () => clock }) : undefined
	stretch?.turnStarted()
	// Each tool call takes 20 s of the fake clock: nothing waits for real.
	const probeTool = {
		...BashTool,
		name: 'probe',
		permissions: [],
		readOnly: true,
		destructive: false,
		concurrencySafe: true,
		execute: async () => {
			clock += 20_000
			return { success: true, output: 'ok' }
		},
	}
	const provider = new MockLLMProvider({ turns: [...turns] })
	const result = await drainQuery({
		provider,
		toolsets: [toolset('probe', [probeTool as never])],
		turnConfig: { model: 'mock', timeoutMs: 20_000, tokenBudget: 500_000, maxIterations: 40 },
		agentId: 'a',
		agentName: 'A',
		messages: [createUserMessage('go through the whole repository')],
		workingDirectory: cwd,
		sessionId: '4867992e-5fe0-44ac-8ad3-84768354abe1' as SessionId,
		topicId: '62a3b800-6711-4be4-9574-b8821f466408' as TopicId,
		projectId: 'f4feb4a0-1fe7-447e-a5bb-29988d224bb0' as ProjectId,
		tenantId: '945ca78a-e487-433d-a206-e2b9c64485c9' as TenantId,
		reminders: createCliReminderSource({
			mode: () => 'auto',
			...(stretch ? { quietStretch: stretch } : {}),
		}),
	})
	return { provider, messages: result.messages as readonly Message[] }
}

const nudged = (messages: readonly Message[]): number =>
	messages.filter(
		(m) => typeof m.content === 'string' && m.content.includes('kind="quiet-stretch"'),
	).length

// 20 s per call: the 90 s mark falls after the fifth call, and 6 calls are made by the sixth.
const WORK = QUIET_STRETCH_CALLS + 2

describe('a long quiet run on a watched surface', () => {
	it('is asked once, as the newest thing the model reads, and the turn carries on', async () => {
		expect(WORK * 20_000).toBeGreaterThan(QUIET_STRETCH_MS)
		const turns = [
			...Array.from({ length: WORK }, (_, i) => probe(`c${i}`)),
			// The model answers the nudge the way it asks: a sentence and its next call.
			probe('after-nudge', 'Read the loader and the cache; both hold the same copy.'),
			probe('last-call'),
			{ text: 'Finished.' },
		]
		const { provider, messages } = await run(turns, { watched: true })
		const sawNudge = provider.requests.findIndex((r) => nudged(r.messages as Message[]) > 0)
		expect(sawNudge).toBeGreaterThan(0)
		const there = provider.requests[sawNudge]?.messages as Message[]
		expect(String(there.at(-1)?.content)).toContain('kind="quiet-stretch"')
		expect(String(there.at(-1)?.content)).toContain('in that same response')
		// It is in the history once, as a hidden note, never as something the person said.
		expect(nudged(messages)).toBe(1)
		// The turn did not end on it: every scripted step ran, and the last answer is the model's.
		expect(provider.requests).toHaveLength(WORK + 3)
		expect(messages.at(-1)?.role).toBe('assistant')
		expect(messages.at(-1)?.content).toBe('Finished.')
	})

	it('is not said again after the sentence, however many calls follow', async () => {
		const turns = [
			...Array.from({ length: WORK }, (_, i) => probe(`c${i}`)),
			probe('after-nudge', 'Reading the cache layer.'),
			...Array.from({ length: 3 }, (_, i) => probe(`d${i}`)),
			{ text: 'Finished.' },
		]
		const { messages } = await run(turns, { watched: true })
		expect(nudged(messages)).toBe(1)
	})

	it('says nothing where nobody is known to watch', async () => {
		const turns = [...Array.from({ length: WORK + 3 }, (_, i) => probe(`c${i}`)), { text: 'Done.' }]
		const { messages } = await run(turns, { watched: false })
		expect(nudged(messages)).toBe(0)
	})
})
