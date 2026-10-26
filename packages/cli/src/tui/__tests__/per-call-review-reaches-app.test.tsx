/**
 * Asking about one call at a time, asserted against a rendered `<App>`.
 *
 * The fake session stands in for the kernel's per-call walk: it receives the
 * `perCallReview` the terminal passes, asks about each call through
 * `onPermission` with `perCall: true` and an abort signal, and reacts to a
 * refusal that ends the turn the way the kernel does (the questions still open
 * are closed through their signals). What is under test is the terminal's side:
 * one overlay per call, the count, the keys, the re-check, the waiting rows.
 *
 * Time is the stubbed clock the permission tests use, never a real wait for a
 * result: every assertion awaits a frame or a decision.
 */

import { render } from 'ink-testing-library'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { PerCallReviewConfig } from '@namzu/sdk'

import type { Preferences } from '../../integrations/providers/index.js'
import type {
	AgentEvent,
	AgentSession,
	PermissionDecision,
	PermissionRequest,
	PermissionToolCall,
} from '../agent.js'
import { APPROVAL_SETTLE_MS } from '../consent-timing.js'
import type { TuiContext } from '../types.js'

const PREFS: Preferences = { version: 3, providers: [{ id: 'openai' }], subagents: { active: [] } }

interface Asked {
	readonly call: PermissionToolCall
	readonly controller: AbortController
	decision?: PermissionDecision
}

/** What the fake kernel saw. */
const asked: Asked[] = []
const remembered: unknown[] = []
const modeSwitches: unknown[] = []
let perCallConfig: PerCallReviewConfig | undefined
let rulesListenerCalls = 0
let calls: PermissionToolCall[] = []
/** Extra requests the fake sends as another agent, after the turn's own asks. */
let agentRequests: PermissionRequest[] = []
/** Whether the fake kernel closes a waiting call that the config now covers. */
let recheck = true
let turnAborted = false
let started: string[] = []
let release: () => void = () => {}
let hold = Promise.resolve()

let nowMs = 1_000_000

vi.mock('../../integrations/trust/store.js', () => ({
	isTrusted: () => true,
	trustDir: () => {},
}))
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

vi.mock('../agent.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../agent.js')>()
	return {
		...actual,
		probeAgentSession: async () => ({ preferences: PREFS, needsRepickReason: null, detected: [] }),
		createAgentSession: async (): Promise<AgentSession> => ({
			hasProvider: true,
			sandbox: { unconfined: true, enforced: [], required: [] },
			compact: async () => null,
			providerSummary: 'a-provider',
			modelSummary: 'a-model',
			toolNames: () => ['bash'],
			presenter: actual.builtinToolPresenter(),
			errorHint: null,
			errorKind: null,
			instructionFiles: [],
			skippedInstructionFiles: [],
			mcpConnected: [],
			mcpFailed: [],
			agentIds: [],
			configNotices: [],
			resumeDurable: async () => {
				throw new Error('not used by the TUI')
			},
			resumePaused: () => {
				throw new Error('not used by this test')
			},
			close: async () => {},
			setPermissionMode: async (mode) => {
				modeSwitches.push(mode)
			},
			allowForSession: (allows) => {
				remembered.push(allows)
				return undefined
			},
			commandArguments: new Map([['bash', 'command']]),
			promptExemptTools: () => [],
			send: async function* (_messages, opts): AsyncIterable<AgentEvent> {
				perCallConfig = opts?.perCallReview
				yield { kind: 'delta', text: 'working' } as AgentEvent
				await new Promise((r) => setTimeout(r, 20))
				const off = perCallConfig?.onRulesChanged?.(() => {
					rulesListenerCalls += 1
					if (!recheck) return
					void (async () => {
						for (const ask of asked) {
							if (ask.decision || ask.controller.signal.aborted) continue
							if (await perCallConfig?.neverCover?.(ask.call as never)) continue
							const covered =
								remembered.length > 0 ? true : await perCallConfig?.covers?.(ask.call as never)
							if (covered) ask.controller.abort()
						}
					})()
				})
				const ask = async (call: PermissionToolCall): Promise<void> => {
					const entry: Asked = { call, controller: new AbortController() }
					asked.push(entry)
					const decision = await opts?.onPermission?.({
						toolCalls: [call],
						perCall: true,
						signal: entry.controller.signal,
						turnId: 'turn-1',
					} as unknown as PermissionRequest)
					if (entry.controller.signal.aborted) return
					entry.decision = decision
					if (decision?.kind === 'reject' && decision.endTurn) {
						turnAborted = true
						for (const other of asked) if (other !== entry) other.controller.abort()
					}
				}
				await Promise.all([
					...calls.map(ask),
					...agentRequests.map(async (request) => {
						const decision = await opts?.onPermission?.(request)
						agentDecisions.push(decision as PermissionDecision)
					}),
				])
				off?.()
				await hold
				if (turnAborted) {
					yield { kind: 'done', stopReason: 'cancelled', text: '' } as AgentEvent
					return
				}
				for (const entry of asked) {
					if (entry.decision?.kind === 'approve') {
						started.push(entry.call.id)
						yield {
							kind: 'tool-start',
							toolUseId: entry.call.id,
							toolName: entry.call.name,
							summary: 'ran',
						} as AgentEvent
					}
				}
			},
		}),
	}
})

