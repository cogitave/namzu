import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
	type CreateTaskOptions,
	type LLMProvider,
	LocalTaskScheduler,
	type Message,
	MockLLMProvider,
	type SessionEvent,
	type TaskHandle,
	type ToolContext,
	ToolRegistry,
	createToolPresenter,
	query,
} from '@namzu/sdk'
import { render } from 'ink-testing-library'
import stringWidth from 'string-width'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import type { Preferences } from '../../integrations/providers/index.js'
import type { SubagentActivity } from '../../integrations/subagents/activity.js'
import { subagentParentFixture } from '../../integrations/subagents/__fixtures__/parent.js'
import { createSubagentRuntime } from '../../integrations/subagents/runtime.js'
import type { Batch } from '../../integrations/subagents/batches.js'
import {
	AgentCockpit,
	AgentTaskPanel,
	AgentTranscript,
	activeSubagentCohorts,
	agentPhases,
	agentTaskPanelPageSize,
	agentTranscriptPage,
	agentTranscriptRows,
	agentWorkflows,
	maxAgentTranscriptTailOffset,
} from '../AgentExplorer.js'
import { type AgentEvent, type AgentSession, toAgentEvent } from '../agent.js'
import type { TuiContext } from '../types.js'
import { type Screen, renderToScreen } from './support/screen.js'

const PREFS: Preferences = {
	version: 3,
	providers: [{ id: 'openai' }],
	subagents: { active: [] },
}

const activity = vi.hoisted(() => {
	let snapshot: readonly unknown[] = []
	let narration: readonly unknown[] = []
	const listeners = new Set<() => void>()
	let delegated:
		| {
				getSnapshot: () => readonly unknown[]
				getNarration?: () => readonly unknown[]
				subscribe: (listener: () => void) => () => void
				reset: () => void
		  }
		| undefined
	return {
		source: {
			getSnapshot: () => delegated?.getSnapshot() ?? snapshot,
			getNarration: () => delegated?.getNarration?.() ?? narration,
			subscribe: (listener: () => void) => {
				if (delegated) return delegated.subscribe(listener)
				listeners.add(listener)
				return () => listeners.delete(listener)
			},
			reset: () => {
				if (delegated) {
					delegated.reset()
					return
				}
				snapshot = []
				narration = []
				for (const listener of listeners) listener()
			},
		},
		delegate: (source: typeof delegated) => {
			delegated = source
		},
		set: (next: readonly unknown[]) => {
			snapshot = next
			for (const listener of listeners) listener()
		},
		/** What the parent has narrated, as the monitor would publish it. */
		narrate: (next: readonly unknown[]) => {
			narration = next
			for (const listener of listeners) listener()
		},
	}
})

let releaseParent: () => void = () => {}
let parentGate = Promise.resolve()
const sendOverride: {
	current?: (
		messages: readonly Message[],
		opts?: Parameters<AgentSession['send']>[1],
	) => AsyncIterable<AgentEvent>
} = vi.hoisted(() => ({}))
/**
 * What this session's finished children left on disk, as the replay reads it.
 *
 * `reads` counts the reads so a test can assert that switching conversation
 * looks again, and `gate` holds one open so a test can put a read in flight
 * underneath the key press that asks for the cockpit.
 */
const savedChildren: {
	current: readonly SubagentActivity[]
	reads: number
	gate?: Promise<void>
} = vi.hoisted(() => ({ current: [], reads: 0 }))
/**
 * What `/agents batches` finds saved for this conversation, as the cheap
 * listing reads it. `gate` holds one open so a test can put the read in
 * flight underneath a key press, the same shape as `savedChildren.gate`.
 */
const orchestrationBatches: { current: readonly Batch[]; gate?: Promise<void> } = vi.hoisted(() => ({
	current: [],
}))

vi.mock('../../integrations/trust/store.js', () => ({
	isTrusted: () => true,
	trustDir: () => {},
}))
vi.mock('../../integrations/updates.js', () => ({
	checkUpdates: async () => [],
}))
vi.mock('../../user-commands/store.js', () => ({
	discoverUserCommands: () => [],
}))
vi.mock('../../integrations/sessions/store.js', () => ({
	// The /resume and /abandon paths ask for the parked turn first; none here.
	activeConversationTurn: async () => undefined,
	openSessions: async () => ({
		tenantId: 'tenant',
		turnEvidence: {
			recordTurnStarted: async (input: unknown) => ({
				...(input as object),
				turnId: 'turn',
			}),
			recordTurnSettled: async (input: unknown) => input,
		},
	}),
	startConversation: async () => 'conversation',
	requireWritableConversation: async () => {},
	appendMessages: async () => {},
	replaceConversation: async () => {},
	listRecent: async () => [],
	loadConversation: async () => [],
}))
vi.mock('../agent.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../agent.js')>()
	return {
		...actual,
		probeAgentSession: async () => ({
			preferences: PREFS,
			needsRepickReason: null,
			detected: [],
		}),
		createAgentSession: async (): Promise<AgentSession> => ({
			hasProvider: true,
			sandbox: { unconfined: true, enforced: [], required: [] },
			providerSummary: 'provider',
			modelSummary: 'model',
			reasoningEffortLevels: [],
			toolNames: () => ['Agent'],
			errorHint: null,
			errorKind: null,
			instructionFiles: [],
			skippedInstructionFiles: [],
			mcpConnected: [],
			mcpFailed: [],
			agentIds: ['general-purpose'],
			subagents: activity.source as AgentSession['subagents'],
			savedChildren: async () => {
				savedChildren.reads += 1
				await savedChildren.gate
				return savedChildren.current
			},
			listSavedBatches: async () => {
				await orchestrationBatches.gate
				return orchestrationBatches.current
			},
			configNotices: [],
			approvalLatched: () => false,
			promptExemptTools: () => [],
			compact: async () => null,
			resumeDurable: async () => {
				throw new Error('not used')
			},
			resumePaused: () => {
				throw new Error('resumePaused is not part of this test')
			},
			close: async () => {},
			send: async function* (
				messages: readonly Message[],
				opts?: Parameters<AgentSession['send']>[1],
			): AsyncIterable<AgentEvent> {
				if (sendOverride.current) {
					yield* sendOverride.current(messages, opts)
					return
				}
				if (JSON.stringify(messages).includes('reused tool id')) {
					yield {
						kind: 'tool-start',
						turnId: 'turn-next',
						toolUseId: 'matched-agent',
						toolName: 'Bash',
						summary: 'echo still visible',
					}
					await parentGate
					yield { kind: 'done', stopReason: 'end_turn' }
					return
				}
				if (JSON.stringify(messages).includes('tool row correlation')) {
					yield {
						kind: 'tool-start',
						toolUseId: 'matched-agent',
						toolName: 'Agent',
						summary: 'Matched child',
					}
					yield {
						kind: 'tool-start',
						toolUseId: 'unmatched-agent',
						toolName: 'Agent',
						summary: 'Unmatched child',
					}
					yield {
						kind: 'tool-start',
						toolUseId: 'unrelated-tool',
						toolName: 'Bash',
						summary: 'Agent(looks similar)',
						standalone: true,
					}
					await parentGate
					yield { kind: 'done', stopReason: 'end_turn' }
					return
				}
				await parentGate
				yield { kind: 'delta', text: 'parent finished\n\n' }
				yield { kind: 'done', stopReason: 'end_turn' }
				void messages
			},
		}),
	}
})

const { App } = await import('../App.js')
const ctx: TuiContext = { cwd: '/w', version: '0.0.0-test' }
let mounted: Screen | null = null

function agent(
	input: Partial<SubagentActivity> & Pick<SubagentActivity, 'viewId'>,
): SubagentActivity {
	return {
		viewId: input.viewId,
		...(input.taskId ? { taskId: input.taskId } : {}),
		agentId: input.agentId ?? 'general-purpose',
		...(input.model ? { model: input.model } : {}),
		...(input.tokens !== undefined ? { tokens: input.tokens } : {}),
		...(input.toolCalls !== undefined ? { toolCalls: input.toolCalls } : {}),
		description: input.description ?? input.viewId,
		prompt: input.prompt ?? `prompt for ${input.viewId}`,
		batchId: input.batchId ?? 'batch-live',
		...(input.toolUseId ? { toolUseId: input.toolUseId } : {}),
		workflowId: input.workflowId ?? 'turn-parent',
		workflowGroupId: input.workflowGroupId ?? JSON.stringify([
			input.workflowId ?? 'turn-parent',
			input.workflow ? 'workflow' : 'batch',
			input.workflow ?? input.batchId ?? 'batch-live',
		]),
		phaseId:
			input.phaseId ??
			JSON.stringify([
				input.workflowId ?? 'turn-parent',
				input.workflow ?? input.batchId ?? 'batch-live',
				input.phase ?? 'Work',
			]),
		workflow: input.workflow ?? 'Delegated work',
		phase: input.phase ?? 'Work',
		...(input.phaseOrder !== undefined ? { phaseOrder: input.phaseOrder } : {}),
		...(input.phaseDetail ? { phaseDetail: input.phaseDetail } : {}),
		phaseSequence: input.phaseSequence ?? 1,
		status: input.status ?? 'working',
		startedAt: input.startedAt ?? 1,
		transcript: input.transcript ?? [],
		...(input.completedAt !== undefined ? { completedAt: input.completedAt } : {}),
		...(input.latestActivity ? { latestActivity: input.latestActivity } : {}),
		...(input.replayed ? { replayed: true } : {}),
	}
}

/**
 * Bounded by the clock, not by a render count. A count of renders is a
 * count of how busy the screen is, which under load is the wrong axis: the
 * live region redraws on a timer, so a slow machine spends its 120 renders
 * on spinner ticks and fails a test whose condition was still on its way.
 * Twenty seconds is far past anything here at rest and still a failure,
 * not a hang, when a condition never arrives.
 */
async function waitUntil(screen: Screen, predicate: () => boolean, message: string): Promise<void> {
	const deadline = Date.now() + 20_000
	while (Date.now() < deadline) {
		await screen.waitForRender()
		if (predicate()) return
		await new Promise<void>((resolve) => setImmediate(resolve))
	}
	throw new Error(`${message}\n${screen.viewport().join('\n')}`)
}

function painted(screen: Screen): string {
	return screen.scrollback().join('\n')
}

async function submit(screen: Screen, text: string): Promise<void> {
	screen.press(text)
	await screen.waitForRender()
	screen.press('\r')
	await screen.waitForRender()
}

beforeEach(() => {
	delete sendOverride.current
	savedChildren.current = []
	savedChildren.reads = 0
	delete savedChildren.gate
	orchestrationBatches.current = []
	delete orchestrationBatches.gate
	activity.delegate(undefined)
	activity.set([])
	activity.narrate([])
	parentGate = new Promise<void>((resolve) => {
		releaseParent = resolve
	})
})

afterEach(async () => {
	releaseParent()
	await mounted?.unmount()
	mounted = null
	vi.restoreAllMocks()
	vi.useRealTimers()
})

