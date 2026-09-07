import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'

import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import { CompactionConfigSchema } from '../../../config/runtime.js'
import { MockLLMProvider, registerMock } from '../../../provider/index.js'
import { ToolRegistry } from '../../../registry/index.js'
import { createMemoryRecallStep } from '../../../run/memory-recall.js'
import { InMemoryMemoryStore } from '../../../store/memory/memory.js'
import { InMemoryCheckpointStore } from '../../../store/run/checkpoint-memory.js'
import { InMemoryRunStore } from '../../../store/run/memory.js'
import { InMemoryTopicStateStore } from '../../../store/topic/state.js'
import { fixtureId } from '../../../test-support/ids.js'
import {
	type Message,
	createAssistantMessage,
	createProjectInstructionMessage,
	createRuntimeContextMessage,
	createSystemMessage,
	createUserMessage,
} from '../../../types/message/index.js'
import type { PrepareStepContext, RunEvent } from '../../../types/run/index.js'
import { generateGoalId } from '../../../utils/id.js'
import { CheckpointManager } from '../checkpoint.js'
import { drainQuery } from '../index.js'
import { SteeringBinding } from '../steering.js'

registerMock()
const dirs: string[] = []
afterEach(async () => {
	await removeTempDirs(dirs)
	dirs.length = 0
})

async function workingDirectory(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), 'namzu-latest-user-'))
	dirs.push(dir)
	return dir
}

const scope = {
	projectId: fixtureId.project('latest-user'),
	sessionId: fixtureId.session('latest-user'),
	topicId: fixtureId.topic('latest-user'),
	tenantId: fixtureId.tenant('latest-user'),
}

it('keeps the current topic after its user message is compacted, then accepts newer inbound input', async () => {
	const pending: Message[] = []
	const provider = new MockLLMProvider({
		nextTurn: (_request, index) => {
			if (index === 0) {
				pending.push(
					createUserMessage('NEW_REPORTING_REQUEST'),
					createRuntimeContextMessage('UNRELATED_TASK_COMPLETION', 'task-completion'),
				)
				return { toolCalls: [{ name: 'noop', args: {} }] }
			}
			return { text: 'done' }
		},
	})
	const tools = new ToolRegistry()
	tools.register({
		name: 'noop',
		description: 'Read-only fixture',
		inputSchema: z.object({}),
		execute: async () => ({ success: true, output: 'ok' }),
	})
	const prepared: { topic: string | undefined; users: string[] }[] = []
	const refusedTopics: (string | undefined)[] = []
	const events: RunEvent[] = []
	await drainQuery(
		{
			...scope,
			provider,
			tools,
			runStore: new InMemoryRunStore(),
			agentId: 'attention-audit',
			agentName: 'Attention audit',
			workingDirectory: await workingDirectory(),
			runConfig: {
				model: 'mock',
				timeoutMs: 20_000,
				tokenBudget: 100_000,
				maxIterations: 5,
			},
			compactionConfig: CompactionConfigSchema.parse({
				strategy: 'structured',
				contextWindowTokens: 1_000,
				llmVerification: false,
				clearToolResults: false,
				keepRecentMessages: 2,
			}),
			messages: [
				{ ...createUserMessage('OLDER_BILLING_REQUEST'), retain: true },
				createAssistantMessage(`Earlier facts. ${'background '.repeat(800)}`),
				createUserMessage('CURRENT_DEPLOYMENT_REQUEST'),
				createAssistantMessage(`More work. ${'context '.repeat(800)}`),
				createRuntimeContextMessage('A worker finished', 'task-completion'),
				createAssistantMessage('The worker report is ready.'),
			],
			inboundMessages: () => pending.splice(0),
			beforeStep: ({ latestUserMessage }) => {
				refusedTopics.push(latestUserMessage?.content)
				return undefined
			},
			prepareStep: ({ latestUserMessage, messages }) => {
				prepared.push({
					topic: latestUserMessage?.content,
					users: messages.flatMap((message) => (message.role === 'user' ? [message.content] : [])),
				})
				return {
					system: `Active topic: ${latestUserMessage?.content ?? 'missing'}`,
				}
			},
		},
		(event) => {
			events.push(event)
		},
	)

	expect(events.some((event) => event.type === 'compaction_shed')).toBe(true)
	expect(prepared[0]?.users).toContain('OLDER_BILLING_REQUEST')
	expect(prepared[0]?.users).not.toContain('CURRENT_DEPLOYMENT_REQUEST')
	expect(prepared.map((step) => step.topic)).toEqual([
		'CURRENT_DEPLOYMENT_REQUEST',
		'NEW_REPORTING_REQUEST',
	])
	expect(refusedTopics).toEqual(['CURRENT_DEPLOYMENT_REQUEST', 'NEW_REPORTING_REQUEST'])
	expect(provider.requests[0]?.messages.at(-1)?.content).toBe(
		'Active topic: CURRENT_DEPLOYMENT_REQUEST',
	)
	expect(provider.requests[1]?.messages.at(-1)?.content).toBe('Active topic: NEW_REPORTING_REQUEST')
})