const agentDecisions: PermissionDecision[] = []

const { App } = await import('../App.js')
const ctx: TuiContext = { cwd: process.cwd(), version: '0.0.0-test' }
const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms))
const mounted: { unmount: () => void }[] = []

const bash = (id: string, command: string): PermissionToolCall => ({
	id,
	name: 'bash',
	input: { command },
	isDestructive: false,
})
const edit = (id: string, path: string): PermissionToolCall => ({
	id,
	name: 'edit',
	input: { path, old_string: 'a', new_string: 'b' },
	isDestructive: false,
})

beforeEach(() => {
	asked.length = 0
	remembered.length = 0
	modeSwitches.length = 0
	agentDecisions.length = 0
	perCallConfig = undefined
	rulesListenerCalls = 0
	agentRequests = []
	recheck = true
	turnAborted = false
	started = []
	hold = new Promise<void>((resolve) => {
		release = resolve
	})
	nowMs = 1_000_000
	calls = [bash('a', 'npm test'), bash('b', 'npm run build'), bash('c', 'git status')]
	vi.spyOn(Date, 'now').mockImplementation(() => nowMs)
})

afterEach(() => {
	release()
	for (const h of mounted) h.unmount()
	mounted.length = 0
	vi.restoreAllMocks()
})

const settle = () => {
	nowMs += APPROVAL_SETTLE_MS + 1
}

async function withQuestionsOpen(expected = calls.length) {
	const harness = render(<App ctx={ctx} />)
	mounted.push(harness)
	await tick(60)
	harness.stdin.write('go')
	await tick(20)
	harness.stdin.write('\r')
	await vi.waitFor(() => {
		expect(harness.lastFrame() ?? '', 'the first question never opened').toContain('enter confirm')
		expect(asked.length).toBe(expected)
	})
	return harness
}

const frameOf = (h: { lastFrame: () => string | undefined }) => h.lastFrame() ?? ''

/** Move the cursor to the last answer, which is No. */
async function cursorToNo(h: { stdin: { write: (data: string) => void } }): Promise<void> {
	h.stdin.write('\x1b[B')
	await tick(20)
	h.stdin.write('\x1b[B')
	await tick(30)
}

