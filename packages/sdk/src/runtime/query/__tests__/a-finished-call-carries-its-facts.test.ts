import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { MockLLMProvider } from '../../../provider/mock.js'
import { InMemorySessionLog } from '../../../store/session-log/index.js'
import { testToolset } from '../../../test-support/toolset.js'
import { defineTool } from '../../../tools/defineTool.js'
import type { AuthorizationGateConfig } from '../../../types/authorization/index.js'
import type { SessionEvent } from '../../../types/session/index.js'
import {
	generateProjectId,
	generateSessionId,
	generateTenantId,
	generateTopicId,
} from '../../../utils/id.js'
import { drainQuery } from '../index.js'

/**
 * The person's view of a call is built from typed fields, so the fields have
 * to reach the event, and a refusal has to say what kind it was without
 * anyone reading its wording.
 */

const gate: AuthorizationGateConfig = {
	enabled: true,
	rules: [
		{
			type: 'custom_pattern',
			pattern: 'sudo',
			target: 'args',
			decision: 'deny',
		},
		{
			type: 'custom_pattern',
			pattern: 'rm -r',
			target: 'args',
			decision: 'deny',
		},
		{ type: 'allow_by_name', toolNames: ['shell', 'probe'] },
	],
	allowReadOnlyTools: false,
	denyDangerousPatterns: false,
	logDecisions: false,
}

const shell = defineTool({
	name: 'shell',
	description: 'a shell fixture',
	inputSchema: z.object({ command: z.string() }),
	category: 'shell',
	permissions: ['shell_execute'],
	readOnly: false,
	destructive: false,
	concurrencySafe: false,
	execute: async () => ({ success: true, output: 'ran' }),
})

const probe = defineTool({
	name: 'probe',
	description: 'reports facts',
	inputSchema: z.object({}),
	category: 'shell',
	permissions: [],
	readOnly: true,
	destructive: false,
	concurrencySafe: true,
	execute: async () => ({
		success: true,
		output: 'STDOUT:\nhi',
		facts: {
			kind: 'command',
			exitCode: 0,
			stdout: { head: 'hi', totalLines: 1, totalBytes: 3 },
		},
	}),
})

async function completed(
	calls: { id: string; name: string; args: Record<string, unknown> }[],
): Promise<Extract<SessionEvent, { type: 'tool_completed' }>[]> {
	const sessionLog = new InMemorySessionLog({ sessionId: generateSessionId() })
	const events: SessionEvent[] = []
	await drainQuery(
		{
			provider: new MockLLMProvider({
				turns: [{ toolCalls: calls }, { text: 'done' }],
			}),
			toolsets: [testToolset(shell, probe)],
			sessionLog,
			agentId: 'facts-agent',
			agentName: 'Facts Agent',
			messages: [{ role: 'user' as const, content: 'go' }],
			workingDirectory: process.cwd(),
			turnConfig: {
				model: 'mock',
				tokenBudget: 100_000,
				timeoutMs: 5_000,
				maxIterations: 4,
			},
			projectId: generateProjectId(),
			sessionId: sessionLog.sessionId,
			topicId: generateTopicId(),
			tenantId: generateTenantId(),
			authorizationGate: gate,
		},
		(event) => {
			events.push(event)
		},
	)
	return events.filter(
		(event): event is Extract<SessionEvent, { type: 'tool_completed' }> =>
			event.type === 'tool_completed',
	)
}

describe('a finished call', () => {
	it('carries the facts its tool returned and keeps the model text as it was', async () => {
		const [event] = await completed([{ id: 'c1', name: 'probe', args: {} }])
		expect(event?.result).toBe('STDOUT:\nhi')
		expect(event?.facts).toEqual({
			kind: 'command',
			exitCode: 0,
			stdout: { head: 'hi', totalLines: 1, totalBytes: 3 },
		})
	})

	it('says a command asking for administrator rights was refused as that', async () => {
		const [event] = await completed([{ id: 'c1', name: 'shell', args: { command: 'sudo rm x' } }])
		expect(event?.isError).toBe(true)
		expect(event?.facts).toEqual({
			kind: 'failure',
			reason: 'needs_administrator',
			subject: 'shell',
		})
	})

	it('says any other policy refusal was a block', async () => {
		const [event] = await completed([{ id: 'c1', name: 'shell', args: { command: 'rm -r x' } }])
		expect(event?.facts).toEqual({
			kind: 'failure',
			reason: 'blocked',
			subject: 'shell',
		})
	})

	it('names a tool the registry does not hold', async () => {
		const [event] = await completed([{ id: 'c1', name: 'ls', args: {} }])
		expect(event?.isError).toBe(true)
		expect(event?.facts).toEqual({
			kind: 'failure',
			reason: 'unknown_tool',
			subject: 'ls',
		})
	})
})