describe('Ctrl+T', () => {
	it('suppresses only the generic Agent row correlated to a visible child', async () => {
		activity.set([
			agent({
				viewId: 'correlated-child',
				description: 'Correlated child',
				toolUseId: 'matched-agent',
			}),
		])
		const screen = await renderToScreen(<App ctx={ctx} />, {
			cols: 110,
			rows: 28,
		})
		mounted = screen
		await waitUntil(screen, () => painted(screen).includes('model'), 'not ready')
		await submit(screen, 'tool row correlation')
		await waitUntil(
			screen,
			() => screen.viewport().join('\n').includes('Unmatched child'),
			'unmatched Agent tool row disappeared',
		)
		const frame = screen.viewport().join('\n')
		expect(frame).not.toContain('Matched child')
		expect(frame).toContain('Agent(looks similar)')

		activity.set([
			agent({
				viewId: 'correlated-child',
				description: 'Correlated child',
				toolUseId: 'matched-agent',
				status: 'completed',
				completedAt: 30,
			}),
		])
		await screen.waitForRender()
		const handoffFrame = screen.viewport().join('\n')
		expect(handoffFrame).not.toContain('Matched child')
		expect(handoffFrame).toContain('Unmatched child')
	})

	it('does not hide another turn tool that reuses a terminal child call id', async () => {
		activity.set([
			agent({
				viewId: 'old-child',
				workflowId: 'run-old',
				toolUseId: 'matched-agent',
				status: 'completed',
				completedAt: 30,
			}),
		])
		const screen = await renderToScreen(<App ctx={ctx} />, { cols: 110, rows: 28 })
		mounted = screen
		await waitUntil(screen, () => painted(screen).includes('model'), 'not ready')
		await submit(screen, 'reused tool id')
		await waitUntil(
			screen,
			() => screen.viewport().join('\n').includes('echo still visible'),
			'reused Bash call id was hidden by an old Agent record',
		)
	})

	it('renders the real Agent runtime lifecycle for four concurrent children', async () => {
		const created: CreateTaskOptions[] = []
		const handles: TaskHandle[] = []
		const completions = new Map<string, (handle: TaskHandle) => void>()
		vi.spyOn(LocalTaskScheduler.prototype, 'createTask').mockImplementation(async (options) => {
			const taskId = `task-${created.length}`
			created.push(options)
			const handle = {
				taskId,
				agentId: options.agentId,
				state: 'running',
				createdAt: Date.now(),
			} as unknown as TaskHandle
			handles.push(handle)
			return handle
		})
		vi.spyOn(LocalTaskScheduler.prototype, 'listTasks').mockImplementation(() => handles)
		vi.spyOn(LocalTaskScheduler.prototype, 'waitForTask').mockImplementation(
			(taskId) =>
				new Promise<TaskHandle>((resolve) => {
					completions.set(String(taskId), resolve)
				}),
		)
		const parent = await subagentParentFixture('/tmp')
		const runtime = await createSubagentRuntime({
			resolveParent: parent.resolveParent,
			cwd: '/tmp',
			model: 'test-model',
			buildProvider: () => ({}) as LLMProvider,
			buildTools: () => ({}) as never,
		})
		try {
			activity.delegate(runtime.activity)
			const screen = await renderToScreen(<App ctx={ctx} />, {
				cols: 110,
				rows: 28,
			})
			mounted = screen
			await waitUntil(screen, () => painted(screen).includes('model'), 'not ready')

			const executions = Array.from({ length: 4 }, (_, index) =>
				runtime.agentTool.execute(
					{
						description: `Runtime child ${index + 1}`,
						prompt: `Inspect area ${index + 1}`,
					},
					{
						sessionId: parent.scope.sessionId,
						turnId: parent.scope.turnId,
						workingDirectory: '/tmp',
						abortSignal: new AbortController().signal,
						env: {},
						log: () => {},
						toolUseId: `agent-call-${index + 1}`,
						toolBatchId: 'agent-wave-one',
					} as unknown as ToolContext,
				),
			)
			await waitUntil(
				screen,
				() => created.length === 4,
				'real runtime did not create four children',
			)
			for (let index = 0; index < created.length; index += 1) {
				created[index]?.onEvent?.({
					type: 'turn_started',
					turnId: `turn-child-${index}`,
				} as unknown as SessionEvent)
			}
			created[0]?.onEvent?.({
				type: 'reasoning_delta',
				turnId: 'turn-child-0',
				iteration: 1,
				messageId: 'reasoning' as never,
				blockIndex: 0,
				text: 'private reasoning must stay hidden',
			} as unknown as SessionEvent)
			created[0]?.onEvent?.({
				type: 'text_delta',
				turnId: 'turn-child-0',
				iteration: 1,
				messageId: 'answer' as never,
				text: 'public live finding',
			} as unknown as SessionEvent)
			// Child deltas are intentionally coalesced for 100 ms so a token stream
			// cannot make Ink repaint per token. Wait past that production boundary.
			await new Promise<void>((resolve) => setTimeout(resolve, 120))
			await waitUntil(
				screen,
				() => screen.viewport().join('\n').includes('public live finding'),
				'interim child answer did not reach the automatic panel',
			)
			completions.get('task-0')?.({
				taskId: 'task-0',
				agentId: 'general-purpose',
				state: 'completed',
				createdAt: Date.now(),
				completedAt: Date.now(),
				result: { status: 'completed', result: 'first done' },
			} as unknown as TaskHandle)

			await waitUntil(
				screen,
				() => screen.viewport().join('\n').includes('3 running · 1/4 done · '),
				'completed sibling did not remain beside its live cohort',
			)
			const liveFrame = screen.viewport().join('\n')
			expect(liveFrame).toMatch(/3 running · 1\/4 done · \S+ · ↓ \/ ctrl\+t/u)
			expect(liveFrame).not.toContain('private reasoning must stay hidden')

			for (let index = 1; index < 4; index += 1) {
				completions.get(`task-${index}`)?.({
					taskId: `task-${index}`,
					agentId: 'general-purpose',
					state: 'completed',
					createdAt: Date.now(),
					completedAt: Date.now(),
					result: { status: 'completed', result: `child ${index + 1} done` },
				} as unknown as TaskHandle)
			}
			await Promise.all(executions)
			await waitUntil(
				screen,
				() => !/running · .*↓ \/ ctrl\+t/u.test(screen.viewport().join('\n')),
				'settled runtime cohort remained visible',
			)
			await waitUntil(
				screen,
				() => painted(screen).includes('✓ Runtime child 4 · '),
				'runtime completion missing',
			)
			expect(screen.viewport().join('\n')).toContain('Type a message')
		} finally {
			await runtime.close()
		}
	})

	it('drives a real parent query through four concurrent Agent calls into the mounted panel', async () => {
		const work = mkdtempSync(join(tmpdir(), 'namzu-live-agents-'))
		const childRequestStartedAt: number[] = []
		let reportAllChildrenStarted: () => void = () => {}
		const allChildrenStarted = new Promise<void>((resolve) => {
			reportAllChildrenStarted = resolve
		})
		let releaseChildren: () => void = () => {}
		const allowChildrenToComplete = new Promise<void>((resolve) => {
			releaseChildren = resolve
		})
		const parentFixture = await subagentParentFixture(work)
		const runtime = await createSubagentRuntime({
			resolveParent: parentFixture.resolveParent,
			cwd: work,
			model: 'mock-model',
			tokenBudget: 100_000,
			buildProvider: () => {
				const child = new MockLLMProvider({ responseText: 'child completed' })
				return {
					id: child.id,
					name: child.name,
					capabilities: child.capabilities,
					chatStream: async function* (params) {
						childRequestStartedAt.push(Date.now())
						if (childRequestStartedAt.length === 4) reportAllChildrenStarted()
						await allowChildrenToComplete
						yield* child.chatStream(params)
					},
					listModels: () => child.listModels(),
					healthCheck: () => child.healthCheck(),
				} satisfies LLMProvider
			},
			buildTools: () => new ToolRegistry(),
		})
		try {
			const tools = new ToolRegistry()
			tools.register(runtime.agentTool)
			const presenter = createToolPresenter(tools)
			const parent = new MockLLMProvider({
				turns: [
					{
						toolCalls: Array.from({ length: 4 }, (_, index) => ({
							id: `agent-real-${index + 1}`,
							name: 'Agent',
							args: {
								description: `Production child ${index + 1}`,
								prompt: `Inspect production seam ${index + 1}`,
								workflow: 'Production fan-out',
								phase: 'Review',
							},
						})),
					},
					{ text: 'parent completed' },
				],
			})
			sendOverride.current = async function* (messages) {
				const events = query({
					taskScheduler: await runtime.gatewayForTurn(parentFixture.scope.turnId),
					provider: parent,
					tools,
					turnConfig: {
						model: 'mock-model',
						tokenBudget: 100_000,
						// Generous on purpose. Four real child sessions stand up under this
						// parent, and on a loaded machine — the whole workspace testing
						// at once — that took longer than the five seconds this used to
						// allow, which failed the parent with a timeout the test was
						// never about. The assertions below are about concurrency and
						// the screen, and none of them names a wall-clock threshold.
						timeoutMs: 60_000,
						maxIterations: 4,
						permissionMode: 'auto',
					},
					agentId: 'namzu-test',
					agentName: 'namzu-test',
					workingDirectory: work,
					messages: [...messages],
					resumeHandler: async () => ({ action: 'approve_tools' }),
					...parentFixture.scope,
				})
				for await (const event of events) {
					const projected = toAgentEvent(event, presenter)
					if (projected) yield projected
				}
			}
			activity.delegate(runtime.activity)
			const screen = await renderToScreen(<App ctx={ctx} />, { cols: 110, rows: 28 })
			mounted = screen
			await waitUntil(screen, () => painted(screen).includes('model'), 'not ready')

			await submit(screen, 'production executor fan-out')
			await waitUntil(
				screen,
				() => /4 running · \S+ · ↓ \/ ctrl\+t/u.test(screen.viewport().join('\n')),
				'real query fan-out did not reach the automatic panel',
			)
			await expect(allChildrenStarted).resolves.toBeUndefined()
			releaseChildren()
			await waitUntil(
				screen,
				() => painted(screen).includes('parent completed'),
				'real parent query did not settle',
			)

			expect(parent.requests).toHaveLength(2)
			expect(childRequestStartedAt).toHaveLength(4)
			// Each child blocks until all four have entered its provider. A serial
			// scheduler can never reach this assertion; no wall-clock threshold is
			// involved.
			expect(screen.writes().join('')).not.toContain('Agent(Production child')
			// The live rail has left with its settled cohort; what stays is the
			// launch receipt, which names the batch once in settled history.
			expect(screen.viewport().join('\n')).not.toMatch(/running · .*↓ \/ ctrl\+t/u)
			expect(painted(screen).match(/Launched 4 agents · Production fan-out/g)).toHaveLength(1)
			// The turn delegated, so it closes with one line saying so.
			expect(painted(screen)).toMatch(/✻ Worked for \S+ · 4 agents/u)
		} finally {
			releaseChildren()
			delete sendOverride.current
			await runtime.close()
			removeTempDir(work)
		}
	})

	it('shows active children automatically and preserves a draft through inspect and completion', async () => {
		const alpha = agent({
			viewId: 'agent-alpha',
			description: 'Alpha audit',
			latestActivity: 'Answering · interim evidence',
		})
		const beta = agent({ viewId: 'agent-beta', description: 'Beta build' })
		activity.set([alpha, beta])
		const screen = await renderToScreen(<App ctx={ctx} />, {
			cols: 110,
			rows: 28,
		})
		mounted = screen
		await waitUntil(screen, () => painted(screen).includes('model'), 'not ready')
		await waitUntil(
			screen,
			() => screen.viewport().join('\n').includes('interim evidence'),
			'automatic agent panel missing',
		)

		screen.press('draft survives')
		screen.press('\x14')
		await waitUntil(
			screen,
			() => screen.viewport().join('\n').includes('Phases'),
			'cockpit missing',
		)
		expect(screen.viewport().join('\n')).not.toContain('draft survives')
		screen.press('\x14')
		await waitUntil(
			screen,
			() => !screen.viewport().join('\n').includes('Phases'),
			'cockpit did not close',
		)
		expect(screen.viewport().join('\n')).toContain('draft survives')

		activity.set([
			{
				...alpha,
				status: 'completed',
				completedAt: 20,
				latestActivity: 'Completed',
			},
			{
				...beta,
				status: 'completed',
				completedAt: 21,
				latestActivity: 'Completed',
			},
		])
		await waitUntil(
			screen,
			() => !/running · .*↓ \/ ctrl\+t/u.test(screen.viewport().join('\n')),
			'settled cohort remained docked',
		)
		expect(screen.viewport().join('\n')).toContain('draft survives')
	})

	it('opens the active roster with down from a truly empty composer', async () => {
		activity.set([agent({ viewId: 'agent-down', description: 'Down-select child' })])
		const screen = await renderToScreen(<App ctx={ctx} />, {
			cols: 110,
			rows: 28,
		})
		mounted = screen
		await waitUntil(screen, () => painted(screen).includes('model'), 'not ready')
		screen.press('\x1b[B')
		await waitUntil(
			screen,
			() => screen.viewport().join('\n').includes('Phases'),
			'down did not focus delegated work',
		)
	})

	it('keeps the composer and footer reachable while a short viewport bounds the roster', async () => {
		activity.set(
			Array.from({ length: 6 }, (_, index) =>
				agent({ viewId: `short-${index}`, description: `Short worker ${index}` }),
			),
		)
		const screen = await renderToScreen(<App ctx={ctx} />, { cols: 90, rows: 14 })
		mounted = screen
		await waitUntil(screen, () => painted(screen).includes('model'), 'not ready')
		const frame = screen.viewport().join('\n')
		expect(frame).toContain('Type a message')
		expect(frame).toContain('model')
		expect(frame).toContain('Short worker 0')
		expect(frame).not.toContain('Short worker 1')
		expect(frame).toContain('+5 more')
	})

	it('keeps a narrow viewport single-line even with long workflow activity', async () => {
		activity.set([
			agent({
				viewId: 'narrow-worker',
				description: 'A deliberately long delegated task description',
				workflow: 'A deliberately long workflow title that must not wrap',
				latestActivity: 'Answering · a deliberately long public preview that must not wrap',
			}),
		])
		const screen = await renderToScreen(<App ctx={ctx} />, { cols: 40, rows: 14 })
		mounted = screen
		await waitUntil(screen, () => painted(screen).includes('model'), 'not ready')
		const frame = screen.viewport().join('\n')
		expect(frame).toContain('Type a message')
		expect(frame).toContain('model')
		expect(frame).toContain('1/1')
		expect(frame).not.toContain('public preview')
		expect(screen.viewport()).toHaveLength(14)
	})

	it('opens on the phase whose agent is still working, titled by that phase', async () => {
		const settled = { status: 'completed' as const, completedAt: 3, workflow: 'Two-phase colour sentence' }
		activity.set([
			agent({ viewId: 'first', description: 'Choose first colour', phase: 'Phase 1', phaseOrder: 0, ...settled }),
			agent({ viewId: 'second', description: 'Choose second colour', phase: 'Phase 1', phaseOrder: 0, ...settled }),
			agent({
				viewId: 'join',
				description: 'Join the two colours',
				workflow: 'Two-phase colour sentence',
				phase: 'Phase 2',
				phaseOrder: 1,
				batchId: 'batch-two',
			}),
		])
		const screen = await renderToScreen(<App ctx={ctx} />, { cols: 110, rows: 28 })
		mounted = screen
		await waitUntil(screen, () => painted(screen).includes('model'), 'not ready')
		screen.press('\x14')
		await waitUntil(
			screen,
			() => screen.viewport().join('\n').includes('Phase 2 · 1 agent'),
			'the cockpit did not open on the live phase',
		)
		const frame = screen.viewport().join('\n')
		expect(frame).toMatch(/› ● 2 Phase 2/u)
		expect(frame).toMatch(/› ● Join the two colours/u)
		expect(frame).toContain('2/3 agents done · 1 running')
	})

	it('gives the inspector its own short viewport and restores the composer draft', async () => {
		activity.set([agent({ viewId: 'short-inspector', description: 'Short inspector child' })])
		const screen = await renderToScreen(<App ctx={ctx} />, { cols: 60, rows: 14 })
		mounted = screen
		await waitUntil(screen, () => painted(screen).includes('model'), 'not ready')
		screen.press('draft remains visible')
		screen.press('\x14')
		await waitUntil(
			screen,
			() => screen.viewport().join('\n').includes('Phases'),
			'short inspector did not open',
		)
		const frame = screen.viewport().join('\n')
		expect(frame).toContain('Phases')
		expect(frame).toContain('1 agent')
		expect(frame).not.toContain('draft remains visible')
		screen.press('\x14')
		await waitUntil(screen, () => screen.viewport().join('\n').includes('draft remains visible'), 'draft was not restored')
		// Back at idle with no interaction hint active, the footer's right side
		// falls through to the model again — it was displaced by the cockpit's
		// own hint a moment ago, exactly as an interaction hint displaces it.
		expect(screen.viewport().join('\n')).toContain('model')
		expect(screen.viewport()).toHaveLength(14)
	})

	it('opens live delegated work with ctrl+t while the parent remains active', async () => {
		activity.set([
			agent({ viewId: 'agent-alpha', description: 'Alpha audit' }),
			agent({ viewId: 'agent-beta', description: 'Beta build' }),
		])
		const screen = await renderToScreen(<App ctx={ctx} />, {
			cols: 110,
			rows: 28,
		})
		mounted = screen
		await waitUntil(screen, () => painted(screen).includes('model'), 'not ready')

		await submit(screen, 'start parent')
		await waitUntil(
			screen,
			() => screen.viewport().join('\n').includes('↓ / ctrl+t'),
			'live child shortcut missing',
		)
		screen.press('\x14')
		await waitUntil(
			screen,
			() => screen.viewport().join('\n').includes('Alpha audit'),
			'ctrl+t did not open the agent cockpit',
		)
		expect(painted(screen)).not.toContain('parent finished')
	})

	it('a child evicted from the live monitor still opens from saved evidence', async () => {
		// Nothing in the live monitor: the eighty-agent bound dropped this child,
		// or the process that ran it has exited. Its evidence is still on disk.
		activity.set([])
		savedChildren.current = [
			agent({
				viewId: 'saved-1',
				description: 'Contract critic',
				status: 'completed',
				startedAt: 1,
				completedAt: 2,
				replayed: true,
				transcript: [{ id: 'saved-row', kind: 'tool', text: 'Read(src/a.ts)', status: 'completed' }],
			}),
		]
		const screen = await renderToScreen(<App ctx={ctx} />, { cols: 110, rows: 28 })
		mounted = screen
		await waitUntil(screen, () => painted(screen).includes('model'), 'not ready')

		screen.press('\x14')
		await waitUntil(
			screen,
			() => screen.viewport().join('\n').includes('Contract critic'),
			'saved evidence did not reach the cockpit',
		)
		screen.press('\r')
		await waitUntil(
			screen,
			() => screen.viewport().join('\n').includes('Read(src/a.ts)'),
			'the saved child transcript did not open',
		)

		const rows = screen.viewport()
		const frame = rows.join('\n')
		// The refusal to overclaim, on screen: where it came from, and that it
		// is not a session anything can be sent into.
		expect(frame).toContain('Replayed from saved evidence.')
		expect(frame).toContain('cannot be continued')
		// The marker on the child's OWN line, where the model and the counters
		// would be. Asserted against that line and not the whole frame, which
		// the banner's own word `saved` would satisfy on its own.
		const identity = rows.find((row) => row.includes('Contract critic'))
		expect(identity).toBeDefined()
		expect(identity).toContain('saved')
		// And no affordance that would imply otherwise.
		expect(frame).not.toMatch(/send message|cancel/i)
	})

	it('reads saved evidence again when the conversation changes, and opens it first try', async () => {
		activity.set([])
		const screen = await renderToScreen(<App ctx={ctx} />, { cols: 110, rows: 28 })
		mounted = screen
		await waitUntil(screen, () => painted(screen).includes('model'), 'not ready')
		const readsOnInstall = savedChildren.reads

		// The evidence belongs to the conversation being switched TO, so it only
		// becomes readable once the scope names that conversation. The read is
		// held open so the cockpit request has to outlive it.
		let release: () => void = () => {}
		savedChildren.gate = new Promise<void>((resolve) => {
			release = resolve
		})
		savedChildren.current = [
			agent({
				viewId: 'saved-2',
				description: 'Contract critic',
				status: 'completed',
				startedAt: 1,
				completedAt: 2,
				replayed: true,
				transcript: [{ id: 'saved-row-2', kind: 'tool', text: 'Read(src/b.ts)', status: 'completed' }],
			}),
		]

		await submit(screen, '/new')
		await waitUntil(
			screen,
			() => painted(screen).includes('Started a fresh conversation'),
			'the conversation did not change',
		)
		// Changing which conversation the scope names is itself a reason to look
		// again. A resume is the case that matters — its children are exactly the
		// ones this process never saw — and it goes through this same path.
		expect(savedChildren.reads).toBeGreaterThan(readsOnInstall)

		await submit(screen, '/agents')
		release()
		// Either answer ends the wait, so a wrong one fails as an assertion
		// naming what appeared rather than as a timeout naming nothing.
		await waitUntil(
			screen,
			() =>
				screen.viewport().join('\n').includes('Contract critic') ||
				painted(screen).includes('No delegated agents'),
			'the first /agents neither opened the saved child nor answered at all',
		)
		// While that read was still running it must not have claimed there was
		// nothing to open. The line below is true of a conversation that
		// delegated nothing, and a lie about this one.
		expect(painted(screen)).not.toContain('No delegated agents in this conversation.')
		expect(screen.viewport().join('\n')).toContain('Contract critic')
	})

	it("does not treat the command's opening Return as a painted-surface action", async () => {
		activity.set([
			agent({
				viewId: 'agent-child',
				description: 'Child session',
				transcript: [
					{
						id: 'child-row',
						kind: 'assistant',
						text: 'private child evidence',
					},
				],
			}),
		])
		const screen = await renderToScreen(<App ctx={ctx} />, {
			cols: 110,
			rows: 28,
		})
		mounted = screen
		await waitUntil(screen, () => painted(screen).includes('model'), 'not ready')

		screen.press('\x14')
		await waitUntil(
			screen,
			() => screen.viewport().join('\n').includes('Child session'),
			'picker missing',
		)
		expect(screen.viewport().join('\n')).not.toContain('private child evidence')

		// The burst fence must eventually arm; permanently ignoring input would
		// satisfy the negative assertion above while leaving the picker unusable.
		screen.press('\r')
		await waitUntil(
			screen,
			() => screen.viewport().join('\n').includes('private child evidence'),
			'picker never became actionable',
		)
	})

	it('keeps burst navigation and view changes without waiting for a repaint', async () => {
		activity.set([
			agent({ viewId: 'agent-a', description: 'Alpha', transcript: [] }),
			agent({ viewId: 'agent-b', description: 'Beta', transcript: [] }),
			agent({
				viewId: 'agent-c',
				description: 'Gamma',
				transcript: [{ id: 'gamma-row', kind: 'assistant', text: 'gamma evidence' }],
			}),
		])
		const screen = await renderToScreen(<App ctx={ctx} />, {
			cols: 110,
			rows: 28,
		})
		mounted = screen
		await waitUntil(screen, () => painted(screen).includes('model'), 'not ready')
		screen.press('\x14')
		await screen.waitForRender()
		await waitUntil(screen, () => screen.viewport().join('\n').includes('Alpha'), 'picker missing')

		screen.press('\x1b[B')
		screen.press('\x1b[B')
		screen.press('\r')
		screen.press('\x1b')
		await screen.waitForRender()
		screen.press('\r')
		await waitUntil(
			screen,
			() => screen.viewport().join('\n').includes('gamma evidence'),
			'burst input lost the selected child',
		)
	})
	it('keeps selection on the same child when lifecycle sorting reorders the list', async () => {
		const alpha = agent({
			viewId: 'agent-alpha',
			description: 'Alpha audit',
			transcript: [{ id: 'alpha-row', kind: 'assistant', text: 'alpha evidence' }],
		})
		const beta = agent({ viewId: 'agent-beta', description: 'Beta build' })
		activity.set([alpha, beta])
		const screen = await renderToScreen(<App ctx={ctx} />, {
			cols: 110,
			rows: 28,
		})
		mounted = screen
		await waitUntil(screen, () => painted(screen).includes('model'), 'not ready')

		screen.press('\x14')
		await screen.waitForRender()
		await waitUntil(
			screen,
			() => screen.viewport().join('\n').includes('Alpha audit'),
			'picker missing',
		)

		activity.set([
			beta,
			{
				...alpha,
				status: 'completed',
				completedAt: 20,
				latestActivity: 'Completed',
			},
		])
		await screen.waitForRender()
		screen.press('\r')
		await waitUntil(
			screen,
			() => screen.viewport().join('\n').includes('alpha evidence'),
			'stable selection opened the wrong child',
		)
		expect(screen.viewport().join('\n')).toContain('Alpha audit')
	})

	it('moves from the phase rail into a child transcript through the production App', async () => {
		activity.set([
			agent({
				viewId: 'research-api',
				description: 'API research',
				workflow: 'Basicbox research',
				batchId: 'research-batch',
				phase: 'Research',
				phaseOrder: 0,
			}),
			agent({
				viewId: 'verify-contract',
				description: 'Contract critic',
				workflow: 'Basicbox research',
				batchId: 'verification-batch',
				phase: 'Verify',
				phaseOrder: 1,
				transcript: [
					{
						id: 'critic-evidence',
						kind: 'assistant',
						text: 'verification evidence',
					},
				],
			}),
		])
		const screen = await renderToScreen(<App ctx={ctx} />, {
			cols: 110,
			rows: 28,
		})
		mounted = screen
		await waitUntil(screen, () => painted(screen).includes('model'), 'not ready')

		screen.press('\x14')
		await screen.waitForRender()
		await waitUntil(
			screen,
			() => screen.viewport().join('\n').includes('Phases · 1/2'),
			'phase rail missing',
		)
		screen.press('\x1b[D')
		screen.press('\x1b[B')
		screen.press('\x1b[C')
		screen.press('\r')
		await waitUntil(
			screen,
			() => screen.viewport().join('\n').includes('verification evidence'),
			'phase selection did not reach the selected child transcript',
		)
		expect(screen.viewport().join('\n')).toContain('Contract critic')
	})

	it.each([{ cols: 110, rows: 28 }, { cols: 60, rows: 18 }])(
		'keeps two eight-agent actions as separate workflows at $cols×$rows', async ({ cols, rows }) => {
		const first = Array.from({ length: 8 }, (_, index) => agent({
			viewId: `first-${index}`, description: `First agent ${index + 1}`,
			workflowId: 'run-one', workflow: 'Capacity review', phase: 'Inspect', phaseOrder: 0,
			status: 'completed', startedAt: 1, completedAt: 2,
			transcript: [{ id: `first-result-${index}`, kind: 'assistant', text: 'first workflow evidence' }],
		}))
		const second = Array.from({ length: 8 }, (_, index) => agent({
			viewId: `second-${index}`, description: `Second agent ${index + 1}`,
			workflowId: 'run-two', workflow: 'Capacity review', phase: 'Inspect', phaseOrder: 0,
			status: 'cancelled', startedAt: 3, completedAt: 4,
			transcript: [{ id: `second-result-${index}`, kind: 'assistant', text: 'second workflow cancellation' }],
		}))
		activity.set([...first, ...second])
		const screen = await renderToScreen(<App ctx={ctx} />, { cols, rows })
		mounted = screen
		await waitUntil(screen, () => painted(screen).includes('model'), 'not ready')
		screen.press('preserved draft')
		await screen.waitForRender()
		screen.press('\x14')
		await waitUntil(screen, () => screen.viewport().join('\n').includes('Workflows · 2/2'), 'workflow picker missing')
		expect(screen.viewport().join('\n')).not.toContain('Phases · 1/2')
		screen.press('\r')
		await waitUntil(screen, () => screen.viewport().join('\n').includes('Second agent 1'), 'latest workflow missing')
		let frame = screen.viewport().join('\n')
		expect(frame).toContain('Phases · 1/1')
		expect(frame).toContain('8/8 agents')
		expect(frame).not.toContain('First agent')
		screen.press('\r')
		await waitUntil(screen, () => screen.viewport().join('\n').includes('second workflow cancellation'), 'cancelled transcript missing')
		screen.press('\x1b')
		await waitUntil(screen, () => screen.viewport().join('\n').includes('Phases · 1/1'), 'did not return to agents')
		screen.press('\x1b')
		await waitUntil(screen, () => screen.viewport().join('\n').includes('Workflows · 2/2'), 'did not return to workflows')
		screen.press('\x1b[A')
		screen.press('\r')
		await waitUntil(screen, () => screen.viewport().join('\n').includes('First agent 1'), 'previous workflow missing')
		frame = screen.viewport().join('\n')
		expect(frame).toContain('8/8 agents')
		expect(frame).not.toContain('Second agent')
		screen.press('q')
		await waitUntil(screen, () => screen.viewport().join('\n').includes('preserved draft'), 'draft not restored')
		screen.press('\x14')
		await waitUntil(screen, () => screen.viewport().join('\n').includes('Workflows · 2/2'), 'retained workflows did not reopen')
	})

	it('keeps the selected child while the mounted cockpit crosses its responsive breakpoint', async () => {
		activity.set([
			agent({ viewId: 'agent-alpha', description: 'Alpha' }),
			agent({
				viewId: 'agent-beta',
				description: 'Beta',
				transcript: [{ id: 'beta-proof', kind: 'assistant', text: 'beta survives resize' }],
			}),
		])
		const screen = await renderToScreen(<App ctx={ctx} />, {
			cols: 110,
			rows: 28,
		})
		mounted = screen
		await waitUntil(screen, () => painted(screen).includes('model'), 'not ready')
		screen.press('\x14')
		await screen.waitForRender()
		await waitUntil(screen, () => screen.viewport().join('\n').includes('Alpha'), 'cockpit missing')

		screen.press('\x1b[B')
		await screen.resize(60, 28)
		expect(screen.viewport().join('\n')).toContain('Phases · 1/1')
		expect(screen.viewport().join('\n')).toContain('Beta')
		await screen.resize(110, 28)
		screen.press('\r')
		await waitUntil(
			screen,
			() => screen.viewport().join('\n').includes('beta survives resize'),
			'resize lost the selected child',
		)
	})

	it('falls back inside the selected phase when retention removes its selected child', async () => {
		const alpha = agent({
			viewId: 'agent-alpha',
			description: 'Alpha fallback',
			transcript: [{ id: 'alpha-proof', kind: 'assistant', text: 'fallback evidence' }],
		})
		const beta = agent({ viewId: 'agent-beta', description: 'Beta pruned' })
		activity.set([alpha, beta])
		const screen = await renderToScreen(<App ctx={ctx} />, {
			cols: 110,
			rows: 28,
		})
		mounted = screen
		await waitUntil(screen, () => painted(screen).includes('model'), 'not ready')
		screen.press('\x14')
		await screen.waitForRender()
		await waitUntil(
			screen,
			() => screen.viewport().join('\n').includes('Beta pruned'),
			'cockpit missing',
		)
		screen.press('\x1b[B')

		activity.set([alpha])
		await waitUntil(
			screen,
			() => screen.viewport().join('\n').includes('Alpha fallback'),
			'cockpit closed instead of choosing a fallback',
		)
		screen.press('\r')
		await waitUntil(
			screen,
			() => screen.viewport().join('\n').includes('fallback evidence'),
			'fallback child did not remain inspectable',
		)
	})

	it('shows a live child screen, pages its full tool output and restores the parent draft', async () => {
		vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
		const child = agent({
			viewId: 'child-screen-id',
			description: 'Inspect project sources',
			prompt: 'CHILD_TASK_START',
			startedAt: Date.now(),
			transcript: [
				{
					id: 'read-output',
					kind: 'tool',
					status: 'completed',
					text: 'Read(project.ts)',
					detail: Array.from(
						{ length: 412 },
						(_, index) =>
							`TOOL_EVIDENCE_${String(index + 1).padStart(3, '0')}\t\t\t\t\t\treturn "漢字 café 👩🏽‍💻"; // value_${index + 1}`,
					).join('\n'),
				},
			],
		})
		activity.set([child])
		const screen = await renderToScreen(<App ctx={ctx} />, { cols: 80, rows: 24 })
		mounted = screen
		await waitUntil(screen, () => painted(screen).includes('model'), 'not ready')
		await submit(screen, 'start parent')
		screen.press('PARENT_DRAFT_RESTORED')
		screen.press('\x14')
		await screen.waitForRender()
		screen.press('\r')
		await waitUntil(
			screen,
			() => screen.viewport().join('\n').includes('TOOL_EVIDENCE_412'),
			'child transcript missing',
		)
		let frame = screen.viewport().join('\n')
		expect(frame).toContain('Subagent')
		expect(frame).toContain('Inspect project sources')
		expect(frame).toContain('q parent')
		expect(frame).not.toContain('PARENT_DRAFT_RESTORED')
		expect(frame).not.toContain('MESSAGE')
		expect(frame).not.toContain('child-screen-id')
		expect(frame).not.toContain('CHILD_TASK_START')
		expect(screen.writes().join('')).not.toContain('\t')
		const expectChildFrame = (columns: number) => {
			const viewport = screen.viewport()
			const top = viewport.findIndex((line) => line.startsWith(' ┌'))
			const bottom = viewport.findIndex((line) => line.startsWith(' └'))
			expect(top).toBeGreaterThanOrEqual(0)
			expect(bottom).toBeGreaterThan(top)
			for (const line of viewport.slice(top + 1, bottom)) {
				expect(line).toMatch(/^ │.*│$/u)
				expect(stringWidth(line)).toBe(columns - 1)
			}
		}
		expectChildFrame(80)
		const tickStartedAt = Date.now()
		const clock = vi.spyOn(Date, 'now')
		for (let tick = 1; tick <= 3; tick += 1) {
			clock.mockReturnValue(tickStartedAt + tick * 1_000)
			await vi.advanceTimersByTimeAsync(1_000)
			await screen.waitForRender()
			expect(painted(screen).match(/Subagent/g)).toHaveLength(1)
			expectChildFrame(80)
		}
		clock.mockRestore()

		activity.set([
			{
				...child,
				transcript: [
					...child.transcript,
					{ id: 'live-answer', kind: 'assistant', text: 'CHILD_LIVE_UPDATE' },
				],
			},
		])
		await waitUntil(
			screen,
			() => screen.viewport().join('\n').includes('CHILD_LIVE_UPDATE'),
			'child output did not update while observed',
		)
		expect(painted(screen).match(/Subagent/g)).toHaveLength(1)
		screen.press('\x1b[H')
		await screen.waitForRender()
		frame = screen.viewport().join('\n')
		expect(frame).toContain('CHILD_TASK_START')
		expect(frame).toContain('Read(project.ts)')
		expect(frame).toContain('History')
		const seen = new Set(frame.match(/TOOL_EVIDENCE_\d{3}/g) ?? [])
		for (let page = 0; page < 90 && !frame.includes('CHILD_LIVE_UPDATE'); page += 1) {
			screen.press('\x1b[6~')
			await screen.waitForRender()
			frame = screen.viewport().join('\n')
			for (const line of frame.match(/TOOL_EVIDENCE_\d{3}/g) ?? []) seen.add(line)
		}
		expect(seen).toEqual(
			new Set(
				Array.from(
					{ length: 412 },
					(_, index) => `TOOL_EVIDENCE_${String(index + 1).padStart(3, '0')}`,
				),
			),
		)
		expect(frame).toContain('CHILD_LIVE_UPDATE')
		expect(frame).toContain('Live')
		expect(screen.bufferType()).toBe('normal')
		await screen.resize(40, 14)
		expectChildFrame(40)
		expect(screen.viewport().join('\n')).toContain('q parent')
		await screen.resize(80, 24)
		expectChildFrame(80)

		screen.press('\x1b')
		await waitUntil(
			screen,
			() => screen.viewport().join('\n').includes('Phases'),
			'escape did not return to the agent list',
		)
		screen.press('\r')
		await screen.waitForRender()
		expect(screen.viewport().join('\n')).toContain('CHILD_LIVE_UPDATE')
		screen.press('q')
		await screen.waitForRender()
		frame = screen.viewport().join('\n')
		expect(frame).toContain('PARENT_DRAFT_RESTORED')
		expect(frame).toContain('MESSAGE')
		expect(frame).not.toContain('CHILD_LIVE_UPDATE')
		expect(painted(screen)).not.toContain('parent finished')
	})

	it('keeps a completed child open, publishes the parent once on return and can reopen its history', async () => {
		const child = agent({
			viewId: 'agent-child',
			description: 'Child session',
			transcript: [{ id: 'child-row', kind: 'assistant', text: 'child is working' }],
		})
		activity.set([child])
		const screen = await renderToScreen(<App ctx={ctx} />, {
			cols: 110,
			rows: 28,
		})
		mounted = screen
		await waitUntil(screen, () => painted(screen).includes('model'), 'not ready')

		await submit(screen, 'start parent')
		screen.press('\x14')
		await screen.waitForRender()
		screen.press('\r')
		await waitUntil(
			screen,
			() => screen.viewport().join('\n').includes('child is working'),
			'child transcript missing',
		)

		expect(screen.viewport().join('\n')).toContain('Live ·')
		releaseParent()
		activity.set([
			{
				...child,
				status: 'completed',
				completedAt: 30,
				latestActivity: 'Completed',
				transcript: [
					...child.transcript,
					{ id: 'child-final', kind: 'assistant', text: 'child final answer' },
				],
			},
		])
		await waitUntil(
			screen,
			() => screen.viewport().join('\n').includes('child final answer'),
			'child completion closed its transcript',
		)
		expect(screen.viewport().join('\n')).toContain('Completed')
		expect(screen.viewport().join('\n')).toContain('Latest ·')
		expect(screen.viewport().join('\n')).not.toContain('Live ·')
		expect(screen.viewport().join('\n')).toContain('Child session')
		expect(screen.viewport().join('\n')).not.toContain('parent finished')
		screen.press('q')
		await waitUntil(
			screen,
			() => painted(screen).includes('parent finished'),
			'parent result missing after returning from the child',
		)
		expect(screen.viewport().join('\n')).toContain('✓ Child session · ')
		expect(painted(screen).match(/parent finished/g)).toHaveLength(1)

		await submit(screen, '/agents')
		expect(screen.viewport().join('\n')).toContain('Child session')
		screen.press('\r')
		await screen.waitForRender()
		expect(screen.viewport().join('\n')).toContain('child final answer')
		expect(screen.viewport().join('\n')).toContain('Completed')
	})
})

