/** A background Bash job remains visible and manageable after its tool call. */

import type { BackgroundJob, BackgroundJobOutput } from '@namzu/sdk'
import stringWidth from 'string-width'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import type { Preferences } from '../../integrations/providers/index.js'
import { genericPresenter } from '../__fixtures__/generic-presenter.js'
import type { AgentEvent, AgentSession, SendOptions } from '../agent.js'
import type { TuiContext } from '../types.js'
import { type Screen, renderToScreen } from './support/screen.js'

const preferences: Preferences = {
	version: 3,
	providers: [{ id: 'openai' }],
	subagents: { active: [] },
}

const ctx: TuiContext = { cwd: '/work', version: '0.0.0-test' }
let jobs: readonly BackgroundJob[] = []
let outputs: Map<string, BackgroundJobOutput>
let nextJobs: readonly BackgroundJob[] = []
let nextOutputs: Map<string, BackgroundJobOutput>
let sessionCreations: number
let scenario: 'start' | 'exit' | 'question'
let sendOptions: (SendOptions | undefined)[]
let stopCalls: string[]
let nextStopCalls: string[]
let stopOutcome: 'killed' | 'exited'
let finishStop: () => void
let sessionReady: Promise<void>
let announceSessionReady: () => void
let nextSessionReady: Promise<void>
let announceNextSessionReady: () => void
let turnSettled: Promise<void>
let announceTurnSettled: () => void
let turnStarted: Promise<void>
let announceTurnStarted: () => void
let releaseQuestion: () => void
let questionStarted: Promise<void>
let announceQuestionStarted: () => void
let modelSelectionGate: Promise<void>
let releaseModelSelection: () => void
const exitListeners = new Set<(job: BackgroundJob) => void>()
const nextExitListeners = new Set<(job: BackgroundJob) => void>()
let mounted: Screen | null = null

function runningJob(id = 'b00000001'): BackgroundJob {
	return { id, owner: 'session', command: 'npm run dev', status: 'running', startedAt: Date.now() }
}

function outputFor(chunk: string): BackgroundJobOutput {
	return {
		chunk,
		nextOffset: Buffer.byteLength(chunk),
		droppedBytes: 0,
		status: 'running',
	}
}

function announceExit(job: BackgroundJob): void {
	for (const listener of exitListeners) listener(job)
}

vi.mock('../../integrations/trust/store.js', () => ({ isTrusted: () => true, trustDir: () => {} }))
vi.mock('../../integrations/updates.js', () => ({ checkUpdates: async () => [] }))
vi.mock('../../integrations/sessions/store.js', () => ({
	activeConversationTurn: async () => undefined,
	openSessions: async () => ({ tenantId: 't' }),
	startConversation: async () => 'conv',
	requireWritableConversation: async () => {},
	appendMessages: async () => {},
	listRecent: async () => [],
	loadConversation: async () => [],
}))
vi.mock('../../user-commands/store.js', () => ({ discoverUserCommands: () => [] }))
vi.mock('../model-selection-intent.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../model-selection-intent.js')>()
	return {
		...actual,
		resolveModelSelectionIntent: async () => {
			await modelSelectionGate
			return { kind: 'resolved' as const, selection: { id: 'openai', model: 'new-model' } }
		},
	}
})

