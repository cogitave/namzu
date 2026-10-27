import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { MockLLMProvider } from '../../../provider/mock.js'
import { InMemorySessionLog } from '../../../store/session-log/index.js'
import { testToolset } from '../../../test-support/toolset.js'
import { defineTool } from '../../../tools/defineTool.js'
import { type Message, createUserMessage } from '../../../types/message/index.js'
import {
	generateProjectId,
	generateSessionId,
	generateTenantId,
	generateTopicId,
} from '../../../utils/id.js'
import { drainQuery } from '../index.js'
import { takeWithheldEnvNotice } from '../steering.js'

const text = (message: Message) => (typeof message.content === 'string' ? message.content : '')
const notices = (messages: readonly Message[]) =>
	messages.filter((m) => m.role === 'user' && text(m).includes(' kind="credentials">'))

async function run(counts: readonly (number | undefined)[]) {
	const sessionId = generateSessionId()
	let call = 0
	const tool = defineTool({
		name: 'shell_like',
		description: 'A command that fails after variables were removed from its environment',
		inputSchema: z.object({ n: z.number() }),
		category: 'analysis',
		permissions: [],
		readOnly: true,
		destructive: false,
		concurrencySafe: true,
		execute: async () => {
			const withheld = counts[call++]
			return {
				success: false,
				output: 'STDERR:\nauthentication failed',
				error: 'Command exited with code 1',
				data: withheld === undefined ? {} : { withheldEnv: withheld },
			}
		},
	})
	return drainQuery({
		provider: new MockLLMProvider({
			turns: [
				...counts.map((_, i) => ({
					toolCalls: [{ id: `call_${i}`, name: 'shell_like', args: { n: i } }],
				})),
				{ text: 'done' },
			],
		}),
		toolsets: [testToolset(tool)],
		agentId: 'credential-notice-test',
		agentName: 'Credential notice test',
		messages: [createUserMessage('run it')],
		workingDirectory: process.cwd(),
		projectId: generateProjectId(),
		sessionId,
		sessionLog: new InMemorySessionLog({ sessionId }),
		tenantId: generateTenantId(),
		topicId: generateTopicId(),
		turnConfig: { model: 'mock', timeoutMs: 10_000, tokenBudget: 100_000, maxIterations: 8 },
	})
}

describe('the credential notice', () => {
	it('is its own framed message after the tool result and leaves the result as the command printed it', async () => {
		const result = await run([4])
		const sent = notices(result.messages)
		expect(sent).toHaveLength(1)
		expect(text(sent[0] as Message)).toContain('4 credential-shaped environment variables')
		const tools = result.messages.filter((m) => m.role === 'tool')
		expect(tools.map(text).join('\n')).not.toMatch(/credential-shaped|NOTE:/)
		const order = result.messages.map((m) => m.role)
		expect(order.indexOf('user', order.indexOf('tool'))).toBe(order.indexOf('tool') + 1)
	})

	it('is sent once for the same set and again when the set changes', async () => {
		const result = await run([4, 4, undefined, 4, 2])
		const sent = notices(result.messages).map(text)
		expect(sent).toHaveLength(2)
		expect(sent[0]).toContain('4 credential-shaped')
		expect(sent[1]).toContain('2 credential-shaped')
	})

	it('says nothing when a batch removed nothing', () => {
		expect(takeWithheldEnvNotice([], [{ result: { data: { exitCode: 1 } } }])).toBeUndefined()
		expect(takeWithheldEnvNotice([], [{ result: {} }])).toBeUndefined()
	})

	it('is not repeated by a resumed conversation that already holds it', () => {
		const first = takeWithheldEnvNotice([], [{ result: { data: { withheldEnv: 3 } } }])
		expect(first).toBeDefined()
		expect(
			takeWithheldEnvNotice([first as Message], [{ result: { data: { withheldEnv: 3 } } }]),
		).toBeUndefined()
	})
})