describe('/agents batches', () => {
	it('selecting a past turn opens the cockpit with the replayed banner', async () => {
		// Nothing live: this turn is entirely on disk, the way a past turn's
		// work looks once the process that ran it has exited.
		activity.set([])
		savedChildren.current = [
			agent({
				viewId: 'run-saved-1',
				workflowId: 'saved-run-1',
				description: 'Contract critic',
				status: 'completed',
				startedAt: 1,
				completedAt: 2,
				replayed: true,
				transcript: [{ id: 'saved-row', kind: 'tool', text: 'Read(src/a.ts)', status: 'completed' }],
			}),
		]
		orchestrationBatches.current = [
			{
				id: 'saved-run-1',
				name: 'Contract critic batch',
				startedAt: 1,
				phases: ['Work'],
				agentsDone: 1,
				agentsTotal: 1,
				tokensTotal: 0,
				elapsedMs: 1_000,
				live: false,
			},
		]
		const screen = await renderToScreen(<App ctx={ctx} />, { cols: 110, rows: 28 })
		mounted = screen
		await waitUntil(screen, () => painted(screen).includes('model'), 'not ready')

		await submit(screen, '/agents batches')
		await waitUntil(
			screen,
			() => screen.viewport().join('\n').includes('Contract critic batch'),
			'the batch listing did not show the saved batch',
		)

		screen.press('\r')
		await waitUntil(
			screen,
			() => screen.viewport().join('\n').includes('Replayed from saved evidence.'),
			'selecting the batch did not open the replayed banner',
		)
		const frame = screen.viewport().join('\n')
		expect(frame).toContain('cannot be continued')
		expect(frame).toContain('Read(src/a.ts)')
	})

	it('reports an empty history rather than an empty picker', async () => {
		activity.set([])
		savedChildren.current = []
		orchestrationBatches.current = []
		const screen = await renderToScreen(<App ctx={ctx} />, { cols: 110, rows: 28 })
		mounted = screen
		await waitUntil(screen, () => painted(screen).includes('model'), 'not ready')

		await submit(screen, '/agents batches')
		await waitUntil(
			screen,
			() => painted(screen).includes('No batches yet'),
			'an empty history did not say so',
		)
	})

	it('drops a stale read once the operator has left the loading picker', async () => {
		activity.set([])
		orchestrationBatches.current = []
		let release: () => void = () => {}
		orchestrationBatches.gate = new Promise<void>((resolve) => {
			release = resolve
		})
		const screen = await renderToScreen(<App ctx={ctx} />, { cols: 110, rows: 28 })
		mounted = screen
		await waitUntil(screen, () => painted(screen).includes('model'), 'not ready')

		await submit(screen, '/agents batches')
		await waitUntil(
			screen,
			() => screen.viewport().join('\n').includes('Reading saved batches'),
			'the loading picker did not open',
		)

		// The operator gives up on the read before the disk walk resolves.
		screen.press('\x1b')
		await waitUntil(
			screen,
			() => !screen.viewport().join('\n').includes('Reading saved batches'),
			'escape did not close the loading picker',
		)

		release()
		// Give the now-resolved read every chance to (wrongly) act.
		for (let i = 0; i < 5; i += 1) {
			await screen.waitForRender()
		}

		// A stale read must not reopen the picker the operator already left,
		// nor push the empty-history message over whatever is on screen now.
		expect(screen.viewport().join('\n')).not.toContain('Reading saved batches')
		expect(painted(screen)).not.toContain('No batches yet')
	})
})