it.each(['inbound', 'tool-steering', 'stranded-steering'] as const)(
	'keeps %s directions on the wire after compaction without a host reinjecting them',
	async (ingress) => {
		const direction = 'NEW_OPERATOR_CONSTRAINT_USE_CERULEAN_ONLY'
		const pending: Message[] = []
		const steering = new SteeringBinding()
		const events: RunEvent[] = []
		const latest: (string | undefined)[] = []
		const largeTurn = ingress === 'stranded-steering' ? 2 : 1
		let output = 'ok'
		const tools = new ToolRegistry()
		tools.register({
			name: 'noop',
			description: 'Read-only fixture',
			inputSchema: z.object({}),
			execute: async () => ({ success: true, output }),
		})
		const provider = new MockLLMProvider({
			nextTurn: (request, index) => {
				// Report the received prompt so the next pass still sees the large
				// result after it moves out of the protected recent window.
				const promptTokens = Math.ceil(JSON.stringify(request.messages).length / 4)
				const usage = { promptTokens, totalTokens: promptTokens }
				if (index === 0) {
					if (ingress === 'inbound') pending.push(createUserMessage(direction))
					else steering.steer(direction)
				}
				if (index === largeTurn) {
					// A later user-role report lets compaction shed the operator turn
					// and this large result together without opening on an assistant.
					pending.push(createRuntimeContextMessage('UNRELATED_WORKER_REPORT', 'task-completion'))
				}
				if (index === 0 && ingress === 'stranded-steering') {
					return { text: 'Initial answer.', usage }
				}
				output = index === largeTurn ? 'work '.repeat(5_000) : 'ok'
				return index <= largeTurn + 1
					? { toolCalls: [{ name: 'noop', args: {} }], usage }
					: { text: 'done', usage }
			},
		})
		await drainQuery(
			{
				...scope,
				provider,
				tools,
				steering,
				runStore: new InMemoryRunStore(),
				agentId: 'operator-retention',
				agentName: 'Operator retention',
				workingDirectory: await workingDirectory(),
				systemPrompt: 'Follow the current operator task.',
				contextLevel: 'minimal',
				messages: [createUserMessage('ORIGINAL_TASK')],
				inboundMessages: () => pending.splice(0),
				prepareStep: ({ latestUserMessage }) => {
					latest.push(latestUserMessage?.content)
					return undefined
				},
				runConfig: {
					model: 'mock',
					timeoutMs: 20_000,
					tokenBudget: 100_000,
					maxIterations: 8,
				},
				compactionConfig: CompactionConfigSchema.parse({
					strategy: 'structured',
					contextWindowTokens: 2_000,
					llmVerification: false,
					clearToolResults: false,
					keepRecentMessages: 2,
				}),
			},
			(event) => {
				events.push(event)
			},
		)
		expect(
			events
				.filter((event) => event.type === 'compaction_shed')
				.flatMap((event) => event.messages)
				.some(
					(message) => typeof message.content === 'string' && message.content.includes(direction),
				),
		).toBe(true)
		expect(latest.at(-1)).toBe(direction)
		const finalRequest = provider.requests.at(-1)
		expect(
			finalRequest?.messages.some(
				(message) =>
					message.role !== 'system' &&
					typeof message.content === 'string' &&
					message.content.includes(direction),
			),
		).toBe(false)
		const summaries = finalRequest?.messages
			.filter(
				(message) => message.role === 'system' && message.content?.includes('[COMPACTED CONTEXT]'),
			)
			.map((message) => message.content)
			.join('\n')
		expect(summaries).toContain(direction)
		expect(summaries?.split(direction)).toHaveLength(2)
		expect(summaries).not.toContain('UNRELATED_WORKER_REPORT')
	},
)

