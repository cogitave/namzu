import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Box } from 'ink'

import {
	type CreateTaskOptions,
	type LLMProvider,
	LocalTaskScheduler,
	type Message,
	MockLLMProvider,
	type SessionEvent,
	type TaskHandle,
	type ToolContext,
	ToolManager,
	createToolPresenter,
	query,
} from '@namzu/sdk'
import { render } from 'ink-testing-library'
import stringWidth from 'string-width'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import type { Preferences } from '../../integrations/providers/index.js'
import { subagentParentFixture } from '../../integrations/subagents/__fixtures__/parent.js'
import type { SubagentActivity } from '../../integrations/subagents/activity.js'
import type { Batch } from '../../integrations/subagents/batches.js'
import { createSubagentRuntime } from '../../integrations/subagents/runtime.js'
import { testToolset } from '../../test-support/toolset.js'
import {
	AgentCockpit,
	AgentTranscript,
	agentPhases,
	agentTranscriptPage,
	agentTranscriptRows,
	agentWorkflows,
	maxAgentTranscriptTailOffset,
} from '../AgentExplorer.js'
import { genericPresenter } from '../__fixtures__/generic-presenter.js'
import { type AgentEvent, type AgentSession, type SessionScope, toAgentEvent } from '../agent.js'
import type { TuiContext } from '../types.js'
import { lowerRuleRow } from './support/composer-rules.js'
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
function prepareChildMessageBridge(scope?: SessionScope): Partial<AgentSession> {
	childMessageBridge.scope = scope
	childMessageBridge.onCreated?.()
	if (!childMessageBridge.current) return {}
	return {
		messageSubagent: childMessageBridge.current,
		resetApprovalLatch: () => {},
		onSubagentReport: (listener) => {
			childMessageBridge.onReport = listener
			return () => {
				if (childMessageBridge.onReport === listener) delete childMessageBridge.onReport
			}
		},
	}
}
const childMessageBridge: {
	current?: NonNullable<AgentSession['messageSubagent']>
	onCreated?: () => void
	scope?: SessionScope
	onReport?: Parameters<NonNullable<AgentSession['onSubagentReport']>>[0]
} = vi.hoisted(() => ({}))
/**
 * What this session's finished children left on disk, as the replay reads it.
 *
 * `reads` counts the reads so a test can assert that switching conversation
 * looks again, and `gate` holds one open so a test can put a read in flight
 * underneath the key press that asks for the cockpit.
 */