describe('agent explorer projection', () => {
	it('keeps completed siblings only while their own batch still has live work', () => {
		const old = agent({
			viewId: 'old',
			batchId: 'wave-one',
			status: 'completed',
			completedAt: 2,
		})
		const doneSibling = agent({
			viewId: 'done-sibling',
			batchId: 'wave-two',
			status: 'completed',
			completedAt: 3,
		})
		const liveSibling = agent({ viewId: 'live-sibling', batchId: 'wave-two' })
		expect(
			activeSubagentCohorts([old, doneSibling, liveSibling]).map((entry) => entry.viewId),
		).toEqual(['done-sibling', 'live-sibling'])
	})

	it('does not revive a terminal cohort when another turn reuses its provider batch id', () => {
		const old = agent({
			viewId: 'old-run',
			workflowId: 'run-old',
			batchId: 'provider-call-1',
			status: 'completed',
			completedAt: 2,
		})
		const current = agent({
			viewId: 'current-run',
			workflowId: 'run-current',
			batchId: 'provider-call-1',
		})

		expect(activeSubagentCohorts([old, current]).map((entry) => entry.viewId)).toEqual([
			'current-run',
		])
	})

	it('bounds automatic agent rows from the terminal height', () => {
		expect(agentTaskPanelPageSize(15)).toBe(1)
		// One row per agent below 24 rows; two (the row and its `⎿` activity
		// line) from 24 up, so the same row budget buys half as many agents.
		expect(agentTaskPanelPageSize(20)).toBe(2)
		expect(agentTaskPanelPageSize(30)).toBe(3)
		const agents = Array.from({ length: 6 }, (_, index) =>
			agent({ viewId: `agent-${index}`, description: `Worker ${index}` }),
		)
		const panel = render(<AgentTaskPanel agents={agents} terminalRows={15} terminalColumns={90} />)
		try {
			expect(panel.lastFrame()).toContain('Worker 0')
			expect(panel.lastFrame()).not.toContain('Worker 1')
			expect(panel.lastFrame()).toContain('+5 more')
		} finally {
			panel.unmount()
		}
	})

	it('an agent row shows its model and counters', async () => {
		const busy = agent({
			viewId: 'agent-busy',
			description: 'Audit dependencies',
			model: 'test-model-large',
			tokens: 42_123,
			toolCalls: 18,
		})
		const screen = await renderToScreen(
			<AgentTaskPanel agents={[busy]} terminalRows={10} terminalColumns={100} />,
			{ cols: 100, rows: 10 },
		)
		mounted = screen
		const frame = screen.viewport().join('\n')
		expect(frame).toContain('Audit dependencies')
		expect(frame).toContain('test-model-large')
		expect(frame).toContain('18 tools · 42.1k')
	})

	it('a narrow viewport drops counters before the description', async () => {
		const busy = agent({
			viewId: 'agent-narrow',
			description: 'Audit dependencies',
			model: 'test-model-large',
			tokens: 42_123,
			toolCalls: 18,
		})
		const screen = await renderToScreen(
			<AgentTaskPanel agents={[busy]} terminalRows={10} terminalColumns={40} />,
			{ cols: 40, rows: 10 },
		)
		mounted = screen
		const frame = screen.viewport().join('\n')
		expect(frame).toContain('Audit dependencies')
		expect(frame).not.toContain('test-model-large')
		expect(frame).not.toContain('42.1k')
		expect(frame).not.toContain('tools')
	})

	// A resolved model id is host-reported, unbounded text: a self-hosted or
	// gateway-style id routinely runs 60-90+ cells, well past anything a
	// short fixture like 'test-model-large' exercises. The meta box carrying
	// it is `flexShrink={0}`, so an uncapped label does not truncate itself —
	// it forces its shrinkable neighbours (the description, the elapsed/
	// activity text) down first, to zero once the deficit is large enough.
	// These three cases pin one long id at each of the three required render
	// sites and assert the description survives rather than vanishing.
	const REALISTIC_LONG_MODEL = 'gateway/production/anthropic/claude-opus-4-1-20250805-experimental-v3'

	it('a long model id never erases the description in the automatic rail', async () => {
		const busy = agent({
			viewId: 'agent-long-model',
			description: 'Audit dependencies',
			model: REALISTIC_LONG_MODEL,
			tokens: 42_123,
			toolCalls: 18,
		})
		const screen = await renderToScreen(
			<AgentTaskPanel agents={[busy]} terminalRows={10} terminalColumns={96} />,
			{ cols: 96, rows: 10 },
		)
		mounted = screen
		const frame = screen.viewport().join('\n')
		expect(frame).toContain('Audit dependencies')
		expect(frame).toContain('18 tools · 42.1k')
	})

	it('a long model id never erases the description in the agent cockpit', async () => {
		const busy = agent({
			viewId: 'agent-long-model',
			description: 'Audit dependencies for known vulnerabilities',
			model: REALISTIC_LONG_MODEL,
			tokens: 42_123,
			toolCalls: 18,
		})
		const screen = await renderToScreen(
			<AgentCockpit
				agents={[busy]}
				selectedPhaseId={busy.phaseId}
				selectedId={busy.viewId}
				focus="agents"
				terminalRows={24}
				terminalColumns={130}
			/>,
			{ cols: 130, rows: 24 },
		)
		mounted = screen
		const frame = screen.viewport().join('\n')
		expect(frame).toContain('Audit dependencies')
	})

	it('a long model id never erases the description in the transcript header', async () => {
		const child = agent({
			viewId: 'agent-long-model',
			description: 'Inspect project sources',
			model: REALISTIC_LONG_MODEL,
			tokens: 42_123,
			toolCalls: 18,
		})
		const screen = await renderToScreen(
			<AgentTranscript agent={child} tailOffset={0} terminalRows={24} terminalColumns={80} />,
			{ cols: 80, rows: 24 },
		)
		mounted = screen
		const frame = screen.viewport().join('\n')
		expect(frame).toContain('Inspect project sources')
	})

	it('groups agents by explicit workflow phase and preserves declared order', () => {
		const phases = agentPhases([
			agent({
				viewId: 'critic',
				workflow: 'Release readiness',
				phase: 'Critic',
				phaseOrder: 2,
				startedAt: 3,
			}),
			agent({
				viewId: 'research-a',
				workflow: 'Release readiness',
				phase: 'Research',
				phaseOrder: 0,
				startedAt: 1,
			}),
			agent({
				viewId: 'research-b',
				workflow: 'Release readiness',
				phase: 'Research',
				phaseOrder: 0,
				startedAt: 2,
			}),
		])

		expect(phases.map((phase) => [phase.name, phase.agents.length])).toEqual([
			['Research', 2],
			['Critic', 1],
		])
	})

	it('keeps unlabelled batches separate even when they reuse the same phase label', () => {
		const workflows = agentWorkflows([
			agent({ viewId: 'first', batchId: 'one', phase: 'Inspect', startedAt: 1 }),
			agent({ viewId: 'second', batchId: 'two', phase: 'Inspect', startedAt: 2 }),
		])
		expect(workflows.map((workflow) => workflow.phases.map((phase) => phase.agents.map((entry) => entry.viewId))))
			.toEqual([[['first']], [['second']]])
	})

	it('names an unlabelled group by its own lead agent instead of the generic default', () => {
		const workflows = agentWorkflows([
			agent({ viewId: 'first', description: 'Scan release artifacts', batchId: 'batch-one' }),
			agent({ viewId: 'second', description: 'Verify checksums', batchId: 'batch-two' }),
		])
		expect(workflows.map((workflow) => workflow.name)).toEqual([
			'Scan release artifacts',
			'Verify checksums',
		])
	})

	it('appends a +N suffix to an unlabelled group name once it has more than one member', () => {
		const workflows = agentWorkflows([
			agent({ viewId: 'lead', description: 'Verify checksums', batchId: 'batch-two' }),
			agent({ viewId: 'extra', description: 'Verify signatures', batchId: 'batch-two' }),
		])
		expect(workflows.map((workflow) => workflow.name)).toEqual(['Verify checksums +1'])
	})

	it('falls back to a plain agent count when an unlabelled group has no title to show', () => {
		const workflows = agentWorkflows([
			agent({ viewId: 'lead', description: '', agentId: '', batchId: 'batch-two' }),
		])
		expect(workflows.map((workflow) => workflow.name)).toEqual(['1 agent'])
	})

	it('shows queued children as active without claiming that they are working', async () => {
		const queued = agent({ viewId: 'queued', description: 'Ninth review', status: 'queued', latestActivity: 'Queued' })
		const running = agent({ viewId: 'running', description: 'Running review' })
		const screen = await renderToScreen(<AgentCockpit agents={[running, queued]}
			selectedPhaseId={queued.phaseId} selectedId={queued.viewId} focus="agents"
			terminalRows={24} terminalColumns={110} />, { cols: 110, rows: 24 })
		mounted = screen
		await screen.waitForRender()
		const frame = screen.viewport().join('\n')
		expect(frame).toContain('0/2 agents done · 2 running')
		expect(frame).toMatch(/Ninth review\s+Queued/)
		expect(frame).not.toMatch(/Queued.*Queued/)
	})

	it.each([
		{ cols: 120, rows: 28 },
		{ cols: 60, rows: 20 },
		{ cols: 40, rows: 14 },
	])('separates cockpit panes and names a settled status once at $cols×$rows', async ({ cols, rows }) => {
		const research = agent({
			viewId: 'research',
			workflow: 'Narrow workflow',
			phase: 'Research',
			phaseOrder: 0,
			description: 'Research worker',
			status: 'completed',
			startedAt: 1_000,
			completedAt: 59_000,
			latestActivity: 'Completed',
		})
		const screen = await renderToScreen(
			<AgentCockpit
				agents={[research]}
				selectedPhaseId={research.phaseId}
				selectedId={research.viewId}
				focus="phases"
				terminalRows={rows}
				terminalColumns={cols}
			/>,
			{ cols, rows },
		)
		mounted = screen
		const viewport = screen.viewport()
		const phaseHeading = viewport.findIndex((line) => line.includes('Phases · 1/1'))
		const agentHeading = viewport.findIndex((line) => line.includes('Research · 1 agent'))
		const worker = viewport.find((line) => line.includes('Research worker')) ?? ''
		expect(phaseHeading).toBeGreaterThanOrEqual(0)
		expect(agentHeading).toBeGreaterThanOrEqual(0)
		expect(worker).toMatch(/Research worker\s+Completed · 58s/)
		expect(worker.match(/Completed/g)).toHaveLength(1)
		if (cols >= 88) {
			expect(agentHeading).toBe(phaseHeading)
			expect(viewport[phaseHeading]).toMatch(/Phases.*│\s+Research · 1 agent/)
		} else {
			expect(agentHeading).toBeGreaterThan(phaseHeading)
		}
		expect(viewport.join('\n')).toContain('esc return')
	})

	it('the focused phase reveals its detail and the others do not', async () => {
		const research = agent({
			viewId: 'research',
			workflow: 'Release readiness',
			phase: 'Research',
			phaseDetail: 'Confirm the rollback plan.',
		})
		const verify = agent({
			viewId: 'verify',
			workflow: 'Release readiness',
			phase: 'Verify',
			phaseDetail: 'Check the queue depth.',
		})
		const screen = await renderToScreen(
			<AgentCockpit
				agents={[research, verify]}
				selectedPhaseId={research.phaseId}
				selectedId={research.viewId}
				focus="phases"
				terminalRows={28}
				terminalColumns={120}
			/>,
			{ cols: 120, rows: 28 },
		)
		mounted = screen
		const frame = screen.viewport().join('\n')
		expect(frame).toContain('Confirm the rollback plan.')
		expect(frame).not.toContain('Check the queue depth.')
	})

	it('a long phase detail does not change the pane height', async () => {
		// Narrow enough to stack Phases above Agents, so a detail box that grew
		// with its text would visibly push the agent list down.
		const size = { cols: 60, rows: 30 }
		const short = agent({ viewId: 'short', phase: 'Verify', phaseDetail: 'Short note.' })
		const long = agent({
			viewId: 'long',
			phase: 'Verify',
			phaseDetail: `A ${'very '.repeat(60)}long detail that wraps many times over.`,
		})

		const shortScreen = await renderToScreen(
			<AgentCockpit
				agents={[short]}
				selectedPhaseId={short.phaseId}
				selectedId={short.viewId}
				focus="phases"
				terminalRows={size.rows}
				terminalColumns={size.cols}
			/>,
			size,
		)
		const shortViewport = shortScreen.viewport()
		const shortAgentsRow = shortViewport.findIndex((line) => line.includes('Verify · 1 agent'))
		expect(shortViewport.join('\n')).toContain('Short note.')
		await shortScreen.unmount()

		const longScreen = await renderToScreen(
			<AgentCockpit
				agents={[long]}
				selectedPhaseId={long.phaseId}
				selectedId={long.viewId}
				focus="phases"
				terminalRows={size.rows}
				terminalColumns={size.cols}
			/>,
			size,
		)
		mounted = longScreen
		const longViewport = longScreen.viewport()
		const longAgentsRow = longViewport.findIndex((line) => line.includes('Verify · 1 agent'))
		expect(longViewport.join('\n')).toContain('very very very')

		expect(shortAgentsRow).toBeGreaterThanOrEqual(0)
		expect(longAgentsRow).toBe(shortAgentsRow)
	})

	it('does not corrupt the compact cockpit frame when a phase carries a detail', async () => {
		// Same fixture and size as "separates cockpit panes..." above
		// (cols=40/rows=14, the compact + stacked layout), plus a phase
		// detail: the compact frame has no spare rows for the detail band,
		// so it must stay suppressed there rather than pushing the agent
		// row out of the viewport or bleeding into the footer.
		const research = agent({
			viewId: 'research',
			workflow: 'Narrow workflow',
			phase: 'Research',
			phaseOrder: 0,
			phaseDetail: 'Confirm the rollback plan holds before sign-off.',
			description: 'Research worker',
			status: 'completed',
			startedAt: 1_000,
			completedAt: 59_000,
			latestActivity: 'Completed',
		})
		const screen = await renderToScreen(
			<AgentCockpit
				agents={[research]}
				selectedPhaseId={research.phaseId}
				selectedId={research.viewId}
				focus="phases"
				terminalRows={14}
				terminalColumns={40}
			/>,
			{ cols: 40, rows: 14 },
		)
		mounted = screen
		const viewport = screen.viewport()
		const worker = viewport.find((line) => line.includes('Research worker')) ?? ''
		expect(worker).toMatch(/Research worker\s+Completed · 58s/)
		const footer = viewport.find((line) => line.includes('esc return')) ?? ''
		expect(footer).toMatch(/esc return[ │]*$/)
		expect(viewport.join('\n')).not.toContain('Confirm the rollback plan')
	})

	it('surfaces failed and cancelled children in phase summaries', () => {
		const failed = agent({
			viewId: 'failed',
			status: 'failed',
			completedAt: 2,
		})
		const working = agent({ viewId: 'working' })
		const cancelled = agent({
			viewId: 'cancelled',
			workflowId: 'turn-parent',
			phaseId: 'phase-two',
			status: 'cancelled',
			completedAt: 2,
		})
		const completed = agent({
			viewId: 'completed',
			workflowId: 'turn-parent',
			phaseId: 'phase-two',
			status: 'completed',
			completedAt: 2,
		})
		const cockpit = render(
			<AgentCockpit
				agents={[failed, working, cancelled, completed]}
				selectedPhaseId={failed.phaseId}
				selectedId={failed.viewId}
				focus="phases"
				terminalRows={24}
				terminalColumns={120}
			/>,
		)
		try {
			expect(cockpit.lastFrame()).toContain('failed 1')
			expect(cockpit.lastFrame()).toContain('cancelled 1')
		} finally {
			cockpit.unmount()
		}
	})

	it.each([
		{ cols: 80, rows: 40, first: 12 },
		{ cols: 40, rows: 14, first: 38 },
		{ cols: 30, rows: 14, first: 38 },
	])(
		'gives a child its own bounded transcript screen at $cols×$rows',
		async ({ cols, rows, first }) => {
			const child = agent({
				viewId: 'internal-view-id',
				taskId: 'internal-task-id',
				description: 'Inspect sources',
				prompt: 'Read the project',
				transcript: [
					{
						id: 'answer',
						kind: 'assistant',
						text: Array.from({ length: 40 }, (_, index) => `CHILD_${index + 1}`).join('\n'),
					},
				],
			})
			const screen = await renderToScreen(
				<AgentTranscript agent={child} tailOffset={0} terminalRows={rows} terminalColumns={cols} />,
				{ cols, rows },
			)
			mounted = screen
			const viewport = screen.viewport()
			const frame = viewport.join('\n')
			expect(frame).toContain('Subagent')
			expect(frame).toContain('Inspect sources')
			expect(frame).toContain('Working')
			for (let line = first; line <= 40; line += 1) {
				expect(frame).toContain(`CHILD_${line}`)
			}
			expect(frame).toContain('Live')
			expect(frame).toContain('q parent')
			expect(frame).not.toContain('internal-view-id')
			expect(frame).not.toContain('internal-task-id')
			const top = viewport.findIndex((line) => line.startsWith('┌'))
			const bottom = viewport.findIndex((line) => line.startsWith('└'))
			expect(top).toBeGreaterThanOrEqual(0)
			expect(bottom - top + 1).toBe(rows - 3)
			expect(screen.bufferType()).toBe('normal')
		},
	)

	it('ticks elapsed time even when the child emits no events', async () => {
		vi.useFakeTimers()
		vi.setSystemTime(10_000)
		const silent = agent({
			viewId: 'silent',
			description: 'Silent',
			startedAt: 0,
		})
		const picker = render(
			<AgentCockpit
				agents={[silent]}
				selectedPhaseId={silent.phaseId}
				selectedId="silent"
				focus="agents"
				terminalRows={24}
				terminalColumns={100}
			/>,
		)
		const transcript = render(
			<AgentTranscript agent={silent} tailOffset={0} terminalRows={24} terminalColumns={80} />,
		)
		try {
			expect(picker.lastFrame()).toContain('10s')
			expect(transcript.lastFrame()).toContain('10s')
			await vi.advanceTimersByTimeAsync(2_000)
			expect(picker.lastFrame()).toContain('12s')
			expect(transcript.lastFrame()).not.toContain('10s')
		} finally {
			picker.unmount()
			transcript.unmount()
			vi.useRealTimers()
		}
	})

	it('wraps prose at word boundaries and retains every original character', () => {
		const text = 'Microsoft stratejisini araştır ve resmi kaynakları karşılaştır.'
		const rows = agentTranscriptRows(agent({ viewId: 'word-wrap', prompt: text, transcript: [] }), 35)
		expect(rows.map(row => row.text).join('')).toBe(text)
		expect(rows[0]?.text).toBe('Microsoft stratejisini ')
		for (const row of rows) expect(row.text.length).toBeLessThanOrEqual(25)
	})

	it('wraps before paging so multiline answer and tool suffixes are reachable', () => {
		const long = agent({
			viewId: 'long',
			prompt: `prompt line\n${'p'.repeat(90)}PROMPT_SUFFIX`,
			transcript: [
				{
					id: 'answer',
					kind: 'assistant',
					text: `answer line\n${'a'.repeat(120)}ANSWER_SUFFIX`,
				},
				{
					id: 'tool',
					kind: 'tool',
					status: 'completed',
					text: 'Read(file)',
					detail: `${'d'.repeat(120)}TOOL_SUFFIX`,
				},
			],
		})
		const rows = agentTranscriptRows(long, 30)
		expect(rows.length).toBeGreaterThan(long.transcript.length)
		const max = maxAgentTranscriptTailOffset(long, 15, 30)
		const reachable = new Set<string>()
		for (let offset = 0; offset <= max; offset += 1) {
			for (const row of agentTranscriptPage(long, offset, 15, 30).rows) reachable.add(row.id)
		}
		expect(reachable).toEqual(new Set(rows.map((row) => row.id)))
		const prompt = rows
			.filter((row) => row.source === 'prompt')
			.map((row) => row.text)
			.join('')
		const answer = rows
			.filter((row) => row.source !== 'prompt' && row.source.id === 'answer')
			.map((row) => row.text)
			.join('')
		const tool = rows
			.filter((row) => row.source !== 'prompt' && row.source.id === 'tool')
			.map((row) => row.text)
			.join('')
		expect(prompt).toContain('PROMPT_SUFFIX')
		expect(answer).toContain('ANSWER_SUFFIX')
		expect(tool).toContain('TOOL_SUFFIX')
	})
})

