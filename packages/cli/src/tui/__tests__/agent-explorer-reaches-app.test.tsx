import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
	type CreateTaskOptions,
	InMemoryCheckpointStore,
	InMemoryRunStore,
	type LLMProvider,
	LocalTaskScheduler,
	type Message,
	MockLLMProvider,
	type ProjectId,
	type RunEvent,
	type SessionId,
	type TaskHandle,
	type TenantId,
	type ToolContext,
	ToolRegistry,
	type TopicId,
	createToolPresenter,
	query,
} from '@namzu/sdk'
import { render } from 'ink-testing-library'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import type { Preferences } from '../../integrations/providers/index.js'
import type { SubagentActivity } from '../../integrations/subagents/activity.js'
import { createSubagentRuntime } from '../../integrations/subagents/runtime.js'
import {
	AgentCockpit,
	AgentTaskPanel,
	AgentTranscript,
	activeSubagentCohorts,
	agentPhases,
	agentTaskPanelPageSize,
	agentTranscriptPage,
	agentTranscriptRows,
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
	const listeners = new Set<() => void>()
	let delegated:
		| {
				getSnapshot: () => readonly unknown[]
				subscribe: (listener: () => void) => () => void
				reset: () => void
		  }
		| undefined
	return {
		source: {
			getSnapshot: () => delegated?.getSnapshot() ?? snapshot,
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
	}
})

