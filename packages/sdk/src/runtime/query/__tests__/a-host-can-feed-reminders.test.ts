import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'

import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import { MockLLMProvider, registerMock } from '../../../provider/index.js'
import { testToolset } from '../../../test-support/toolset.js'
import { defineTool } from '../../../tools/defineTool.js'
import type { SessionId, TenantId } from '../../../types/ids/index.js'
import { createUserMessage } from '../../../types/message/index.js'
import type { Message } from '../../../types/message/index.js'
import type { MockTurn } from '../../../types/provider/index.js'
import type { ProjectId, TopicId } from '../../../types/session/ids.js'
import { drainQuery } from '../index.js'
import { type ReminderSource, isReminderMessage } from '../reminders.js'
import { isOperatorUserMessage } from '../steering.js'

/**
 * A host can hand a turn hidden reminders. The kernel asks the source before
 * each model request, appends what it returns as runtime context (never as
 * something the operator typed), and a turn without a source is unchanged.
 */

registerMock()

const dirs: string[] = []

afterEach(async () => {
	await removeTempDirs(dirs)
	dirs.length = 0
})

const probe = (id: string): MockTurn => ({
	toolCalls: [{ id, name: 'probe', args: {} }],
	finishReason: 'tool_calls',
})

async function run(turns: readonly MockTurn[], reminders?: ReminderSource) {
	const workingDirectory = await mkdtemp(join(tmpdir(), 'namzu-reminders-'))
	dirs.push(workingDirectory)
	const provider = new MockLLMProvider({ turns: [...turns, { text: 'done' }] })
	const result = await drainQuery({
		provider,
		toolsets: [
			testToolset(
				defineTool({
					name: 'probe',
					description: 'answers',
					inputSchema: z.object({}),
					category: 'analysis',
					permissions: [],
					readOnly: true,
					destructive: false,
					concurrencySafe: true,
					execute: async () => ({ success: true, output: 'ok' }),
				}),
			),
		],
		turnConfig: {
			model: 'mock',
			timeoutMs: 20_000,
			tokenBudget: 200_000,
			maxIterations: 10,
		},
		agentId: 'a',
		agentName: 'A',
		messages: [createUserMessage('go')],
		workingDirectory,
		sessionId: '4867992e-5fe0-44ac-8ad3-84768354abe1' as SessionId,
		topicId: '62a3b800-6711-4be4-9574-b8821f466408' as TopicId,
		projectId: 'f4feb4a0-1fe7-447e-a5bb-29988d224bb0' as ProjectId,
		tenantId: '945ca78a-e487-433d-a206-e2b9c64485c9' as TenantId,
		...(reminders ? { reminders } : {}),
	})
	return { provider, messages: result.messages as readonly Message[] }
}

describe('a host can feed hidden reminders', () => {
	it('adds nothing when no source is given', async () => {
		const { messages } = await run([probe('c1')])
		expect(messages.some(isReminderMessage)).toBe(false)
	})

	it('asks before every request and appends each text as runtime context', async () => {
		const seen: number[] = []
		const { provider, messages } = await run([probe('c1'), probe('c2')], ({ iteration }) => {
			seen.push(iteration)
			return iteration === 2 ? ['second request only'] : undefined
		})
		expect(seen).toEqual([1, 2, 3])
		const reminders = messages.filter(isReminderMessage)
		expect(reminders.map((m) => m.content)).toEqual(['second request only'])
		// It is not the operator: not the latest request, not a typed prompt.
		expect(isOperatorUserMessage(reminders[0] as Message)).toBe(false)
		// The model saw it on the request it was meant for, after the tool batch.
		const second = provider.requests[1]?.messages ?? []
		expect(second.at(-1)?.content).toBe('second request only')
		expect(second.at(-2)?.role).toBe('tool')
		// And only from then on.
		expect(provider.requests[0]?.messages.some((m) => m.content === 'second request only')).toBe(
			false,
		)
	})

	it('lets a source read the conversation to decide its own cadence', async () => {
		const assistantTurns: number[] = []
		await run([probe('c1'), probe('c2')], ({ messages }) => {
			assistantTurns.push(messages.filter((m) => m.role === 'assistant').length)
			return undefined
		})
		expect(assistantTurns).toEqual([0, 1, 2])
	})

	it('ignores blank texts and survives a source that throws', async () => {
		const blank = await run([probe('c1')], () => ['', '   '])
		expect(blank.messages.some(isReminderMessage)).toBe(false)
		const boom = await run([probe('c1')], () => {
			throw new Error('source failed')
		})
		expect(boom.messages.at(-1)?.role).toBe('assistant')
		expect(boom.messages.some(isReminderMessage)).toBe(false)
	})
})