describe('agent completion presentation', () => {
	it('Ctrl+O still reaches a completion row once it has settled into history', async () => {
		// A settled row cannot be repainted, so its `ctrl+o result` stays on
		// screen; the key has to keep reaching the answer behind it.
		const first = agent({ viewId: 'child-first', taskId: 'task-first', description: 'Choose first colour' })
		const second = agent({ viewId: 'child-second', taskId: 'task-second', description: 'Join the two colours' })
		const done = (child: SubagentActivity, text: string): SubagentActivity => ({
			...child,
			transcript: [{ id: `${child.viewId}-answer`, kind: 'assistant' as const, text }],
			status: 'completed' as const,
			completedAt: 30,
		})
		activity.set([first, second])
		sendOverride.current = async function* () {
			yield { kind: 'delta', text: 'noted\n\n' }
			yield { kind: 'done', stopReason: 'end_turn' }
		}
		const screen = await renderToScreen(<App ctx={ctx} />, { cols: 100, rows: 24 })
		mounted = screen
		await waitUntil(screen, () => painted(screen).includes('model'), 'not ready')
		activity.set([done(first, 'FIRST_ANSWER'), second])
		await waitUntil(screen, () => painted(screen).includes('✓ Choose first colour · '), 'first row missing')
		// Enough later rows that the first completion leaves the live region.
		for (const prompt of ['one', 'two', 'three', 'four']) {
			await submit(screen, prompt)
			await waitUntil(
				screen,
				() => painted(screen).split('noted').length > ['one', 'two', 'three', 'four'].indexOf(prompt) + 1,
				`reply to ${prompt} missing`,
			)
		}
		activity.set([done(first, 'FIRST_ANSWER'), done(second, 'SECOND_ANSWER')])
		await waitUntil(screen, () => painted(screen).includes('✓ Join the two colours · '), 'second row missing')
		await screen.waitForRender()
		expect(screen.viewport().join('\n')).not.toContain('FIRST_ANSWER')
		// First press: the live answer opens in place.
		screen.press('\x0f')
		await waitUntil(screen, () => screen.viewport().join('\n').includes('SECOND_ANSWER'), 'live answer not opened')
		expect(screen.viewport().join('\n')).not.toContain('FIRST_ANSWER')
		// Second press: the settled one, in the viewer.
		screen.press('\x0f')
		await waitUntil(screen, () => screen.viewport().join('\n').includes('FIRST_ANSWER'), 'settled answer never reachable')
		expect(screen.viewport().join('\n')).toContain('Choose first colour')
		screen.press('\x1b')
		await waitUntil(screen, () => !screen.viewport().join('\n').includes('←→ outputs'), 'viewer did not close')
		// Closed, the live answer is folded again, and the next press reopens it.
		expect(screen.viewport().join('\n')).not.toContain('SECOND_ANSWER')
		screen.press('\x0f')
		await waitUntil(screen, () => screen.viewport().join('\n').includes('SECOND_ANSWER'), 'live answer not reopened')
	})

	it.each([true, false])('shows all three outcomes, retaining wait evidence when inspection is unavailable (inspectable=%s)', async (inspectable) => {
		const children = ['CLI review', 'SDK review', 'Package review'].map((description, i) =>
			agent({ viewId: `child-${i}`, taskId: `task-${i}`, description }),
		)
		activity.set(children)
		let finishWaits!: () => void
		const waits = new Promise<void>((resolve) => {
			finishWaits = resolve
		})
		sendOverride.current = async function* () {
			for (let i = 0; i < 2; i++)
				yield {
					kind: 'tool-start',
					toolUseId: `wait-${i}`,
					toolName: 'wait_for_task',
					taskId: `task-${i}`,
					turnId: 'turn-parent',
					summary: `{"task_id":"task-${i}"}`,
				}
			await waits
			for (let i = 0; i < 2; i++)
				yield {
					kind: 'tool-end',
					toolUseId: `wait-${i}`,
					toolName: 'wait_for_task',
					turnId: 'turn-parent',
					isError: false,
					summary: `task_id: task-${i}`,
					detail: ['status: completed', 'Agent result:', 'full report from child'],
				}
			await parentGate
			yield { kind: 'done', stopReason: 'end_turn' }
		}
		const screen = await renderToScreen(<App ctx={ctx} />, { cols: 110, rows: 36 })
		mounted = screen
		try {
			await waitUntil(screen, () => painted(screen).includes('model'), 'not ready')
			await submit(screen, 'review')
			await waitUntil(
				screen,
				() => screen.viewport().join('\n').includes('✻ Waiting for 2 agents to finish'),
				'folded wait line missing',
			)
			const finished = children.map((child) => ({
				...child,
				transcript: inspectable ? [{ id: 'answer', kind: 'assistant' as const, text: 'full report from child' }] : [],
				status: 'completed' as const,
				completedAt: 30,
			}))
			activity.set(finished)
			finishWaits()
			await waitUntil(
				screen,
				() => painted(screen).includes('✓ Package review · '),
				'unwaited child completion missing',
			)
			activity.set([...finished])
			await screen.waitForRender()
			const output = painted(screen)
			for (const child of children)
				expect(output.split(`✓ ${child.description} · `)).toHaveLength(2)
			if (inspectable) {
				expect(output).not.toContain('task_id:')
				expect(output).not.toContain('Agent result:')
				// The answer rides on the completion row, collapsed; Ctrl+O opens it.
				expect(output).not.toContain('full report from child')
				expect(output).toContain('ctrl+o result · ctrl+t details')
				screen.press('\x0f')
				await waitUntil(
					screen,
					() => screen.viewport().join('\n').includes('full report from child'),
					'Ctrl+O did not open the agent result',
				)
			} else {
				expect(output).toContain('task_id:')
				expect(output).toContain('full report from child')
			}
			expect(output).toContain('ctrl+t details')
		} finally {
			finishWaits()
		}
	})
})