describe('which user-role messages can supply current intent', () => {
	it.each([false, true])(
		'seeds only operator requirements with continuationMode=%s',
		async (continuationMode) => {
			const provider = new MockLLMProvider({ turns: [{ text: 'done' }] })
			await drainQuery({
				...scope,
				provider,
				tools: new ToolRegistry(),
				runStore: new InMemoryRunStore(),
				agentId: 'operator-seeding',
				agentName: 'Operator seeding',
				workingDirectory: await workingDirectory(),
				continuationMode,
				systemPrompt: 'Follow the current operator task.',
				contextLevel: 'minimal',
				runConfig: {
					model: 'mock',
					timeoutMs: 20_000,
					tokenBudget: 100_000,
					maxIterations: 2,
				},
				compactionConfig: CompactionConfigSchema.parse({
					strategy: 'structured',
					contextWindowTokens: 2_000,
					llmVerification: false,
					clearToolResults: false,
					keepRecentMessages: 2,
				}),
				messages: [
					createSystemMessage('Static policy'),
					createProjectInstructionMessage('PROJECT_POLICY_IS_NOT_THE_TASK', ['AGENTS.md']),
					createUserMessage('ORIGINAL_OPERATOR_TASK'),
					createRuntimeContextMessage('WORKER_REPORT_IS_NOT_A_REQUIREMENT', 'task-completion'),
					createAssistantMessage('background '.repeat(1_600)),
					createUserMessage('LATEST_OPERATOR_REQUIREMENT'),
					createAssistantMessage('Ready'),
				],
			})
			const summary = provider.requests[0]?.messages.find(
				(message) => message.role === 'system' && message.content?.includes('[COMPACTED CONTEXT]'),
			)?.content
			expect(summary).toContain('## Task\n\nORIGINAL_OPERATOR_TASK')
			expect(summary).toContain('LATEST_OPERATOR_REQUIREMENT')
			expect(summary).not.toContain('PROJECT_POLICY_IS_NOT_THE_TASK')
			expect(summary).not.toContain('WORKER_REPORT_IS_NOT_A_REQUIREMENT')
		},
	)

	it.each(['goal-round', 'steering'] as const)(
		'accepts %s and ignores later project/task context',
		async (kind) => {
			const authoritative =
				kind === 'steering'
					? createRuntimeContextMessage('STEER_TO_CURRENT_TASK', 'steering')
					: {
							...createUserMessage('GOAL_CURRENT_TASK'),
							source: {
								type: 'goal-round' as const,
								goalId: generateGoalId(),
								objective: 'GOAL_CURRENT_TASK',
								goalRevision: 1,
								round: 1,
								maxGoalRounds: 4,
							},
						}
			const provider = new MockLLMProvider({ turns: [{ text: 'done' }] })
			const captured: (string | undefined)[] = []
			await drainQuery({
				...scope,
				provider,
				tools: new ToolRegistry(),
				runStore: new InMemoryRunStore(),
				agentId: 'latest-input',
				agentName: 'Latest input',
				workingDirectory: await workingDirectory(),
				runConfig: {
					model: 'mock',
					timeoutMs: 20_000,
					tokenBudget: 100_000,
					maxIterations: 2,
				},
				messages: [
					createUserMessage('OLD_TASK'),
					authoritative,
					createProjectInstructionMessage('PROJECT_POLICY', ['AGENTS.md']),
					createRuntimeContextMessage('TASK_REPORT', 'task-completion'),
				],
				prepareStep: ({ latestUserMessage }) => {
					captured.push(latestUserMessage?.content)
					return undefined
				},
			})
			expect(captured).toEqual([authoritative.content])
		},
	)
})

