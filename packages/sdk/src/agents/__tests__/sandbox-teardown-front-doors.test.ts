import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { removeTempDirs } from '../../__fixtures__/temp-dir.js'
import { MockLLMProvider } from '../../provider/mock.js'
import { ToolRegistry } from '../../registry/tool/execute.js'
import type { PipelineAgentConfig } from '../../types/agent/pipeline.js'
import type { ReactiveAgentConfig } from '../../types/agent/reactive.js'
import type { SupervisorAgentConfig } from '../../types/agent/supervisor.js'
import type { SandboxId, SessionId, TenantId } from '../../types/ids/index.js'
import { createUserMessage } from '../../types/message/index.js'
import type {
	Sandbox,
	SandboxCreateConfig,
	SandboxDestroyOptions,
	SandboxProvider,
} from '../../types/sandbox/index.js'
import type { ProjectId, TopicId } from '../../types/session/ids.js'
import { PipelineAgent } from '../PipelineAgent.js'
import { ReactiveAgent } from '../ReactiveAgent.js'
import { SupervisorAgent } from '../SupervisorAgent.js'
import { runAgent } from '../runAgent.js'

const scope = {
	sessionId: 'ses_sandbox_teardown_front' as SessionId,
	topicId: 'top_sandbox_teardown_front' as TopicId,
	projectId: 'prj_sandbox_teardown_front' as ProjectId,
	tenantId: 'tnt_sandbox_teardown_front' as TenantId,
}

const dirs: string[] = []

afterEach(async () => {
	await removeTempDirs(dirs)
	dirs.length = 0
})

async function directory(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), 'namzu-sandbox-teardown-front-'))
	dirs.push(dir)
	return dir
}

function heldSandboxProvider(observe: (signal: AbortSignal) => void): SandboxProvider {
	const sandbox: Sandbox = {
		id: 'sbx_front_door' as SandboxId,
		status: 'ready',
		rootDir: '/workspace',
		environment: 'basic',
		exec: async () => ({
			stdout: '',
			stderr: '',
			exitCode: 0,
			durationMs: 0,
			timedOut: false,
		}),
		writeFile: async () => {},
		readFile: async () => Buffer.alloc(0),
		listFiles: async () => [],
		destroy: (options?: SandboxDestroyOptions) => {
			if (!options?.signal) throw new Error('expected a teardown signal')
			observe(options.signal)
			return new Promise<void>(() => {})
		},
	}
	return {
		id: 'held-teardown',
		name: 'Held teardown',
		environment: 'basic',
		create: async () => sandbox,
	}
}

function recordingWorkspaceProvider(): {
	readonly provider: SandboxProvider
	readonly seen: SandboxCreateConfig[]
} {
	const seen: SandboxCreateConfig[] = []
	return {
		seen,
		provider: {
			id: 'recording-workspace',
			name: 'Recording workspace',
			environment: 'basic',
			workspaceModes: ['ephemeral', 'working-directory'],
			create: async (config = {}) => {
				seen.push(config)
				return {
					id: 'sbx_workspace_front' as SandboxId,
					status: 'ready',
					rootDir: config.workingDirectory ?? '/ephemeral',
					environment: 'basic',
					exec: async () => ({
						stdout: '',
						stderr: '',
						exitCode: 0,
						durationMs: 0,
						timedOut: false,
					}),
					writeFile: async () => {},
					readFile: async () => Buffer.alloc(0),
					listFiles: async () => [],
					destroy: async () => {},
				} as Sandbox
			},
		},
	}
}

async function within<T>(operation: Promise<T>): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined
	try {
		return await Promise.race([
			operation,
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(
					() => reject(new Error('agent front door dropped sandboxTeardownTimeoutMs')),
					1_000,
				)
			}),
		])
	} finally {
		if (timer !== undefined) clearTimeout(timer)
	}
}

