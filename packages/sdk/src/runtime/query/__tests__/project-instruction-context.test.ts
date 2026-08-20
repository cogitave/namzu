import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import { MockLLMProvider } from '../../../provider/mock.js'
import { ToolRegistry } from '../../../registry/tool/execute.js'
import { ReadFileTool } from '../../../tools/builtins/read-file.js'
import { defineTool } from '../../../tools/defineTool.js'
import type { SessionId, TenantId } from '../../../types/ids/index.js'
import {
	type Message,
	type UserMessage,
	createProjectInstructionMessage,
	createUserMessage,
} from '../../../types/message/index.js'
import { RunCancelled } from '../../../types/run/cancel-cause.js'
import type { ProjectId, TopicId } from '../../../types/session/ids.js'
import { drainQuery } from '../index.js'
import type { ProjectInstructionContext, ToolResultObservation } from '../project-instructions.js'
import {
	collapseProjectInstructionSnapshots,
	replaceProjectInstructionSnapshot,
} from '../project-instructions.js'

const dirs: string[] = []

afterEach(async () => {
	await removeTempDirs(dirs)
	dirs.length = 0
})

async function workingTree(): Promise<string> {
	const cwd = await mkdtemp(join(tmpdir(), 'namzu-project-context-'))
	dirs.push(cwd)
	await mkdir(join(cwd, 'packages', 'a'), { recursive: true })
	await writeFile(join(cwd, 'packages', 'a', 'file.ts'), 'export const value = 1\n')
	return cwd
}

function identity() {
	return {
		sessionId: 'ses_project_context' as SessionId,
		topicId: 'top_project_context' as TopicId,
		projectId: 'prj_project_context' as ProjectId,
		tenantId: 'tnt_project_context' as TenantId,
	}
}

class SnapshotAfterRead implements ProjectInstructionContext {
	readonly observations: ToolResultObservation[] = []

	async observeToolResult(observation: ToolResultObservation) {
		this.observations.push(observation)
		if (observation.toolName === 'read' && observation.result.success) {
			return createProjectInstructionMessage('nested policy: use exact imports', [
				'packages/a/AGENTS.md',
			])
		}
		return undefined
	}
}

