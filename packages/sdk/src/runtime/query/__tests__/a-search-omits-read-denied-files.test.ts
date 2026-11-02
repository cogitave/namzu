import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import { MockLLMProvider, registerMock } from '../../../provider/index.js'
import { InMemorySessionLog } from '../../../store/session-log/index.js'
import { testToolset } from '../../../test-support/toolset.js'
import { GrepTool } from '../../../tools/builtins/grep.js'
import { ToolManager } from '../../../toolsets/manager.js'
import type { TenantId } from '../../../types/ids/index.js'
import { type Message, createUserMessage } from '../../../types/message/index.js'
import type { ProjectId, TopicId } from '../../../types/session/ids.js'
import { generateSessionId } from '../../../utils/id.js'
import { type QueryParams, drainQuery } from '../index.js'
import { createReviewHandler } from '../review-policy.js'

/**
 * `grep` through the real executor and a real authorization gate: a path a
 * `read` deny rule covers is not listed and not opened, with no rule on `grep`
 * itself.
 */

registerMock()

const dirs: string[] = []

afterEach(async () => {
	await removeTempDirs(dirs)
	dirs.length = 0
})

const ids = {
	topicId: '78bd1b88-07a8-43ba-b3c1-cc02468a3781' as TopicId,
	projectId: '38018058-7f48-4a66-8cac-67bc513451f4' as ProjectId,
	tenantId: '56b14123-e653-4cef-ac96-21f2d79d9bbd' as TenantId,
}

function toolTexts(messages: readonly Message[]): string {
	return messages
		.filter((m) => m.role === 'tool' && typeof m.content === 'string')
		.map((m) => m.content as string)
		.join('\n')
}

describe('a search under a read deny rule', () => {
	it('omits the denied file and keeps the others', async () => {
		const cwd = await mkdtemp(join(tmpdir(), 'namzu-readdenied-'))
		dirs.push(cwd)
		await writeFile(join(cwd, '.env'), 'needle=SECRET_VALUE\n')
		await writeFile(join(cwd, 'a.txt'), 'needle\n')
		const tools = testToolset(GrepTool)
		const registry = new ToolManager({ toolsets: [tools], messages: () => [] })
		const sessionId = generateSessionId()
		const result = await drainQuery({
			provider: new MockLLMProvider({
				turns: [
					{
						toolCalls: [
							{
								id: 'c1',
								name: 'grep',
								args: { pattern: 'needle', output_mode: 'content' },
							},
						],
						finishReason: 'tool_calls',
					},
					{ text: 'done' },
				],
			}),
			toolsets: [tools],
			turnConfig: { model: 'mock', timeoutMs: 20_000, tokenBudget: 200_000, maxIterations: 4 },
			agentId: 'a',
			agentName: 'A',
			messages: [createUserMessage('search')],
			workingDirectory: cwd,
			authorizationGate: {
				enabled: true,
				allowReadOnlyTools: true,
				denyDangerousPatterns: false,
				logDecisions: false,
				rules: [
					{
						type: 'argument_pattern',
						toolNames: ['read'],
						argument: 'path',
						pattern: '(^|/)\\.env$',
						decision: 'deny',
					},
				],
			},
			resumeHandler: createReviewHandler({ mode: 'auto', registry }),
			sessionId,
			sessionLog: new InMemorySessionLog({ sessionId }),
			...ids,
		} as QueryParams)
		const text = toolTexts(result.messages)
		expect(text).toContain('a.txt')
		expect(text).not.toContain('SECRET_VALUE')
		expect(text).not.toContain('.env')
	})
})