describe('agent front doors preserve the sandbox teardown bound', () => {
	it('runAgent forwards the provider and bound to the query lifecycle owner', async () => {
		let teardownSignal: AbortSignal | undefined
		const result = await within(
			runAgent({
				provider: new MockLLMProvider({ turns: [{ text: 'done' }] }),
				model: 'mock-model',
				prompt: 'go',
				sandboxProvider: heldSandboxProvider((signal) => {
					teardownSignal = signal
				}),
				sandboxTeardownTimeoutMs: 10,
				workingDirectory: process.cwd(),
			}),
		)

		expect(result.run.status).toBe('completed')
		expect(teardownSignal?.aborted).toBe(true)
		expect(teardownSignal?.reason).toMatchObject({ name: 'TimeoutError' })
	})

	it('ReactiveAgent forwards the bound to the query lifecycle owner', async () => {
		let teardownSignal: AbortSignal | undefined
		const provider = new MockLLMProvider({ turns: [{ text: 'done' }] })
		const workingDirectory = await directory()
		const agent = new ReactiveAgent({
			id: 'reactive-sandbox-teardown-front',
			name: 'Reactive Sandbox Teardown Front',
			version: '1',
			category: 'test',
			description: 'sandbox teardown reachability probe',
		})
		const config = {
			provider,
			tools: new ToolRegistry(),
			sandboxProvider: heldSandboxProvider((signal) => {
				teardownSignal = signal
			}),
			sandboxTeardownTimeoutMs: 10,
			model: 'mock-model',
			tokenBudget: 100_000,
			timeoutMs: 5_000,
			maxIterations: 1,
			...scope,
		} satisfies ReactiveAgentConfig

		const result = await within(
			agent.run({ messages: [createUserMessage('go')], workingDirectory }, config),
		)

		expect(result.status).toBe('completed')
		expect(teardownSignal?.aborted).toBe(true)
		expect(teardownSignal?.reason).toMatchObject({ name: 'TimeoutError' })
	})

	it('SupervisorAgent forwards the bound to the query lifecycle owner', async () => {
		let teardownSignal: AbortSignal | undefined
		const provider = new MockLLMProvider({ turns: [{ text: 'done' }] })
		const workingDirectory = await directory()
		const agent = new SupervisorAgent({
			id: 'supervisor-sandbox-teardown-front',
			name: 'Supervisor Sandbox Teardown Front',
			version: '1',
			category: 'test',
			description: 'sandbox teardown reachability probe',
		})
		const config = {
			provider,
			agentIds: [],
			allowDelegation: false,
			agentManager: { sendMessage: async () => ({}) } as never,
			systemPrompt: 'Answer directly.',
			sandboxProvider: heldSandboxProvider((signal) => {
				teardownSignal = signal
			}),
			sandboxTeardownTimeoutMs: 10,
			model: 'mock-model',
			tokenBudget: 100_000,
			timeoutMs: 5_000,
			maxIterations: 1,
			...scope,
		} satisfies SupervisorAgentConfig

		const result = await within(
			agent.run({ messages: [createUserMessage('go')], workingDirectory }, config),
		)

		expect(result.status).toBe('completed')
		expect(teardownSignal?.aborted).toBe(true)
		expect(teardownSignal?.reason).toMatchObject({ name: 'TimeoutError' })
	})
})

describe('agent front doors preserve the sandbox workspace choice', () => {
	it('PipelineAgent refuses a boundary it cannot enforce around callbacks', async () => {
		const agent = new PipelineAgent({
			id: 'pipeline-sandbox-workspace-front',
			name: 'Pipeline Sandbox Workspace Front',
			version: '1',
			category: 'test',
			description: 'sandbox refusal reachability probe',
		})

		await expect(
			agent.run({ messages: [createUserMessage('go')], workingDirectory: process.cwd() }, {
				model: 'unused',
				tokenBudget: 100,
				timeoutMs: 1_000,
				steps: [{ name: 'step', execute: async () => 'done' }],
				sandbox: { workspace: 'working-directory' },
			} satisfies PipelineAgentConfig),
		).rejects.toThrow(/cannot enforce a run-level sandbox/)
	})

	it('runAgent roots the provider at its working directory', async () => {
		const workingDirectory = await directory()
		const { provider, seen } = recordingWorkspaceProvider()

		await runAgent({
			provider: new MockLLMProvider({ turns: [{ text: 'done' }] }),
			model: 'mock-model',
			prompt: 'go',
			sandboxProvider: provider,
			sandbox: { workspace: 'working-directory' },
			workingDirectory,
		})

		expect(seen).toHaveLength(1)
		expect(seen[0]?.workingDirectory).toBe(workingDirectory)
	})

	it('ReactiveAgent roots the provider at its working directory', async () => {
		const workingDirectory = await directory()
		const { provider: sandboxProvider, seen } = recordingWorkspaceProvider()
		const agent = new ReactiveAgent({
			id: 'reactive-sandbox-workspace-front',
			name: 'Reactive Sandbox Workspace Front',
			version: '1',
			category: 'test',
			description: 'sandbox workspace reachability probe',
		})

		await agent.run({ messages: [createUserMessage('go')], workingDirectory }, {
			provider: new MockLLMProvider({ turns: [{ text: 'done' }] }),
			tools: new ToolRegistry(),
			sandboxProvider,
			sandbox: { workspace: 'working-directory' },
			model: 'mock-model',
			tokenBudget: 100_000,
			timeoutMs: 5_000,
			maxIterations: 1,
			...scope,
		} satisfies ReactiveAgentConfig)

		expect(seen).toHaveLength(1)
		expect(seen[0]?.workingDirectory).toBe(workingDirectory)
	})

	it('SupervisorAgent roots the provider at its working directory', async () => {
		const workingDirectory = await directory()
		const { provider: sandboxProvider, seen } = recordingWorkspaceProvider()
		const agent = new SupervisorAgent({
			id: 'supervisor-sandbox-workspace-front',
			name: 'Supervisor Sandbox Workspace Front',
			version: '1',
			category: 'test',
			description: 'sandbox workspace reachability probe',
		})

		await agent.run({ messages: [createUserMessage('go')], workingDirectory }, {
			provider: new MockLLMProvider({ turns: [{ text: 'done' }] }),
			agentIds: [],
			allowDelegation: false,
			agentManager: { sendMessage: async () => ({}) } as never,
			systemPrompt: 'Answer directly.',
			sandboxProvider,
			sandbox: { workspace: 'working-directory' },
			model: 'mock-model',
			tokenBudget: 100_000,
			timeoutMs: 5_000,
			maxIterations: 1,
			...scope,
		} satisfies SupervisorAgentConfig)

		expect(seen).toHaveLength(1)
		expect(seen[0]?.workingDirectory).toBe(workingDirectory)
	})
})
