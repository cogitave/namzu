import type { Message } from '@namzu/sdk'
import { render } from 'ink-testing-library'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Preferences } from '../../integrations/providers/index.js'
import type { SubagentActivity } from '../../integrations/subagents/activity.js'
import {
	AgentCockpit,
	AgentTranscript,
	agentPhases,
	agentTranscriptPage,
	agentTranscriptRows,
	maxAgentTranscriptTailOffset,
} from '../AgentExplorer.js'
import type { AgentEvent, AgentSession } from '../agent.js'
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
	return {
		source: {
			getSnapshot: () => snapshot,
			subscribe: (listener: () => void) => {
				listeners.add(listener)
				return () => listeners.delete(listener)
			},
			reset: () => {
				snapshot = []
				for (const listener of listeners) listener()
			},
		},
		set: (next: readonly unknown[]) => {
			snapshot = next
			for (const listener of listeners) listener()
		},
	}
})

let releaseParent: () => void = () => {}
let parentGate = Promise.resolve()

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

async function waitUntil(screen: Screen, predicate: () => boolean, message: string): Promise<void> {
	for (let attempt = 0; attempt < 120; attempt += 1) {
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
	activity.set([])
	parentGate = new Promise<void>((resolve) => {
		releaseParent = resolve
	})
})

afterEach(async () => {
	releaseParent()
	await mounted?.unmount()
	mounted = null
})

describe('/agent', () => {
	it('opens live delegated work with ctrl+t while the parent remains active', async () => {
		activity.set([
			agent({ viewId: 'agent-alpha', description: 'Alpha audit' }),
			agent({ viewId: 'agent-beta', description: 'Beta build' }),
		])
		const screen = await renderToScreen(<App ctx={ctx} />, { cols: 110, rows: 28 })
		mounted = screen
		await waitUntil(screen, () => painted(screen).includes('Connected to provider'), 'not ready')

		await submit(screen, 'start parent')
		await waitUntil(
			screen,
			() => screen.viewport().join('\n').includes('ctrl+t to view'),
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
					{ id: 'critic-evidence', kind: 'assistant', text: 'verification evidence' },
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
		const screen = await renderToScreen(<App ctx={ctx} />, { cols: 110, rows: 28 })
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
		const screen = await renderToScreen(<App ctx={ctx} />, { cols: 110, rows: 28 })
		mounted = screen
		await waitUntil(screen, () => painted(screen).includes('Connected to provider'), 'not ready')
		await submit(screen, '/agent')
		await waitUntil(screen, () => screen.viewport().join('\n').includes('Beta pruned'), 'cockpit missing')
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

	it('freezes parent scrollback while observing and publishes it once on return', async () => {
		activity.set([
			agent({
				viewId: 'agent-child',
				description: 'Child run',
				transcript: [{ id: 'child-row', kind: 'assistant', text: 'child is working' }],
			}),
		])
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
		await waitUntil(
			screen,
			() => screen.viewport().join('\n').includes('Child run'),
			'child screen disappeared',
		)
		expect(painted(screen)).not.toContain('parent finished')

		screen.press('q')
		await waitUntil(
			screen,
			() => painted(screen).includes('parent finished'),
			'parent result missing',
		)
		expect(painted(screen).match(/parent finished/g)).toHaveLength(1)
	})
})

describe('agent explorer projection', () => {
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
