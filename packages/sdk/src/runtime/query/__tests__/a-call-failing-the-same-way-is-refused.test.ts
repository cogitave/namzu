import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'

import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import { MockLLMProvider, registerMock } from '../../../provider/index.js'
import { ToolRegistry } from '../../../registry/index.js'
import { defineTool } from '../../../tools/defineTool.js'
import type { SessionId, TenantId } from '../../../types/ids/index.js'
import { createUserMessage } from '../../../types/message/index.js'
import type { Message } from '../../../types/message/index.js'
import type { MockTurn } from '../../../types/provider/index.js'
import type { ProjectId, TopicId } from '../../../types/session/ids.js'
import { drainQuery } from '../index.js'
import { RepeatCallTracker } from '../repeat-call.js'

/**
 * The one thing the repeat tracker refuses.
 *
 * An operator watched a model ask a desktop it could not reach for a
 * screenshot, read the same error, and ask again, for as long as the run
 * was allowed to go on. The tracker only advised, and advice the model
 * could not act on was worth nothing. After four consecutive identical
 * failures the fifth identical call is answered with a refusal instead of
 * being run; a success in between resets the count, so a poll that fails a
 * few times before it succeeds is never touched.
 */

registerMock()

const dirs: string[] = []

afterEach(async () => {
	await removeTempDirs(dirs)
	dirs.length = 0
})

const call = (args: Record<string, unknown>, id: string): MockTurn => ({
	toolCalls: [{ id, name: 'screenshot', args }],
	finishReason: 'tool_calls',
})

function tools(outcomes: readonly boolean[], executions: string[]): ToolRegistry {
	const registry = new ToolRegistry()
	let n = 0
	registry.register(
		defineTool({
			name: 'screenshot',
			description: 'fails until it does not',
			inputSchema: z.object({ display: z.string().optional() }),
			category: 'analysis',
			permissions: [],
			readOnly: true,
			destructive: false,
			concurrencySafe: true,
			execute: async () => {
				executions.push('ran')
				const ok = outcomes[n] ?? outcomes[outcomes.length - 1] ?? false
				n += 1
				return ok
					? { success: true, output: 'a picture' }
					: { success: false, output: '', error: 'no interactive desktop session' }
			},
		}),
	)
	return registry
}

async function run(turns: readonly MockTurn[], outcomes: readonly boolean[]) {
	const workingDirectory = await mkdtemp(join(tmpdir(), 'namzu-refuse-'))
	dirs.push(workingDirectory)
	const executions: string[] = []
	const result = await drainQuery({
		provider: new MockLLMProvider({ turns: [...turns, { text: 'done' }] }),
		tools: tools(outcomes, executions),
		runConfig: { model: 'mock', timeoutMs: 20_000, tokenBudget: 200_000, maxIterations: 12 },
		agentId: 'a',
		agentName: 'A',
		messages: [createUserMessage('go')],
		workingDirectory,
		sessionId: 'ses_f' as SessionId,
		topicId: 'top_f' as TopicId,
		projectId: 'prj_f' as ProjectId,
		tenantId: 'tnt_f' as TenantId,
	})
	return { messages: result.messages, executions }
}

const toolText = (messages: readonly Message[]): string[] =>
	messages
		.filter((m) => m.role === 'tool' && typeof m.content === 'string')
		.map((m) => m.content as string)

describe('a call failing the same way is refused', () => {
	it('runs four identical failures and refuses the fifth and sixth', async () => {
		const same = { display: 'primary' }
		const { messages, executions } = await run(
			['c1', 'c2', 'c3', 'c4', 'c5', 'c6'].map((id) => call(same, id)),
			[false],
		)
		const results = toolText(messages)
		expect(results).toHaveLength(6)
		expect(executions, 'the refused calls still ran').toHaveLength(4)
		expect(results[3]).toContain('no interactive desktop session')
		expect(results[4]).toContain('Refused: `screenshot`')
		expect(results[4]).toContain('failed 4 times in a row')
		expect(results[5]).toContain('failed 5 times in a row')
	})

	it('never refuses a poll that fails and then succeeds', async () => {
		const same = { display: 'primary' }
		const { messages, executions } = await run(
			['c1', 'c2', 'c3', 'c4', 'c5', 'c6'].map((id) => call(same, id)),
			[false, false, false, true, false, false],
		)
		expect(executions).toHaveLength(6)
		expect(toolText(messages).some((text) => text.startsWith('Refused:'))).toBe(false)
	})

	it('counts only what it is told about', () => {
		const tracker = new RepeatCallTracker()
		for (let i = 0; i < 6; i += 1) tracker.record('x', { a: 1 })
		expect(tracker.refusal('x', { a: 1 })).toBeUndefined()
		for (let i = 0; i < 4; i += 1) tracker.record('y', { a: 1 }, { failed: true })
		expect(tracker.refusal('y', { a: 1 })).toMatch(/failed 4 times in a row/)
		tracker.record('y', { a: 1 }, { failed: false })
		expect(tracker.refusal('y', { a: 1 })).toBeUndefined()
	})
})