describe('one overlay per call', () => {
	it('opts the terminal turn in', async () => {
		await withQuestionsOpen()
		expect(perCallConfig).toBeDefined()
		expect(typeof perCallConfig?.onRulesChanged).toBe('function')
	})

	it('shows the calls one at a time, in the order they were asked, with k of N', async () => {
		const h = await withQuestionsOpen()
		expect(frameOf(h)).toContain('$ npm test')
		expect(frameOf(h)).not.toContain('$ npm run build')
		expect(frameOf(h)).toContain('1 of 3')
		expect(frameOf(h)).not.toContain('awaiting approval')

		settle()
		h.stdin.write('y')
		await vi.waitFor(() => expect(frameOf(h)).toContain('$ npm run build'))
		expect(frameOf(h)).toContain('2 of 3')
		expect(asked[0]?.decision).toEqual({ kind: 'approve' })

		settle()
		h.stdin.write('y')
		await vi.waitFor(() => expect(frameOf(h)).toContain('$ git status'))
		// The last of three still reads as the third of three.
		expect(frameOf(h)).toContain('3 of 3')
		settle()
		h.stdin.write('y')
		await vi.waitFor(() =>
			expect(asked.map((entry) => entry.decision?.kind)).toEqual(['approve', 'approve', 'approve']),
		)
	})

	it('gives every question its own settle window, so a key aimed at one cannot answer the next', async () => {
		const h = await withQuestionsOpen()
		settle()
		h.stdin.write('y')
		await vi.waitFor(() => expect(frameOf(h)).toContain('$ npm run build'))
		// The clock has not moved: the second question is brand new.
		h.stdin.write('y')
		await tick(120)
		expect(asked[1]?.decision).toBeUndefined()
		expect(frameOf(h)).toContain('$ npm run build')
	})

	it('shows each waiting call as a quiet row: a static dot, and "Waiting…" for a shell call', async () => {
		const h = await withQuestionsOpen()
		const frame = frameOf(h)
		expect(frame.match(/Waiting…/g)?.length).toBe(3)
		expect(frame).not.toContain('Running…')
	})
})

describe('refusing', () => {
	it('ends the turn on a plain No, closes the other questions and answers none of them', async () => {
		const h = await withQuestionsOpen()
		h.stdin.write('n')
		await vi.waitFor(() => expect(turnAborted).toBe(true))
		expect(asked[0]?.decision).toEqual({ kind: 'reject', declined: {}, endTurn: true })
		expect(asked[1]?.controller.signal.aborted).toBe(true)
		expect(asked[2]?.controller.signal.aborted).toBe(true)
		await vi.waitFor(() => expect(frameOf(h)).not.toContain('enter confirm'))
	})

	it('leaves one dim interruption row when a plain No stops the turn', async () => {
		const h = await withQuestionsOpen()
		h.stdin.write('n')
		await vi.waitFor(() => expect(turnAborted).toBe(true))
		release()
		await vi.waitFor(() =>
			expect(frameOf(h)).toContain('Interrupted · What should Namzu do instead?'),
		)
		expect(frameOf(h).match(/Interrupted/g)?.length).toBe(1)
	})

	it('leaves the same row when Ctrl+C stops the turn at a question', async () => {
		const h = await withQuestionsOpen()
		h.stdin.write('\x03')
		await vi.waitFor(() => expect(turnAborted).toBe(true))
		// The same ending as a plain No: the shown call is declined, the others closed unasked.
		expect(asked[0]?.decision).toEqual({ kind: 'reject', declined: {}, endTurn: true })
		expect(asked[1]?.controller.signal.aborted).toBe(true)
		expect(asked[2]?.controller.signal.aborted).toBe(true)
		release()
		await vi.waitFor(() =>
			expect(frameOf(h)).toContain('Interrupted · What should Namzu do instead?'),
		)
		expect(frameOf(h).match(/Interrupted/g)?.length).toBe(1)
	})

	it('ends the turn on Esc as well', async () => {
		const h = await withQuestionsOpen()
		h.stdin.write('\x1b')
		await vi.waitFor(() => expect(turnAborted).toBe(true))
		expect(asked[0]?.decision).toMatchObject({ kind: 'reject', endTurn: true })
	})

	it('keeps asking after a refusal that carries a reason, and refuses only that call', async () => {
		const h = await withQuestionsOpen()
		await cursorToNo(h)
		expect(frameOf(h)).toContain('tab say why')
		h.stdin.write('\t')
		await vi.waitFor(() => expect(frameOf(h)).toContain('Tell Namzu what to do differently'))
		// Typing is per key press, as a person types.
		for (const ch of 'use pnpm') {
			h.stdin.write(ch)
			await tick(5)
		}
		await vi.waitFor(() => expect(frameOf(h)).toContain('use pnpm'))
		// Letters typed here are not answers: nothing was decided yet.
		expect(asked[0]?.decision).toBeUndefined()
		h.stdin.write('\r')
		await vi.waitFor(() => expect(frameOf(h)).toContain('$ npm run build'))
		await vi.waitFor(() =>
			expect(asked[0]?.decision).toEqual({
				kind: 'reject',
				feedback: 'The user declined this and said: use pnpm',
				declined: { note: 'use pnpm' },
			}),
		)
		expect(turnAborted).toBe(false)
		expect(asked[1]?.controller.signal.aborted).toBe(false)
	})

	it('puts the typed reason away on Esc without answering', async () => {
		const h = await withQuestionsOpen()
		await cursorToNo(h)
		h.stdin.write('\t')
		await vi.waitFor(() => expect(frameOf(h)).toContain('Tell Namzu what to do differently'))
		h.stdin.write('x')
		await tick(30)
		h.stdin.write('\x1b')
		await vi.waitFor(() => expect(frameOf(h)).toContain('1. Yes'))
		expect(asked[0]?.decision).toBeUndefined()
		expect(turnAborted).toBe(false)
	})

	it('does not open the reason on Tab while the cursor is on Yes', async () => {
		const h = await withQuestionsOpen()
		h.stdin.write('\t')
		await tick(60)
		expect(frameOf(h)).not.toContain('Tell Namzu what to do differently')
	})

	it('refuses everything on Ctrl+C', async () => {
		const h = await withQuestionsOpen()
		h.stdin.write('\x03')
		await vi.waitFor(() => expect(frameOf(h)).not.toContain('enter confirm'))
		expect(
			asked.every((entry) => entry.controller.signal.aborted || entry.decision?.kind === 'reject'),
		).toBe(true)
	})
})