describe('live project instruction context', () => {
	it('starts no host or provider work when authority was already withdrawn', async () => {
		const caller = new AbortController()
		const reason = new RunCancelled('user')
		caller.abort(reason)
		const provider = new MockLLMProvider({ responseText: 'must not run' })
		const prepare = vi.fn(() => createProjectInstructionMessage('must not publish', ['AGENTS.md']))

		const run = await drainQuery({
			provider,
			tools: new ToolRegistry(),
			messages: [createUserMessage('do not start')],
			workingDirectory: await workingTree(),
			runConfig: {
				model: 'mock',
				timeoutMs: 20_000,
				tokenBudget: 100_000,
				maxIterations: 1,
			},
			agentId: 'project-context-pre-abort',
			agentName: 'Project context pre-abort',
			projectInstructionContext: {
				prepareInitialSnapshot: prepare,
				observeToolResult: () => undefined,
			},
			signal: caller.signal,
			...identity(),
		})

		expect(prepare).not.toHaveBeenCalled()
		expect(provider.requests).toHaveLength(0)
		expect(run.status).toBe('cancelled')
		expect(run.stopReason).toBe('cancelled')
	})

	it('settles an initial host wait on abort and rejects its late snapshot', async () => {
		let markStarted!: () => void
		const started = new Promise<void>((resolve) => {
			markStarted = resolve
		})
		let release!: (message: UserMessage) => void
		const held = new Promise<UserMessage>((resolve) => {
			release = resolve
		})
		let receivedSignal: AbortSignal | undefined
		const caller = new AbortController()
		const reason = new RunCancelled('user')
		const provider = new MockLLMProvider({ responseText: 'must not run' })
		const late = createProjectInstructionMessage('late initial policy', ['AGENTS.md'])
		const running = drainQuery({
			provider,
			tools: new ToolRegistry(),
			messages: [createUserMessage('wait for policy')],
			workingDirectory: await workingTree(),
			runConfig: {
				model: 'mock',
				timeoutMs: 20_000,
				tokenBudget: 100_000,
				maxIterations: 1,
			},
			agentId: 'project-context-held-initial',
			agentName: 'Project context held initial',
			projectInstructionContext: {
				prepareInitialSnapshot: ({ signal }) => {
					receivedSignal = signal
					markStarted()
					return held
				},
				observeToolResult: () => undefined,
			},
			signal: caller.signal,
			...identity(),
		})
		let settled = false
		void running.then(
			() => {
				settled = true
			},
			() => {
				settled = true
			},
		)

		await started
		caller.abort(reason)
		let waitFailure: unknown
		try {
			await vi.waitFor(() => expect(settled).toBe(true), { timeout: 1_000, interval: 10 })
		} catch (error) {
			waitFailure = error
		} finally {
			release(late)
		}
		const run = await running
		if (waitFailure) throw waitFailure
		await Promise.resolve()

		expect(receivedSignal).toBe(caller.signal)
		expect(receivedSignal?.reason).toBe(reason)
		expect(provider.requests).toHaveLength(0)
		expect(run.status).toBe('cancelled')
		expect(run.messages).not.toContainEqual(late)
	})

	it('does not publish a preparation value that aborts authority in the same turn', async () => {
		const caller = new AbortController()
		const reason = new RunCancelled('user')
		const provider = new MockLLMProvider({ responseText: 'must not run' })
		const late = createProjectInstructionMessage('same-turn late policy', ['AGENTS.md'])

		const run = await drainQuery({
			provider,
			tools: new ToolRegistry(),
			messages: [createUserMessage('do not publish late policy')],
			workingDirectory: await workingTree(),
			runConfig: {
				model: 'mock',
				timeoutMs: 20_000,
				tokenBudget: 100_000,
				maxIterations: 1,
			},
			agentId: 'project-context-same-turn-abort',
			agentName: 'Project context same-turn abort',
			projectInstructionContext: {
				prepareInitialSnapshot: () => {
					caller.abort(reason)
					return late
				},
				observeToolResult: () => undefined,
			},
			signal: caller.signal,
			...identity(),
		})

		expect(provider.requests).toHaveLength(0)
		expect(run.status).toBe('cancelled')
		expect(run.messages).not.toContainEqual(late)
	})

	it('fences initial publication after callback settlement and before commit', async () => {
		let markStarted!: () => void
		const started = new Promise<void>((resolve) => {
			markStarted = resolve
		})
		let release!: (message: UserMessage) => void
		const held = new Promise<UserMessage>((resolve) => {
			release = resolve
		})
		const caller = new AbortController()
		const reason = new RunCancelled('user')
		const provider = new MockLLMProvider({ responseText: 'must not run' })
		const late = createProjectInstructionMessage('post-settlement initial policy', ['AGENTS.md'])
		const running = drainQuery({
			provider,
			tools: new ToolRegistry(),
			messages: [createUserMessage('fence initial publication')],
			workingDirectory: await workingTree(),
			runConfig: {
				model: 'mock',
				timeoutMs: 20_000,
				tokenBudget: 100_000,
				maxIterations: 1,
			},
			agentId: 'project-context-initial-commit-fence',
			agentName: 'Project context initial commit fence',
			projectInstructionContext: {
				prepareInitialSnapshot: () => {
					markStarted()
					return held
				},
				observeToolResult: () => undefined,
			},
			signal: caller.signal,
			...identity(),
		})

		await started
		release(late)
		queueMicrotask(() => caller.abort(reason))
		const run = await running

		expect(provider.requests).toHaveLength(0)
		expect(run.status).toBe('cancelled')
		expect(run.messages).not.toContainEqual(late)
	})

	it('does not erase a callback failure that won before a later abort', async () => {
		const caller = new AbortController()
		const reason = new RunCancelled('user')
		const failure = new Error('project policy loader failed first')
		const provider = new MockLLMProvider({ responseText: 'must not run' })

		await expect(
			drainQuery({
				provider,
				tools: new ToolRegistry(),
				messages: [createUserMessage('load policy')],
				workingDirectory: await workingTree(),
				runConfig: {
					model: 'mock',
					timeoutMs: 20_000,
					tokenBudget: 100_000,
					maxIterations: 1,
				},
				agentId: 'project-context-first-failure',
				agentName: 'Project context first failure',
				projectInstructionContext: {
					prepareInitialSnapshot: () => {
						queueMicrotask(() => caller.abort(reason))
						throw failure
					},
					observeToolResult: () => undefined,
				},
				signal: caller.signal,
				...identity(),
			}),
		).rejects.toBe(failure)
		expect(caller.signal.reason).toBe(reason)
		expect(provider.requests).toHaveLength(0)
	})

	it('flushes a tool-discovered snapshot before a first-batch stop settles the run', async () => {
		const cwd = await workingTree()
		const provider = new MockLLMProvider({
			turns: [{ toolCalls: [{ name: 'read', args: { path: 'packages/a/file.ts' } }] }],
		})
		const tools = new ToolRegistry()
		tools.register(ReadFileTool)
		const context = new SnapshotAfterRead()

		const run = await drainQuery({
			provider,
			tools,
			messages: [createUserMessage('inspect the file')],
			workingDirectory: cwd,
			runConfig: {
				model: 'mock',
				timeoutMs: 20_000,
				tokenBudget: 100_000,
				maxIterations: 4,
			},
			agentId: 'project-context',
			agentName: 'Project context',
			projectInstructionContext: context,
			stopWhen: () => true,
			...identity(),
		})

		// There is deliberately no request two on which a next-turn-only drain
		// could accidentally make the assertion pass.
		expect(provider.requests).toHaveLength(1)
		expect(context.observations).toHaveLength(1)
		expect(context.observations[0]).toMatchObject({
			toolName: 'read',
			input: { path: 'packages/a/file.ts' },
			result: { success: true },
		})
		const snapshots = run.messages.filter(
			(message) => message.role === 'user' && message.source?.type === 'project-instructions',
		)
		expect(snapshots).toHaveLength(1)
		expect(snapshots[0]).toMatchObject({
			content: 'nested policy: use exact imports',
			retain: true,
			source: { files: ['packages/a/AGENTS.md'] },
		})

		const resumedProvider = new MockLLMProvider({ responseText: 'done' })
		await drainQuery({
			provider: resumedProvider,
			tools: new ToolRegistry(),
			messages: [...run.messages, createUserMessage('continue')],
			workingDirectory: cwd,
			runConfig: {
				model: 'mock',
				timeoutMs: 20_000,
				tokenBudget: 100_000,
				maxIterations: 1,
			},
			agentId: 'project-context',
			agentName: 'Project context',
			...identity(),
		})
		const firstResumedRequest = resumedProvider.requests[0]?.messages as Message[]
		expect(
			firstResumedRequest.some(
				(message) =>
					message.role === 'user' &&
					message.source?.type === 'project-instructions' &&
					message.content === 'nested policy: use exact imports',
			),
		).toBe(true)
	})

	it('observes a registry call dispatched by another tool, not only model-issued calls', async () => {
		const cwd = await workingTree()
		const provider = new MockLLMProvider({
			turns: [{ toolCalls: [{ name: 'wrapper' }] }],
		})
		const tools = new ToolRegistry()
		tools.register([
			ReadFileTool,
			defineTool({
				name: 'wrapper',
				description: 'dispatch a nested read',
				inputSchema: z.object({}),
				category: 'analysis',
				permissions: [],
				readOnly: true,
				destructive: false,
				concurrencySafe: true,
				execute: async (_input, context) => {
					if (!context.dispatchTool) return { success: false, output: '', error: 'no dispatch' }
					return await context.dispatchTool('read', {
						path: 'packages/a/file.ts',
					})
				},
			}),
		])
		const context = new SnapshotAfterRead()

		const run = await drainQuery({
			provider,
			tools,
			messages: [createUserMessage('use the wrapper')],
			workingDirectory: cwd,
			runConfig: {
				model: 'mock',
				timeoutMs: 20_000,
				tokenBudget: 100_000,
				maxIterations: 2,
			},
			agentId: 'nested-project-context',
			agentName: 'Nested project context',
			projectInstructionContext: context,
			stopWhen: () => true,
			...identity(),
		})

		expect(context.observations.map((observation) => observation.toolName)).toEqual([
			'read',
			'wrapper',
		])
		expect(context.observations[0]?.parentToolUseId).toBeDefined()
		expect(
			run.messages.filter(
				(message) => message.role === 'user' && message.source?.type === 'project-instructions',
			),
		).toHaveLength(1)
	})

	it('commits the accepted observation prefix before a later observer is cancelled', async () => {
		const cwd = await workingTree()
		await mkdir(join(cwd, 'packages', 'b'), { recursive: true })
		await writeFile(join(cwd, 'packages', 'b', 'file.ts'), 'export const value = 2\n')
		const provider = new MockLLMProvider({
			turns: [
				{
					toolCalls: [
						{ name: 'read', args: { path: 'packages/a/file.ts' } },
						{ name: 'read', args: { path: 'packages/b/file.ts' } },
					],
				},
			],
		})
		const tools = new ToolRegistry()
		tools.register(ReadFileTool)
		const caller = new AbortController()
		const reason = new RunCancelled('user')
		let markSecondStarted!: () => void
		const secondStarted = new Promise<void>((resolve) => {
			markSecondStarted = resolve
		})
		let releaseSecond!: (message: UserMessage) => void
		const heldSecond = new Promise<UserMessage>((resolve) => {
			releaseSecond = resolve
		})
		let accepted: UserMessage | undefined
		let late: UserMessage | undefined
		let observationCount = 0
		let secondSignal: AbortSignal | undefined
		const callbackMessages: Message[][] = []
		const context: ProjectInstructionContext = {
			observeToolResult: (observation, { messages, signal }) => {
				observationCount += 1
				callbackMessages.push([...messages])
				const path = (observation.input as { path: string }).path
				const scope = path.includes('/a/') ? 'packages/a/AGENTS.md' : 'packages/b/AGENTS.md'
				const snapshot = createProjectInstructionMessage(`policy after ${path}`, [scope])
				if (observationCount === 1) {
					accepted = snapshot
					return snapshot
				}
				late = snapshot
				secondSignal = signal
				markSecondStarted()
				return heldSecond
			},
		}
		const running = drainQuery({
			provider,
			tools,
			messages: [createUserMessage('read both files')],
			workingDirectory: cwd,
			runConfig: {
				model: 'mock',
				timeoutMs: 20_000,
				tokenBudget: 100_000,
				maxIterations: 2,
			},
			agentId: 'project-context-prefix',
			agentName: 'Project context prefix',
			projectInstructionContext: context,
			signal: caller.signal,
			...identity(),
		})
		let settled = false
		void running.then(
			() => {
				settled = true
			},
			() => {
				settled = true
			},
		)

		await secondStarted
		caller.abort(reason)
		let waitFailure: unknown
		try {
			await vi.waitFor(() => expect(settled).toBe(true), { timeout: 1_000, interval: 10 })
		} catch (error) {
			waitFailure = error
		}
		if (!late) throw new Error('the second real tool observation never started')
		releaseSecond(late)
		const run = await running
		if (waitFailure) throw waitFailure
		await Promise.resolve()

		expect(secondSignal?.aborted).toBe(true)
		expect(secondSignal?.reason).toBe(reason)
		expect(provider.requests).toHaveLength(1)
		expect(run.status).toBe('cancelled')
		expect(run.messages.filter((message) => message.role === 'tool')).toHaveLength(2)
		expect(callbackMessages).toHaveLength(2)
		expect(callbackMessages[0]?.filter((message) => message.role === 'tool')).toHaveLength(2)
		expect(callbackMessages[1]?.filter((message) => message.role === 'tool')).toHaveLength(2)
		expect(
			callbackMessages[1]?.filter(
				(message) => message.role === 'user' && message.source?.type === 'project-instructions',
			),
		).toEqual([accepted])
		const snapshots = run.messages.filter(
			(message) => message.role === 'user' && message.source?.type === 'project-instructions',
		)
		expect(snapshots).toEqual([accepted])
		expect(snapshots).not.toContainEqual(late)
	})

	it('fences a tool snapshot after callback settlement and before commit', async () => {
		const cwd = await workingTree()
		const provider = new MockLLMProvider({
			turns: [{ toolCalls: [{ name: 'read', args: { path: 'packages/a/file.ts' } }] }],
		})
		const tools = new ToolRegistry()
		tools.register(ReadFileTool)
		const caller = new AbortController()
		const reason = new RunCancelled('user')
		let markStarted!: () => void
		const started = new Promise<void>((resolve) => {
			markStarted = resolve
		})
		let release!: (message: UserMessage) => void
		const held = new Promise<UserMessage>((resolve) => {
			release = resolve
		})
		const late = createProjectInstructionMessage('post-settlement tool policy', [
			'packages/a/AGENTS.md',
		])
		const running = drainQuery({
			provider,
			tools,
			messages: [createUserMessage('read then fence publication')],
			workingDirectory: cwd,
			runConfig: {
				model: 'mock',
				timeoutMs: 20_000,
				tokenBudget: 100_000,
				maxIterations: 2,
			},
			agentId: 'project-context-tool-commit-fence',
			agentName: 'Project context tool commit fence',
			projectInstructionContext: {
				observeToolResult: () => {
					markStarted()
					return held
				},
			},
			signal: caller.signal,
			...identity(),
		})

		await started
		release(late)
		queueMicrotask(() => caller.abort(reason))
		const run = await running

		expect(provider.requests).toHaveLength(1)
		expect(run.status).toBe('cancelled')
		expect(run.messages.filter((message) => message.role === 'tool')).toHaveLength(1)
		expect(run.messages).not.toContainEqual(late)
	})
})