describe('the rail while a review is open', () => {
	it('keeps the header line under the review and draws no agent rows', async () => {
		activity.set([
			agent({
				viewId: 'approved',
				description: 'Choose first colour',
				workflow: 'Two-phase colour sentence',
				latestActivity: 'Reading the palette',
			}),
		])
		let answer!: (decision: unknown) => void
		const decided = new Promise((resolve) => {
			answer = resolve
		})
		sendOverride.current = async function* (_messages, opts) {
			yield { kind: 'delta', text: 'launching the second agent' }
			const decision = await opts?.onPermission?.({
				toolCalls: [
					{
						id: 'agent-two',
						name: 'Agent',
						input: { description: 'Choose second colour', prompt: 'Name one colour.' },
						isDestructive: false,
					},
				],
			})
			answer(decision)
			yield { kind: 'done', stopReason: 'end_turn' }
		}
		const screen = await renderToScreen(<App ctx={ctx} />, { cols: 100, rows: 30 })
		mounted = screen
		await waitUntil(screen, () => painted(screen).includes('model'), 'not ready')
		await waitUntil(
			screen,
			() => screen.viewport().join('\n').includes('⎿ Reading the palette'),
			'full rail missing before the review',
		)
		await submit(screen, 'start both')
		await waitUntil(
			screen,
			() => screen.viewport().join('\n').includes('Start an agent'),
			'review never opened',
		)
		const during = screen.viewport().join('\n')
		// The review owns the keyboard: ↓ and Ctrl+T do not reach the rail
		// while it is open, so the reduced header names neither.
		expect(during).toContain('● Two-phase colour sentence · 1 running')
		expect(during).not.toContain('↓ / ctrl+t')
		expect(during).not.toContain('Choose first colour')
		expect(during).not.toContain('⎿ Reading the palette')
		screen.press('\x1b')
		await decided
		await waitUntil(
			screen,
			() => screen.viewport().join('\n').includes('⎿ Reading the palette'),
			'full rail did not come back after the review',
		)
		expect(screen.viewport().join('\n')).toMatch(/· 1 running · \S+ · ↓ \/ ctrl\+t/u)
	})
})

