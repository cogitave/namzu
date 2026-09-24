/**
 * A session that has already exchanged two ordinary messages could not take
 * a third: `namzu resume <id>` (or a still-running TUI/`exec` process) kept
 * the previous turn's own settled `Turn.messages` as the next send's prior
 * history — the documented, tolerated way to carry a conversation forward —
 * and that array is one message SHORTER than a fresh fold of the session log
 * at the same point, because `collapseProjectInstructionSnapshots` sheds
 * every earlier project-instruction snapshot from a turn's own working set
 * before that turn ever reaches a provider. The log keeps them all.
 *
 * `withoutRecordedPrefix` (`packages/sdk/.../prepare-turn.ts`) compared the
 * two positionally and mismatched at the very first message, so it kept the
 * WHOLE stale array and appended it after the correctly-folded history —
 * duplicating every message the two shared, including the second turn's own
 * tool call. `validateToolCallIds` then refused the duplicate, correctly:
 * `Message history repeats tool-call id '…'; a signed assistant turn cannot
 * be rewritten safely.`
 *
 * No checkpoint, pause, resume-from-checkpoint or process restart is
 * involved — this is the ordinary "send a third message" path. Text below is
 * a placeholder; nothing here describes a real conversation.
 */
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MockLLMProvider, ProviderRegistry, createUserMessage } from '@namzu/sdk'
import type { AssistantMessage, Message } from '@namzu/sdk'
import { afterEach, expect, it, vi } from 'vitest'

import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import {
	type DetectedProvider,
	PROVIDER_REGISTRY,
	type Preferences,
} from '../../integrations/providers/index.js'
import { createAgentSession } from '../agent.js'

const roots: string[] = []
afterEach(() => {
	vi.restoreAllMocks()
	for (const root of roots.splice(0)) removeTempDir(root)
})

const preferences: Preferences = {
	version: 3,
	providers: [{ id: 'anthropic', model: 'claude-sonnet-5' }],
	subagents: { active: [] },
}
const detected: DetectedProvider[] = [
	{
		entry: PROVIDER_REGISTRY['anthropic'],
		source: { kind: 'env', envName: 'ANTHROPIC_API_KEY' },
		apiKey: 'not-a-real-key',
		alternatives: [],
	},
]

async function drain(events: AsyncIterable<unknown>): Promise<void> {
	for await (const _event of events) {
		/* drain */
	}
}

it('a third live send does not repeat a completed turns tool-call id', async () => {
	const cwd = await mkdtemp(join(tmpdir(), 'namzu-stale-history-'))
	roots.push(cwd)
	await writeFile(join(cwd, 'AGENTS.md'), 'placeholder project instructions\n')
	await writeFile(join(cwd, 'notes.txt'), 'placeholder file body\n')

	const provider = new MockLLMProvider({
		turns: [
			{ text: 'placeholder reply one' },
			{ toolCalls: [{ name: 'read', args: { path: 'notes.txt' } }] },
			{ text: 'placeholder reply two' },
			{ text: 'placeholder reply three' },
		],
	})
	vi.spyOn(ProviderRegistry, 'create').mockReturnValue({ provider } as never)

	const session = await createAgentSession(preferences, detected, {
		cwd,
		sandbox: { enabled: false },
	})
	expect(session.hasProvider, session.errorHint ?? undefined).toBe(true)

	try {
		let historyAfterTurn1: readonly Message[] | undefined
		await drain(
			session.send([createUserMessage('placeholder first message')], {
				onConversationMessages: (messages) => {
					historyAfterTurn1 = messages
				},
			}),
		)
		if (!historyAfterTurn1) throw new Error('turn 1 never settled')

		let historyAfterTurn2: readonly Message[] | undefined
		await drain(
			session.send([...historyAfterTurn1, createUserMessage('placeholder second message')], {
				onConversationMessages: (messages) => {
					historyAfterTurn2 = messages
				},
			}),
		)
		if (!historyAfterTurn2) throw new Error('turn 2 never settled')
		const toolCallId = historyAfterTurn2
			.filter((message): message is AssistantMessage => message.role === 'assistant')
			.find((message) => (message.toolCalls?.length ?? 0) > 0)?.toolCalls?.[0]?.id
		if (!toolCallId) throw new Error('turn 2 never recorded a tool call')

		// This is exactly what a live TUI/exec session does between sends: it
		// carries the previous turn's OWN settled `Turn.messages` forward as the
		// next turn's prior history, rather than re-reading the session log.
		let thirdTurnError: string | undefined
		let historyAfterTurn3: readonly Message[] | undefined
		for await (const event of session.send(
			[...historyAfterTurn2, createUserMessage('placeholder third message')],
			{
				onConversationMessages: (messages) => {
					historyAfterTurn3 = messages
				},
			},
		)) {
			if (event.kind === 'error') thirdTurnError = event.message
		}

		expect(thirdTurnError).toBeUndefined()
		if (!historyAfterTurn3) throw new Error('turn 3 never settled')
		const occurrences = historyAfterTurn3
			.filter((message): message is AssistantMessage => message.role === 'assistant')
			.flatMap((message) => message.toolCalls ?? [])
			.filter((call) => call.id === toolCallId)
		expect(occurrences).toHaveLength(1)
	} finally {
		await session.close()
	}
})