vi.mock('../agent.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../agent.js')>()
	return {
		...actual,
		probeAgentSession: async () => ({ preferences, needsRepickReason: null, detected: [] }),
		createAgentSession: async (): Promise<AgentSession> => {
			const creation = sessionCreations++
			if (creation === 0) announceSessionReady()
			else announceNextSessionReady()
			const forThisSession = () => (creation === 0 ? jobs : nextJobs)
			const outputForThisSession = () => (creation === 0 ? outputs : nextOutputs)
			const listeners = creation === 0 ? exitListeners : nextExitListeners
			return {
				hasProvider: true,
				sandbox: { unconfined: true, enforced: [], required: [] },
				compact: async () => null,
				providerSummary: 'a-provider',
				modelSummary: creation === 0 ? 'a-model' : 'new-model',
				toolNames: () => ['bash', 'job'],
				presenter: genericPresenter,
				errorHint: null,
				errorKind: null,
				instructionFiles: [],
				skippedInstructionFiles: [],
				mcpConnected: [],
				mcpFailed: [],
				agentIds: [],
				configNotices: [],
				resumeDurable: async () => {
					throw new Error('not used by this test')
				},
				resumePaused: () => {
					throw new Error('not used by this test')
				},
				close: async () => {},
				promptExemptTools: () => [],
				jobs: forThisSession,
				readJob: (id) => {
					const output = outputForThisSession().get(id)
					if (!output) throw new Error(`No job ${id}`)
					return output
				},
				stopJob: (id) => {
					if (creation > 0) {
						nextStopCalls.push(id)
						return Promise.resolve(forThisSession().find((job) => job.id === id)!)
					}
					stopCalls.push(id)
					return new Promise((resolve) => {
						finishStop = () => {
							const previous = jobs.find((job) => job.id === id)
							if (!previous) throw new Error(`No job ${id}`)
							const stopped: BackgroundJob = {
								...previous,
								status: stopOutcome,
								exitedAt: Date.now(),
								...(stopOutcome === 'exited' ? { exitCode: 0 } : {}),
							}
							jobs = jobs.map((job) => (job.id === id ? stopped : job))
							announceExit(stopped)
							resolve(stopped)
						}
					})
				},
				onJobExit: (listener) => {
					listeners.add(listener)
					return () => listeners.delete(listener)
				},
				send: async function* (_messages, opts?: SendOptions): AsyncIterable<AgentEvent> {
					sendOptions.push(opts)
					announceTurnStarted()
					if (scenario === 'start') {
						yield {
							kind: 'tool-start',
							toolUseId: 'bash-start',
							toolName: 'bash',
							summary: 'npm run dev',
						}
						jobs = [runningJob()]
						outputs.set('b00000001', outputFor('server ready on port 3000\n'))
						yield {
							kind: 'tool-end',
							toolUseId: 'bash-start',
							toolName: 'bash',
							summary: 'b00000001 started',
							isError: false,
						}
					} else if (scenario === 'question') {
						await new Promise<void>((resolve) => {
							releaseQuestion = resolve
						})
						const answer = opts?.onQuestion?.({
							questionId: 'q-shell',
							question: 'Keep this server running?',
							options: [
								{ id: 'keep', label: 'Keep it', description: 'Continue using the server' },
								{ id: 'stop', label: 'Stop it', description: 'Shut down the server' },
							],
							multiSelect: false,
							allowFreeText: false,
						})
						announceQuestionStarted()
						const result = await answer
						yield {
							kind: 'delta',
							text: `MODEL GOT: ${result?.kind === 'answer' ? result.selectedOptionIds.join(',') : (result?.kind ?? 'nothing')}`,
						}
					} else if (sendOptions.length === 1) {
						const previous = jobs[0]!
						const exited: BackgroundJob = {
							...previous,
							status: 'exited',
							exitedAt: Date.now(),
							exitCode: 0,
						}
						jobs = [exited]
						announceExit(exited)
						// This fake's turn represents a kernel that put the exit in model context.
						opts?.onJobNoticeDelivered?.(['b00000001'])
						yield { kind: 'delta', text: 'finished' }
					}
					yield { kind: 'done', stopReason: 'end_turn' }
					announceTurnSettled()
				},
			}
		},
	}
})

const { App } = await import('../App.js')

beforeEach(() => {
	jobs = []
	outputs = new Map()
	nextJobs = []
	nextOutputs = new Map()
	sessionCreations = 0
	scenario = 'start'
	sendOptions = []
	stopCalls = []
	nextStopCalls = []
	stopOutcome = 'killed'
	finishStop = () => {
		throw new Error('stop was never requested')
	}
	releaseQuestion = () => {
		throw new Error('question was not requested')
	}
	exitListeners.clear()
	nextExitListeners.clear()
	sessionReady = new Promise<void>((resolve) => {
		announceSessionReady = resolve
	})
	nextSessionReady = new Promise<void>((resolve) => {
		announceNextSessionReady = resolve
	})
	turnSettled = new Promise<void>((resolve) => {
		announceTurnSettled = resolve
	})
	turnStarted = new Promise<void>((resolve) => {
		announceTurnStarted = resolve
	})
	questionStarted = new Promise<void>((resolve) => {
		announceQuestionStarted = resolve
	})
	modelSelectionGate = new Promise<void>((resolve) => {
		releaseModelSelection = resolve
	})
})

