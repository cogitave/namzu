/**
 * The `workflow` tool, as the person meets it in the real App: the launch row,
 * the rail row, the detail view and its keys, the closing line when the run
 * ends (not when a turn does), the model's one message about it, and
 * `/workflows`. The session is a fixture; the runs it publishes are the
 * registry's own shape.
 */

import { render } from 'ink-testing-library'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Preferences } from '../../integrations/providers/index.js'
import {
	type WorkflowAgentView,
	type WorkflowRunView,
	initialRunView,
} from '../../integrations/workflows/view.js'
import { genericPresenter } from '../__fixtures__/generic-presenter.js'
import type { AgentEvent, AgentSession, SessionScope } from '../agent.js'
import type { TuiContext } from '../types.js'
import { type Screen, renderToScreen } from './support/screen.js'

void render

const PREFS: Preferences = {
	version: 3,
	providers: [{ id: 'openai' }],
	subagents: { active: [] },
}

const NOW = Date.now()

const flows = vi.hoisted(() => {
	let runs: readonly unknown[] = []
	let history: readonly unknown[] = []
	const subscribers = new Set<() => void>()
	const endListeners = new Set<(end: { view: unknown }) => void>()
	const recovered: {
		runId: string
		runIds: string[]
		name: string
		text: string
		line: string
	}[] = []
	const delivered: string[][] = []
	const calls = {
		stop: [] as string[],
		skip: [] as [string, number][],
		reset: 0,
	}
	return {
		calls,
		recovered,
		delivered,
		source: {
			runs: () => runs,
			subscribe: (listener: () => void) => {
				subscribers.add(listener)
				return () => subscribers.delete(listener)
			},
			stop: (runId: string) => {
				calls.stop.push(runId)
				return true
			},
			skipAgent: (runId: string, index: number) => {
				calls.skip.push([runId, index])
				return true
			},
			agentOf: () => undefined,
			history: async () => history,
			readScript: () => undefined,
			describeResume: () => ({
				runId: '',
				pass: 1,
				previousFinish: 'unfinished' as const,
				resumable: false,
				legacy: false,
				saved: 0,
				unfinished: 0,
				failed: 0,
				problems: [],
			}),
			recoverUnfinished: async () => [...recovered],
			noticesDelivered: async (ids: readonly string[]) => {
				delivered.push([...ids])
			},
			onEnd: (listener: (end: { view: unknown }) => void) => {
				endListeners.add(listener)
				return () => endListeners.delete(listener)
			},
			reset: () => {
				calls.reset += 1
			},
		},
		set(next: readonly unknown[]) {
			runs = next
			for (const listener of [...subscribers]) listener()
		},
		setHistory(next: readonly unknown[]) {
			history = next
		},
		end(view: unknown) {
			for (const listener of [...endListeners]) listener({ view })
		},
		reset() {
			runs = []
			history = []
			calls.stop.length = 0
			calls.skip.length = 0
			calls.reset = 0
			recovered.length = 0
			delivered.length = 0
		},
	}
})

const monitor = vi.hoisted(() => ({
	getSnapshot: () => [] as readonly unknown[],
	getNarration: () => [] as readonly unknown[],
	subscribe: () => () => {},
	reset: () => {},
}))

const sendOverride: {
	current?: (
		messages: readonly import('@namzu/sdk').Message[],
		opts?: Parameters<AgentSession['send']>[1],
	) => AsyncIterable<AgentEvent>
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
			_options?: { scope?: SessionScope },
		): Promise<AgentSession> => ({
			hasProvider: true,
			sandbox: { unconfined: true, enforced: [], required: [] },
			providerSummary: 'provider',
			modelSummary: 'model',
			reasoningEffortLevels: [],
			toolNames: () => ['workflow'],
			presenter: genericPresenter,
			errorHint: null,
			errorKind: null,
			instructionFiles: [],
			skippedInstructionFiles: [],
			mcpConnected: [],
			mcpFailed: [],
			agentIds: ['general-purpose'],
			subagents: monitor as AgentSession['subagents'],
			workflows: flows.source as unknown as AgentSession['workflows'],
			configNotices: [],
			promptExemptTools: () => [],
			compact: async () => null,
			resumeDurable: async () => {
				throw new Error('not used')
			},
			resumePaused: () => {
				throw new Error('not used')
			},
			close: async () => {},
			send: async function* (messages, opts): AsyncIterable<AgentEvent> {
				if (sendOverride.current) {
					yield* sendOverride.current(messages, opts)
					return
				}
				yield { kind: 'delta', text: 'ok\n\n' }
				yield { kind: 'done', stopReason: 'end_turn' }
			},
		}),
	}
})