/** The rows `x` stopped on the rail, in order. */
const stoppedChildren: string[] = vi.hoisted(() => [])
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
const orchestrationBatches: { current: readonly Batch[]; gate?: Promise<void> } = vi.hoisted(
	() => ({
		current: [],
	}),
)

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
		createAgentSession: async (
			_preferences: Preferences,
			_detected: unknown,
			options?: { scope?: SessionScope },
		): Promise<AgentSession> => ({
			...prepareChildMessageBridge(options?.scope),
			stopSubagent: (viewId: string) => {
				stoppedChildren.push(viewId)
				return true
			},
			hasProvider: true,
			sandbox: { unconfined: true, enforced: [], required: [] },
			providerSummary: 'provider',
			modelSummary: 'model',
			reasoningEffortLevels: [],
			toolNames: () => ['Agent'],
			presenter: genericPresenter,
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
		...(input.summary ? { summary: input.summary } : {}),
		...(input.queued ? { queued: input.queued } : {}),
		...(input.background ? { background: true } : {}),
		prompt: input.prompt ?? `prompt for ${input.viewId}`,
		batchId: input.batchId ?? 'batch-live',
		...(input.toolUseId ? { toolUseId: input.toolUseId } : {}),
		workflowId: input.workflowId ?? 'turn-parent',
		workflowGroupId:
			input.workflowGroupId ??
			JSON.stringify([
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
	delete childMessageBridge.current
	delete childMessageBridge.onCreated
	delete childMessageBridge.onReport
	delete childMessageBridge.scope
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
	it('targets the selected child, keeps the parent draft, and supplies a host notice on the next parent turn', async () => {
		let created!: () => void
		const ready = new Promise<void>((resolve) => {
			created = resolve
		})
		childMessageBridge.onCreated = created
		const messageSubagent = vi.fn<NonNullable<AgentSession['messageSubagent']>>(async () => ({
			kind: 'queued' as const,
			taskId: 'child-task',
			state: 'running',
			parentNotice: 'Host admitted operator text for child-task: "q stays inside this child".',
		}))
		childMessageBridge.current = messageSubagent
		activity.set([
			agent({
				viewId: 'selected-child',
				agentId: 'selected-reviewer',
				description: 'Selected reviewer',
			}),
		])
		let parentStarted!: () => void
		const parentTurn = new Promise<void>((resolve) => {
			parentStarted = resolve
		})
		let hostContext: readonly string[] = []
		const parentSend = vi.fn()
		sendOverride.current = async function* (_messages, opts) {
			parentSend()
			hostContext = opts?.hostContext?.() ?? []
			parentStarted()
			yield { kind: 'done', stopReason: 'end_turn' }
		}
		const screen = await renderToScreen(<App ctx={ctx} />, { cols: 100, rows: 28 })
		mounted = screen
		await ready
		await screen.waitForRender()
		screen.press('\x14')
		await screen.waitForRender()
		screen.press('\r')
		await screen.waitForRender()
		// Viewing: the one composer is live and addressed to the agent.
		expect(screen.viewport().join('\n')).toContain('Message @selected-reviewer…')
		screen.press('q stays inside this child')
		await screen.waitForRender()
		screen.press('\r')
		await screen.waitForRender()
		// What was typed is the agent's, not the parent's: it shows in the agent's transcript.
		expect(messageSubagent).toHaveBeenCalledTimes(1)
		expect(messageSubagent).toHaveBeenCalledWith(
			'selected-child',
			'q stays inside this child',
			expect.objectContaining({
				permissionMode: 'prompt',
				currentPermissionMode: expect.any(Function),
				onPermission: expect.any(Function),
				signal: expect.any(AbortSignal),
			}),
		)
		const admissionOptions = messageSubagent.mock.calls[0]?.[2]
		screen.press('\x1b[Z')
		await screen.waitForRender()
		expect(admissionOptions?.currentPermissionMode?.()).toBe('accept-edits')
		expect(parentSend).not.toHaveBeenCalled()
		childMessageBridge.onReport?.({
			parentSessionId: 'other-conversation',
			text: 'Unrelated report must stay out.',
		})
		childMessageBridge.onReport?.({
			parentSessionId: childMessageBridge.scope!.sessionId,
			text: 'Host follow-up result: untrusted child output is quoted.',
		})
		// A complete enhanced-keyboard Escape has no ambiguity timeout to race:
		// it goes back to the conversation, whose composer takes the parent's words.
		screen.press('\x1b[27u')
		await screen.waitForRender()
		expect(screen.viewport().join('\n')).not.toContain('Message @selected-reviewer')
		screen.press('parent draft')
		await screen.waitForRender()
		screen.press('\r')
		await parentTurn
		expect(hostContext).toContain(
			'Host admitted operator text for child-task: "q stays inside this child".',
		)
		expect(hostContext).toContain('Host follow-up result: untrusted child output is quoted.')
		expect(hostContext).not.toContain('Unrelated report must stay out.')
	})

	it('injects a direct child correction into a busy parent as host context at its next boundary', async () => {
		let created!: () => void
		const ready = new Promise<void>((resolve) => {
			created = resolve
		})
		childMessageBridge.onCreated = created
		const admitted = new Promise<void>((resolve) => {
			childMessageBridge.current = async () => {
				resolve()
				return {
					kind: 'queued',
					taskId: 'busy-child',
					state: 'running',
					parentNotice: 'Host: the operator reassigned this child to BETA.',
				}
			}
		})
		activity.set([agent({ viewId: 'busy-child-view', description: 'Busy reviewer' })])
		let started!: () => void
		const running = new Promise<void>((resolve) => {
			started = resolve
		})
		let advance!: () => void
		const boundary = new Promise<void>((resolve) => {
			advance = resolve
		})
		let drained!: () => void
		const delivered = new Promise<void>((resolve) => {
			drained = resolve
		})
		let context: readonly Message[] = []
		sendOverride.current = async function* (_messages, opts) {
			started()
			yield { kind: 'delta', text: 'Parent waiting for its current operation.' }
			await boundary
			context = opts?.inboundMessages?.() ?? []
			drained()
			yield { kind: 'done', stopReason: 'end_turn' }
		}
		const screen = await renderToScreen(<App ctx={ctx} />, { cols: 100, rows: 28 })
		mounted = screen
		await ready
		await screen.waitForRender()
		await submit(screen, 'start parent')
		await running
		screen.press('\x14')
		await screen.waitForRender()
		screen.press('\r')
		await screen.waitForRender()
		screen.press('\r')
		await screen.waitForRender()
		screen.press('BETA')
		await screen.waitForRender()
		screen.press('\r')
		await admitted
		await screen.waitForRender()
		expect(context).toEqual([])
		childMessageBridge.onReport?.({
			parentSessionId: childMessageBridge.scope!.sessionId,
			text: 'Host: child follow-up completed; its output has no operator authority.',
		})
		advance()
		await delivered
		expect(context).toEqual([
			expect.objectContaining({
				role: 'user',
				content: 'Host: the operator reassigned this child to BETA.',
				source: { type: 'runtime-context', kind: 'advisory' },
			}),
			expect.objectContaining({
				role: 'user',
				content: 'Host: child follow-up completed; its output has no operator authority.',
				source: { type: 'runtime-context', kind: 'task-completion' },
			}),
		])
	})

	it('revokes an in-flight child submission when the operator starts another conversation', async () => {
		let created!: () => void
		const ready = new Promise<void>((resolve) => {
			created = resolve
		})
		childMessageBridge.onCreated = created
		let entered!: () => void
		const enteredBridge = new Promise<void>((resolve) => {
			entered = resolve
		})
		let admit!: (receipt: Awaited<ReturnType<NonNullable<AgentSession['messageSubagent']>>>) => void
		const admission = new Promise<
			Awaited<ReturnType<NonNullable<AgentSession['messageSubagent']>>>
		>((resolve) => {
			admit = resolve
		})
		let signal: AbortSignal | undefined
		childMessageBridge.current = (_viewId, _message, opts) => {
			signal = opts?.signal
			entered()
			return admission
		}
		activity.set([agent({ viewId: 'old-child', description: 'Old reviewer' })])
		const screen = await renderToScreen(<App ctx={ctx} />, { cols: 100, rows: 28 })
		mounted = screen
		await ready
		await screen.waitForRender()
		screen.press('\x14')
		await screen.waitForRender()
		screen.press('\r')
		await screen.waitForRender()
		screen.press('\r')
		await screen.waitForRender()
		await submit(screen, 'old assignment')
		await enteredBridge
		const revoked = new Promise<void>((resolve) =>
			signal!.addEventListener('abort', () => resolve(), { once: true }),
		)
		screen.press('\x1b[27u')
		await screen.waitForRender()
		await submit(screen, '/new')
		await revoked
		admit({
			kind: 'started',
			taskId: 'old-task',
			state: 'pending',
			parentNotice: 'Old assignment must not enter the new conversation.',
		})
		await admission
		let sent!: () => void
		const next = new Promise<void>((resolve) => {
			sent = resolve
		})
		let hostContext: readonly string[] = []
		sendOverride.current = async function* (_messages, opts) {
			hostContext = opts?.hostContext?.() ?? []
			sent()
			yield { kind: 'done', stopReason: 'end_turn' }
		}
		await submit(screen, 'fresh parent prompt')
		await next
		expect(signal?.aborted).toBe(true)
		expect(hostContext).not.toContain('Old assignment must not enter the new conversation.')
	})

	it.each([
		[100, 28],
		[60, 14],
		[35, 20],
	])('keeps child messages inside a %i × %i terminal', async (cols, rows) => {
		let created!: () => void
		const ready = new Promise<void>((resolve) => {
			created = resolve
		})
		childMessageBridge.onCreated = created
		childMessageBridge.current = async () => ({
			kind: 'queued',
			taskId: 'child',
			state: 'running',
			parentNotice: 'admitted',
		})
		activity.set([agent({ viewId: 'visible-child', agentId: 'reviewer', description: 'Reviewer' })])
		const screen = await renderToScreen(<App ctx={ctx} />, { cols, rows })
		mounted = screen
		await ready
		await screen.waitForRender()
		screen.press('\x14')
		await screen.waitForRender()
		screen.press('\r')
		await screen.waitForRender()
		const frame = screen.viewport().join('\n')
		expect(frame).toContain('Message @reviewer')
		expect(frame).toContain('prompt for visible-child')
		expect(screen.row(-1).trim()).toBe('')
		// The composer, the footer and the rail all fit under the transcript.
		expect(frame).toContain('◯ main')
		expect(frame).toMatch(/● reviewer/u)
	})

	it('keeps replayed children read only even when direct messaging is available', async () => {
		let created!: () => void
		const ready = new Promise<void>((resolve) => {
			created = resolve
		})
		childMessageBridge.onCreated = created
		const send = vi.fn(async () => ({
			kind: 'started' as const,
			taskId: 'unused',
			state: 'running',
			parentNotice: 'unused',
		}))
		childMessageBridge.current = send
		activity.set([
			agent({
				viewId: 'saved-child',
				description: 'Saved reviewer',
				replayed: true,
				status: 'completed',
				completedAt: 2,
			}),
		])
		const screen = await renderToScreen(<App ctx={ctx} />, { cols: 100, rows: 28 })
		mounted = screen
		await ready
		await screen.waitForRender()
		screen.press('\x14')
		await screen.waitForRender()
		screen.press('\r')
		await screen.waitForRender()
		screen.press('\r')
		await screen.waitForRender()
		expect(screen.viewport().join('\n')).not.toContain('Message @saved-reviewer')
		expect(send).not.toHaveBeenCalled()
	})

	it('keeps the selected conversation and its draft when a follow-up changes its run and phase', async () => {
		let created!: () => void
		const ready = new Promise<void>((resolve) => {
			created = resolve
		})
		childMessageBridge.onCreated = created
		childMessageBridge.current = async () => ({
			kind: 'started',
			taskId: 'follow-up',
			state: 'running',
			parentNotice: 'new task',
		})
		activity.set([
			agent({
				viewId: 'retained-reviewer',
				description: 'Retained reviewer',
				workflowId: 'old-run',
				phase: 'Original',
			}),
		])
		const screen = await renderToScreen(<App ctx={ctx} />, { cols: 100, rows: 28 })
		mounted = screen
		await ready
		await screen.waitForRender()
		screen.press('\x14')
		await screen.waitForRender()
		screen.press('\r')
		await screen.waitForRender()
		screen.press('draft for the retained child')
		await screen.waitForRender()
		activity.set([
			agent({
				viewId: 'retained-reviewer',
				description: 'Retained reviewer',
				workflowId: 'new-run',
				phase: 'Follow-up',
			}),
			agent({
				viewId: 'old-sibling',
				description: 'Archived other task',
				workflowId: 'old-run',
				phase: 'Original',
				status: 'completed',
				completedAt: 2,
			}),
		])
		await screen.waitForRender()
		// The agent stays the one on screen through a change of its run and phase,
		// with the draft still in the composer.
		const frame = screen.viewport().join('\n')
		expect(frame).toContain('draft for the retained child')
		expect(frame).toMatch(/● general-purpose\s+Retained reviewer/u)
		expect(frame).not.toContain('Archived other task  ')
	})

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
				() => railRows(screen).length === 4,
				'children did not reach the automatic panel',
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
				() => painted(screen).includes('Agent "Runtime child 1" finished'),
				'first completion missing',
			)
			// The finished sibling stays on the rail beside the three still running.
			expect(railRows(screen)).toHaveLength(4)
			const liveFrame = screen.viewport().join('\n')
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
				() => painted(screen).includes('Agent "Runtime child 4" finished'),
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
			buildTools: () => [],
		})
		try {
			const toolsets = [testToolset(runtime.agentTool)]
			const presenter = createToolPresenter(new ToolManager({ toolsets, messages: () => [] }))
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
					toolsets,
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
				() => /◯ Production fan-out/u.test(screen.viewport().join('\n')),
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
			// The finished agents linger on the rail for 30 s; the launch receipt
			// names the batch once in settled history.
			expect(
				painted(screen).match(/Workflow Production fan-out[\s\S]{0,40}Running in background/g),
			).toHaveLength(1)
			expect(painted(screen)).not.toMatch(/Launched 4 agents/u)
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
			() => screen.viewport().join('\n').includes('Alpha audit'),
			'automatic agent panel missing',
		)

		screen.press('draft survives')
		screen.press('\x14')
		await waitUntil(
			screen,
			() => screen.viewport().join('\n').includes('Agents · 2 agents'),
			'cockpit missing',
		)
		expect(screen.viewport().join('\n')).not.toContain('draft survives')
		screen.press('\x14')
		await waitUntil(
			screen,
			() => !screen.viewport().join('\n').includes('Agents · 2 agents'),
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
		expect(screen.viewport().join('\n')).toContain('draft survives')
	})

	it('moves into the agents rail with down from a truly empty composer', async () => {
		activity.set([
			agent({ viewId: 'agent-down', description: 'Down-select child' }),
			agent({ viewId: 'agent-down-2', description: 'Second child' }),
		])
		const screen = await renderToScreen(<App ctx={ctx} />, {
			cols: 110,
			rows: 28,
		})
		mounted = screen
		await waitUntil(screen, () => painted(screen).includes('model'), 'not ready')
		expect(screen.viewport().join('\n')).not.toContain('Enter to view')
		screen.press('\x1b[B')
		await waitUntil(
			screen,
			() => /^ *❯ ◯ \S+ +Down-select child/mu.test(screen.viewport().join('\n')),
			'down did not focus the first agent',
		)
		// The same press must not also step to the second row.
		expect(screen.viewport().join('\n')).not.toMatch(/^ *❯ ◯ \S+ +Second child/mu)
		// The key line takes the mode line's place; two agents run, so the stop-all chord is offered.
		expect(screen.viewport().join('\n')).toContain(
			'Enter to view · x to stop · ctrl+x ctrl+k to stop all agents',
		)
		expect(screen.viewport().join('\n')).not.toContain('esc to go back')
		screen.press('\x1b[B')
		await waitUntil(
			screen,
			() => /^ *❯ ◯ \S+ +Second child/mu.test(screen.viewport().join('\n')),
			'down did not move to the second agent',
		)
		screen.press('\x1b[A')
		screen.press('\x1b[A')
		await waitUntil(
			screen,
			() => /^ *❯ ● main/mu.test(screen.viewport().join('\n')),
			'up did not reach the main row',
		)
		screen.press('\x1b')
		await waitUntil(
			screen,
			() => !screen.viewport().join('\n').includes('Enter to view'),
			'escape did not hand the keyboard back',
		)
		expect(screen.viewport().join('\n')).toContain('Type a message')
	})

	it('offers the running agents on the footer and opens them with left from an empty composer', async () => {
		activity.set([
			agent({ viewId: 'agent-left-1', description: 'First child' }),
			agent({ viewId: 'agent-left-2', description: 'Second child' }),
		])
		const screen = await renderToScreen(<App ctx={ctx} />, { cols: 110, rows: 28 })
		mounted = screen
		await waitUntil(screen, () => painted(screen).includes('model'), 'not ready')
		expect(screen.viewport().join('\n')).toContain('← 2 agents · ↓ to manage')
		screen.press('\x1b[D')
		await waitUntil(
			screen,
			() => screen.viewport().join('\n').includes('Agents · 2 agents'),
			'left did not open the agents',
		)
	})

	it('keeps left as cursor movement once anything is typed, and stops advertising it', async () => {
		activity.set([agent({ viewId: 'agent-typed', description: 'Typed child' })])
		const screen = await renderToScreen(<App ctx={ctx} />, { cols: 110, rows: 28 })
		mounted = screen
		await waitUntil(screen, () => painted(screen).includes('model'), 'not ready')
		expect(screen.viewport().join('\n')).toContain('← 1 agent · ↓ to manage')
		screen.press('hi')
		await screen.waitForRender()
		expect(screen.viewport().join('\n')).not.toContain('← 1 agent')
		expect(screen.viewport().join('\n')).not.toContain('↓ to manage')
		screen.press('\x1b[D')
		await screen.waitForRender()
		screen.press('X')
		await waitUntil(
			screen,
			() => /hX.?i/u.test(screen.viewport().join('\n')),
			'cursor did not move',
		)
		expect(screen.viewport().join('\n')).not.toContain('Agents · 1 agent')
	})

	it('stops a running agent with x and leaves the rail focused', async () => {
		stoppedChildren.length = 0
		activity.set([
			agent({ viewId: 'agent-stop-1', description: 'First child' }),
			agent({ viewId: 'agent-stop-2', description: 'Second child' }),
		])
		const screen = await renderToScreen(<App ctx={ctx} />, { cols: 110, rows: 28 })
		mounted = screen
		await waitUntil(screen, () => painted(screen).includes('model'), 'not ready')
		screen.press('\x1b[B')
		await waitUntil(
			screen,
			() => screen.viewport().join('\n').includes('x to stop'),
			'rail not focused',
		)
		screen.press('\x1b[B')
		await waitUntil(
			screen,
			() => /^ *❯ ◯ \S+ +Second child/mu.test(screen.viewport().join('\n')),
			'second row not selected',
		)
		screen.press('x')
		await waitUntil(screen, () => stoppedChildren.length === 1, 'x did not stop the agent')
		expect(stoppedChildren).toEqual(['agent-stop-2'])
		expect(screen.viewport().join('\n')).toContain('x to stop')
	})

	it('clears a finished agent with x instead of stopping it', async () => {
		stoppedChildren.length = 0
		activity.set([
			agent({ viewId: 'agent-live', description: 'Live child' }),
			agent({
				viewId: 'agent-done',
				description: 'Done child',
				status: 'completed',
				startedAt: Date.now() - 5_000,
				completedAt: Date.now() - 1_000,
			}),
		])
		const screen = await renderToScreen(<App ctx={ctx} />, { cols: 110, rows: 28 })
		mounted = screen
		await waitUntil(screen, () => painted(screen).includes('model'), 'not ready')
		screen.press('\x1b[B')
		await waitUntil(
			screen,
			() => screen.viewport().join('\n').includes('x to stop'),
			'rail not focused',
		)
		screen.press('\x1b[B')
		await waitUntil(
			screen,
			() => screen.viewport().join('\n').includes('x to clear'),
			'finished row not selected',
		)
		screen.press('x')
		await waitUntil(
			screen,
			() => railRows(screen).length === 1,
			'the finished agent stayed on the rail',
		)
		expect(stoppedChildren).toEqual([])
		expect(railRows(screen).join('\n')).toContain('Live child')
	})

	it('opens the selected agent with enter and returns to the same row with escape', async () => {
		activity.set([
			agent({ viewId: 'agent-view-1', description: 'First child' }),
			agent({
				viewId: 'agent-view-2',
				description: 'Second child',
				prompt: 'Look at the second thing',
			}),
		])
		const screen = await renderToScreen(<App ctx={ctx} />, { cols: 110, rows: 28 })
		mounted = screen
		await waitUntil(screen, () => painted(screen).includes('model'), 'not ready')
		screen.press('\x1b[B')
		await waitUntil(
			screen,
			() => screen.viewport().join('\n').includes('x to stop'),
			'rail not focused',
		)
		screen.press('\x1b[B')
		await waitUntil(
			screen,
			() => /^ *❯ ◯ \S+ +Second child/mu.test(screen.viewport().join('\n')),
			'second row not selected',
		)
		screen.press('\r')
		await waitUntil(
			screen,
			() => screen.viewport().join('\n').includes('Look at the second thing'),
			'enter did not open the agent transcript',
		)
		expect(screen.viewport().join('\n')).toContain('esc back')
		screen.press('\x1b')
		await waitUntil(
			screen,
			() => /^ *❯ ◯ \S+ +Second child/mu.test(screen.viewport().join('\n')),
			'escape did not return to the rail row',
		)
	})

	describe('workflow rows', () => {
		const flow = (viewId: string, extra: Partial<SubagentActivity> = {}): SubagentActivity =>
			agent({
				viewId,
				description: `Step ${viewId}`,
				workflow: 'Release audit',
				phase: viewId === 'wf-c' ? 'Verify' : 'Survey',
				phaseSequence: viewId === 'wf-c' ? 2 : 1,
				...extra,
			})

		async function focusWorkflow(screen: Screen, downs: number): Promise<void> {
			for (let i = 0; i < downs; i += 1) {
				screen.press('\x1b[B')
				await screen.waitForRender()
			}
			await waitUntil(
				screen,
				() => /^ *❯ ◯ Release audit/mu.test(screen.viewport().join('\n')),
				'the workflow row did not take the pointer',
			)
		}

		it('draws the row after the agents and stops every running member with x', async () => {
			stoppedChildren.length = 0
			activity.set([
				flow('wf-a', { startedAt: Date.now() - 9_000 }),
				flow('wf-b', {
					status: 'completed',
					startedAt: Date.now() - 9_000,
					completedAt: Date.now() - 2_000,
				}),
				flow('wf-c', { startedAt: Date.now() - 8_000 }),
			])
			const screen = await renderToScreen(<App ctx={ctx} />, { cols: 110, rows: 30 })
			mounted = screen
			await waitUntil(screen, () => painted(screen).includes('model'), 'not ready')
			await waitUntil(
				screen,
				() => /◯ Release audit +▰+▱+ +1\/3 · \d+s/u.test(screen.viewport().join('\n')),
				'the workflow row never appeared',
			)
			// Its agents are not rows, and with no agent row there is no main: the
			// workflow is the only row, one down from the composer.
			await focusWorkflow(screen, 1)
			expect(screen.viewport().join('\n')).not.toMatch(/Step wf-|main/u)
			expect(screen.viewport().join('\n')).toContain('Enter to view · x to stop')
			screen.press('x')
			await waitUntil(screen, () => stoppedChildren.length === 2, 'x did not stop the workflow')
			expect([...stoppedChildren].sort()).toEqual(['wf-a', 'wf-c'])
		})

		it('opens the workflow on its phases with enter and returns to the row with escape', async () => {
			activity.set([
				flow('wf-a', { startedAt: Date.now() - 9_000 }),
				flow('wf-c', { startedAt: Date.now() - 8_000 }),
			])
			const screen = await renderToScreen(<App ctx={ctx} />, { cols: 110, rows: 30 })
			mounted = screen
			await waitUntil(screen, () => painted(screen).includes('model'), 'not ready')
			await focusWorkflow(screen, 1)
			screen.press('\r')
			await waitUntil(
				screen,
				() =>
					/Survey/u.test(screen.viewport().join('\n')) &&
					/Verify/u.test(screen.viewport().join('\n')),
				'enter did not open the workflow phases',
			)
			expect(screen.viewport().join('\n')).not.toContain('Select a workflow')
			screen.press('\x1b')
			await waitUntil(
				screen,
				() => /^ *❯ ◯ Release audit/mu.test(screen.viewport().join('\n')),
				'escape did not return to the workflow row',
			)
		})

		it('stops the whole workflow with x on its phases and one agent with x on its agents', async () => {
			stoppedChildren.length = 0
			activity.set([
				flow('wf-a', { startedAt: Date.now() - 9_000 }),
				flow('wf-c', { startedAt: Date.now() - 8_000 }),
			])
			const screen = await renderToScreen(<App ctx={ctx} />, { cols: 110, rows: 30 })
			mounted = screen
			await waitUntil(screen, () => painted(screen).includes('model'), 'not ready')
			await focusWorkflow(screen, 1)
			screen.press('\r')
			await waitUntil(screen, () => screen.viewport().join('\n').includes('Phases'), 'no phases')
			screen.press('\r')
			await waitUntil(
				screen,
				() => screen.viewport().join('\n').includes('Survey · 1 agent'),
				'no agents of the phase',
			)
			// Level 2: only the selected agent.
			screen.press('x')
			await waitUntil(screen, () => stoppedChildren.length === 1, 'x did not stop the agent')
			expect(stoppedChildren).toEqual(['wf-a'])
			// Left walks back up; level 1: every agent still going.
			screen.press('\x1b[D')
			await waitUntil(screen, () => screen.viewport().join('\n').includes('Phases'), 'no way up')
			screen.press('x')
			await waitUntil(screen, () => stoppedChildren.length === 3, 'x did not stop the workflow')
			expect([...stoppedChildren].sort()).toEqual(['wf-a', 'wf-a', 'wf-c'])
		})

		it('writes one closing line, at turn end, even when the next phase starts 10 s after the last settled', async () => {
			let turnRunning!: () => void
			const running = new Promise<void>((resolve) => {
				turnRunning = resolve
			})
			let endTurn!: () => void
			const gate = new Promise<void>((resolve) => {
				endTurn = resolve
			})
			sendOverride.current = async function* () {
				turnRunning()
				yield { kind: 'delta', text: 'Coordinating the audit.' }
				await gate
				yield { kind: 'done', stopReason: 'end_turn' }
			}
			const screen = await renderToScreen(<App ctx={ctx} />, { cols: 110, rows: 30 })
			mounted = screen
			await waitUntil(screen, () => painted(screen).includes('model'), 'not ready')
			await submit(screen, 'run the audit')
			await running
			const t0 = Date.now()
			const closing = (): number =>
				(painted(screen).match(/Workflow Release audit (completed|failed|stopped)/gu) ?? []).length
			// Phase one settles.
			activity.set([flow('wf-a', { startedAt: t0, status: 'completed', completedAt: t0 + 1 })])
			await screen.waitForRender()
			// Phase two starts 10 s later and settles too.
			activity.set([
				flow('wf-a', { startedAt: t0, status: 'completed', completedAt: t0 + 1 }),
				flow('wf-c', { startedAt: t0 + 10_000, status: 'completed', completedAt: t0 + 12_000 }),
			])
			// A workflow's agents leave no rows of their own; the group line is
			// the one thing its launch writes.
			await waitUntil(
				screen,
				() => painted(screen).includes('Running in background'),
				'the workflow launch line was not written',
			)
			await screen.waitForRender()
			await screen.waitForRender()
			// Both phases have settled, but the turn that ran them has not ended.
			expect(closing()).toBe(0)
			endTurn()
			await waitUntil(screen, () => closing() === 1, 'no closing line at turn end')
			await screen.waitForRender()
			await screen.waitForRender()
			expect(closing()).toBe(1)
			expect(painted(screen)).toContain('Workflow Release audit completed')
			expect(painted(screen)).toMatch(/Workflow Release audit completed · .*2 agents/u)
		})

		it('clears a finished workflow with x without stopping anything', async () => {
			stoppedChildren.length = 0
			activity.set([
				flow('wf-a', {
					status: 'completed',
					startedAt: Date.now() - 9_000,
					completedAt: Date.now() - 2_000,
				}),
			])
			const screen = await renderToScreen(<App ctx={ctx} />, { cols: 110, rows: 30 })
			mounted = screen
			await waitUntil(screen, () => painted(screen).includes('model'), 'not ready')
			await focusWorkflow(screen, 1)
			expect(screen.viewport().join('\n')).toContain('Enter to view · x to clear')
			screen.press('x')
			await waitUntil(
				screen,
				() => !/◯ Release audit/u.test(screen.viewport().join('\n')),
				'the finished workflow stayed on the rail',
			)
			expect(stoppedChildren).toEqual([])
		})
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
		expect(frame).toContain('Short worker 4')
		expect(frame).not.toContain('Short worker 5')
		expect(frame).toContain('↓ 1 more')
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
		// A labelled agent is only inside its workflow: one workflow row, no main.
		expect(frame).toContain('◯ A deliberat')
		expect(frame).not.toContain('main')
		expect(frame).not.toContain('public preview')
		expect(screen.viewport()).toHaveLength(14)
	})

	it('opens on the phase whose agent is still working, titled by that phase', async () => {
		const settled = {
			status: 'completed' as const,
			completedAt: 3,
			workflow: 'Two-phase colour sentence',
		}
		activity.set([
			agent({
				viewId: 'first',
				description: 'Choose first colour',
				phase: 'Phase 1',
				phaseOrder: 0,
				...settled,
			}),
			agent({
				viewId: 'second',
				description: 'Choose second colour',
				phase: 'Phase 1',
				phaseOrder: 0,
				...settled,
			}),
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
			() => screen.viewport().join('\n').includes('Phases'),
			'the cockpit did not open on the phases',
		)
		const frame = screen.viewport().join('\n')
		// Opened on the phase still moving, one list at a time.
		expect(frame).toMatch(/✔\s+Phase 1\s+2\/2/u)
		expect(frame).toMatch(/❯ 2\s+Phase 2\s+0\/1/u)
		expect(frame).toContain('2/3 agents')
		screen.press('\r')
		await waitUntil(
			screen,
			() => screen.viewport().join('\n').includes('Phase 2 · 1 agent'),
			'enter did not open the live phase',
		)
		expect(screen.viewport().join('\n')).toMatch(/❯● Join the two colours/u)
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
			() => screen.viewport().join('\n').includes('Agents · 1 agent'),
			'short inspector did not open',
		)
		const frame = screen.viewport().join('\n')
		expect(frame).toContain('Agents · 1 agent')
		expect(frame).not.toContain('draft remains visible')
		screen.press('\x14')
		await waitUntil(
			screen,
			() => screen.viewport().join('\n').includes('draft remains visible'),
			'draft was not restored',
		)
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
		await waitUntil(screen, () => railRows(screen).length === 2, 'live child rows missing')
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
				transcript: [
					{ id: 'saved-row', kind: 'tool', text: 'Read(src/a.ts)', status: 'completed' },
				],
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
				transcript: [
					{ id: 'saved-row-2', kind: 'tool', text: 'Read(src/b.ts)', status: 'completed' },
				],
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
			() => screen.viewport().join('\n').includes('Phases'),
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

	it.each([
		{ cols: 110, rows: 28 },
		{ cols: 60, rows: 18 },
	])(
		'keeps two eight-agent actions as separate workflows at $cols×$rows',
		async ({ cols, rows }) => {
			const first = Array.from({ length: 8 }, (_, index) =>
				agent({
					viewId: `first-${index}`,
					description: `First agent ${index + 1}`,
					workflowId: 'run-one',
					workflow: 'Capacity review',
					phase: 'Inspect',
					phaseOrder: 0,
					status: 'completed',
					startedAt: 1,
					completedAt: 2,
					transcript: [
						{ id: `first-result-${index}`, kind: 'assistant', text: 'first workflow evidence' },
					],
				}),
			)
			const second = Array.from({ length: 8 }, (_, index) =>
				agent({
					viewId: `second-${index}`,
					description: `Second agent ${index + 1}`,
					workflowId: 'run-two',
					workflow: 'Capacity review',
					phase: 'Inspect',
					phaseOrder: 0,
					status: 'cancelled',
					startedAt: 3,
					completedAt: 4,
					transcript: [
						{
							id: `second-result-${index}`,
							kind: 'assistant',
							text: 'second workflow cancellation',
						},
					],
				}),
			)
			activity.set([...first, ...second])
			const screen = await renderToScreen(<App ctx={ctx} />, { cols, rows })
			mounted = screen
			await waitUntil(screen, () => painted(screen).includes('model'), 'not ready')
			screen.press('preserved draft')
			await screen.waitForRender()
			screen.press('\x14')
			await waitUntil(
				screen,
				() => screen.viewport().join('\n').includes('Workflows · 2/2'),
				'workflow picker missing',
			)
			expect(screen.viewport().join('\n')).not.toContain('Phases')
			screen.press('\r')
			await waitUntil(
				screen,
				() => screen.viewport().join('\n').includes('Phases'),
				'latest workflow missing',
			)
			let frame = screen.viewport().join('\n')
			// The header names the list; a count here would read as phases done.
			expect(frame).not.toMatch(/Phases · \d/)
			expect(frame).toContain('8/8 agents')
			expect(frame).toMatch(/✘\s+Inspect\s+8\/8/)
			expect(frame).not.toContain('First agent')
			screen.press('\r')
			await waitUntil(
				screen,
				() => /❯ ?\S Second agent 1/u.test(screen.viewport().join('\n')),
				'agents of the phase missing',
			)
			expect(screen.viewport().join('\n')).toContain('Inspect · 8 agents')
			screen.press('\r')
			await waitUntil(
				screen,
				() => screen.viewport().join('\n').includes('second workflow cancellation'),
				'cancelled transcript missing',
			)
			screen.press('\x1b')
			await waitUntil(
				screen,
				() => /❯ ?[✔✘●◌] .*(First|Second) agent/u.test(screen.viewport().join('\n')),
				'did not return to agents',
			)
			screen.press('\x1b')
			await waitUntil(
				screen,
				() => /❯ ?[✔✘\d] +Inspect/u.test(screen.viewport().join('\n')),
				'did not return to phases',
			)
			screen.press('\x1b')
			await waitUntil(
				screen,
				() => screen.viewport().join('\n').includes('Workflows · 2/2'),
				'did not return to workflows',
			)
			screen.press('\x1b[A')
			screen.press('\r')
			await waitUntil(
				screen,
				() => screen.viewport().join('\n').includes('Phases'),
				'previous workflow missing',
			)
			screen.press('\r')
			await waitUntil(
				screen,
				() => screen.viewport().join('\n').includes('First agent 1'),
				'previous workflow agents missing',
			)
			frame = screen.viewport().join('\n')
			expect(frame).toContain('8/8 agents')
			expect(frame).not.toContain('Second agent')
			screen.press('q')
			await waitUntil(
				screen,
				() => screen.viewport().join('\n').includes('preserved draft'),
				'draft not restored',
			)
			screen.press('\x14')
			await waitUntil(
				screen,
				() => screen.viewport().join('\n').includes('Workflows · 2/2'),
				'retained workflows did not reopen',
			)
		},
	)

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
		expect(screen.viewport().join('\n')).toContain('Agents · 2 agents')
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

	// Longer than this file's other cases on purpose, not by accident: the
	// paging loop below drives ~60-90 real keypress-then-render round trips
	// through the actual Ink renderer and a real `xterm-headless` terminal
	// (see `support/screen.ts`) so it can prove every one of 412 lines of
	// wide-character tool output eventually scrolls into view — there is no
	// timer to fake here, the cost is real reconciliation and terminal-parser
	// work. Measured directly (`performance.now()` around each phase): ~5.9s
	// for that loop at rest, and ~25s for the same loop with the process
	// pinned to two cores under eight competing busy loops. The package's
	// shared 15s `testTimeout` (see `vitest.config.ts`) covers everything
	// else in this file, which does far less real work per case, but was too
	// tight for this one case under the CPU contention a full CI matrix leg
	// produces — that gap, not a hang, is what timed the test out on CI.
	// 60s keeps more than 2x headroom over the measured worst case while
	// still failing a genuine hang in finite time.
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
			() => /Agents · \d+ agents?/u.test(screen.viewport().join('\n')),
			'escape did not return to the agent list',
		)
		screen.press('\r')
		await screen.waitForRender()
		expect(screen.viewport().join('\n')).toContain('CHILD_LIVE_UPDATE')
		screen.press('q')
		await screen.waitForRender()
		frame = screen.viewport().join('\n')
		expect(frame).toContain('PARENT_DRAFT_RESTORED')
		expect(lowerRuleRow(screen.viewport())).toBeGreaterThanOrEqual(0)
		expect(frame).not.toContain('CHILD_LIVE_UPDATE')
		expect(painted(screen)).not.toContain('parent finished')
	}, 60_000)

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
		expect(screen.viewport().join('\n')).toContain('Agent "Child session" finished')
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
				transcript: [
					{ id: 'saved-row', kind: 'tool', text: 'Read(src/a.ts)', status: 'completed' },
				],
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
	// A resolved model id is host-reported, unbounded text: a self-hosted or
	// gateway-style id routinely runs 60-90+ cells, well past anything a
	// short fixture like 'test-model-large' exercises. The meta box carrying
	// it is `flexShrink={0}`, so an uncapped label does not truncate itself —
	// it forces its shrinkable neighbours (the description, the elapsed/
	// activity text) down first, to zero once the deficit is large enough.
	// These three cases pin one long id at each of the three required render
	// sites and assert the description survives rather than vanishing.
	const REALISTIC_LONG_MODEL =
		'gateway/production/anthropic/claude-opus-4-1-20250805-experimental-v3'

	it('a long model id never erases the description in the agent cockpit', async () => {
		const busy = agent({
			viewId: 'agent-long-model',
			description: 'Audit dependencies for known vulnerabilities',
			model: REALISTIC_LONG_MODEL,
			tokens: 42_123,
			toolCalls: 18,
		})
		const screen = await renderToScreen(
			<Box flexDirection="column" paddingX={1}>
				<AgentCockpit
					agents={[busy]}
					selectedPhaseId={busy.phaseId}
					selectedId={busy.viewId}
					focus="agents"
					terminalRows={24}
					terminalColumns={130}
				/>
			</Box>,
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
		expect(
			workflows.map((workflow) =>
				workflow.phases.map((phase) => phase.agents.map((entry) => entry.viewId)),
			),
		).toEqual([[['first']], [['second']]])
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
		const queued = agent({
			viewId: 'queued',
			description: 'Ninth review',
			status: 'queued',
			latestActivity: 'Queued',
		})
		const running = agent({ viewId: 'running', description: 'Running review' })
		const screen = await renderToScreen(
			<Box flexDirection="column" paddingX={1}>
				<AgentCockpit
					agents={[running, queued]}
					selectedPhaseId={queued.phaseId}
					selectedId={queued.viewId}
					focus="agents"
					terminalRows={24}
					terminalColumns={110}
				/>
			</Box>,
			{ cols: 110, rows: 24 },
		)
		mounted = screen
		await screen.waitForRender()
		const frame = screen.viewport().join('\n')
		expect(frame).toContain('0/2 agents')
		expect(frame).toContain('Agents · 2 agents')
		expect(frame).toMatch(/◌\s+Ninth review.*queued/)
		expect(frame).toMatch(/●\s+Running review/)
		expect(frame).not.toMatch(/queued.*queued/)
	})

	it.each([
		{ cols: 120, rows: 28 },
		{ cols: 60, rows: 20 },
		{ cols: 40, rows: 14 },
	])(
		'lists phases, then the agents of one phase, one list at a time at $cols×$rows',
		async ({ cols, rows }) => {
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
			const show = async (focus: 'phases' | 'agents') => {
				const screen = await renderToScreen(
					<Box flexDirection="column" paddingX={1}>
						<AgentCockpit
							agents={[research]}
							selectedPhaseId={research.phaseId}
							selectedId={research.viewId}
							focus={focus}
							terminalRows={rows}
							terminalColumns={cols}
						/>
					</Box>,
					{ cols, rows },
				)
				mounted = screen
				return screen.viewport()
			}
			const levelOne = await show('phases')
			const text = levelOne.join('\n')
			expect(text).toContain('Phases')
			expect(levelOne.find((line) => /Research.*1\/1/.test(line))).toMatch(/❯ ✔\s+Research\s+1\/1/)
			if (cols >= 64) {
				// Side by side: the selected phase's agents sit in the right pane.
				expect(text).toContain('Research · 1 agent')
				expect(text).toContain('╭')
			} else {
				expect(text).not.toContain('Research worker')
			}
			await mounted?.unmount()
			mounted = null
			const levelTwo = await show('agents')
			expect(levelTwo.join('\n')).toContain('Research · 1 agent')
			const worker = levelTwo.find((line) => line.includes('Research worker')) ?? ''
			expect(worker).toMatch(/❯✔\s*Research worker.*58s|❯ ✔\s+Research worker.*58s/)
			expect(levelTwo.join('\n')).toContain('esc back')
		},
	)

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
			<Box flexDirection="column" paddingX={1}>
				<AgentCockpit
					agents={[research, verify]}
					selectedPhaseId={research.phaseId}
					selectedId={research.viewId}
					focus="phases"
					terminalRows={28}
					terminalColumns={120}
				/>
			</Box>,
			{ cols: 120, rows: 28 },
		)
		mounted = screen
		const frame = screen.viewport().join('\n')
		expect(frame).toContain('Confirm the rollback plan.')
		expect(frame).not.toContain('Check the queue depth.')
	})

	it('a long phase detail does not change the pane height', async () => {
		// The detail band is a fixed budget, so a long sentence cannot push the
		// phase list or the hint line to another row.
		const size = { cols: 60, rows: 30 }
		const short = agent({ viewId: 'short', phase: 'Verify', phaseDetail: 'Short note.' })
		const long = agent({
			viewId: 'long',
			phase: 'Verify',
			phaseDetail: `A ${'very '.repeat(60)}long detail that wraps many times over.`,
		})
		const rowsOf = async (member: SubagentActivity) => {
			const screen = await renderToScreen(
				<Box flexDirection="column" paddingX={1}>
					<AgentCockpit
						agents={[member]}
						selectedPhaseId={member.phaseId}
						selectedId={member.viewId}
						focus="phases"
						terminalRows={size.rows}
						terminalColumns={size.cols}
					/>
				</Box>,
				size,
			)
			mounted = screen
			const viewport = screen.viewport()
			const found = {
				phase: viewport.findIndex((line) => line.includes('Verify')),
				hint: viewport.findIndex((line) => line.includes('esc to go back')),
				detail: viewport.filter((line) => /very|Short note/.test(line)).length,
				text: viewport.join('\n'),
			}
			await screen.unmount()
			mounted = null
			return found
		}
		const shortRows = await rowsOf(short)
		const longRows = await rowsOf(long)
		expect(shortRows.text).toContain('Short note.')
		expect(longRows.text).toContain('very very very')
		expect(shortRows.phase).toBeGreaterThanOrEqual(0)
		expect(longRows.phase).toBe(shortRows.phase)
		expect(longRows.hint).toBe(shortRows.hint)
		expect(longRows.detail).toBeLessThanOrEqual(3)
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
			<Box flexDirection="column" paddingX={1}>
				<AgentCockpit
					agents={[research]}
					selectedPhaseId={research.phaseId}
					selectedId={research.viewId}
					focus="phases"
					terminalRows={14}
					terminalColumns={40}
				/>
			</Box>,
			{ cols: 40, rows: 14 },
		)
		mounted = screen
		const viewport = screen.viewport()
		const phaseRow = viewport.find((line) => line.includes('Research')) ?? ''
		expect(phaseRow).toMatch(/✔\s+Research\s+1\/1/)
		const footer = viewport.find((line) => line.includes('esc')) ?? ''
		expect(footer).toMatch(/esc[ a-z│]*$/)
		expect(viewport.join('\n')).not.toContain('Confirm the rollback plan')
	})

	it('marks a phase failed once it has settled with a failure or a stop', () => {
		const failed = agent({ viewId: 'failed', status: 'failed', completedAt: 2 })
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
			<Box flexDirection="column" paddingX={1}>
				<AgentCockpit
					agents={[failed, working, cancelled, completed]}
					selectedPhaseId={failed.phaseId}
					selectedId={failed.viewId}
					focus="phases"
					terminalRows={24}
					terminalColumns={120}
				/>
			</Box>,
		)
		try {
			// Still working: the phase keeps its number. Settled with a stop: ✘.
			expect(cockpit.lastFrame()).toMatch(/❯ 1\s+Agents\s+1\/2/)
			expect(cockpit.lastFrame()).toMatch(/✘\s+Agents\s+2\/2/)
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
			<Box flexDirection="column" paddingX={1}>
				<AgentCockpit
					agents={[silent]}
					selectedPhaseId={silent.phaseId}
					selectedId="silent"
					focus="agents"
					terminalRows={24}
					terminalColumns={100}
				/>
			</Box>,
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
		const rows = agentTranscriptRows(
			agent({ viewId: 'word-wrap', prompt: text, transcript: [] }),
			35,
		)
		expect(rows.map((row) => row.text).join('')).toBe(text)
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
		const first = agent({
			viewId: 'child-first',
			taskId: 'task-first',
			description: 'Choose first colour',
		})
		const second = agent({
			viewId: 'child-second',
			taskId: 'task-second',
			description: 'Join the two colours',
		})
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
		const screen = await renderToScreen(<App ctx={ctx} />, { cols: 100, rows: 30 })
		mounted = screen
		await waitUntil(screen, () => painted(screen).includes('model'), 'not ready')
		activity.set([done(first, 'FIRST_ANSWER'), second])
		await waitUntil(
			screen,
			() => painted(screen).includes('Agent "Choose first colour" finished'),
			'first row missing',
		)
		// Enough later rows that the first completion leaves the live region.
		for (const prompt of ['one', 'two', 'three', 'four']) {
			await submit(screen, prompt)
			await waitUntil(
				screen,
				() =>
					painted(screen).split('noted').length >
					['one', 'two', 'three', 'four'].indexOf(prompt) + 1,
				`reply to ${prompt} missing`,
			)
		}
		activity.set([done(first, 'FIRST_ANSWER'), done(second, 'SECOND_ANSWER')])
		await waitUntil(
			screen,
			() => painted(screen).includes('Agent "Join the two colours" finished'),
			'second row missing',
		)
		await screen.waitForRender()
		expect(screen.viewport().join('\n')).not.toContain('FIRST_ANSWER')
		// First press: the live answer opens in place.
		screen.press('\x0f')
		await waitUntil(
			screen,
			() => screen.viewport().join('\n').includes('SECOND_ANSWER'),
			'live answer not opened',
		)
		expect(screen.viewport().join('\n')).not.toContain('FIRST_ANSWER')
		// Second press: the settled one, in the viewer.
		screen.press('\x0f')
		await waitUntil(
			screen,
			() => screen.viewport().join('\n').includes('FIRST_ANSWER'),
			'settled answer never reachable',
		)
		expect(screen.viewport().join('\n')).toContain('Choose first colour')
		screen.press('\x1b')
		await waitUntil(
			screen,
			() => !screen.viewport().join('\n').includes('←→ outputs'),
			'viewer did not close',
		)
		// Closed, the live answer is folded again, and the next press reopens it.
		expect(screen.viewport().join('\n')).not.toContain('SECOND_ANSWER')
		screen.press('\x0f')
		await waitUntil(
			screen,
			() => screen.viewport().join('\n').includes('SECOND_ANSWER'),
			'live answer not reopened',
		)
	})

	it.each([true, false])(
		'shows all three outcomes, retaining wait evidence when inspection is unavailable (inspectable=%s)',
		async (inspectable) => {
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
					transcript: inspectable
						? [{ id: 'answer', kind: 'assistant' as const, text: 'full report from child' }]
						: [],
					status: 'completed' as const,
					completedAt: 30,
				}))
				activity.set(finished)
				finishWaits()
				await waitUntil(
					screen,
					() => painted(screen).includes('Agent "Package review" finished'),
					'unwaited child completion missing',
				)
				activity.set([...finished])
				await screen.waitForRender()
				const output = painted(screen)
				for (const child of children)
					expect(output.split(`Agent "${child.description}" finished`)).toHaveLength(2)
				if (inspectable) {
					expect(output).not.toContain('task_id:')
					expect(output).not.toContain('Agent result:')
					// The answer rides on the completion row, collapsed; Ctrl+O opens it.
					expect(output).not.toContain('full report from child')
					expect(output).toContain('ctrl+o to expand')
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
			} finally {
				finishWaits()
			}
		},
	)
})