describe('a question another agent asks', () => {
	it('waits behind the questions of the conversation and names the agent', async () => {
		calls = [bash('a', 'npm test'), bash('c', 'git status')]
		agentRequests = [
			{
				sessionId: 'child-session',
				toolCalls: [bash('x', 'echo from-agent')],
			} as unknown as PermissionRequest,
		]
		const h = await withQuestionsOpen(2)
		expect(frameOf(h)).toContain('$ npm test')
		for (const expected of ['$ git status', '$ echo from-agent']) {
			settle()
			h.stdin.write('y')
			await vi.waitFor(() => expect(frameOf(h)).toContain(expected))
		}
		expect(frameOf(h)).toContain('from another agent')
	})

	it('stays open for the person when a rule asked about its call, whatever was remembered', async () => {
		const connector = (
			id: string,
			extra: Partial<PermissionToolCall> = {},
		): PermissionToolCall => ({
			id,
			name: 'mcp__files__read',
			input: { path: 'a' },
			isDestructive: false,
			...extra,
		})
		calls = [connector('m1')]
		agentRequests = [
			{
				sessionId: 'child-session',
				toolCalls: [connector('m2', { authorization: { askRule: true } })],
			} as unknown as PermissionRequest,
		]
		const h = await withQuestionsOpen(1)
		settle()
		h.stdin.write('2')
		await vi.waitFor(() => expect(remembered.length).toBe(1))
		// The other agent's call is shown, not approved by the remembered tool rule.
		await vi.waitFor(() => expect(frameOf(h)).toContain('from another agent'))
		await tick(60)
		expect(agentDecisions).toEqual([])
	})

	it('does not end the turn when the agent is refused', async () => {
		calls = []
		agentRequests = [
			{
				sessionId: 'child-session',
				toolCalls: [bash('x', 'echo from-agent')],
			} as unknown as PermissionRequest,
		]
		const h = render(<App ctx={ctx} />)
		mounted.push(h)
		await tick(60)
		h.stdin.write('go')
		await tick(20)
		h.stdin.write('\r')
		await vi.waitFor(() => expect(frameOf(h)).toContain('$ echo from-agent'))
		h.stdin.write('n')
		await vi.waitFor(() => expect(agentDecisions).toEqual([{ kind: 'reject', declined: {} }]))
		expect(turnAborted).toBe(false)
	})
})