afterEach(async () => {
	await mounted?.unmount()
	mounted = null
	vi.restoreAllMocks()
})

async function mount(cols: number, rows: number): Promise<Screen> {
	const screen = await renderToScreen(<App ctx={ctx} />, { cols, rows, scrollback: 200 })
	mounted = screen
	await sessionReady
	await screen.waitForRender()
	return screen
}

async function submit(screen: Screen, text: string): Promise<void> {
	screen.press(text)
	await screen.waitForRender()
	screen.press('\r')
	await screen.waitForRender()
}

it('shows a lasting shell count, opens /jobs details, and stops only once across resize', async () => {
	const screen = await mount(100, 28)
	expect(screen.viewport().join('\n')).not.toContain('shell /jobs')

	await submit(screen, 'launch server')
	await turnSettled
	await screen.waitForRender()
	expect(screen.viewport().join('\n')).toContain('1 shell · ↓ to manage')
	expect(screen.viewport().join('\n')).toContain('Type a message')

	await submit(screen, '/jobs')
	expect(screen.viewport().join('\n')).toContain('Background')
	expect(screen.viewport().join('\n')).toContain('1 active shell')
	expect(screen.viewport().join('\n')).not.toContain('b00000001')
	expect(screen.viewport().join('\n')).toContain('npm run dev')
	expect(screen.viewport().join('\n')).not.toContain('Command details')

	screen.press('\r')
	await screen.waitForRender()
	expect(screen.viewport().join('\n')).toContain('Command details')
	expect(screen.viewport().join('\n')).toContain('server ready on port 3000')

	await screen.resize(40, 14)
	const narrow = screen.viewport()
	expect(narrow.join('\n')).toContain('Command details')
	expect(narrow.join('\n')).toContain('server ready on port 3000')
	for (const row of narrow) expect(stringWidth(row)).toBeLessThanOrEqual(40)

	screen.press('x')
	await screen.waitForRender()
	screen.press('x')
	await screen.waitForRender()
	expect(stopCalls).toEqual(['b00000001'])
	finishStop()
	await screen.waitForRender()
	expect(screen.viewport().join('\n')).toContain('stopped')
	screen.press('q')
	await screen.waitForRender()
	expect(screen.viewport().join('\n')).not.toContain('1 shell · ↓ to manage')
})

it('reaches the shells from the footer with down and opens them with enter', async () => {
	scenario = 'exit'
	jobs = [runningJob()]
	outputs.set('b00000001', outputFor('build output\n'))
	const screen = await mount(100, 28)
	expect(screen.viewport().join('\n')).toContain('1 shell · ↓ to manage')

	screen.press('\x1b[B')
	await screen.waitForRender()
	expect(screen.viewport().join('\n')).toContain('1 shell · enter to view shells')
	expect(screen.viewport().join('\n')).not.toContain('↓ to manage')

	screen.press('\x1b')
	// The lone Esc is held back by the key parser until it is known not to start
	// a sequence, so wait for the repaint it causes; Vitest's own timeout catches a real hang.
	while (!screen.viewport().join('\n').includes('↓ to manage')) {
		await screen.waitForRender()
		await new Promise<void>((resolve) => setImmediate(resolve))
	}
	expect(screen.viewport().join('\n')).toContain('1 shell · ↓ to manage')

	screen.press('\x1b[B')
	await screen.waitForRender()
	screen.press('\r')
	await screen.waitForRender()
	expect(screen.viewport().join('\n')).toContain('1 active shell')
	expect(screen.viewport().join('\n')).toContain('npm run dev')
})

it('clears the shell count and shows one exit row when the kernel delivered the notice', async () => {
	scenario = 'exit'
	jobs = [runningJob()]
	outputs.set('b00000001', outputFor('build output\n'))
	const screen = await mount(100, 28)
	expect(screen.viewport().join('\n')).toContain('1 shell · ↓ to manage')

	await submit(screen, 'finish the job')
	await turnSettled
	await screen.waitForRender()
	expect(screen.viewport().join('\n')).not.toContain('1 shell · ↓ to manage')
	expect(
		screen
			.scrollback()
			.filter((line) => line.includes('Background command "npm run dev" finished (exit code 0)')),
	).toHaveLength(1)

	await submit(screen, 'next turn')
	expect(sendOptions).toHaveLength(2)
	expect(sendOptions[1]?.extraSystem ?? '').not.toContain('Background jobs that ended')
	expect(sendOptions[1]?.extraSystem ?? '').not.toContain('b00000001')
})