const { App } = await import('../App.js')
const ctx: TuiContext = { cwd: '/w', version: '0.0.0-test' }
let mounted: Screen | null = null

/** No wall-clock deadline: a condition that never arrives is the test's own timeout. */
async function waitUntil(screen: Screen, predicate: () => boolean): Promise<void> {
	for (;;) {
		await screen.waitForRender()
		if (predicate()) return
		await new Promise<void>((resolve) => setImmediate(resolve))
	}
}

const text = (screen: Screen) => screen.viewport().join('\n')
const everything = (screen: Screen) => screen.scrollback().join('\n')

function agentView(
	index: number,
	status: WorkflowAgentView['status'],
	extra: Partial<WorkflowAgentView> = {},
): WorkflowAgentView {
	return {
		index,
		label: `agent:${index}`,
		queuedAt: NOW - 20_000,
		tokens: 0,
		toolCalls: 0,
		status,
		...(status === 'running' || status === 'done' ? { startedAt: NOW - 15_000 } : {}),
		...(status === 'done' ? { finishedAt: NOW - 5_000 } : {}),
		...extra,
	}
}

function run(
	overrides: Partial<WorkflowRunView> & {
		readonly runId?: string
		readonly name?: string
	} = {},
): WorkflowRunView {
	const { runId = 'wrun00001', name = 'audit', ...rest } = overrides
	return {
		...initialRunView({
			runId,
			name,
			description: 'Scan, then fix',
			phases: [{ title: 'Scan' }, { title: 'Fix' }, { title: 'Report' }],
			at: NOW - 20_000,
		}),
		agents: [
			agentView(1, 'done', { phaseIndex: 1, phaseTitle: 'Scan', tokens: 1200 }),
			agentView(2, 'running', {
				phaseIndex: 1,
				phaseTitle: 'Scan',
				tokens: 300,
			}),
			agentView(3, 'queued', { phaseIndex: 2, phaseTitle: 'Fix' }),
		],
		...rest,
	}
}

beforeEach(() => {
	flows.reset()
	sendOverride.current = undefined
})

afterEach(async () => {
	await mounted?.unmount()
	mounted = null
	vi.restoreAllMocks()
})

async function start(opts: { cols?: number; rows?: number } = {}): Promise<Screen> {
	const screen = await renderToScreen(<App ctx={ctx} />, {
		cols: opts.cols ?? 110,
		rows: opts.rows ?? 30,
	})
	mounted = screen
	await waitUntil(screen, () => everything(screen).includes('model'))
	return screen
}