it('resumes the current topic after a compacted checkpoint, without resurrecting an old retained request', async () => {
	const checkpointStore = new InMemoryCheckpointStore()
	const tools = new ToolRegistry()
	tools.register({
		name: 'noop',
		description: 'Fixture',
		inputSchema: z.object({}),
		execute: async () => ({ success: true, output: 'ok' }),
	})
	const params = {
		...scope,
		tools,
		checkpointStore,
		workingDirectory: await workingDirectory(),
		agentId: 'resume-intent',
		agentName: 'Resume intent',
		runConfig: {
			model: 'mock',
			timeoutMs: 20_000,
			tokenBudget: 100_000,
			maxIterations: 4,
		},
		compactionConfig: CompactionConfigSchema.parse({
			strategy: 'structured',
			contextWindowTokens: 1_000,
			llmVerification: false,
			clearToolResults: false,
			keepRecentMessages: 2,
		}),
	}
	const current = createRuntimeContextMessage('CURRENT_DEPLOYMENT_REQUEST', 'steering')
	const paused = await drainQuery({
		...params,
		runStore: new InMemoryRunStore(),
		provider: new MockLLMProvider({
			turns: [{ toolCalls: [{ name: 'noop', args: {} }] }],
		}),
		messages: [
			{ ...createUserMessage('OLDER_BILLING_REQUEST'), retain: true },
			createAssistantMessage('background '.repeat(800)),
			current,
			createAssistantMessage('context '.repeat(800)),
			createRuntimeContextMessage('A worker finished', 'task-completion'),
			createAssistantMessage('Ready'),
		],
		resumeHandler: async (request) =>
			request.type === 'iteration_checkpoint'
				? { action: 'pause', reason: 'Restart fixture' }
				: { action: 'continue' },
	})
	expect(paused.stopReason).toBe('paused')
	const storedScope = { ...scope, runId: paused.id }
	const checkpoint = (await checkpointStore.listCheckpoints(storedScope)).at(-1)
	if (!checkpoint) throw new Error('Expected a persisted checkpoint')
	expect(checkpoint.messages.some((message) => message.content === current.content)).toBe(false)
	expect(checkpoint.messages.some((message) => message.content === 'OLDER_BILLING_REQUEST')).toBe(
		true,
	)
	expect(checkpoint.latestUserMessage).toEqual(current)
	const restoredStore = new InMemoryCheckpointStore()
	await restoredStore.writeCheckpoint(storedScope, JSON.parse(JSON.stringify(checkpoint)))
	const provider = new MockLLMProvider({ turns: [{ text: 'Resumed.' }] })
	const resumed = await drainQuery({
		...params,
		runId: paused.id,
		provider,
		checkpointStore: restoredStore,
		runStore: new InMemoryRunStore(),
		messages: [],
		resumeFromCheckpoint: checkpoint.id,
		prepareStep: ({ latestUserMessage }) => ({
			system: `Active topic: ${latestUserMessage?.content}`,
		}),
	})
	expect(resumed.status).toBe('completed')
	expect(provider.requests[0]?.messages.at(-1)?.content).toBe(
		'Active topic: CURRENT_DEPLOYMENT_REQUEST',
	)

	// Only arrivals after this checkpoint may supersede its compacted intent.
	// Re-scanning all restored history would instead resurrect the retained old task.
	const topicStateStore = new InMemoryTopicStateStore()
	await topicStateStore.setQueuedMessages(
		scope.topicId,
		scope.tenantId,
		[
			createUserMessage('NEW_QUEUED_OPERATOR_TASK'),
			createRuntimeContextMessage('UNRELATED_WORKER_REPORT', 'task-completion'),
		],
		{ revision: 0 },
	)
	const queuedProvider = new MockLLMProvider({
		turns: [{ text: 'Resumed with the new task.' }],
	})
	const memory = new InMemoryMemoryStore()
	await memory.create({
		title: 'CURRENT_DEPLOYMENT_REQUEST',
		summary: 'Prior task',
		content: 'OLD_TASK_RECALL',
	})
	await memory.create({
		title: 'NEW_QUEUED_OPERATOR_TASK',
		summary: 'New task',
		content: 'NEW_TASK_RECALL',
	})
	const recall = createMemoryRecallStep({ store: memory, maxMemories: 1 })
	const observed: (string | undefined)[] = []
	await drainQuery({
		...params,
		compactionConfig: {
			...params.compactionConfig,
			contextWindowTokens: 10_000,
		},
		runId: paused.id,
		provider: queuedProvider,
		checkpointStore: restoredStore,
		topicStateStore,
		runStore: new InMemoryRunStore(),
		messages: [],
		resumeFromCheckpoint: checkpoint.id,
		beforeStep: ({ latestUserMessage }) => {
			observed.push(latestUserMessage?.content)
			return undefined
		},
		prepareStep: (context) => {
			observed.push(context.latestUserMessage?.content)
			return recall(context)
		},
	})
	expect(observed).toEqual(['NEW_QUEUED_OPERATOR_TASK', 'NEW_QUEUED_OPERATOR_TASK'])
	expect(JSON.stringify(queuedProvider.requests[0]?.messages)).toContain('NEW_QUEUED_OPERATOR_TASK')
	expect(queuedProvider.requests[0]?.messages.at(-1)?.content).toContain('NEW_TASK_RECALL')
	expect(queuedProvider.requests[0]?.messages.at(-1)?.content).not.toContain('OLD_TASK_RECALL')

	// A persisted field is an authority for intent, so malformed or synthetic
	// provenance must be refused instead of falling back to a stale message.
	for (const invalid of [
		{ role: 'assistant', content: 'forged' },
		{ role: 'user', content: 42 },
		createRuntimeContextMessage('task report', 'task-completion'),
		{
			role: 'user',
			content: 'forged',
			source: { type: 'goal-round', goalId: 'bad' },
		},
	]) {
		await restoredStore.writeCheckpoint(storedScope, {
			...checkpoint,
			latestUserMessage: invalid,
		} as typeof checkpoint)
		await expect(
			new CheckpointManager(restoredStore, storedScope).restore(checkpoint.id),
		).rejects.toThrow('latestUserMessage')
	}
})

