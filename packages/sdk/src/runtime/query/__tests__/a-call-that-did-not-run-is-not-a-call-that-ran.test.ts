/**
 * The outcome record says "a command ran that may have changed files" only for
 * a call that ran. A call the person declined, a rule refused, whose input was
 * refused before it started, or that only launched work elsewhere, changed
 * nothing in this turn, and the record must not say it might have.
 */

import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import { MockLLMProvider } from '../../../provider/mock.js'
import { InMemorySessionLog } from '../../../store/session-log/index.js'
import { testToolset } from '../../../test-support/toolset.js'
import { defineTool } from '../../../tools/defineTool.js'
import type { HITLResumeDecision } from '../../../types/hitl/index.js'
import type { MockTurn } from '../../../types/provider/index.js'
import {
	generateProjectId,
	generateSessionId,
	generateTenantId,
	generateTopicId,
} from '../../../utils/id.js'
import { type QueryParams, drainQuery } from '../index.js'

const dirs: string[] = []
afterEach(async () => {
	await removeTempDirs(dirs)
	dirs.length = 0
})

function tools(execute = vi.fn(async () => ({ success: true, output: 'ran' }))) {
	return {
		execute,
		toolset: testToolset(
			defineTool({
				name: 'bash',
				description: 'run a command',
				inputSchema: z.object({ command: z.string() }),
				category: 'custom',
				permissions: [],
				readOnly: false,
				destructive: true,
				concurrencySafe: false,
				execute,
			}),
			defineTool({
				name: 'Agent',
				description: 'launch a sub-agent',
				inputSchema: z.object({ description: z.string(), background: z.boolean().optional() }),
				category: 'custom',
				permissions: [],
				readOnly: false,
				destructive: false,
				concurrencySafe: true,
				execute: async (input) => ({
					success: true,
					output: 'launched',
					...(input.background ? { launched: true as const } : {}),
				}),
			}),
		),
	}
}

async function run(
	turns: MockTurn[],
	decision: HITLResumeDecision = { action: 'continue' },
	extra: Record<string, unknown> = {},
) {
	const workingDirectory = await mkdtemp(join(tmpdir(), 'namzu-did-not-run-'))
	dirs.push(workingDirectory)
	const { execute, toolset } = tools()
	const sessionLog = new InMemorySessionLog({ sessionId: generateSessionId() })
	const turn = await drainQuery(
		{
			provider: new MockLLMProvider({ turns }),
			toolsets: [toolset],
			sessionLog,
			agentId: 'agent_outcome',
			agentName: 'Outcome',
			messages: [{ role: 'user', content: 'do it' }],
			workingDirectory,
			turnConfig: { model: 'mock', tokenBudget: 100_000, timeoutMs: 5_000, maxIterations: 6 },
			projectId: generateProjectId(),
			sessionId: sessionLog.sessionId,
			topicId: generateTopicId(),
			tenantId: generateTenantId(),
			resumeHandler: async () => decision,
			retry: false,
			...extra,
		} as unknown as QueryParams,
		() => {},
	)
	return { turn, execute }
}

const touch: MockTurn = {
	toolCalls: [{ id: 'c1', name: 'bash', args: { command: 'touch made.txt' } }],
}

describe('what the record says of a call that did not run', () => {
	it('says a command that ran may have changed files, when it did run', async () => {
		const { turn, execute } = await run([touch, { text: 'done' }])
		expect(execute).toHaveBeenCalledTimes(1)
		expect(turn.outcome?.verdict).toBe('unknown')
	})

	it('says nothing changed for a command the person declined', async () => {
		const { turn, execute } = await run([touch, { text: 'ok, not doing it' }], {
			action: 'reject_tools',
			feedback: 'The user declined this.',
			declined: {},
		})
		expect(execute).not.toHaveBeenCalled()
		expect(turn.outcome?.verdict).toBe('unchanged')
	})

	it('says nothing changed for a command a rule refused', async () => {
		const { turn, execute } = await run([touch, { text: 'blocked' }], undefined, {
			authorizationGate: {
				enabled: true,
				rules: [{ type: 'deny_by_name', toolNames: ['bash'] }],
				allowReadOnlyTools: false,
				denyDangerousPatterns: false,
				logDecisions: false,
			},
		})
		expect(execute).not.toHaveBeenCalled()
		expect(turn.outcome?.verdict).toBe('unchanged')
	})

	it('says nothing changed for a call to a tool that is not there', async () => {
		const { turn } = await run([
			{ toolCalls: [{ id: 'c1', name: 'no_such_tool', args: {} }] },
			{ text: 'could not' },
		])
		expect(turn.outcome?.verdict).toBe('unchanged')
	})

	it('says nothing changed for a mere launch, and still counts a command that ran after it', async () => {
		const launch: MockTurn = {
			toolCalls: [{ id: 'a1', name: 'Agent', args: { description: 'survey', background: true } }],
		}
		const launched = await run([launch, { text: 'launched' }])
		expect(launched.turn.outcome?.verdict).toBe('unchanged')
		const then = await run([launch, touch, { text: 'done' }])
		expect(then.turn.outcome?.verdict).toBe('unknown')
	})

	it('still treats a sub-agent that was waited for as work that may have changed files', async () => {
		const { turn } = await run([
			{ toolCalls: [{ id: 'a1', name: 'Agent', args: { description: 'survey' } }] },
			{ text: 'back' },
		])
		expect(turn.outcome?.verdict).toBe('unknown')
	})
})