let releaseParent: () => void = () => {}
let parentGate = Promise.resolve()
const sendOverride: {
	current?: (messages: readonly Message[]) => AsyncIterable<AgentEvent>
} = vi.hoisted(() => ({}))

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
			configNotices: [],
			approvalLatched: () => false,
			promptExemptTools: () => [],
			compact: async () => null,
			resumeDurable: async () => {
				throw new Error('not used')
			},
			close: async () => {},
			send: async function* (messages: readonly Message[]): AsyncIterable<AgentEvent> {
				if (sendOverride.current) {
					yield* sendOverride.current(messages)
					return
				}
				if (JSON.stringify(messages).includes('reused tool id')) {
					yield {
						kind: 'tool-start',
						runId: 'run-next',
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
		agentId: input.agentId ?? 'general-purpose',
		description: input.description ?? input.viewId,
		prompt: input.prompt ?? `prompt for ${input.viewId}`,
		batchId: input.batchId ?? 'batch-live',
		...(input.toolUseId ? { toolUseId: input.toolUseId } : {}),
		workflowId: input.workflowId ?? 'run-parent',
		phaseId:
			input.phaseId ??
			JSON.stringify([
				input.workflowId ?? 'run-parent',
				input.workflow ?? 'Delegated work',
				input.phase ?? 'Work',
			]),
		workflow: input.workflow ?? 'Delegated work',
		phase: input.phase ?? 'Work',
		...(input.phaseOrder !== undefined ? { phaseOrder: input.phaseOrder } : {}),
		phaseSequence: input.phaseSequence ?? 1,
		status: input.status ?? 'working',
		startedAt: input.startedAt ?? 1,
		transcript: input.transcript ?? [],
		...(input.completedAt !== undefined ? { completedAt: input.completedAt } : {}),
		...(input.latestActivity ? { latestActivity: input.latestActivity } : {}),
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
	throw new Error(message)
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
	activity.delegate(undefined)
	activity.set([])
	parentGate = new Promise<void>((resolve) => {
		releaseParent = resolve
	})
})

afterEach(async () => {
	releaseParent()
	await mounted?.unmount()
	mounted = null
	vi.restoreAllMocks()
})

describe('/agent', () => {
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
		await waitUntil(screen, () => painted(screen).includes('Connected to provider'), 'not ready')
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

	it('does not hide another run tool that reuses a terminal child call id', async () => {
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
		await waitUntil(screen, () => painted(screen).includes('Connected to provider'), 'not ready')
		await submit(screen, 'reused tool id')
		await waitUntil(
			screen,
			() => screen.viewport().join('\n').includes('echo still visible'),
			'reused Bash call id was hidden by an old Agent record',
		)
	})

	it('renders the real Agent runtime lifecycle for four concurrent children', async () => {
		const created: CreateTaskOptions[] = []
		const completions = new Map<string, (handle: TaskHandle) => void>()
		vi.spyOn(LocalTaskScheduler.prototype, 'createTask').mockImplementation(async (options) => {
			const taskId = `task-${created.length}`
			created.push(options)
			return {
				taskId,
				agentId: options.agentId,
				state: 'running',
				createdAt: Date.now(),
			} as unknown as TaskHandle
		})
		vi.spyOn(LocalTaskScheduler.prototype, 'waitForTask').mockImplementation(
			(taskId) =>
				new Promise<TaskHandle>((resolve) => {
					completions.set(String(taskId), resolve)
				}),
		)
		const runtime = await createSubagentRuntime({
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
			await waitUntil(screen, () => painted(screen).includes('Connected to provider'), 'not ready')

			const executions = Array.from({ length: 4 }, (_, index) =>
				runtime.agentTool.execute(
					{
						description: `Runtime child ${index + 1}`,
						prompt: `Inspect area ${index + 1}`,
					},
					{
						runId: 'run-parent',
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
					type: 'run_started',
					runId: `run-child-${index}`,
				} as unknown as RunEvent)
			}
			created[0]?.onEvent?.({
				type: 'reasoning_delta',
				runId: 'run-child-0',
				iteration: 1,
				messageId: 'reasoning' as never,
				blockIndex: 0,
				text: 'private reasoning must stay hidden',
			} as unknown as RunEvent)
			created[0]?.onEvent?.({
				type: 'text_delta',
				runId: 'run-child-0',
				iteration: 1,
				messageId: 'answer' as never,
				text: 'public live finding',
			} as unknown as RunEvent)
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
				() => screen.viewport().join('\n').includes('3 active · 4 total'),
				'completed sibling did not remain beside its live cohort',
			)
			const liveFrame = screen.viewport().join('\n')
			expect(liveFrame).toContain('3 active · 4 total')
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
				() => !screen.viewport().join('\n').includes('Runtime child'),
				'settled runtime cohort remained visible',
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
		const runtime = await createSubagentRuntime({
			cwd: work,
			model: 'mock-model',
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
					provider: parent,
					tools,
					runConfig: {
						model: 'mock-model',
						tokenBudget: 100_000,
						// Generous on purpose. Four real child runs stand up under this
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
					sessionId: 'ses_live_agents' as SessionId,
					topicId: 'top_live_agents' as TopicId,
					projectId: 'prj_live_agents' as ProjectId,
					tenantId: 'ten_live_agents' as TenantId,
					runStore: new InMemoryRunStore(),
					checkpointStore: new InMemoryCheckpointStore(),
				})
				for await (const event of events) {
					const projected = toAgentEvent(event, presenter)
					if (projected) yield projected
				}
			}
			activity.delegate(runtime.activity)
			const screen = await renderToScreen(<App ctx={ctx} />, { cols: 110, rows: 28 })
			mounted = screen
			await waitUntil(screen, () => painted(screen).includes('Connected to provider'), 'not ready')

			await submit(screen, 'production executor fan-out')
			await waitUntil(
				screen,
				() => screen.viewport().join('\n').includes('4 active · 4 total'),
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
			expect(screen.viewport().join('\n')).not.toContain('Production fan-out')
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
		await waitUntil(screen, () => painted(screen).includes('Connected to provider'), 'not ready')
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
		expect(screen.viewport().join('\n')).toContain('draft survives')
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
			() => !screen.viewport().join('\n').includes('Alpha audit'),
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
		await waitUntil(screen, () => painted(screen).includes('Connected to provider'), 'not ready')
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
		await waitUntil(screen, () => painted(screen).includes('Connected to provider'), 'not ready')
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
		await waitUntil(screen, () => painted(screen).includes('Connected to provider'), 'not ready')
		const frame = screen.viewport().join('\n')
		expect(frame).toContain('Type a message')
		expect(frame).toContain('model')
		expect(frame).toContain('1/1')
		expect(frame).not.toContain('public preview')
		expect(screen.viewport()).toHaveLength(14)
	})

	it('keeps the inspector, composer draft and status inside a short viewport', async () => {
		activity.set([agent({ viewId: 'short-inspector', description: 'Short inspector child' })])
		const screen = await renderToScreen(<App ctx={ctx} />, { cols: 60, rows: 14 })
		mounted = screen
		await waitUntil(screen, () => painted(screen).includes('Connected to provider'), 'not ready')
		screen.press('draft remains visible')
		screen.press('\x14')
		await waitUntil(
			screen,
			() => screen.viewport().join('\n').includes('Phases'),
			'short inspector did not open',
		)
		const frame = screen.viewport().join('\n')
		expect(frame).toContain('Phases')
		expect(frame).toContain('Agents')
		expect(frame).toContain('draft remains visible')
		expect(frame).toContain('model')
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
		await waitUntil(screen, () => painted(screen).includes('Connected to provider'), 'not ready')

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

	it("does not treat the command's opening Return as a painted-surface action", async () => {
		activity.set([
			agent({
				viewId: 'agent-child',
				description: 'Child run',
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
		await waitUntil(screen, () => painted(screen).includes('Connected to provider'), 'not ready')

		screen.press('/agent')
		await screen.waitForRender()
		screen.press('\r')
		await waitUntil(
			screen,
			() => screen.viewport().join('\n').includes('Child run'),
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
		await waitUntil(screen, () => painted(screen).includes('Connected to provider'), 'not ready')
		await submit(screen, '/agent')
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
		await waitUntil(screen, () => painted(screen).includes('Connected to provider'), 'not ready')

		await submit(screen, '/agent')
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
				phase: 'Research',
				phaseOrder: 0,
			}),
			agent({
				viewId: 'verify-contract',
				description: 'Contract critic',
				workflow: 'Basicbox research',
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
		await waitUntil(screen, () => painted(screen).includes('Connected to provider'), 'not ready')

		await submit(screen, '/agent')
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
		await waitUntil(screen, () => painted(screen).includes('Connected to provider'), 'not ready')
		await submit(screen, '/agent')
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
		await waitUntil(screen, () => painted(screen).includes('Connected to provider'), 'not ready')
		await submit(screen, '/agent')
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

	it('returns to the parent once the observed cohort settles and publishes it once', async () => {
		const child = agent({
			viewId: 'agent-child',
			description: 'Child run',
			transcript: [{ id: 'child-row', kind: 'assistant', text: 'child is working' }],
		})
		activity.set([child])
		const screen = await renderToScreen(<App ctx={ctx} />, {
			cols: 110,
			rows: 28,
		})
		mounted = screen
		await waitUntil(screen, () => painted(screen).includes('Connected to provider'), 'not ready')

		await submit(screen, 'start parent')
		await submit(screen, '/agent')
		screen.press('\r')
		await waitUntil(
			screen,
			() => screen.viewport().join('\n').includes('child is working'),
			'child transcript missing',
		)

		releaseParent()
		activity.set([
			{
				...child,
				status: 'completed',
				completedAt: 30,
				latestActivity: 'Completed',
			},
		])
		await waitUntil(
			screen,
			() => painted(screen).includes('parent finished'),
			'parent result missing after the child cohort settled',
		)
		expect(screen.viewport().join('\n')).not.toContain('Child run')
		expect(painted(screen).match(/parent finished/g)).toHaveLength(1)
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

	it('does not revive a terminal cohort when another run reuses its provider batch id', () => {
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
		expect(agentTaskPanelPageSize(30)).toBe(4)
		const agents = Array.from({ length: 6 }, (_, index) =>
			agent({ viewId: `agent-${index}`, description: `Worker ${index}` }),
		)
		const panel = render(
			<AgentTaskPanel agents={agents} terminalRows={15} terminalColumns={90} />,
		)
		try {
			expect(panel.lastFrame()).toContain('Worker 0')
			expect(panel.lastFrame()).not.toContain('Worker 1')
			expect(panel.lastFrame()).toContain('+5 more')
		} finally {
			panel.unmount()
		}
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

	it('keeps both cockpit panes visible on a narrow terminal', () => {
		const research = agent({
			viewId: 'research',
			workflow: 'Narrow workflow',
			phase: 'Research',
			phaseOrder: 0,
			description: 'Research worker',
		})
		const cockpit = render(
			<AgentCockpit
				agents={[research]}
				selectedPhaseId={research.phaseId}
				selectedId={research.viewId}
				focus="phases"
				terminalRows={20}
				terminalColumns={60}
			/>,
		)
		try {
			expect(cockpit.lastFrame()).toContain('Phases · 1/1')
			expect(cockpit.lastFrame()).toContain('Agents · 1/1')
			expect(cockpit.lastFrame()).toContain('Research worker')
		} finally {
			cockpit.unmount()
		}
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
			workflowId: 'run-two',
			phaseId: 'phase-two',
			status: 'cancelled',
			completedAt: 2,
		})
		const completed = agent({
			viewId: 'completed',
			workflowId: 'run-two',
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
