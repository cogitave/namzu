import { mkdtemp, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import { MockLLMProvider } from '../../../provider/mock.js'
import { ToolRegistry } from '../../../registry/tool/execute.js'
import { LocalSandboxProvider } from '../../../sandbox/provider/local.js'
import { BashTool } from '../../../tools/builtins/bash.js'
import { WriteFileTool } from '../../../tools/builtins/write-file.js'
import type { ProjectId, SessionId, TenantId, TopicId } from '../../../types/ids/index.js'
import { createUserMessage } from '../../../types/message/index.js'
import { NOOP_LOGGER } from '../../../utils/log/create-logger.js'
import { drainQuery } from '../index.js'

/**
 * The CLI does not keep one sandbox process alive for a whole conversation.
 * It creates one SDK run per turn, and each run owns and tears down its own
 * sandbox handle. The project tree is caller-owned state, so a second run must
 * see the first run's real built-in tool effects after that teardown.
 */

const workspaces: string[] = []

afterEach(async () => {
	await removeTempDirs(workspaces)
	workspaces.length = 0
})

function tools(): ToolRegistry {
	const registry = new ToolRegistry()
	registry.register([WriteFileTool, BashTool])
	return registry
}

async function run(
	workingDirectory: string,
	provider: MockLLMProvider,
): Promise<Awaited<ReturnType<typeof drainQuery>>> {
	return drainQuery({
		provider,
		tools: tools(),
		sandboxProvider: new LocalSandboxProvider(NOOP_LOGGER),
		runConfig: {
			model: 'mock-model',
			timeoutMs: 20_000,
			tokenBudget: 100_000,
			maxIterations: 4,
			sandbox: { workspace: 'working-directory' },
		},
		agentId: 'agent_workspace',
		agentName: 'Workspace agent',
		messages: [createUserMessage('work in the project')],
		workingDirectory,
		sessionId: 'ses_workspace' as SessionId,
		topicId: 'top_workspace' as TopicId,
		projectId: 'prj_workspace' as ProjectId,
		tenantId: 'tnt_workspace' as TenantId,
	})
}

describe('a caller-owned workspace across SDK runs', () => {
	it('keeps real write and bash effects reachable after each run tears its handle down', async () => {
		const workingDirectory = await mkdtemp(join(process.cwd(), 'namzu-query-workspace-'))
		workspaces.push(workingDirectory)

		const first = await run(
			workingDirectory,
			new MockLLMProvider({
				turns: [
					{
						toolCalls: [
							{
								id: 'call_write',
								name: 'write',
								args: { path: 'from-write.txt', content: 'first turn' },
							},
							{
								id: 'call_bash',
								name: 'bash',
								args: { command: "printf 'first shell' > from-bash.txt" },
							},
						],
					},
					{ text: 'first turn complete' },
				],
			}),
		)
		expect(first.status).toBe('completed')

		const second = await run(
			workingDirectory,
			new MockLLMProvider({
				turns: [
					{
						toolCalls: [
							{
								id: 'call_verify',
								name: 'bash',
								args: {
									command:
										"test \"$(cat from-write.txt)\" = 'first turn' && test \"$(cat from-bash.txt)\" = 'first shell' && printf 'second turn' > from-second.txt",
								},
							},
						],
					},
					{ text: 'second turn complete' },
				],
			}),
		)

		expect(second.status).toBe('completed')
		expect(await readFile(`${workingDirectory}/from-second.txt`, 'utf8')).toBe('second turn')
	})
})