describe('project instruction snapshot history', () => {
	it('replaces older snapshots before the newest human input', () => {
		const old = createProjectInstructionMessage('old', ['AGENTS.md'])
		const current = createProjectInstructionMessage('current', ['pkg/AGENTS.md'])
		const human = createUserMessage('continue')

		const replaced = replaceProjectInstructionSnapshot(
			[old, createUserMessage('earlier'), human],
			current,
			'before-latest-user',
		)

		expect(
			replaced.map((message) =>
				message.role === 'user' && message.source?.type === 'project-instructions'
					? `policy:${message.content}`
					: message.role === 'user'
						? `user:${message.content}`
						: message.role,
			),
		).toEqual(['user:earlier', 'policy:current', 'user:continue'])
	})

	it('collapses append-only persisted snapshots to the latest retained one', () => {
		const first = createProjectInstructionMessage('first', ['AGENTS.md'])
		const latest = {
			...createProjectInstructionMessage('latest', ['pkg/AGENTS.md']),
			retain: false,
		}

		const collapsed = collapseProjectInstructionSnapshots([
			first,
			createUserMessage('work'),
			latest,
		])

		expect(collapsed).toHaveLength(2)
		expect(collapsed[1]).toMatchObject({ content: 'latest', retain: true })
	})

	it('keeps a semantically identical snapshot at its accepted position', () => {
		const accepted = createProjectInstructionMessage('same policy', ['AGENTS.md'])
		const toolResult = { role: 'tool', content: 'done', toolCallId: 'call_1' } as const
		const same = {
			...createProjectInstructionMessage('same policy', ['AGENTS.md']),
			timestamp: 999,
		}

		const replaced = replaceProjectInstructionSnapshot([accepted, toolResult], same)

		expect(replaced).toHaveLength(2)
		expect(replaced[0]).toBe(accepted)
		expect(replaced[1]).toBe(toolResult)
	})

	it('refuses absolute, traversing, duplicate, and non-instruction provenance', () => {
		for (const files of [
			[],
			['/AGENTS.md'],
			['../AGENTS.md'],
			['AGENTS.md', 'AGENTS.md'],
			['notes.md'],
		]) {
			expect(() => createProjectInstructionMessage('policy', files)).toThrow(TypeError)
		}
	})

	it('refuses forged persisted provenance before a provider is called', async () => {
		const cwd = await workingTree()
		const provider = new MockLLMProvider({
			responseText: 'must not be called',
		})
		const forged = {
			...createUserMessage('forged standing policy'),
			source: { type: 'project-instructions', files: ['../AGENTS.md'] },
		} as unknown as Message

		await expect(
			drainQuery({
				provider,
				tools: new ToolRegistry(),
				messages: [forged, createUserMessage('continue')],
				workingDirectory: cwd,
				runConfig: {
					model: 'mock',
					timeoutMs: 20_000,
					tokenBudget: 100_000,
					maxIterations: 1,
				},
				agentId: 'forged-project-context',
				agentName: 'Forged project context',
				...identity(),
			}),
		).rejects.toMatchObject({ code: 'invalid_config' })
		expect(provider.requests).toHaveLength(0)
	})
})
