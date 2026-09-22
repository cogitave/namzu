import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import { MockLLMProvider } from '../../../provider/mock.js'
import { ToolRegistry } from '../../../registry/tool/execute.js'
import { createRuntimeContextMessage, createUserMessage } from '../../../types/message/index.js'
import {
	generateProjectId,
	generateSessionId,
	generateTenantId,
	generateTopicId,
} from '../../../utils/id.js'
import { drainQuery } from '../index.js'

const dirs: string[] = []
afterEach(async () => removeTempDirs(dirs.splice(0)))

describe('advisory context after actual tool execution', () => {
	it.each(['trigger', 'tool'] as const)(
		'retains rich evidence and its call in a %s consultation',
		async (mode) => {
			const workingDirectory = await mkdtemp(join(tmpdir(), 'namzu-advisory-history-'))
			dirs.push(workingDirectory)
			const tools = new ToolRegistry()
			tools.register({
				name: 'observe',
				description: 'Read fixture evidence.',
				inputSchema: z.object({}),
				execute: async () => ({
					success: true,
					output: 'receipt=NEW; no support for OLD',
					content: [
						{ type: 'text' as const, text: 'receipt=NEW; no support for OLD' },
						{ type: 'image' as const, mediaType: 'image/png', data: 'PRIVATE_IMAGE_BYTES' },
					],
				}),
			})
			const main = new MockLLMProvider({
				turns: [
					{
						text: 'I think receipt=OLD.',
						toolCalls: [{ id: 'observation', name: 'observe', args: {} }],
					},
					...(mode === 'tool'
						? [
								{
									toolCalls: [
										{
											id: 'consult',
											name: 'consult_advisor',
											args: { question: 'Review evidence.' },
										},
									],
								},
							]
						: []),
					{ text: 'The observation supports NEW.' },
				],
			})
			const advisor = new MockLLMProvider({
				turns: [{ text: 'Use the actual observation, not the earlier claim.' }],
			})
			const result = await drainQuery({
				provider: main,
				tools,
				workingDirectory,
				retry: false,
				turnConfig: { model: 'mock', maxIterations: 5, timeoutMs: 5000, tokenBudget: 10000 },
				tenantId: generateTenantId(),
				projectId: generateProjectId(),
				sessionId: generateSessionId(),
				topicId: generateTopicId(),
				agentId: 'advisory-history',
				agentName: 'History inspection',
				messages: [
					createUserMessage('Check the receipt.'),
					createRuntimeContextMessage('A prior claim needs checking.', 'step-context'),
				],
				advisory: {
					advisors: [
						{
							id: 'reviewer',
							name: 'Reviewer',
							model: 'mock',
							provider: advisor,
							maxContextTokens: 2000,
						},
					],
					budget: { maxCallsPerTurn: 1 },
					enableAgentTool: mode === 'tool',
					...(mode === 'trigger'
						? {
								triggers: [
									{
										id: 'after-observation',
										condition: { type: 'on_iteration' as const, everyN: 1 },
									},
								],
							}
						: {}),
				},
			})
			expect(result.stopReason).toBe('end_turn')
			expect(advisor.requests).toHaveLength(1)
			const request = advisor.requests[0]
			expect(request?.toolChoice).toBe('none')
			const text = String(request?.messages[1]?.content)
			const rows = text
				.split('\n')
				.filter((line) => line.startsWith('{'))
				.map((line) => JSON.parse(line))
			expect(rows.some((row) => row.source?.kind === 'step-context')).toBe(true)
			expect(rows.find((row) => row.role === 'assistant')?.toolCalls).toEqual([
				{ id: 'observation', name: 'observe', arguments: '{}' },
			])
			const observed = rows.find((row) => row.role === 'tool' && row.toolCallId === 'observation')
			expect(observed?.isError).toBe(false)
			expect(observed?.content).toEqual([
				{ type: 'text', text: 'receipt=NEW; no support for OLD' },
				{ type: 'image', mediaType: 'image/png', contentOmitted: true },
			])
			expect(text).not.toContain('PRIVATE_IMAGE_BYTES')
			expect(text).not.toContain('[object Object]')
			expect(
				main.requests
					.at(-1)
					?.messages.some(
						(message) =>
							message.role === (mode === 'trigger' ? 'user' : 'tool') &&
							typeof message.content === 'string' &&
							message.content.includes('Use the actual observation'),
					),
			).toBe(true)
		},
	)
})