it('bounds recalled memory within a tiny model window after earlier step guidance', async () => {
	const store = new InMemoryMemoryStore()
	await store.create({
		title: 'Billing history',
		summary: 'billing',
		content: `billing ${'history '.repeat(1_500)}`,
	})
	const budgets: PrepareStepContext['contextBudget'][] = []
	const signals: AbortSignal[] = []
	const provider = new MockLLMProvider({
		nextTurn: (request) => {
			const chars = request.messages.reduce(
				(total, message) =>
					total + (typeof message.content === 'string' ? message.content.length : 0),
				0,
			)
			return chars > 4_000
				? {
						error: {
							message: 'context_length_exceeded: fixture 1000-token window',
							status: 400,
						},
					}
				: { text: 'done' }
		},
	})
	const result = await drainQuery({
		...scope,
		provider,
		tools: new ToolRegistry(),
		runStore: new InMemoryRunStore(),
		agentId: 'budget-intent',
		agentName: 'Budget intent',
		workingDirectory: await workingDirectory(),
		systemPrompt: 'Answer the question.',
		messages: [createUserMessage('billing')],
		runConfig: {
			model: 'mock',
			tokenBudget: 100_000,
			timeoutMs: 20_000,
			maxIterations: 2,
			maxResponseTokens: 128,
		},
		compactionConfig: CompactionConfigSchema.parse({
			contextWindowTokens: 1_000,
			llmVerification: false,
		}),
		beforeStep: ({ signal }) => {
			if (signal) signals.push(signal)
			return undefined
		},
		prepareStep: [
			({ contextBudget, signal }) => {
				budgets.push(contextBudget)
				if (signal) signals.push(signal)
				return {
					system: 'Earlier guidance '.repeat(10),
					skills: [
						{
							metadata: {
								name: 'billing-audit',
								description: 'Check the invoices',
							},
							body: 'Follow the ledger.',
							dirPath: '/fixture',
						},
					],
				}
			},
			(context) => {
				budgets.push(context.contextBudget)
				return createMemoryRecallStep({ store })(context)
			},
		],
	})
	expect(result.status).toBe('completed')
	expect(provider.requests).toHaveLength(1)
	expect(budgets[0]?.windowTokens).toBe(1_000)
	expect(budgets[0]?.remainingTokens).toBeLessThan(872)
	expect(budgets[1]?.remainingTokens).toBeLessThan(budgets[0]?.remainingTokens ?? 0)
	expect(signals).toHaveLength(2)
	expect(signals[0]).toBe(signals[1])
	const preamble = provider.requests[0]?.messages.at(-1)?.content
	expect(preamble).toContain('Retrieved project memory')
	expect(preamble).toContain('Earlier guidance')
	expect(preamble).toContain('billing-audit')
})

