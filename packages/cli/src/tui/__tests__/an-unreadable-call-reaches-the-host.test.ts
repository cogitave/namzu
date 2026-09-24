/**
 * A tool call whose streamed arguments could not be read reaches a host with
 * the reason and the text that arrived.
 *
 * The kernel's `tool_input_completed` says whether the arguments were cut off
 * or malformed (`inputError`) and carries what was sent (`partialArguments`),
 * and the CLI's mapper dropped the event. A host reading `namzu exec --json`,
 * which writes every session event it is given, saw only the failed
 * `tool-end`: it could not tell a length cut from malformed JSON, nor record
 * what the model had sent.
 */

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
	type QueryParams,
	type SessionEvent,
	type ToolInputError,
	ToolRegistry,
	type TurnId,
	createAssistantMessage,
	createToolPresenter,
	createUserMessage,
} from '@namzu/sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import {
	type DetectedProvider,
	PROVIDER_REGISTRY,
	type Preferences,
} from '../../integrations/providers/index.js'
import { type AgentEvent, toAgentEvent } from '../agent.js'

const turnId = '0d6f3f0e-8a53-4b8e-9d1e-2c3b4a5f6e7d' as TurnId
const inputError: ToolInputError = {
	reason: 'malformed',
	finishReason: 'tool_calls',
	parseError: 'Unexpected token \'T\', "{"q": True}" is not valid JSON',
	offset: 6,
	length: 11,
	precedingLength: 0,
}
const unreadable = {
	type: 'tool_input_completed',
	turnId,
	toolUseId: 'call_bad',
	input: {},
	inputTruncated: true,
	inputError,
	partialArguments: '{"q": True}',
} as unknown as SessionEvent

vi.mock('@namzu/sdk', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@namzu/sdk')>()
	return {
		...actual,
		query: (params: QueryParams) =>
			(async function* () {
				yield unreadable
				yield {
					type: 'turn_completed',
					turnId,
					stopReason: 'end_turn',
					result: 'done',
				} as unknown as SessionEvent
				return { messages: [...(params.messages ?? []), createAssistantMessage('done')] }
			})(),
	}
})

const roots: string[] = []
afterEach(() => {
	vi.unstubAllGlobals()
	for (const root of roots.splice(0)) removeTempDir(root)
})

describe('an unreadable tool call', () => {
	it('is mapped with its reason and what arrived, and a readable completion is not', () => {
		const presenter = createToolPresenter(new ToolRegistry())
		expect(toAgentEvent(unreadable, presenter)).toEqual({
			kind: 'tool-input-unreadable',
			turnId,
			toolUseId: 'call_bad',
			inputError,
			partialArguments: '{"q": True}',
		})
		expect(
			toAgentEvent(
				{
					type: 'tool_input_completed',
					turnId,
					toolUseId: 'call_ok',
					input: { q: 'x' },
				} as unknown as SessionEvent,
				presenter,
			),
		).toBeNull()
	})

	it('reaches what a session sends its host, which exec --json writes line by line', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(() => {
				throw new Error('This test must not make a network request')
			}),
		)
		const cwd = mkdtempSync(join(tmpdir(), 'namzu-unreadable-call-'))
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
		const events: AgentEvent[] = []
		try {
			for await (const event of session.send([createUserMessage('ask')])) events.push(event)
		} finally {
			await session.close?.()
		}
		expect(events.find((event) => event.kind === 'tool-input-unreadable')).toEqual({
			kind: 'tool-input-unreadable',
			turnId,
			toolUseId: 'call_bad',
			inputError,
			partialArguments: '{"q": True}',
		})
	})
})
