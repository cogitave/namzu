import { ChildProcess, spawn } from 'node:child_process'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import { MockLLMProvider, registerMock } from '../../../provider/index.js'
import { ToolRegistry } from '../../../registry/index.js'
import { BackgroundJobRegistry } from '../../../runtime/jobs/registry.js'
import { BashTool, SANDBOX_CANNOT_DETACH } from '../../../tools/builtins/bash.js'
import { defineTool } from '../../../tools/defineTool.js'
import type { SandboxId, SessionId, TenantId } from '../../../types/ids/index.js'
import { createUserMessage } from '../../../types/message/index.js'
import type { RunEvent } from '../../../types/run/index.js'
import type { Sandbox, SandboxProvider } from '../../../types/sandbox/index.js'
import type { ProjectId, TopicId } from '../../../types/session/ids.js'
import { drainQuery } from '../index.js'

vi.mock('node:child_process', async (importOriginal) => {
	const actual = await importOriginal<typeof import('node:child_process')>()
	return {
		...actual,
		spawn: vi.fn(() => {
			throw new Error('a sandboxed background job must not spawn on the host')
		}),
	}
})

registerMock()

const REFUSAL = SANDBOX_CANNOT_DETACH
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
		id: '51281012-1dd1-444d-98b8-487422669dff' as SandboxId,
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
	readonly env?: Record<string, string>
}) {
	return {
		provider: input.provider,
		tools: input.tools,
		runConfig: {
			model: 'mock',
			env: input.env,
			timeoutMs: 10_000,
			tokenBudget: 100_000,
			maxIterations: 3,
			maxResponseTokens: 256,
		},
		agentId: 'agent_sandbox_jobs',
		agentName: 'Sandbox jobs',
		messages: [createUserMessage('run it')],
		workingDirectory: input.cwd,
		sessionId: 'd197741b-86af-4154-8d13-3cc7c9067200' as SessionId,
		topicId: 'c2a1f76c-e2c9-406f-99fd-f7d471c7d71a' as TopicId,
		projectId: '8ab67399-c3e7-409b-ad7b-a2bf0bcf7774' as ProjectId,
		tenantId: '488262fe-6f12-4a4e-b30e-3712a9c5aa7a' as TenantId,
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
	it('starts and stops a background job through the sandbox instead of spawning on the host', async () => {
		const cwd = await workdir()
		const owner = 'd197741b-86af-4154-8d13-3cc7c9067200'
		const command = 'printf sandbox-output'
		const jobs = new BackgroundJobRegistry()
		const child = new ChildProcess()
		const output = new PassThrough()
		const errors = new PassThrough()
		child.stdout = output
		child.stderr = errors
		const kill = vi.fn((signal: NodeJS.Signals) => {
			child.emit('close', null, signal)
		})
		const spawnDetached = vi.fn(() => ({ child, kill }))
		const boundary: Sandbox = { ...sandbox(), spawnDetached }
		const tools = new ToolRegistry()
		tools.register(BashTool)
		const seen: RunEvent[] = []
		vi.mocked(spawn).mockClear()

		try {
			await drainQuery(
				{
					...params({
						cwd,
						tools,
						provider: new MockLLMProvider({
							turns: [
								{
									toolCalls: [
										{
											id: 'call_detached',
											name: 'bash',
											args: { command, run_in_background: true },
										},
									],
								},
								{ text: 'done' },
							],
						}),
						sandbox: boundary,
						backgroundJobs: jobs,
						env: { NAMZU_JOB_FIXTURE: 'sandbox' },
					}),
					backgroundJobOwner: owner,
				},
				(event) => {
					seen.push(event)
				},
			)

			expect(spawnDetached).toHaveBeenCalledExactlyOnceWith('/bin/sh', ['-c', command], {
				cwd,
				env: expect.objectContaining({ NAMZU_JOB_FIXTURE: 'sandbox' }),
			})
			expect(boundary.exec).not.toHaveBeenCalled()
			expect(spawn).not.toHaveBeenCalled()
			expect(seen.find((event) => event.type === 'tool_completed')).toMatchObject({
				isError: false,
				result: expect.stringContaining('Started background job'),
			})
			expect(jobs.list(owner)).toHaveLength(1)
			const job = jobs.list(owner)[0]
			if (!job) throw new Error('Expected the run to register a sandbox-owned job')
			expect(job).toMatchObject({ owner, command, status: 'running' })
			output.write('sandbox-output')
			expect(jobs.read(job.id).chunk).toBe('sandbox-output')
		} finally {
			await jobs.killOwner(owner)
			output.destroy()
			errors.destroy()
		}
		expect(kill).toHaveBeenCalledExactlyOnceWith('SIGTERM')
		expect(jobs.list(owner)[0]?.status).toBe('killed')
	})

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