it('recomputes headroom for a stage-selected model instead of using the base model window', async () => {
	class ReportingProvider extends MockLLMProvider {
		async resolveContextWindow(model: string): Promise<number | undefined> {
			return model === 'large-base' ? 1_000_000 : undefined
		}
	}
	const budgets: PrepareStepContext['contextBudget'][] = []
	const provider = new ReportingProvider()
	await drainQuery({
		...scope,
		provider,
		tools: new ToolRegistry(),
		runStore: new InMemoryRunStore(),
		agentId: 'model-budget',
		agentName: 'Model budget',
		workingDirectory: await workingDirectory(),
		systemPrompt: 'Answer.',
		messages: [createUserMessage('billing')],
		runConfig: {
			model: 'large-base',
			tokenBudget: 100_000,
			timeoutMs: 20_000,
			maxIterations: 2,
		},
		prepareStep: [
			({ contextBudget }) => {
				budgets.push(contextBudget)
				return { model: 'gpt-4', system: 'x'.repeat(40_000) }
			},
			({ contextBudget }) => {
				budgets.push(contextBudget)
				return undefined
			},
		],
	})
	expect(budgets[0]?.windowTokens).toBe(1_000_000)
	expect(budgets[1]).toEqual({ windowTokens: 8_192, remainingTokens: 0 })
})

it('keeps tool-attached steering as current intent after its tool result is compacted away', async () => {
	const store = new InMemoryMemoryStore()
	await store.create({
		title: 'Billing',
		summary: 'billing',
		content: 'BILLING_MEMORY',
	})
	await store.create({
		title: 'Deployment',
		summary: 'deployment',
		content: 'DEPLOYMENT_MEMORY',
	})
	const steering = new SteeringBinding()
	const pending: Message[] = []
	const checkpoints = new InMemoryCheckpointStore()
	const tools = new ToolRegistry()
	tools.register({
		name: 'inspect',
		description: 'Read-only fixture',
		inputSchema: z.object({}),
		execute: async () => {
			steering.steer('Investigate deployment')
			pending.push(
				createRuntimeContextMessage('Unrelated worker finished', 'task-completion'),
				createAssistantMessage('Worker report available.'),
			)
			return { success: true, output: 'background '.repeat(3_000) }
		},
	})
	const provider = new MockLLMProvider({
		turns: [{ toolCalls: [{ name: 'inspect', args: {} }] }, { text: 'Done' }],
	})
	const events: RunEvent[] = []
	const result = await drainQuery(
		{
			...scope,
			provider,
			tools,
			checkpointStore: checkpoints,
			runStore: new InMemoryRunStore(),
			agentId: 'steered-recall',
			agentName: 'Steered recall',
			workingDirectory: await workingDirectory(),
			systemPrompt: 'Answer the question.',
			messages: [
				{ ...createUserMessage('OLDER_REQUEST'), retain: true },
				createAssistantMessage('Old report'),
				createUserMessage('Investigate billing'),
			],
			runConfig: {
				model: 'mock',
				timeoutMs: 20_000,
				tokenBudget: 100_000,
				maxIterations: 4,
				maxResponseTokens: 128,
			},
			compactionConfig: CompactionConfigSchema.parse({
				strategy: 'structured',
				contextWindowTokens: 3_000,
				llmVerification: false,
				clearToolResults: false,
				keepRecentMessages: 2,
			}),
			steering,
			inboundMessages: () => pending.splice(0),
			prepareStep: createMemoryRecallStep({ store }),
		},
		(event) => {
			events.push(event)
		},
	)
	expect(result.status).toBe('completed')
	expect(provider.requests).toHaveLength(2)
	expect(provider.requests[0]?.messages.at(-1)?.content).toContain('BILLING_MEMORY')
	expect(provider.requests[1]?.messages.at(-1)?.content).toContain('DEPLOYMENT_MEMORY')
	expect(provider.requests[1]?.messages.at(-1)?.content).not.toContain('BILLING_MEMORY')
	expect(events.some((event) => event.type === 'compaction_shed')).toBe(true)
	expect(provider.requests[1]?.messages.some((message) => message.role === 'tool')).toBe(false)
	const checkpoint = (await checkpoints.listCheckpoints({ ...scope, runId: result.id })).at(-1)
	expect(
		checkpoint?.messages.some(
			(message) =>
				message.role === 'tool' &&
				typeof message.content === 'string' &&
				message.content.includes('Investigate deployment'),
		),
	).toBe(true)
	expect(checkpoint?.latestUserMessage).toMatchObject({
		content: 'Investigate deployment',
		source: { type: 'runtime-context', kind: 'steering' },
	})
	expect(steering.pending).toBe(false)
})
