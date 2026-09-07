import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
	type RunEvent,
	ToolRegistry,
	defineTool,
	generateProjectId,
	generateSessionId,
	generateTenantId,
	generateTopicId,
	query,
} from '@namzu/sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { ZenProvider } from '../client.js'

const directories: string[] = []

afterEach(async () => {
	vi.unstubAllGlobals()
	await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

function response(toolRound: boolean): Response {
	const frames = toolRound
		? [
				{
					id: 'kernel-tool-turn',
					choices: [{ index: 0, delta: { role: 'assistant', content: 'Doubling the number.' } }],
				},
				{
					id: 'kernel-tool-turn',
					choices: [
						{
							index: 0,
							delta: {
								tool_calls: [
									{
										index: 0,
										id: 'double-call',
										type: 'function',
										function: { name: 'double', arguments: '{"value":' },
									},
								],
							},
						},
					],
				},
				{
					id: 'kernel-tool-turn',
					choices: [
						{
							index: 0,
							delta: { tool_calls: [{ index: 0, function: { arguments: '21}' } }] },
							finish_reason: 'tool_calls',
						},
					],
					usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 },
				},
			]
		: [
				{
					id: 'kernel-answer-turn',
					choices: [
						{
							index: 0,
							delta: { role: 'assistant', content: 'Twice 21 is 42.' },
							finish_reason: 'stop',
						},
					],
					usage: { prompt_tokens: 25, completion_tokens: 7, total_tokens: 32 },
				},
			]
	return new Response(
		`${frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join('')}data: [DONE]\n\n`,
		{
			headers: { 'content-type': 'text/event-stream' },
		},
	)
}

describe('Zen through the query kernel', () => {
	it('executes a registered toy tool and completes the next model turn with stable attribution', async () => {
		const workingDirectory = await mkdtemp(join(tmpdir(), 'namzu-zen-kernel-'))
		directories.push(workingDirectory)
		const sessionId = generateSessionId()
		const execute = vi.fn(async ({ value }: { value: number }) => ({
			success: true,
			output: String(value * 2),
		}))
		const tools = new ToolRegistry()
		tools.register(
			defineTool({
				name: 'double',
				description: 'Double a number without external effects',
				inputSchema: z.object({ value: z.number() }),
				category: 'analysis',
				permissions: [],
				readOnly: true,
				destructive: false,
				concurrencySafe: true,
				execute,
			}),
		)
		const requests: { headers: Headers; body: Record<string, unknown> }[] = []
		vi.stubGlobal(
			'fetch',
			vi.fn<typeof fetch>(async (input, init) => {
				expect(String(input)).toBe('https://opencode.ai/zen/v1/chat/completions')
				const body: Record<string, unknown> = JSON.parse(String(init?.body))
				requests.push({ headers: new Headers(init?.headers), body })
				if (requests.length === 1) {
					expect(execute).not.toHaveBeenCalled()
					expect(body.tools).toEqual(
						expect.arrayContaining([
							expect.objectContaining({
								type: 'function',
								function: expect.objectContaining({ name: 'double' }),
							}),
						]),
					)
				} else {
					expect(requests).toHaveLength(2)
					expect(execute).toHaveBeenCalledExactlyOnceWith({ value: 21 }, expect.anything())
					expect(body.messages).toEqual(
						expect.arrayContaining([
							expect.objectContaining({
								role: 'tool',
								tool_call_id: 'double-call',
								content: expect.stringContaining('42'),
							}),
						]),
					)
				}
				return response(requests.length === 1)
			}),
		)
		const provider = new ZenProvider({ apiKey: 'kernel-fixture-key', sessionId })
		const events: RunEvent[] = []
		for await (const event of query({
			provider,
			tools,
			workingDirectory,
			messages: [{ role: 'user', content: 'Use the double tool on 21 and tell me the result.' }],
			agentId: 'zen-kernel-test',
			agentName: 'Zen kernel integration',
			sessionId,
			topicId: generateTopicId(),
			projectId: generateProjectId(),
			tenantId: generateTenantId(),
			runConfig: {
				model: 'glm-5.3-flash',
				maxIterations: 3,
				timeoutMs: 10_000,
				tokenBudget: 100_000,
				maxResponseTokens: 256,
			},
			resumeHandler: async () => ({ action: 'continue' }),
			retry: false,
		}))
			events.push(event)

		expect(execute).toHaveBeenCalledTimes(1)
		expect(events.filter((event) => event.type === 'run_failed')).toEqual([])
		expect(events).toContainEqual(
			expect.objectContaining({ type: 'tool_executing', toolName: 'double', input: { value: 21 } }),
		)
		expect(events).toContainEqual(
			expect.objectContaining({
				type: 'tool_completed',
				toolName: 'double',
				result: expect.stringContaining('42'),
				isError: false,
			}),
		)
		expect(events).toContainEqual(
			expect.objectContaining({ type: 'run_completed', result: 'Twice 21 is 42.' }),
		)
		expect(requests).toHaveLength(2)
		for (const request of requests) {
			expect(request.headers.get('x-opencode-session')).toBe(sessionId)
			expect(request.headers.get('user-agent')).toMatch(/^namzu\//)
			expect(request.headers.get('authorization')).toBe('Bearer kernel-fixture-key')
			expect(request.body.model).toBe('glm-5.3-flash')
		}
	})
})
