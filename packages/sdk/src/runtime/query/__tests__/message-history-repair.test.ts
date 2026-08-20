import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'

import { MockLLMProvider } from '../../../provider/mock.js'
import { ToolRegistry } from '../../../registry/tool/execute.js'
import type { NamzuError } from '../../../types/errors/index.js'
import type { SessionId, TenantId } from '../../../types/ids/index.js'
import {
	createAssistantMessage,
	createSystemMessage,
	createToolMessage,
	createUserMessage,
} from '../../../types/message/index.js'
import type { RunEvent } from '../../../types/run/index.js'
import type { ProjectId, TopicId } from '../../../types/session/ids.js'
import { drainQuery } from '../index.js'

const dirs: string[] = []

afterEach(async () => {
	await removeTempDirs(dirs)
	dirs.length = 0
})

async function workdir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), 'namzu-history-repair-'))
	dirs.push(dir)
	return dir
}

async function params(provider: MockLLMProvider) {
	return {
		provider,
		tools: new ToolRegistry(),
		runConfig: {
			model: 'mock-model',
			timeoutMs: 5_000,
			tokenBudget: 100_000,
			maxIterations: 1,
			maxResponseTokens: 256,
		},
		agentId: 'agent_history_repair',
		agentName: 'History Repair',
		workingDirectory: await workdir(),
		sessionId: 'ses_history_repair' as SessionId,
		topicId: 'top_history_repair' as TopicId,
		projectId: 'prj_history_repair' as ProjectId,
		tenantId: 'tnt_history_repair' as TenantId,
	}
}

describe('query() repairs provider-invalid tool history at the real boundary', () => {
	it('repairs chronological violations, emits measured counts, and sends only the projection', async () => {
		const provider = new MockLLMProvider({ turns: [{ text: 'continued safely' }] })
		const events: RunEvent[] = []
		const callA = {
			id: 'call-a',
			type: 'function' as const,
			function: { name: 'charge_card', arguments: '{"amount":42}' },
		}
		const callB = {
			id: 'call-b',
			type: 'function' as const,
			function: { name: 'read_record', arguments: '{}' },
		}
		const assistant = createAssistantMessage('working', [callA, callB])
		const realA = createToolMessage('charged once', callA.id)
		const messages = [
			createUserMessage('continue an imported conversation'),
			createToolMessage('result before any owner', 'call-orphan'),
			assistant,
			createToolMessage('stale duplicate', callA.id),
			realA,
			createUserMessage('the process restarted here'),
			createToolMessage('displaced result', callB.id),
			createUserMessage('what happened?'),
		]

		const run = await drainQuery({ ...(await params(provider)), messages }, (event) => {
			events.push(event)
		})

		expect(run.status).toBe('completed')
		const sent = provider.requests[0]?.messages ?? []
		expect(sent).not.toContainEqual(expect.objectContaining({ content: 'result before any owner' }))
		expect(sent).not.toContainEqual(expect.objectContaining({ content: 'stale duplicate' }))
		expect(sent).not.toContainEqual(expect.objectContaining({ content: 'displaced result' }))
		const ownerIndex = sent.indexOf(assistant)
		expect(ownerIndex).toBeGreaterThanOrEqual(0)
		expect(sent[ownerIndex + 1]).toBe(realA)
		expect(sent[ownerIndex + 2]).toMatchObject({
			role: 'tool',
			toolCallId: callB.id,
			isError: true,
		})
		expect(sent[ownerIndex + 2]?.content).toContain('outcome is unknown')
		expect(sent[ownerIndex + 3]?.role).toBe('user')

		const repairIndex = events.findIndex((event) => event.type === 'message_history_repaired')
		const requestIndex = events.findIndex((event) => event.type === 'request_envelope')
		expect(events[0]?.type).toBe('run_started')
		expect(repairIndex).toBeGreaterThan(0)
		expect(repairIndex).toBeLessThan(requestIndex)
		expect(events[repairIndex]).toMatchObject({
			type: 'message_history_repaired',
			source: 'fresh-history',
			duplicateToolResultsRemoved: 1,
			orphanedToolResultsRemoved: 2,
			syntheticToolResultsInserted: 1,
		})
		expect(run.messages).toContain(assistant)
		expect(run.messages).toContain(realA)
		expect(run.messages).toContain(sent[ownerIndex + 2])
	})

	it('refuses duplicate call ids before provider construction can consume the history', async () => {
		const provider = new MockLLMProvider({ turns: [{ text: 'must not run' }] })
		const duplicate = {
			id: 'call-same',
			type: 'function' as const,
			function: { name: 'write_once', arguments: '{}' },
		}

		await expect(
			drainQuery({
				...(await params(provider)),
				messages: [
					createUserMessage('start'),
					createAssistantMessage('first', [duplicate]),
					createToolMessage('done', duplicate.id),
					createAssistantMessage('repeated', [duplicate]),
				],
			}),
		).rejects.toMatchObject({
			code: 'invalid_config',
			details: { messageIndex: 3, callIndex: 0, toolCallId: duplicate.id },
		} satisfies Partial<NamzuError>)
		expect(provider.requests).toHaveLength(0)
	})

	it('drops stale prompt floors before deciding whether an exact tool result is displaced', async () => {
		const provider = new MockLLMProvider({ turns: [{ text: 'used the observed result' }] })
		const events: RunEvent[] = []
		const call = {
			id: 'call-observed',
			type: 'function' as const,
			function: { name: 'charge_card', arguments: '{"amount":42}' },
		}
		const assistant = createAssistantMessage('charging', [call])
		const observed = createToolMessage('charged exactly once', call.id)

		const run = await drainQuery(
			{
				...(await params(provider)),
				messages: [
					createUserMessage('continue'),
					assistant,
					createSystemMessage('stale host prompt that this fresh run rebuilds'),
					observed,
					createUserMessage('what happened?'),
				],
			},
			(event) => {
				events.push(event)
			},
		)

		const sent = provider.requests[0]?.messages ?? []
		const assistantIndex = sent.indexOf(assistant)
		expect(assistantIndex).toBeGreaterThanOrEqual(0)
		expect(sent[assistantIndex + 1]).toBe(observed)
		expect(
			sent.some((message) => message.role === 'system' && message.content.includes('stale host')),
		).toBe(false)
		expect(
			sent.some(
				(message) =>
					message.role === 'tool' && message.toolCallId === call.id && message.isError === true,
			),
		).toBe(false)
		expect(run.messages).toContain(observed)
		expect(events.some((event) => event.type === 'message_history_repaired')).toBe(false)
	})
})
