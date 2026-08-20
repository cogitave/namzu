/** A real run carries the read fingerprint into the later full-file write. */

import { writeFileSync } from 'node:fs'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'

import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import { MockLLMProvider } from '../../../provider/mock.js'
import { ToolRegistry } from '../../../registry/tool/execute.js'
import { ReadFileTool, WriteFileTool } from '../../../tools/builtins/index.js'
import { createUserMessage } from '../../../types/message/index.js'
import {
	generateProjectId,
	generateSessionId,
	generateTenantId,
	generateTopicId,
} from '../../../utils/id.js'
import { drainQuery } from '../index.js'

const roots: string[] = []

afterEach(async () => {
	await removeTempDirs(roots)
	roots.length = 0
})

it('returns admission-time drift to the model and preserves the newer body', async () => {
	const workingDirectory = await mkdtemp(join(tmpdir(), 'namzu-query-stale-write-'))
	roots.push(workingDirectory)
	const file = join(workingDirectory, 'doc.md')
	await writeFile(file, 'body the model will read\n', 'utf-8')

	const provider = new MockLLMProvider({
		nextTurn: (_params, index) => {
			if (index === 0) {
				return {
					toolCalls: [{ id: 'call_read', name: 'read', args: { path: 'doc.md' } }],
					finishReason: 'tool_calls',
				}
			}
			if (index === 1) {
				// Outside the tool runtime: the exact production shape the process-local
				// mutation lock cannot serialize. It happens before write admission,
				// which is the bounded property this iteration claims.
				writeFileSync(file, 'newer body from another writer\n', 'utf-8')
				return {
					toolCalls: [
						{
							id: 'call_write',
							name: 'write',
							args: { path: 'doc.md', content: 'stale full replacement\n' },
						},
					],
					finishReason: 'tool_calls',
				}
			}
			return { text: 'The file changed after I read it, so I left the newer body intact.' }
		},
	})
	const tools = new ToolRegistry()
	tools.register(ReadFileTool)
	tools.register(WriteFileTool)

	const run = await drainQuery({
		provider,
		tools,
		agentId: 'agent_stale_write',
		agentName: 'Stale Write Agent',
		messages: [createUserMessage('read doc.md and then replace it')],
		workingDirectory,
		runConfig: {
			model: 'mock-model',
			tokenBudget: 100_000,
			timeoutMs: 30_000,
			maxIterations: 4,
			maxResponseTokens: 256,
		},
		projectId: generateProjectId(),
		sessionId: generateSessionId(),
		topicId: generateTopicId(),
		tenantId: generateTenantId(),
	})

	expect(run.status).toBe('completed')
	expect(provider.requests).toHaveLength(3)
	const modelSaw = JSON.stringify(provider.requests[2]?.messages)
	expect(modelSaw).toContain('this write was based on a stale copy')
	expect(modelSaw).toContain('Nothing was written')
	expect(await readFile(file, 'utf-8')).toBe('newer body from another writer\n')
})