it('keeps a live CLI session shell visible after /new changes the conversation', async () => {
	jobs = [runningJob()]
	outputs.set('b00000001', outputFor('still serving\n'))
	const screen = await mount(100, 28)
	await submit(screen, '/new')
	await screen.waitForRender()
	expect(sessionCreations).toBe(1)
	expect(screen.viewport().join('\n')).toContain('1 shell · ↓ to manage')
	await submit(screen, '/jobs')
	expect(screen.viewport().join('\n')).toContain('npm run dev')
	screen.press('\r')
	await screen.waitForRender()
	expect(screen.viewport().join('\n')).toContain('still serving')
})

it('drops the old job panel when a new session reuses the same job id', async () => {
	jobs = [{ ...runningJob(), status: 'exited', exitedAt: Date.now(), exitCode: 0 }]
	outputs.set('b00000001', outputFor('OLD SESSION OUTPUT\n'))
	nextJobs = [{ ...runningJob(), owner: 'next-session', command: 'npm run preview' }]
	nextOutputs.set('b00000001', outputFor('NEW SESSION OUTPUT\n'))
	const screen = await mount(100, 28)

	// Resolve the model choice only after /jobs is open on the old session.
	await submit(screen, '/model new-model')
	await submit(screen, '/jobs')
	expect(screen.viewport().join('\n')).toContain('0 active shells')
	screen.press('\r')
	await screen.waitForRender()
	expect(screen.viewport().join('\n')).toContain('OLD SESSION OUTPUT')

	releaseModelSelection()
	await nextSessionReady
	await screen.waitForRender()
	await screen.waitForRender()
	expect(screen.viewport().join('\n')).not.toContain('Command details')
	expect(screen.viewport().join('\n')).not.toContain('OLD SESSION OUTPUT')

	// An old panel's x key must never be able to target the new b00000001.
	screen.press('x')
	await screen.waitForRender()
	expect(nextStopCalls).toEqual([])
	screen.press('\x7f')
	await screen.waitForRender()
	await submit(screen, '/jobs')
	expect(screen.viewport().join('\n')).toContain('npm run preview')
	screen.press('\r')
	await screen.waitForRender()
	expect(screen.viewport().join('\n')).toContain('NEW SESSION OUTPUT')
	expect(screen.viewport().join('\n')).not.toContain('OLD SESSION OUTPUT')
	expect(nextStopCalls).toEqual([])
})

it('lets a model question replace an open shell panel and accept its answer', async () => {
	scenario = 'question'
	jobs = [runningJob()]
	outputs.set('b00000001', outputFor('server ready\n'))
	const screen = await mount(100, 28)

	await submit(screen, 'ask me about the server')
	await turnStarted
	await submit(screen, '/jobs')
	expect(screen.viewport().join('\n')).toContain('1 active shell')

	releaseQuestion()
	await questionStarted
	await screen.waitForRender()
	expect(screen.viewport().join('\n')).not.toContain('1 active shell')
	expect(screen.viewport().join('\n')).toContain('Keep this server running?')
	expect(screen.viewport().join('\n')).toContain('Keep it')

	screen.press('\r')
	await turnSettled
	await screen.waitForRender()
	expect(screen.scrollback().join('\n')).toContain('MODEL GOT: keep')
})

it('reports that a job exited while its stop request was in flight', async () => {
	jobs = [runningJob()]
	outputs.set('b00000001', outputFor('server ready\n'))
	const screen = await mount(100, 28)
	await submit(screen, '/jobs')
	screen.press('\r')
	await screen.waitForRender()
	screen.press('x')
	await screen.waitForRender()
	expect(stopCalls).toEqual(['b00000001'])

	stopOutcome = 'exited'
	finishStop()
	await screen.waitForRender()
	expect(screen.viewport().join('\n')).toContain('Already finished (exit code 0)')
	expect(screen.viewport().join('\n')).not.toContain('Stopped.')
	expect(screen.viewport().join('\n')).not.toContain('1 shell · ↓ to manage')
})