describe('correction delivery presentation', () => {
	it('the parent conversation shows the correction it sent', async () => {
		const child = agent({
			viewId: 'child-correction',
			taskId: 'task-correction',
			description: 'Branch audit',
		})
		activity.set([child])
		const screen = await renderToScreen(<App ctx={ctx} />, { cols: 110, rows: 30 })
		mounted = screen
		await waitUntil(screen, () => painted(screen).includes('model'), 'not ready')

		const corrected = {
			...child,
			transcript: [
				{
					id: `${child.viewId}:message:1`,
					kind: 'system' as const,
					text: 'also check the beta branch identifier',
					direction: 'to-child' as const,
				},
			],
		}
		activity.set([corrected])
		await waitUntil(
			screen,
			() => painted(screen).includes('Branch audit · correction sent'),
			'correction row missing from the parent conversation',
		)
		expect(painted(screen)).toContain('also check the beta branch identifier')

		// A later re-render (or a resumed replay publishing the same snapshot
		// again) must not duplicate the row.
		activity.set([{ ...corrected }])
		await screen.waitForRender()
		expect(painted(screen).split('Branch audit · correction sent')).toHaveLength(2)
	})
})

describe('rail and cockpit titles', () => {
	it('titles the rail by the workflow label every agent shares', async () => {
		const screen = await renderToScreen(
			<AgentTaskPanel
				agents={[
					agent({ viewId: 'a', workflow: 'Nightly regression sweep' }),
					agent({ viewId: 'b', workflow: 'Nightly regression sweep' }),
				]}
				terminalRows={20}
				terminalColumns={100}
			/>,
			{ cols: 100, rows: 20 },
		)
		mounted = screen
		const frame = screen.viewport().join('\n')
		expect(frame).toContain('Nightly regression sweep')
		expect(frame).not.toContain('Delegated work')
	})

	it('titles the rail with a neutral count when no agent carries an explicit workflow label', async () => {
		// Neither agent below sets `workflow`, so the fixture defaults it to the
		// unlabelled placeholder — the exact case the title must not name.
		const screen = await renderToScreen(
			<AgentTaskPanel
				agents={[agent({ viewId: 'a' }), agent({ viewId: 'b' })]}
				terminalRows={20}
				terminalColumns={100}
			/>,
			{ cols: 100, rows: 20 },
		)
		mounted = screen
		const frame = screen.viewport().join('\n')
		expect(frame).toContain('2 agents · 2 running')
		expect(frame).not.toContain('Delegated work')
	})

	it('titles the rail with a neutral count when agents carry different workflow labels', async () => {
		const screen = await renderToScreen(
			<AgentTaskPanel
				agents={[
					agent({ viewId: 'a', workflow: 'Alpha rollout' }),
					agent({ viewId: 'b', workflow: 'Beta rollout' }),
				]}
				terminalRows={20}
				terminalColumns={100}
			/>,
			{ cols: 100, rows: 20 },
		)
		mounted = screen
		const frame = screen.viewport().join('\n')
		expect(frame).toContain('2 agents · 2 running')
		expect(frame).not.toContain('Alpha rollout')
		expect(frame).not.toContain('Beta rollout')
		expect(frame).not.toContain('Delegated work')
	})

	it('titles the cockpit header by the workflow label when the selected workflow carries one', async () => {
		const busy = agent({ viewId: 'solo', workflow: 'Release readiness' })
		const screen = await renderToScreen(
			<AgentCockpit
				agents={[busy]}
				selectedPhaseId={busy.phaseId}
				selectedId={busy.viewId}
				focus="agents"
				terminalRows={24}
				terminalColumns={110}
			/>,
			{ cols: 110, rows: 24 },
		)
		mounted = screen
		const frame = screen.viewport().join('\n')
		expect(frame).toContain('Release readiness')
		expect(frame).not.toContain('Delegated work')
	})

	it('titles the cockpit header with a neutral count when the workflow carries no explicit label', async () => {
		const busy = agent({ viewId: 'solo' })
		const screen = await renderToScreen(
			<AgentCockpit
				agents={[busy]}
				selectedPhaseId={busy.phaseId}
				selectedId={busy.viewId}
				focus="agents"
				terminalRows={24}
				terminalColumns={110}
			/>,
			{ cols: 110, rows: 24 },
		)
		mounted = screen
		const frame = screen.viewport().join('\n')
		expect(frame).toContain('1 agent · 1 running')
		expect(frame).not.toContain('Delegated work')
	})
})

describe('workflow selector pane naming', () => {
	it('gives two unlabelled groups distinct neutral names so they stay tellable apart', async () => {
		const first = agent({
			viewId: 'first-lead',
			description: 'Scan release artifacts',
			batchId: 'batch-one',
		})
		const second = agent({
			viewId: 'second-lead',
			description: 'Verify checksums',
			batchId: 'batch-two',
		})
		const screen = await renderToScreen(
			<AgentCockpit
				agents={[first, second]}
				selectedPhaseId={first.phaseId}
				selectedId={first.viewId}
				focus="workflows"
				terminalRows={24}
				terminalColumns={110}
			/>,
			{ cols: 110, rows: 24 },
		)
		mounted = screen
		const frame = screen.viewport().join('\n')
		expect(frame).toContain('Scan release artifacts')
		expect(frame).toContain('Verify checksums')
		expect(frame).not.toContain('Delegated work')
	})

	it('adds a +N suffix to an unlabelled group whose name comes from more than one agent', async () => {
		const solo = agent({
			viewId: 'solo-lead',
			description: 'Scan release artifacts',
			batchId: 'batch-one',
		})
		const groupLead = agent({
			viewId: 'group-lead',
			description: 'Verify checksums',
			batchId: 'batch-two',
		})
		const groupExtra = agent({
			viewId: 'group-extra',
			description: 'Verify signatures',
			batchId: 'batch-two',
		})
		const screen = await renderToScreen(
			<AgentCockpit
				agents={[solo, groupLead, groupExtra]}
				selectedPhaseId={solo.phaseId}
				selectedId={solo.viewId}
				focus="workflows"
				terminalRows={24}
				terminalColumns={110}
			/>,
			{ cols: 110, rows: 24 },
		)
		mounted = screen
		const frame = screen.viewport().join('\n')
		expect(frame).toContain('Scan release artifacts')
		expect(frame).toContain('Verify checksums +1')
		expect(frame).not.toContain('Delegated work')
	})

	it('names a labelled group by its label beside an unlabelled sibling named neutrally', async () => {
		const labelled = agent({
			viewId: 'labelled-lead',
			workflow: 'Nightly regression sweep',
		})
		const unlabelled = agent({
			viewId: 'unlabelled-lead',
			description: 'Triage flaky tests',
			batchId: 'batch-solo',
		})
		const screen = await renderToScreen(
			<AgentCockpit
				agents={[labelled, unlabelled]}
				selectedPhaseId={labelled.phaseId}
				selectedId={labelled.viewId}
				focus="workflows"
				terminalRows={24}
				terminalColumns={110}
			/>,
			{ cols: 110, rows: 24 },
		)
		mounted = screen
		const frame = screen.viewport().join('\n')
		expect(frame).toContain('Nightly regression sweep')
		expect(frame).toContain('Triage flaky tests')
		expect(frame).not.toContain('Delegated work')
	})
})