describe('the rail while a review is open', () => {
	it('keeps the header line under the review and draws no agent rows', async () => {
		activity.set([
			agent({
				viewId: 'approved',
				description: 'Choose first colour',
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
			() => railRows(screen).length === 1,
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
		// while it is open, so the reduced row names neither and draws no agent.
		expect(during).toMatch(/● main\s+1 agent\b/u)
		expect(during).not.toContain('↓ to manage')
		expect(during).not.toContain('Choose first colour')
		screen.press('\x1b')
		await decided
		await waitUntil(
			screen,
			() => railRows(screen).length === 1,
			'full rail did not come back after the review',
		)
		expect(screen.viewport().join('\n')).toContain('↓ to manage')
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
	it('titles the cockpit header by the workflow label when the selected workflow carries one', async () => {
		const busy = agent({ viewId: 'solo', workflow: 'Release readiness' })
		const screen = await renderToScreen(
			<Box flexDirection="column" paddingX={1}>
				<AgentCockpit
					agents={[busy]}
					selectedPhaseId={busy.phaseId}
					selectedId={busy.viewId}
					focus="agents"
					terminalRows={24}
					terminalColumns={110}
				/>
			</Box>,
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
			<Box flexDirection="column" paddingX={1}>
				<AgentCockpit
					agents={[busy]}
					selectedPhaseId={busy.phaseId}
					selectedId={busy.viewId}
					focus="agents"
					terminalRows={24}
					terminalColumns={110}
				/>
			</Box>,
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
			<Box flexDirection="column" paddingX={1}>
				<AgentCockpit
					agents={[first, second]}
					selectedPhaseId={first.phaseId}
					selectedId={first.viewId}
					focus="workflows"
					terminalRows={24}
					terminalColumns={110}
				/>
			</Box>,
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
			<Box flexDirection="column" paddingX={1}>
				<AgentCockpit
					agents={[solo, groupLead, groupExtra]}
					selectedPhaseId={solo.phaseId}
					selectedId={solo.viewId}
					focus="workflows"
					terminalRows={24}
					terminalColumns={110}
				/>
			</Box>,
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
			<Box flexDirection="column" paddingX={1}>
				<AgentCockpit
					agents={[labelled, unlabelled]}
					selectedPhaseId={labelled.phaseId}
					selectedId={labelled.viewId}
					focus="workflows"
					terminalRows={24}
					terminalColumns={110}
				/>
			</Box>,
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
		const border = lowerRuleRow(viewport)
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

	it('puts the agent rail directly under the footer once agents are live, with a workflow row only for the agent that carries a label', async () => {
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
		expect(viewport[border + 1]).toContain('← 2 agents · ↓ to manage')
		// Under the footer, not the transcript/composer: one blank row, then the
		// `main` row, then one row per agent.
		expect((viewport[border + 2] ?? '').trim()).toBe('')
		const railTop = viewport[border + 3] ?? ''
		expect(railTop).toMatch(/^ *● main\b/u)
		const frame = screen.viewport().join('\n')
		// An explicit workflow label earns its own `◯` row after the agent rows;
		// the unlabelled default never names anything.
		expect(railRows(screen)).toHaveLength(1)
		expect(frame).toMatch(/^ *◯ Nightly regression sweep +▱+ +0\/1 · /mu)
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
		expect((viewport[border + 2] ?? '').trim()).toBe('')
		const railTop = viewport[border + 3] ?? ''
		expect(railTop.trimStart().charAt(0)).toBe('●')
	})
})

/** Rows of the agents rail on screen, `main` excluded. */
function railRows(screen: Screen): string[] {
	return screen
		.viewport()
		.filter((row) => /^(❯| ) [●◯] (?!main)\S/u.test(row) && !/[▰▱]/u.test(row))
}

describe('parent narration', () => {
	/** The message frame's bottom border row, the anchor every row below is read from. */
	function frameBottom(screen: Screen): number {
		const border = lowerRuleRow(screen.viewport())
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
		const top = rows.findIndex((row, index) => index > below && /^ *● main\b/u.test(row))
		expect(top, 'rail header not on screen').toBeGreaterThan(below)
		// The `main` row, then every agent row and the `↓ N more` line, if any.
		let bottom = top
		while (
			bottom + 1 < rows.length &&
			/^( *[❯ ] )?[●◯] \S|^ +↓ \d+ more$/u.test(rows[bottom + 1] ?? '')
		)
			bottom += 1
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
		const railTop = frameBottom(screen) + 3
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
		expect(viewport[border + 1]).toContain('← 2 agents · ↓ to manage')
		expect(viewport[border + 2]).toContain('map returned five lenses')
		expect(viewport[border + 3]).toContain('verifying the storage claim')
		expect((viewport[border + 4] ?? '').trim()).toBe('')
		expect((viewport[border + 5] ?? '').trimStart().charAt(0)).toBe('●')
		// The rail itself is untouched: same rows, same order, same count. An
		// agent row is never spent on commentary.
		expect(railBlock(screen)).toEqual(railRows)
		// Aligned with the rail's `main` label, past its pointer and bullet cells.
		const header = viewport[border + 5] ?? ''
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
		expect(viewport[border + 1]).toContain('← 2 agents · ↓ to manage')
		expect(viewport[border + 2]).toContain('map returned five lenses')
		expect(viewport[border + 3]).toContain('verifying the storage claim')
		expect((viewport[border + 4] ?? '').trim()).toBe('')
		expect((viewport[border + 5] ?? '').trimStart().charAt(0)).toBe('●')
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

describe('viewing an agent', () => {
	/** A host that takes messages for children, the way the real session does. */
	function allowMessages(
		kind: 'queued' | 'started' = 'queued',
	): ReturnType<typeof vi.fn<NonNullable<AgentSession['messageSubagent']>>> {
		const send = vi.fn<NonNullable<AgentSession['messageSubagent']>>(async () => ({
			kind,
			taskId: 'task',
			state: 'running',
			parentNotice: 'admitted',
		}))
		childMessageBridge.current = send
		return send
	}

	async function viewSecond(cols = 110, rows = 28, status: SubagentActivity['status'] = 'working') {
		activity.set([
			agent({ viewId: 'v1', agentId: 'count-words', description: 'Count words in a.txt' }),
			agent({
				viewId: 'v2',
				agentId: 'a-very-long-agent-name-here',
				description: 'List files',
				prompt: 'List the files please',
				status,
				...(status === 'working' ? {} : { completedAt: Date.now() }),
			}),
		])
		const screen = await renderToScreen(<App ctx={ctx} />, { cols, rows })
		mounted = screen
		await waitUntil(screen, () => painted(screen).includes('model'), 'not ready')
		screen.press('\x1b[B')
		await waitUntil(screen, () => screen.viewport().join('\n').includes('Enter to view'), 'no rail')
		screen.press('\x1b[B')
		await waitUntil(
			screen,
			() => /^ *❯ ◯ a-very-long-agent-name/mu.test(screen.viewport().join('\n')),
			'second row not selected',
		)
		screen.press('\r')
		await waitUntil(
			screen,
			() => screen.viewport().join('\n').includes('List the files please'),
			'the agent was not shown',
		)
		return screen
	}

	it('shows the agent on the main screen with the one composer live and addressed to it', async () => {
		allowMessages()
		const screen = await viewSecond()
		const frame = screen.viewport().join('\n')
		// Not a modal: no box, no header, no second composer.
		expect(frame).not.toContain('Subagent')
		expect(frame).not.toContain('┌')
		expect(frame).not.toContain('Message this child')
		// The prompt reads as a row of its own, the placeholder names the agent (20 cells and …).
		expect(frame).toMatch(/❯ List the files please/u)
		expect(frame).toContain('Message @a-very-long-agent-na…')
		// The viewed row carries the filled bullet and the hint is just the selection.
		expect(frame).toMatch(/^ *◯ main/mu)
		expect(frame).toMatch(/^ *● a-very-long-agent-name/mu)
	})

	it('sends what is typed to the agent and shows it at once as the person’s own row', async () => {
		const send = allowMessages()
		const screen = await viewSecond()
		screen.press('please also count lines')
		await screen.waitForRender()
		screen.press('\r')
		await waitUntil(screen, () => send.mock.calls.length === 1, 'the message did not go')
		expect(send).toHaveBeenCalledWith('v2', 'please also count lines', expect.any(Object))
	})

	// Reference: a built-in command is never the agent's. `/model` is refused,
	// the history commands ask first, the rest run against the conversation, and
	// other `/` text is for the agent (REA fns p3e and Ece).
	describe('slash commands typed in the view', () => {
		async function type(screen: Awaited<ReturnType<typeof viewSecond>>, line: string) {
			screen.press(line)
			await screen.waitForRender()
			screen.press('\r')
		}

		it('refuses /model with a plain notice, keeps the text and sends nothing', async () => {
			const send = allowMessages()
			const screen = await viewSecond()
			await type(screen, '/model')
			await waitUntil(
				screen,
				() =>
					screen
						.viewport()
						.join('\n')
						.includes("/model changes the main conversation's model, not this agent's"),
				'no notice',
			)
			expect(send).not.toHaveBeenCalled()
		})

		it('asks before /compact and sends nothing to the agent', async () => {
			const send = allowMessages()
			const screen = await viewSecond()
			await type(screen, '/compact')
			await waitUntil(
				screen,
				() =>
					screen
						.viewport()
						.join('\n')
						.includes('/compact acts on the main conversation, not this agent'),
				'no question',
			)
			const frame = screen.viewport().join('\n')
			expect(frame).toContain('Cancel')
			expect(frame).toContain('Run /compact on the main conversation')
			// Cancel is the row the question opens on.
			screen.press('\r')
			await waitUntil(
				screen,
				() => !screen.viewport().join('\n').includes('acts on the main conversation'),
				'the question stayed open',
			)
			expect(send).not.toHaveBeenCalled()
		})

		it('runs the history command against the conversation once it is confirmed', async () => {
			const send = allowMessages()
			const screen = await viewSecond()
			await type(screen, '/new')
			await waitUntil(
				screen,
				() => screen.viewport().join('\n').includes('/new acts on the main conversation'),
				'no question',
			)
			screen.press('\x1b[B')
			await screen.waitForRender()
			screen.press('\r')
			await waitUntil(
				screen,
				() => !screen.viewport().join('\n').includes('acts on the main conversation'),
				'the question stayed open',
			)
			await screen.waitForRender()
			expect(send).not.toHaveBeenCalled()
			// The confirmed line was the command, not text left in the composer.
			expect(screen.viewport().join('\n')).not.toMatch(/❯ \/new/u)
		})

		it('runs another built-in against the conversation, not the agent', async () => {
			const send = allowMessages()
			const screen = await viewSecond()
			await type(screen, '/help')
			await waitUntil(
				screen,
				() => screen.viewport().join('\n').includes('Choose a command'),
				'help did not run',
			)
			expect(send).not.toHaveBeenCalled()
		})

		it('sends other slash text to the agent as typed', async () => {
			const send = allowMessages()
			const screen = await viewSecond()
			await type(screen, '/no-such-skill please')
			await waitUntil(screen, () => send.mock.calls.length === 1, 'the line did not go')
			expect(send).toHaveBeenCalledWith('v2', '/no-such-skill please', expect.any(Object))
		})
	})

	it('says plainly when the message cannot go, and keeps the text', async () => {
		const send = allowMessages()
		send.mockRejectedValueOnce(new Error('Agent was stopped, so it cannot take a message.'))
		const screen = await viewSecond()
		screen.press('hello again')
		await screen.waitForRender()
		screen.press('\r')
		await waitUntil(
			screen,
			() => screen.viewport().join('\n').includes('cannot take a message'),
			'no refusal shown',
		)
		expect(screen.viewport().join('\n')).toContain('hello again')
	})

	// Reference: Esc on a running agent stops it and does not leave the view;
	// on one that has ended it leaves the view (REA fn Y_e, chunk-2rs9vjmc.js).
	it('stops a running agent with Esc and stays in its view', async () => {
		allowMessages()
		stoppedChildren.length = 0
		const screen = await viewSecond()
		screen.press('\x1b[27u')
		await waitUntil(screen, () => stoppedChildren.length === 1, 'Esc did not stop the agent')
		expect(stoppedChildren).toEqual(['v2'])
		await screen.waitForRender()
		// Still the agent's view: its prompt row and the filled bullet on its rail row.
		expect(screen.viewport().join('\n')).toMatch(/❯ List the files please/u)
		expect(screen.viewport().join('\n')).toMatch(/^ *● a-very-long-agent-name/mu)
	})

	it('goes back to the conversation with Esc once the agent has ended, and stops nothing', async () => {
		allowMessages()
		stoppedChildren.length = 0
		const screen = await viewSecond(110, 28, 'completed')
		screen.press('\x1b[27u')
		await waitUntil(
			screen,
			() => /^ *● main/mu.test(screen.viewport().join('\n')),
			'Esc did not go back to the conversation',
		)
		expect(screen.viewport().join('\n')).not.toContain('Message @')
		expect(stoppedChildren).toEqual([])
	})

	// Reference: Ctrl+C stops a running agent and always leaves the view (REA fn ese).
	it('stops a running agent with Ctrl+C and goes back to the conversation', async () => {
		allowMessages()
		stoppedChildren.length = 0
		const screen = await viewSecond()
		screen.press('\x03')
		await waitUntil(
			screen,
			() => /^ *● main/mu.test(screen.viewport().join('\n')),
			'Ctrl+C did not go back to the conversation',
		)
		expect(stoppedChildren).toEqual(['v2'])
	})

	it('goes back with Ctrl+C from an ended agent without stopping anything', async () => {
		allowMessages()
		stoppedChildren.length = 0
		const screen = await viewSecond(110, 28, 'failed')
		screen.press('\x03')
		await waitUntil(
			screen,
			() => /^ *● main/mu.test(screen.viewport().join('\n')),
			'Ctrl+C did not go back to the conversation',
		)
		expect(stoppedChildren).toEqual([])
	})

	it('goes back with Enter on the main row of the rail', async () => {
		allowMessages()
		const screen = await viewSecond()
		screen.press('\x1b[B')
		await waitUntil(
			screen,
			() => screen.viewport().join('\n').includes('↑/↓ to select'),
			'rail not focused from the view',
		)
		screen.press('\x1b[A')
		screen.press('\x1b[A')
		await waitUntil(
			screen,
			() => /^ *❯ ◯ main/mu.test(screen.viewport().join('\n')),
			'main row not selected',
		)
		screen.press('\r')
		await waitUntil(
			screen,
			() => /^ *● main/mu.test(screen.viewport().join('\n')),
			'Enter on main did not go back',
		)
	})

	it('shows N queued in the warning colour on the row of an agent with messages waiting', async () => {
		activity.set([agent({ viewId: 'q1', agentId: 'busy', description: 'Busy one', queued: 2 })])
		const screen = await renderToScreen(<App ctx={ctx} />, { cols: 110, rows: 28 })
		mounted = screen
		await waitUntil(screen, () => painted(screen).includes('model'), 'not ready')
		await waitUntil(
			screen,
			() => /◯ busy\s+Busy one\s+\S+ · 2 queued/u.test(screen.viewport().join('\n')),
			'no queued count',
		)
	})
})
