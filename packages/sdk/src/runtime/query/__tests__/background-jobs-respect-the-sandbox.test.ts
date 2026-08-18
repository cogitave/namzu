import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import { MockLLMProvider, registerMock } from '../../../provider/index.js'
import { ToolRegistry } from '../../../registry/index.js'
import { BackgroundJobRegistry } from '../../../runtime/jobs/registry.js'
import { BashTool } from '../../../tools/builtins/bash.js'
import { defineTool } from '../../../tools/defineTool.js'
import type { SandboxId, SessionId, TenantId } from '../../../types/ids/index.js'
import { createUserMessage } from '../../../types/message/index.js'
import type { RunEvent } from '../../../types/run/index.js'
import type { Sandbox, SandboxProvider } from '../../../types/sandbox/index.js'
import type { ProjectId, TopicId } from '../../../types/session/ids.js'
import { drainQuery } from '../index.js'

registerMock()

const REFUSAL =
	'run_in_background is unavailable while a sandbox is active because the host background-job registry cannot preserve that sandbox boundary. Run the command in the foreground, or use a sandbox-aware persistent-process capability.'
const dirs: string[] = []

afterEach(async () => {
	await removeTempDirs(dirs)
	dirs.length = 0
})

async function workdir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), 'namzu-sandbox-jobs-'))
	dirs.push(dir)
	return dir
}

function sandbox(): Sandbox {
	return {
		id: 'sbx_test' as SandboxId,
		status: 'ready',
		rootDir: '/workspace',
		environment: 'basic',
		exec: vi.fn(async () => {
			throw new Error('sandbox execution must not start for a refused background request')
		}),
		writeFile: vi.fn(async () => {}),
		readFile: vi.fn(async () => Buffer.alloc(0)),
		listFiles: vi.fn(async () => []),
		destroy: vi.fn(async () => {}),
	}
}

function params(input: {
	readonly cwd: string
	readonly tools: ToolRegistry
	readonly provider: MockLLMProvider
	readonly sandbox: Sandbox
	readonly backgroundJobs: BackgroundJobRegistry
}) {
	return {
		provider: input.provider,
		tools: input.tools,
		runConfig: {
			model: 'mock',
			timeoutMs: 10_000,
			tokenBudget: 100_000,
			maxIterations: 3,
			maxResponseTokens: 256,
		},
		agentId: 'agent_sandbox_jobs',
		agentName: 'Sandbox jobs',
		messages: [createUserMessage('run it')],
		workingDirectory: input.cwd,
		sessionId: 'ses_sandbox_jobs' as SessionId,
		topicId: 'top_sandbox_jobs' as TopicId,
		projectId: 'prj_sandbox_jobs' as ProjectId,
		tenantId: 'tnt_sandbox_jobs' as TenantId,
		sandboxProvider: {
			id: 'sandbox-test',
			name: 'Sandbox test',
			environment: input.sandbox.environment,
			create: async () => input.sandbox,
		} satisfies SandboxProvider,
		backgroundJobs: input.backgroundJobs,
	}
}

describe('a sandbox and a host background registry are not one capability', () => {
	it('withholds the host process capability from every tool context', async () => {
		const observed: Array<{ sandbox: boolean; backgroundJobs: boolean }> = []
		const tools = new ToolRegistry()
		tools.register(
			defineTool({
				name: 'inspect_context',
				description: 'Inspect the execution capabilities supplied to this tool.',
				inputSchema: z.object({}),
				category: 'analysis',
				permissions: [],
				readOnly: true,
				destructive: false,
				concurrencySafe: true,
				execute: async (_input, context) => {
					observed.push({
						sandbox: context.sandbox !== undefined,
						backgroundJobs: context.backgroundJobs !== undefined,
					})
					return { success: true, output: 'inspected' }
				},
			}),
		)

		await drainQuery(
			params({
				cwd: await workdir(),
				tools,
				provider: new MockLLMProvider({
					turns: [
						{ toolCalls: [{ id: 'call_1', name: 'inspect_context', args: {} }] },
						{ text: 'done' },
					],
				}),
				sandbox: sandbox(),
				backgroundJobs: new BackgroundJobRegistry(),
			}),
		)

		expect(observed).toEqual([{ sandbox: true, backgroundJobs: false }])
	})

	it('returns the sandbox-conflict refusal through the real tool event path', async () => {
		const tools = new ToolRegistry()
		tools.register(BashTool)
		const boundary = sandbox()
		const seen: RunEvent[] = []

		await drainQuery(
			params({
				cwd: await workdir(),
				tools,
				provider: new MockLLMProvider({
					turns: [
						{
							toolCalls: [
								{
									id: 'call_1',
									name: 'bash',
									args: {
										command: 'printf should-not-run',
										timeout: 1_000,
										run_in_background: true,
									},
								},
							],
						},
						{ text: 'done' },
					],
				}),
				sandbox: boundary,
				backgroundJobs: new BackgroundJobRegistry(),
			}),
			(event) => {
				seen.push(event)
			},
		)

		expect(seen.some((event) => event.type === 'tool_executing')).toBe(true)
		expect(seen.find((event) => event.type === 'tool_completed')).toMatchObject({
			type: 'tool_completed',
			isError: true,
			result: `Error: ${REFUSAL}`,
		})
		expect(boundary.exec).not.toHaveBeenCalled()
	})
})