describe('render order below the message frame', () => {
	/** The message frame's bottom border row on the full App's own screen. */
	function frameBottomBorder(screen: Screen): number {
		const viewport = screen.viewport()
		// The App wraps everything in one column of `paddingX={1}`, so every
		// border row this padding touches carries a one-space left margin —
		// the same anchor `expectChildFrame` and friends already rely on
		// elsewhere in this file.
		const border = viewport.findIndex((line) => line.startsWith(' └'))
		expect(border, 'message frame bottom border not found on screen').toBeGreaterThanOrEqual(0)
		return border
	}

	it('puts the footer directly under the frame with nothing following when no agents are live', async () => {
		activity.set([])
		const screen = await renderToScreen(<App ctx={ctx} />, { cols: 100, rows: 28 })
		mounted = screen
		await waitUntil(screen, () => painted(screen).includes('model'), 'not ready')
		const viewport = screen.viewport()
		const border = frameBottomBorder(screen)
		expect(viewport[border + 1]).toContain('shift+tab to cycle')
		expect(viewport[border + 2] ?? '').toBe('')
	})

	it('puts the agent rail directly under the footer once agents are live, titled by neutral count when only one of two carries a label', async () => {
		activity.set([
			agent({ viewId: 'alpha', description: 'Alpha audit' }),
			agent({ viewId: 'beta', description: 'Beta build', workflow: 'Nightly regression sweep' }),
		])
		const screen = await renderToScreen(<App ctx={ctx} />, { cols: 100, rows: 28 })
		mounted = screen
		await waitUntil(screen, () => painted(screen).includes('model'), 'not ready')
		await waitUntil(
			screen,
			() => screen.viewport().join('\n').includes('Alpha audit'),
			'rail missing',
		)
		const viewport = screen.viewport()
		const border = frameBottomBorder(screen)
		expect(viewport[border + 1]).toContain('shift+tab to cycle')
		// Directly under the footer, not the transcript/composer: the rail's
		// header line, one row below where the footer landed. The rail has no
		// box any more; its header starts with the live `●`.
		const railTop = viewport[border + 2] ?? ''
		expect(railTop.trimStart().charAt(0)).toBe('●')
		const frame = screen.viewport().join('\n')
		// One agent carries a label and the other does not, so the rail is not
		// entitled to either agent's label — it gets the neutral count.
		expect(frame).toContain('2 agents · 2 running')
		expect(frame).not.toContain('Nightly regression sweep')
		expect(frame).not.toContain('Delegated work')
	})

	it('keeps the footer directly under the frame and the rail directly under the footer at 40 columns', async () => {
		activity.set([agent({ viewId: 'alpha', description: 'Alpha audit' })])
		const screen = await renderToScreen(<App ctx={ctx} />, { cols: 40, rows: 20 })
		mounted = screen
		await waitUntil(screen, () => painted(screen).includes('model'), 'not ready')
		await waitUntil(
			screen,
			() => screen.viewport().join('\n').includes('Alpha audit'),
			'rail missing',
		)
		const viewport = screen.viewport()
		const border = frameBottomBorder(screen)
		expect((viewport[border + 1] ?? '').length).toBeGreaterThan(0)
		const railTop = viewport[border + 2] ?? ''
		expect(railTop.trimStart().charAt(0)).toBe('●')
	})
})

describe('parent narration', () => {
	/** The message frame's bottom border row, the anchor every row below is read from. */
	function frameBottom(screen: Screen): number {
		const border = screen.viewport().findIndex((line) => line.startsWith(' └'))
		expect(border, 'message frame bottom border not found on screen').toBeGreaterThanOrEqual(0)
		return border
	}

	function line(id: string, text: string) {
		return { id, text, at: 1 }
	}

	/**
	 * The rail's own rows, top border through bottom border, read from the
	 * VIEWPORT — the rows an operator is looking at.
	 *
	 * Finding both borders is half the assertion: a rail whose bottom border is
	 * not on screen fails here rather than returning a short block.
	 */
	function railBlock(screen: Screen): string[] {
		const rows = screen.viewport()
		const below = frameBottom(screen)
		const top = rows.findIndex((row, index) => index > below && row.trimStart().startsWith('●'))
		expect(top, 'rail header not on screen').toBeGreaterThan(below)
		// The last agent's branch is `└`; everything from the header through it
		// (and its activity line, when one is drawn) is the rail.
		const last = rows.findIndex((row, index) => index > top && row.trimStart().startsWith('└'))
		expect(last, 'rail last branch not on screen').toBeGreaterThan(top)
		let bottom = last
		while (bottom + 1 < rows.length && (rows[bottom + 1] ?? '').trim().startsWith('⎿')) bottom += 1
		return rows.slice(top, bottom + 1)
	}

	it('renders between the footer and the rail without displacing an agent row', async () => {
		activity.set([
			agent({ viewId: 'narrated-alpha', description: 'Storage lens' }),
			agent({ viewId: 'narrated-beta', description: 'Reference lens' }),
		])
		const screen = await renderToScreen(<App ctx={ctx} />, { cols: 100, rows: 28 })
		mounted = screen
		await waitUntil(screen, () => painted(screen).includes('model'), 'not ready')
		await waitUntil(
			screen,
			() => screen.viewport().join('\n').includes('Storage lens'),
			'rail missing',
		)
		const quiet = screen.viewport()
		const railTop = frameBottom(screen) + 2
		expect((quiet[railTop] ?? '').trimStart().charAt(0)).toBe('●')
		// What the rail shows, read from its own header, so the comparison
		// below is about the rail's rows rather than about where it sits.
		const railRows = railBlock(screen)

		activity.narrate([
			line('narration-1', 'map returned five lenses, one with a correction'),
			line('narration-2', 'verifying the storage claim on disk'),
		])
		await waitUntil(
			screen,
			() => screen.viewport().join('\n').includes('storage claim'),
			'narration missing',
		)

		const viewport = screen.viewport()
		const border = frameBottom(screen)
		// The footer stays directly under the frame; narration follows it, and
		// the rail's header follows the narration — commentary above the tree,
		// never inside it and never between the frame and its footer.
		expect(viewport[border + 1]).toContain('shift+tab to cycle')
		expect(viewport[border + 2]).toContain('map returned five lenses')
		expect(viewport[border + 3]).toContain('verifying the storage claim')
		expect((viewport[border + 4] ?? '').trimStart().charAt(0)).toBe('●')
		// The rail itself is untouched: same rows, same order, same count. An
		// agent row is never spent on commentary.
		expect(railBlock(screen)).toEqual(railRows)
		// Aligned with the rail's title, past its two-cell header glyph.
		const header = viewport[border + 4] ?? ''
		const title = header.indexOf('●') + 2
		const narrationRow = viewport[border + 2] ?? ''
		expect(narrationRow.length - narrationRow.trimStart().length).toBe(title)
	})

	it('shows a written line once, and keeps the row for one that was refused', async () => {
		// The band carries a line that was actually written, so the call that
		// wrote it adds no row underneath repeating the same sentence. A refused
		// line wrote nothing, so its row is the only thing that says so and it
		// stays.
		sendOverride.current = async function* () {
			yield {
				kind: 'tool-start' as const,
				toolUseId: 'narrate-ok',
				toolName: 'narrate_work',
				summary: 'map returned five lenses',
			}
			yield {
				kind: 'tool-end' as const,
				toolUseId: 'narrate-ok',
				toolName: 'narrate_work',
				summary: 'map returned five lenses',
				isError: false,
			}
			yield {
				kind: 'tool-start' as const,
				toolUseId: 'narrate-blank',
				toolName: 'narrate_work',
				summary: 'Narrating',
			}
			yield {
				kind: 'tool-end' as const,
				toolUseId: 'narrate-blank',
				toolName: 'narrate_work',
				summary: 'Narration must not be blank.',
				isError: true,
			}
			yield { kind: 'done' as const, stopReason: 'end_turn' as const }
		}
		const screen = await renderToScreen(<App ctx={ctx} />, { cols: 100, rows: 28 })
		mounted = screen
		await waitUntil(screen, () => painted(screen).includes('model'), 'not ready')
		await submit(screen, 'narrate twice')
		await waitUntil(
			screen,
			() => painted(screen).includes('Narration must not be blank'),
			'refused narration row missing',
		)

		expect(painted(screen)).not.toContain('map returned five lenses')
	})

	it('keeps every rail row on a screen with no spare rows, and scrolls the conversation instead', async () => {
		// 14 rows is shorter than the brand header, the message frame, the
		// footer and the rail together, so the band's rows have to come from
		// somewhere. They come from the TOP: the terminal scrolls, the oldest
		// row above leaves the screen, and the rail keeps every row it had and
		// the budget it had them under.
		//
		// Read from the viewport rather than from row 0 of the emulator's
		// buffer. Once the screen has scrolled those are different rows, and
		// the buffer-top reading shows the rail's last rows as missing while
		// they are on screen — which is how this was first reported.
		activity.set([
			agent({ viewId: 'short-alpha', description: 'Storage lens' }),
			agent({ viewId: 'short-beta', description: 'Reference lens' }),
		])
		const screen = await renderToScreen(<App ctx={ctx} />, { cols: 100, rows: 14 })
		mounted = screen
		await waitUntil(screen, () => painted(screen).includes('model'), 'not ready')
		await waitUntil(
			screen,
			() => screen.viewport().join('\n').includes('Storage lens'),
			'rail missing',
		)
		const quiet = railBlock(screen)

		activity.narrate([
			line('narration-1', 'map returned five lenses, one with a correction'),
			line('narration-2', 'verifying the storage claim on disk'),
		])
		await waitUntil(
			screen,
			() => screen.viewport().join('\n').includes('storage claim'),
			'narration missing',
		)

		// Byte-identical, header included: the same rows, the same count, the
		// same `+N more` — nothing hidden and nothing pushed past the bottom.
		expect(railBlock(screen)).toEqual(quiet)
		const viewport = screen.viewport()
		const border = frameBottom(screen)
		expect(viewport[border + 1]).toContain('shift+tab to cycle')
		expect(viewport[border + 2]).toContain('map returned five lenses')
		expect(viewport[border + 3]).toContain('verifying the storage claim')
		expect((viewport[border + 4] ?? '').trimStart().charAt(0)).toBe('●')
	})

	it('leaves a turn with no narration exactly as it was', async () => {
		activity.set([agent({ viewId: 'quiet-child', description: 'Quiet lens' })])
		const screen = await renderToScreen(<App ctx={ctx} />, { cols: 100, rows: 28 })
		mounted = screen
		await waitUntil(screen, () => painted(screen).includes('model'), 'not ready')
		await waitUntil(
			screen,
			() => screen.viewport().join('\n').includes('Quiet lens'),
			'rail missing',
		)
		const before = screen.viewport()

		activity.narrate([line('narration-1', 'one line of commentary')])
		await waitUntil(
			screen,
			() => screen.viewport().join('\n').includes('one line of commentary'),
			'narration missing',
		)
		expect(screen.viewport()).not.toEqual(before)

		// A conversation reset clears the monitor's commentary; the screen it
		// leaves is the screen that was there before anything was narrated —
		// no blank row, no separator, nothing held open for a line to return to.
		activity.narrate([])
		await waitUntil(
			screen,
			() => !screen.viewport().join('\n').includes('one line of commentary'),
			'narration stayed on screen',
		)
		expect(screen.viewport()).toEqual(before)
	})
})