describe('the rail and the detail view of a run', () => {
	it('draws one row for the run, queued agents counted, and no agent rows', async () => {
		flows.set([run()])
		const screen = await start()
		await waitUntil(screen, () => /◯ audit +▰+▱+ +1\/3 · \d+s · ↓ 1\.5k tokens/.test(text(screen)))
		expect(text(screen)).not.toMatch(/main|agent:1|general-purpose/)
	})

	it('opens on the phases with enter, a phase nothing started in is "Not started yet"', async () => {
		flows.set([run()])
		const screen = await start()
		screen.press('\x1b[B')
		await waitUntil(screen, () => text(screen).includes('enter to view · x to stop'))
		screen.press('\r')
		await waitUntil(screen, () => text(screen).includes('Phases'))
		expect(text(screen)).toMatch(/❯ 1\s+Scan\s+1\/2/)
		expect(text(screen)).toMatch(/3\s+Report/)
		// Down to the unstarted phase, then into it.
		screen.press('\x1b[B')
		screen.press('\x1b[B')
		await waitUntil(screen, () => /❯ 3\s+Report/.test(text(screen)))
		screen.press('\r')
		await waitUntil(screen, () => text(screen).includes('Report · 0 agents'))
		expect(text(screen)).toContain('Not started yet')
	})

	it('x on the phases stops the whole run; x on an agent skips that agent only', async () => {
		flows.set([run()])
		const screen = await start()
		screen.press('\x1b[B')
		await waitUntil(screen, () => text(screen).includes('enter to view'))
		screen.press('\r')
		await waitUntil(screen, () => text(screen).includes('Phases'))
		screen.press('x')
		await waitUntil(screen, () => flows.calls.stop.length === 1)
		expect(flows.calls.stop).toEqual(['wrun00001'])
		expect(flows.calls.skip).toEqual([])
		screen.press('\r')
		await waitUntil(screen, () => text(screen).includes('Scan · 2 agents'))
		// The first agent is done: nothing to skip. Down to the running one.
		screen.press('\x1b[B')
		await waitUntil(screen, () => /❯ ● agent:2/.test(text(screen)))
		expect(text(screen)).toContain('x skip')
		screen.press('x')
		await waitUntil(screen, () => flows.calls.skip.length === 1)
		expect(flows.calls.skip).toEqual([['wrun00001', 2]])
		expect(flows.calls.stop).toEqual(['wrun00001'])
	})

	it('x on the rail row stops the run', async () => {
		flows.set([run()])
		const screen = await start()
		screen.press('\x1b[B')
		await waitUntil(screen, () => text(screen).includes('x to stop'))
		screen.press('x')
		await waitUntil(screen, () => flows.calls.stop.length === 1)
		expect(flows.calls.stop).toEqual(['wrun00001'])
	})

	it('opens a run that has no agent yet, on its declared phases', async () => {
		flows.set([run({ agents: [] })])
		const screen = await start()
		screen.press('\x1b[B')
		await waitUntil(screen, () => text(screen).includes('enter to view'))
		screen.press('\r')
		await waitUntil(screen, () => text(screen).includes('Phases'))
		expect(text(screen)).toMatch(/1\s+Scan/)
		expect(text(screen)).toMatch(/3\s+Report/)
		expect(text(screen)).toContain('0/0 agents')
	})
})

