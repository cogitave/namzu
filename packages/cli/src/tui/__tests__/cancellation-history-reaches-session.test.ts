/** A cancelled turn still publishes the tool evidence needed by the next turn. */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
	type Message,
	type QueryParams,
	type RunEvent,
	createAssistantMessage,
	createSystemMessage,
	createToolMessage,
	createUserMessage,
} from '@namzu/sdk'
import { afterEach, expect, it, vi } from 'vitest'

import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import {
	type DetectedProvider,
	PROVIDER_REGISTRY,
	type Preferences,
} from '../../integrations/providers/index.js'
import type { AgentEvent } from '../agent.js'

const queryCalls: QueryParams[] = []
const controller = new AbortController()
const call = createAssistantMessage('Started the folder inspection.', [
	{
		id: 'call_child_evidence',
		type: 'function',
		function: { name: 'Agent', arguments: '{"description":"Inspect folder"}' },
	},
])
const receipt = createToolMessage('Child inspected the folder successfully.', 'call_child_evidence')
const privateFloor = createSystemMessage('PRIVATE_SYSTEM_FLOOR')

vi.mock('@namzu/sdk', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@namzu/sdk')>()
	return {
		...actual,
		query: (params: QueryParams) => {
			queryCalls.push(params)
			const first = queryCalls.length === 1
			return (async function* () {
				if (first) {
					yield {
						type: 'tool_completed',
						runId: 'cancelled-run',
						toolUseId: 'call_child_evidence',
						toolName: 'Agent',
						isError: false,
						result: receipt.content,
						durationMs: 1,
					} as RunEvent
					controller.abort(new DOMException('User interrupted.', 'AbortError'))
					yield { type: 'text_delta', text: 'LATE_TEXT_MUST_NOT_RENDER' } as RunEvent
				}
				yield {
					type: 'run_completed',
					runId: first ? 'cancelled-run' : 'next-run',
					stopReason: first ? 'cancelled' : 'end_turn',
					result: '',
				} as RunEvent
				return {
					messages: [
						privateFloor,
						...(params.messages ?? []),
						...(first ? [call, receipt] : [createAssistantMessage('Acknowledged the inspection.')]),
					],
				}
			})()
		},
	}
})

const roots: string[] = []
afterEach(() => {
	vi.unstubAllGlobals()
	for (const root of roots.splice(0)) removeTempDir(root)
})

it('retains completed Agent calls after cancellation and replays them before the next user message', async () => {
	const network = vi.fn(() => {
		throw new Error('This regression must not make a network request')
	})
	vi.stubGlobal('fetch', network)
	const cwd = mkdtempSync(join(tmpdir(), 'namzu-cancelled-history-'))
	roots.push(cwd)
	const preferences: Preferences = {
		version: 3,
		providers: [{ id: 'anthropic' }],
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
	const { createAgentSession } = await import('../agent.js')
	const session = await createAgentSession(preferences, detected, { cwd })
	const publish = vi.fn<(messages: readonly Message[]) => void>()
	const nextPublish = vi.fn<(messages: readonly Message[]) => void>()
	const user = createUserMessage('Start a parallel inspection')
	const visible: AgentEvent[] = []
	try {
		for await (const event of session.send([user], {
			signal: controller.signal,
			onConversationMessages: publish,
		})) {
			visible.push(event)
		}
		expect(publish).toHaveBeenCalledExactlyOnceWith([user, call, receipt])
		expect(visible.filter((event) => event.kind === 'error')).toEqual([
			{ kind: 'error', message: 'aborted' },
		])
		expect(JSON.stringify(visible)).not.toContain('LATE_TEXT_MUST_NOT_RENDER')
		expect(JSON.stringify(visible)).not.toContain('PRIVATE_SYSTEM_FLOOR')

		const history = publish.mock.calls[0]?.[0]
		if (!history) throw new Error('Cancelled turn did not publish its conversation')
		const nextUser = createUserMessage('What did the agents find?')
		for await (const _event of session.send([...history, nextUser], {
			onConversationMessages: nextPublish,
		})) {
			// Drain a distinct turn through the same real session adapter.
		}
		expect(queryCalls[1]?.messages).toEqual([user, call, receipt, nextUser])
		expect(publish).toHaveBeenCalledTimes(1)
		expect(nextPublish).toHaveBeenCalledTimes(1)
		expect(network).not.toHaveBeenCalled()
	} finally {
		await session.close()
	}
})