describe('re-checking the questions still open', () => {
	it('tells the kernel a rule was remembered, and a call it now covers is never shown', async () => {
		calls = [bash('a', 'npm test'), bash('b', 'npm run build'), bash('c', 'git status')]
		const h = await withQuestionsOpen()
		expect(frameOf(h)).toContain("don't ask again")
		settle()
		h.stdin.write('2')
		await vi.waitFor(() => expect(remembered.length).toBe(1))
		await vi.waitFor(() => expect(rulesListenerCalls).toBeGreaterThan(0))
		// The kernel closed the waiting questions it now covers: none is shown.
		await vi.waitFor(() => expect(asked[1]?.controller.signal.aborted).toBe(true))
		expect(asked[0]?.decision).toEqual({ kind: 'approve' })
		await vi.waitFor(() => expect(frameOf(h)).not.toContain('enter confirm'))
	})

	it('re-checks when the mode switches to accept edits, and a switch to plan approves nothing', async () => {
		calls = [edit('a', 'a.ts'), edit('b', 'b.ts'), bash('c', 'git status')]
		const h = await withQuestionsOpen()
		// The answer that accepts edits is only offered when every call is an edit,
		// so switch by key (Shift+Tab is the same answer on an edit prompt).
		h.stdin.write('\x1b[Z')
		await tick(30)
		expect(asked[0]?.decision).toBeUndefined()
		settle()
		h.stdin.write('\x1b[Z')
		await tick(30)
		// The first question is a plain edit, and the answer is offered for it.
		expect(modeSwitches).toContain('accept-edits')
		await vi.waitFor(() => expect(rulesListenerCalls).toBeGreaterThan(0))
		await vi.waitFor(() => expect(asked[1]?.controller.signal.aborted).toBe(true))
		// The shell call is not an edit: it stays open and is shown.
		expect(asked[2]?.controller.signal.aborted).toBe(false)
		await vi.waitFor(() => expect(frameOf(h)).toContain('$ git status'))
	})

	it('never lets a re-check approve a call whose input was not shown in full', async () => {
		calls = [bash('a', 'npm test'), bash('big', `echo ${'x'.repeat(250_000)}`)]
		await withQuestionsOpen(2)
		expect(perCallConfig?.neverCover?.(calls[1] as never)).toBe(true)
		expect(perCallConfig?.neverCover?.(calls[0] as never)).toBe(false)
	})
})

describe('the input that was approved is the input that runs', () => {
	it('refuses only that call when its input changed after it was shown', async () => {
		const h = await withQuestionsOpen()
		;(calls[0]?.input as { command: string }).command = 'rm -rf /'
		settle()
		h.stdin.write('y')
		await vi.waitFor(() => expect(frameOf(h)).toContain('$ npm run build'))
		await vi.waitFor(() => expect(asked[0]?.decision).toMatchObject({ kind: 'reject' }))
		expect((asked[0]?.decision as { endTurn?: true }).endTurn).toBeUndefined()
		expect(turnAborted).toBe(false)
	})
})

describe('a waiting row becomes the running one', () => {
	it('hands the waiting row to the start of the same call, and removes the row of a refused call', async () => {
		calls = [bash('a', 'npm test'), bash('b', 'npm run build')]
		const h = await withQuestionsOpen(2)
		expect(frameOf(h).match(/Waiting…/g)?.length).toBe(2)
		await cursorToNo(h)
		h.stdin.write('\t')
		await tick(30)
		h.stdin.write('n')
		await tick(30)
		h.stdin.write('\r')
		await vi.waitFor(() => expect(frameOf(h)).toContain('$ npm run build'))
		// The refused call's row is gone; the other still waits.
		await vi.waitFor(() => expect(frameOf(h).match(/Waiting…/g)?.length).toBe(1))
		settle()
		h.stdin.write('y')
		await vi.waitFor(() => expect(asked[1]?.decision).toEqual({ kind: 'approve' }))
		release()
		await vi.waitFor(() => expect(started).toEqual(['b']))
		await vi.waitFor(() => expect(frameOf(h)).not.toContain('Waiting…'))
	})
})