describe('the keyboard on the rail row', () => {
	it('hands a "/" to the input box, so a command can be typed from the row', async () => {
		flows.set([run()])
		const screen = await start()
		screen.press('\x1b[B')
		await waitUntil(screen, () => text(screen).includes('enter to view · x to stop'))
		screen.press('/')
		await waitUntil(screen, () => /❯ \//.test(text(screen)))
		// The row gave the keyboard up: its key line is gone and the rest is typed in the box.
		expect(text(screen)).not.toContain('enter to view · x to stop')
		screen.press('w')
		screen.press('o')
		await waitUntil(screen, () => /❯ \/wo/.test(text(screen)))
	})

	it('hands any printable character over, and keeps the keys the row owns', async () => {
		flows.set([run()])
		const screen = await start()
		screen.press('\x1b[B')
		await waitUntil(screen, () => text(screen).includes('x to stop'))
		screen.press('q')
		await waitUntil(screen, () => /❯ q/.test(text(screen)))
		expect(flows.calls.stop).toEqual([])
		// `x` is the row's own: it stops the run and types nothing.
		screen.press('\x7f')
		await waitUntil(screen, () => !/❯ q/.test(text(screen)))
		screen.press('\x1b[B')
		await waitUntil(screen, () => text(screen).includes('x to stop'))
		screen.press('x')
		await waitUntil(screen, () => flows.calls.stop.length === 1)
		expect(text(screen)).not.toMatch(/❯ x/)
	})

	it('leaves the keyboard with the input box when a run ends while the row is not focused', async () => {
		flows.set([run()])
		const screen = await start()
		await waitUntil(screen, () => /◯ audit/.test(text(screen)))
		flows.set([run({ status: 'completed', endedAt: Date.now() })])
		await waitUntil(screen, () => /8\/3|1\/3/.test(text(screen)))
		expect(text(screen)).not.toContain('enter to view')
		screen.press('/')
		await waitUntil(screen, () => /❯ \//.test(text(screen)))
	})
})

describe('a run that asks for more agents than the guideline', () => {
	const many = (count: number) =>
		run({
			agents: Array.from({ length: count }, (_, i) =>
				agentView(i + 1, 'running', { phaseIndex: 1, phaseTitle: 'Scan' }),
			),
		})

	it('says "Large workflow" on its row and tells the conversation once how to stop it', async () => {
		flows.set([many(11)])
		const screen = await start({ cols: 130 })
		await waitUntil(screen, () => /◯ audit .*Large workflow/.test(text(screen)))
		await waitUntil(screen, () => everything(screen).includes('has asked for 11 agents'))
		const told = () => everything(screen).match(/has asked for \d+ agents/g)?.length ?? 0
		// The line wraps in a terminal of this width: read it with the breaks closed up.
		const flat = everything(screen).replace(/\s+/g, ' ')
		expect(flat).toContain(
			'Workflow audit has asked for 11 agents, more than the 10 this session advises. It keeps running; press ↓ then x on its row, or open /workflows, to stop it.',
		)
		// More agents and more renders: still the one notice, and nothing stopped.
		flows.set([many(14)])
		await waitUntil(screen, () => /0\/14/.test(text(screen)))
		expect(told()).toBe(1)
		expect(flows.calls.stop).toEqual([])
	})

	it('stays quiet at the guideline itself', async () => {
		flows.set([many(10)])
		const screen = await start({ cols: 130 })
		await waitUntil(screen, () => /◯ audit/.test(text(screen)))
		expect(text(screen)).not.toContain('Large workflow')
		expect(everything(screen)).not.toContain('has asked for')
	})

	it('names the phases that are running now beside the counter when there is room', async () => {
		flows.set([run()])
		const screen = await start({ cols: 130 })
		await waitUntil(screen, () =>
			/◯ audit .*1\/3 · \d+s · ↓ 1\.5k tokens · Scan/.test(text(screen)),
		)
	})
})

describe('the conversation', () => {
	it('shows the launch row and where to manage it, never what the model was told', async () => {
		sendOverride.current = async function* () {
			yield {
				kind: 'tool-start',
				toolUseId: 'call-1',
				toolName: 'workflow',
				summary: 'Workflow(Scan, then fix)',
				standalone: true,
			}
			yield {
				kind: 'tool-end',
				toolUseId: 'call-1',
				toolName: 'workflow',
				isError: false,
				summary: 'Workflow "audit" started in the background as wrun00001.',
				output:
					'Workflow "audit" started in the background as wrun00001.\nIts agents are running now.',
			}
			yield { kind: 'done', stopReason: 'end_turn' }
		}
		const screen = await start()
		screen.press('use a workflow')
		await screen.waitForRender()
		screen.press('\r')
		await waitUntil(screen, () => everything(screen).includes('Running in the background'))
		const all = everything(screen)
		expect(all).toMatch(/● Workflow\(Scan, then fix\)/)
		expect(all).toMatch(/⎿ {2}Running in the background \(↓ to manage\)/)
		expect(all).not.toContain('wrun00001')
		expect(all).not.toContain('started in the background as')
	})

	it('shows a script that failed before any agent as a failed call, with no launch row', async () => {
		sendOverride.current = async function* () {
			yield {
				kind: 'tool-start',
				toolUseId: 'call-1',
				toolName: 'workflow',
				summary: 'Workflow(Scan, then fix)',
				standalone: true,
			}
			yield {
				kind: 'tool-end',
				toolUseId: 'call-1',
				toolName: 'workflow',
				isError: true,
				summary: 'TypeError: cannot read property map of undefined',
				output: 'TypeError: cannot read property map of undefined\nNo agent had started.',
			}
			yield { kind: 'done', stopReason: 'end_turn' }
		}
		const screen = await start()
		screen.press('use a workflow')
		await screen.waitForRender()
		screen.press('\r')
		await waitUntil(screen, () => everything(screen).includes('cannot read property map'))
		const all = everything(screen)
		expect(all).not.toContain('Running in the background')
		expect(text(screen)).not.toContain('0/0')
	})

	it('shows a run that finished without any agent as a plain finished call, not a background run', async () => {
		sendOverride.current = async function* () {
			yield {
				kind: 'tool-start',
				toolUseId: 'call-1',
				toolName: 'workflow',
				summary: 'Workflow(Add up)',
				standalone: true,
			}
			yield {
				kind: 'tool-end',
				toolUseId: 'call-1',
				toolName: 'workflow',
				isError: false,
				summary: 'Workflow "sum" (wrun00002) completed.',
				output: 'Workflow "sum" (wrun00002) completed.\n<result>42</result>',
			}
			yield { kind: 'done', stopReason: 'end_turn' }
		}
		const screen = await start()
		screen.press('use a workflow')
		await screen.waitForRender()
		screen.press('\r')
		await waitUntil(screen, () => everything(screen).includes('completed'))
		expect(everything(screen)).not.toContain('Running in the background')
	})

	it('writes the closing line when the run ends, with no turn running', async () => {
		flows.set([run()])
		const screen = await start()
		const ended = run({
			status: 'completed',
			endedAt: NOW,
			agents: run().agents.map((a) => ({ ...a, status: 'done' as const })),
		})
		flows.set([ended])
		flows.end(ended)
		await waitUntil(screen, () =>
			/● Workflow audit finished · 20s · 3 agents · 1\.5k tokens/.test(everything(screen)),
		)
	})

	it('says a stopped run was stopped and a failed one failed', async () => {
		const screen = await start()
		flows.end(run({ status: 'stopped', endedAt: NOW }))
		await waitUntil(screen, () => /● Workflow audit stopped/.test(everything(screen)))
		flows.end(run({ name: 'build', status: 'failed', endedAt: NOW, error: 'it threw' }))
		await waitUntil(screen, () => /● Workflow build failed/.test(everything(screen)))
	})

	it('does not write a launch receipt or a completion row for the run`s agents', async () => {
		flows.set([run()])
		const screen = await start()
		await waitUntil(screen, () => text(screen).includes('◯ audit'))
		expect(everything(screen)).not.toMatch(/Launched|Workflow audit\n/)
	})
})

describe('runs a previous session left unfinished', () => {
	it('names the run to the person, does not wake the model, and tells it once with the next turn', async () => {
		flows.recovered.push({
			runId: 'wold00001',
			runIds: ['wold00001'],
			name: 'nightly',
			text: 'Background workflow "nightly" (run wold00001) didn\'t finish before the previous session ended.',
			line: "nightly didn't finish before the last session ended. /workflows to see it or resume it.",
		})
		const turns: { text: string; hostContext: readonly string[] }[] = []
		sendOverride.current = async function* (messages, opts) {
			turns.push({
				text: String(messages.at(-1)?.content),
				hostContext: opts?.hostContext?.() ?? [],
			})
			yield { kind: 'done', stopReason: 'end_turn' }
		}
		const screen = await start()
		await waitUntil(screen, () => everything(screen).includes("nightly didn't finish"))
		// Nobody typed: no turn, and nothing was marked delivered yet.
		await screen.waitForRender()
		expect(turns).toHaveLength(0)
		expect(flows.delivered).toEqual([])
		screen.press('hello')
		await screen.waitForRender()
		screen.press('\r')
		await waitUntil(screen, () => turns.length === 1)
		const told = `${turns[0]?.text}\n${turns[0]?.hostContext.join('\n')}`
		expect(told).toContain('run wold00001')
		await waitUntil(screen, () => flows.delivered.length > 0)
		expect(flows.delivered.flat()).toEqual(['wold00001'])
	})
})

describe('what the model is told when a run ends', () => {
	it('wakes an idle session: the model gets a turn that carries it, with no typing', async () => {
		const turns: {
			text: string
			source: unknown
			hostContext: readonly string[]
		}[] = []
		sendOverride.current = async function* (messages, opts) {
			const last = messages.at(-1)
			turns.push({
				text: String(last?.content),
				source: (last as { source?: unknown } | undefined)?.source,
				hostContext: opts?.hostContext?.() ?? [],
			})
			yield { kind: 'delta', text: 'The audit is done.\n\n' }
			yield { kind: 'done', stopReason: 'end_turn' }
		}
		const screen = await start()
		flows.end(run({ status: 'completed', endedAt: NOW, result: { fixed: 3 } }))
		await waitUntil(screen, () => everything(screen).includes('The audit is done.'))
		expect(turns).toHaveLength(1)
		expect(turns[0]?.text).toContain('Workflow "audit" (wrun00001) completed.')
		expect(turns[0]?.text).toContain('"fixed": 3')
		expect(turns[0]?.source).toEqual({
			type: 'runtime-context',
			kind: 'task-completion',
		})
		// The same message is not also handed over as context.
		expect(turns[0]?.hostContext.join('\n')).not.toContain('Workflows that ended')
		// The person typed nothing, and no user row was invented for it.
		expect(everything(screen)).not.toMatch(/❯ .*Workflow "audit"/)
		// Told once: the next thing the person types does not repeat it.
		turns.length = 0
		await waitUntil(screen, () => text(screen).includes('Type a message'))
		screen.press('thanks')
		await screen.waitForRender()
		screen.press('\r')
		await waitUntil(screen, () => turns.length === 1)
		expect(turns[0]?.text).toBe('thanks')
		expect(turns[0]?.hostContext.join('\n')).not.toContain('Workflows that ended')
	})

	it('tells two runs that ended together in one turn', async () => {
		const turns: string[] = []
		sendOverride.current = async function* (messages) {
			turns.push(String(messages.at(-1)?.content))
			yield { kind: 'done', stopReason: 'end_turn' }
		}
		const screen = await start()
		flows.end(run({ status: 'completed', endedAt: NOW }))
		flows.end(
			run({
				runId: 'wrun00002',
				name: 'build',
				status: 'failed',
				endedAt: NOW,
				error: 'it threw',
			}),
		)
		await waitUntil(screen, () => turns.length >= 1)
		await waitUntil(screen, () => text(screen).includes('Type a message'))
		const joined = turns.join('\n')
		expect(joined).toContain('Workflow "audit" (wrun00001) completed.')
		expect(joined).toContain('Workflow "build" (wrun00002) failed: it threw')
	})

	it('hands it to a turn that is already running, as the turn asks for input', async () => {
		const screen = await start()
		let releaseTurn!: () => void
		const held = new Promise<void>((resolve) => {
			releaseTurn = resolve
		})
		let delivered: readonly import('@namzu/sdk').Message[] = []
		sendOverride.current = async function* (_messages, opts) {
			await held
			delivered = opts?.inboundMessages?.() ?? []
			yield { kind: 'done', stopReason: 'end_turn' }
		}
		screen.press('long work')
		await screen.waitForRender()
		screen.press('\r')
		await waitUntil(screen, () => everything(screen).includes('long work'))
		flows.end(run({ status: 'completed', endedAt: NOW }))
		await waitUntil(screen, () => everything(screen).includes('Workflow audit finished'))
		releaseTurn()
		await waitUntil(screen, () => delivered.length > 0)
		expect(String(delivered[0]?.content)).toContain('Workflow "audit" (wrun00001) completed.')
		expect(delivered).toHaveLength(1)
	})
})

describe('/workflows', () => {
	it('says so when there is nothing to list', async () => {
		const screen = await start()
		screen.press('/workflows')
		await screen.waitForRender()
		screen.press('\r')
		await waitUntil(screen, () => everything(screen).includes('No workflows in this conversation'))
	})

	it('lists the runs, journaled ones too, and opens the detail of one', async () => {
		const old = run({
			runId: 'wold00001',
			name: 'nightly',
			status: 'completed',
			startedAt: NOW - 3_600_000,
			endedAt: NOW - 3_500_000,
			agents: [
				agentView(1, 'done', {
					phaseIndex: 1,
					phaseTitle: 'Scan',
					tokens: 900,
				}),
			],
		})
		flows.set([run()])
		flows.setHistory([run(), old])
		const screen = await start()
		screen.press('/workflows')
		await screen.waitForRender()
		screen.press('\r')
		await waitUntil(screen, () => text(screen).includes('Workflows'))
		expect(text(screen)).toMatch(/1\. audit\s+running · .*1\/3 agents/)
		expect(text(screen)).toMatch(/2\. nightly\s+finished · .*1 agent · 900 tokens · 1h ago/)
		screen.press('\x1b[B')
		await waitUntil(screen, () => /›2\. nightly/.test(text(screen)))
		screen.press('\r')
		await waitUntil(screen, () => text(screen).includes('nightly'))
		await waitUntil(screen, () => text(screen).includes('Phases'))
		// The detail carries its own key line: no footer row (the model name) above it.
		expect(screen.viewport().some((row) => /^\s*model\s*$/.test(row))).toBe(false)
		expect(text(screen)).toContain('1/1 agent')
		expect(text(screen)).toContain('· finished')
		expect(text(screen)).not.toContain('x to stop')
	})
})

describe('resuming from /workflows', () => {
	const old = (extra: Partial<WorkflowRunView> = {}) =>
		run({
			runId: 'wold00001',
			name: 'nightly',
			status: 'stopped',
			startedAt: NOW - 3_600_000,
			endedAt: NOW - 3_500_000,
			scriptPath: '/s/nightly-wold00001.js',
			agents: [agentView(1, 'done', { phaseIndex: 1, phaseTitle: 'Scan' })],
			...extra,
		})

	it('offers r on a run that is not going, and r asks the model to make the resume call', async () => {
		flows.setHistory([old()])
		const turns: string[] = []
		sendOverride.current = async function* (messages) {
			turns.push(String(messages.at(-1)?.content))
			yield { kind: 'done', stopReason: 'end_turn' }
		}
		const screen = await start()
		screen.press('/workflows')
		await screen.waitForRender()
		screen.press('\r')
		await waitUntil(screen, () => text(screen).includes('r to resume'))
		screen.press('r')
		await waitUntil(screen, () => turns.length === 1)
		expect(turns[0]).toContain('The person asked to resume workflow "nightly" (run wold00001)')
		expect(turns[0]).toContain(
			'workflow({scriptPath: "/s/nightly-wold00001.js", resumeFromRunId: "wold00001"})',
		)
		// It starts nothing itself: the registry never saw a run.
		expect(flows.calls.stop).toEqual([])
	})

	it('does not offer r on a run that is going or was saved before resuming existed', async () => {
		flows.setHistory([old({ resumable: 'legacy' })])
		const screen = await start()
		screen.press('/workflows')
		await screen.waitForRender()
		screen.press('\r')
		await waitUntil(screen, () => text(screen).includes('enter to view'))
		expect(text(screen)).not.toContain('r to resume')
	})
})

describe('a finished run with a failed agent in the list', () => {
	it('counts the agents that finished over all of them and leaves the failure to the status word', async () => {
		const flaky = run({
			runId: 'wflaky001',
			name: 'flaky',
			status: 'failed',
			startedAt: NOW - 3_600_000,
			endedAt: NOW - 3_500_000,
			agents: [
				agentView(1, 'done', { phaseIndex: 1, phaseTitle: 'Scan' }),
				agentView(2, 'failed', {
					phaseIndex: 1,
					phaseTitle: 'Scan',
					finishedAt: NOW - 3_500_000,
				}),
				agentView(3, 'done', { phaseIndex: 1, phaseTitle: 'Scan' }),
			],
		})
		flows.set([])
		flows.setHistory([flaky])
		const screen = await start()
		screen.press('/workflows')
		await screen.waitForRender()
		screen.press('\r')
		await waitUntil(screen, () => text(screen).includes('Workflows'))
		expect(text(screen)).toMatch(/1\. flaky\s+failed · .*2\/3 agents/)
		expect(text(screen)).not.toContain('1 failed')
	})
})

describe('a slash command is shown as typed', () => {
	it('echoes the command, with its answer hung under it', async () => {
		const screen = await start()
		screen.press('/cost')
		await screen.waitForRender()
		screen.press('\r')
		await waitUntil(screen, () => everything(screen).includes('No usage reported yet'))
		expect(everything(screen)).toMatch(/› \/cost\n+\s*⎿ {2}No usage reported yet/)
	})

	it('has no /workflow command: it is answered as an unknown command and nothing is sent', async () => {
		const sent: string[] = []
		sendOverride.current = async function* (messages) {
			sent.push(String(messages.at(-1)?.content))
			yield { kind: 'done', stopReason: 'end_turn' }
		}
		const screen = await start()
		screen.press('/workflow audit the repo')
		await screen.waitForRender()
		screen.press('\r')
		await waitUntil(screen, () => everything(screen).includes('Unknown command: /workflow'))
		expect(sent).toEqual([])
	})
})

describe('a workflow agent that asks after the turn is over', () => {
	it('reaches the person, under the mode they have now, and a No is answered as one', async () => {
		let review: Parameters<AgentSession['send']>[1] extends infer O
			? O extends { workflowReview?: infer R }
				? R | undefined
				: never
			: never
		sendOverride.current = async function* (_messages, opts) {
			review = opts?.workflowReview
			yield { kind: 'done', stopReason: 'end_turn' }
		}
		const screen = await start()
		screen.press('go')
		await screen.waitForRender()
		screen.press('\r')
		await waitUntil(screen, () => review !== undefined && text(screen).includes('Type a message'))
		expect(review?.currentPermissionMode()).toBe('prompt')
		const answer = review?.onPermission?.({
			toolCalls: [
				{
					id: 'c1',
					name: 'write',
					input: { path: 'a.txt', content: 'b' },
					isDestructive: true,
				},
			],
		} as never)
		await waitUntil(screen, () => text(screen).includes('Do you want to write this file?'))
		screen.press('\x1b')
		const decision = await answer
		expect(decision?.kind).toBe('reject')
		expect(decision && 'feedback' in decision ? decision.feedback : '').not.toContain(
			'no longer active',
		)
		await waitUntil(screen, () => text(screen).includes('Type a message'))
	})
})
