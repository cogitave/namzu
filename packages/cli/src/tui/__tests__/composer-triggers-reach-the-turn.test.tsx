/**
 * Composer triggers through the real App: what a typed trigger changes about
 * the turn it starts, and what it must never change.
 *
 * - `hypermode` pins `xhigh` (not the model's top level, `max` here) and adds namzu's request-only
 *   context for that turn alone; the session's hypermode stays off and the
 *   next turn gets neither. Dropped with Alt+W, pasted, or talked about, it
 *   does nothing.
 * - Save as skill runs exactly `/skills save` after a turn that completed and
 *   did tool work, ahead of a prompt queued with Tab, and says why when it
 *   does not run. A message that is only the phrase runs `/skills save`.
 * - Enter while a turn runs still steers; the save binds to that turn.
 * - A model loop's text never carries a trigger.
 * - `/config triggers off` turns all of it off and writes the user file.
 */

import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { render } from 'ink-testing-library'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import type { Preferences } from '../../integrations/providers/index.js'
import type { AgentEvent, AgentSession, SendOptions } from '../agent.js'
import type { ScheduleIntegrationDeps } from '../schedule/integration.js'
import type { TuiContext } from '../types.js'
import { genericPresenter } from '../__fixtures__/generic-presenter.js'

const PREFS: Preferences = { version: 3, providers: [{ id: 'openai' }], subagents: { active: [] } }

vi.mock('../../integrations/trust/store.js', () => ({ isTrusted: () => true, trustDir: () => {} }))
vi.mock('../../integrations/updates.js', () => ({ checkUpdates: async () => [] }))
vi.mock('../../integrations/sessions/store.js', () => ({
	activeConversationTurn: async () => undefined,
	openSessions: async () => ({ tenantId: 't' }),
	startConversation: async () => 'conv-triggers',
	requireWritableConversation: async () => {},
	appendMessages: async () => {},
	listRecent: async () => [],
	loadConversation: async () => [],
}))
vi.mock('../../user-commands/store.js', () => ({ discoverUserCommands: () => [] }))

let deps: ScheduleIntegrationDeps | undefined
vi.mock('../schedule/integration.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../schedule/integration.js')>()
	return {
		...actual,
		createScheduleIntegration: (given: ScheduleIntegrationDeps) => {
			deps = given
			return actual.createScheduleIntegration(given)
		},
	}
})

interface Sent {
	readonly prompt: string
	readonly options: SendOptions | undefined
	/** What `hostContext` said at the first iteration. */
	readonly context: readonly string[]
	readonly steered: string[]
}
const sent: Sent[] = []
/** Holds a turn whose prompt contains `HOLD` open before its end. */
let hold: Promise<void> | null = null

/** Seven successful steps across four tools, one of which writes. */
function* work(n: number): Generator<AgentEvent> {
	const calls: Array<[string, boolean]> = [
		['glob', true],
		['grep', true],
		['read', true],
		['read', true],
		['grep', true],
		['write', false],
		['read', true],
	]
	for (const [i, [toolName, readOnly]] of calls.entries()) {
		const toolUseId = `t${n}-${i}`
		yield {
			kind: 'tool-start',
			toolUseId,
			toolName,
			summary: toolName,
			...(readOnly ? { readOnly: true as const } : {}),
		}
		yield { kind: 'tool-end', toolUseId, toolName, isError: false, summary: 'ok', output: 'ok' }
	}
}

vi.mock('../agent.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../agent.js')>()
	return {
		...actual,
		probeAgentSession: async () => ({ preferences: PREFS, needsRepickReason: null, detected: [] }),
		createAgentSession: async (): Promise<AgentSession> => ({
			hasProvider: true,
			sandbox: { unconfined: true, enforced: [], required: [] },
			compact: async () => null,
			providerSummary: 'test-provider',
			modelSummary: 'test-model',
			// Up to max, so the tests show hypermode pins xhigh and not the top.
			reasoningEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
			toolNames: () => [],
			presenter: genericPresenter,
			errorHint: null,
			errorKind: null,
			agentIds: [],
			configNotices: [],
			instructionFiles: [],
			skippedInstructionFiles: [],
			mcpConnected: [],
			mcpFailed: [],
			resumeDurable: async () => {
				throw new Error('not used')
			},
			resumePaused: () => {
				throw new Error('not used')
			},
			close: async () => {},
			approvalLatched: () => false,
			resetApprovalLatch: () => {},
			setPermissionMode: async () => {},
			promptExemptTools: () => [],
			send: async function* (messages, opts): AsyncIterable<AgentEvent> {
				const prompt = String(messages.at(-1)?.content ?? '')
				const record: Sent = {
					prompt,
					options: opts,
					context: [...(opts?.hostContext?.() ?? [])],
					steered: [],
				}
				sent.push(record)
				const n = sent.length
				// A turn asked only a question does no tool work.
				if (!prompt.includes('QUESTION')) yield* work(n)
				if (prompt.includes('HOLD') && hold) await hold
				if (opts?.signal?.aborted) {
					yield { kind: 'error', message: 'aborted' }
					return
				}
				for (const message of opts?.inboundMessages?.() ?? []) {
					record.steered.push(String(message.content))
				}
				yield { kind: 'delta', text: `ANSWER${n}` }
				yield { kind: 'done', stopReason: 'end_turn' }
			},
		}),
	}
})

const { App } = await import('../App.js')
const mounted: Array<{ unmount: () => void }> = []
const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms))
let home: string
let savedHome: string | undefined

beforeEach(() => {
	deps = undefined
	hold = null
	sent.length = 0
	savedHome = process.env.NAMZU_HOME
	home = mkdtempSync(join(tmpdir(), 'namzu-triggers-'))
	process.env.NAMZU_HOME = home
})
afterEach(() => {
	for (const harness of mounted.splice(0)) harness.unmount()
	process.env.NAMZU_HOME = savedHome
	removeTempDir(home)
	vi.clearAllMocks()
})

const plain = (text: string) =>
	// biome-ignore lint/suspicious/noControlCharactersInRegex: strips terminal colour codes.
	text.replace(/\u001b\[[0-9;]*m/g, '').replace(/\s+/g, ' ')

async function until(check: () => boolean, why: string): Promise<void> {
	const by = Date.now() + 5_000
	while (!check() && Date.now() < by) await tick()
	expect(check(), why).toBe(true)
}

const HYPERMODE_CONTEXT = 'The operator asked for hypermode for THIS turn only'
const SAVE_CONTEXT = 'The operator asked namzu to save this work as a skill after this turn'
const SKILL_PROMPT = '"from this conversation" mode'
const PROPOSAL = 'Save it as a reusable skill?'

async function mount() {
	const harness = render(
		<App ctx={{ cwd: home, version: '0.0.0-test', rules: [], skipPermissions: false } as TuiContext} />,
	)
	mounted.push(harness)
	await until(() => (harness.lastFrame() ?? '').includes('test-model'), 'App never became ready')
	/** One key at a time, the way a person types: only this arms a trigger. */
	const typeKeys = async (text: string) => {
		for (const key of text) {
			harness.stdin.write(key)
			await tick(2)
		}
		await tick()
	}
	const enter = async () => {
		harness.stdin.write('\r')
		await tick()
	}
	const shown = () => plain(harness.frames.join('\n'))
	const now = () => plain(harness.lastFrame() ?? '')
	return { harness, typeKeys, enter, shown, now }
}

it('arms hypermode for one turn: xhigh and namzu’s context, then neither', async () => {
	const { typeKeys, enter, shown, now } = await mount()
	await typeKeys('hypermode fix the flaky test')
	expect(now()).toContain(
		'✦ hypermode · this turn: effort xhigh, delegate to parallel agents · alt+w drop',
	)
	await enter()
	await until(() => shown().includes('ANSWER1'), 'the turn never finished')
	expect(sent[0]?.prompt).toBe('hypermode fix the flaky test')
	expect(sent[0]?.options?.effort).toBe('xhigh')
	expect(sent[0]?.options?.hypermode).toBeUndefined()
	expect(sent[0]?.context.join('\n')).toContain(HYPERMODE_CONTEXT)
	expect(shown()).toContain('hypermode (this turn, effort xhigh)')
	// The session's mode never turned on: the footer does not name it.
	expect(now()).not.toMatch(/· hypermode(?! \()/u)

	await typeKeys('now the docs')
	await enter()
	await until(() => sent.length === 2, 'the second turn never started')
	expect(sent[1]?.options?.effort).toBeUndefined()
	expect(sent[1]?.context).toEqual([])
})

it('does nothing for a hypermode dropped with Alt+W, pasted, talked about, or the other keyword', async () => {
	const { harness, typeKeys, enter, shown, now } = await mount()
	await typeKeys('hypermode fix the flaky test')
	harness.stdin.write('\u001bw')
	await until(() => now().includes('✧ hypermode (off) · alt+w restores'), 'Alt+W did not drop it')
	await enter()
	await until(() => sent.length === 1, 'the dropped message was not sent')

	harness.stdin.write('\u001b[200~hypermode fix the flaky test\u001b[201~')
	await until(() => now().includes('✧ hypermode? · alt+w arms'), 'the paste did not suggest')
	await enter()
	await until(() => sent.length === 2, 'the pasted message was not sent')

	await typeKeys('what is hypermode?')
	expect(now()).toContain('✧ hypermode? · alt+w arms')
	await enter()
	await until(() => sent.length === 3, 'the question was not sent')

	await typeKeys('ultracode fix the flaky test')
	expect(now()).not.toContain('✦')
	expect(now()).not.toContain('✧')
	await enter()
	await until(() => sent.length === 4 && shown().includes('ANSWER4'), 'the last turn never finished')

	for (const turn of sent) {
		expect(turn.options?.effort, turn.prompt).toBeUndefined()
		expect(turn.context, turn.prompt).toEqual([])
	}
})

it('saves the work as a skill after a turn that did it, ahead of a Tab-queued prompt', async () => {
	let release = () => {}
	hold = new Promise<void>((resolve) => {
		release = resolve
	})
	const { harness, typeKeys, enter, shown } = await mount()
	await typeKeys("HOLD şu repodaki TODO'ları say ve bunu skill olarak kaydet")
	await enter()
	await until(() => sent.length === 1 && shown().includes('Working'), 'the first turn never started')
	expect(sent[0]?.context.join('\n')).toContain(SAVE_CONTEXT)
	await typeKeys('second task')
	harness.stdin.write('\t')
	await until(() => shown().includes('1 message queued'), 'Tab did not queue')

	release()
	await until(() => sent.length === 3, 'the follow-up and the queued prompt did not both run')
	expect(sent[1]?.prompt).toContain(SKILL_PROMPT)
	expect(sent[2]?.prompt).toBe('second task')
	expect(shown()).toContain('save as skill · running /skills save for this turn')
	// Asked for in words, it is not also proposed.
	expect(shown()).not.toContain(PROPOSAL)
})

it('says why a save did not run: no tool work, or the turn was cancelled', async () => {
	const { harness, typeKeys, enter, shown } = await mount()
	await typeKeys('QUESTION what does this do? then save it as a skill')
	await enter()
	await until(
		() => shown().includes('save as skill · not run: the turn did no tool work'),
		'no row for a turn without tool work',
	)

	let release = () => {}
	hold = new Promise<void>((resolve) => {
		release = resolve
	})
	await typeKeys('HOLD fix the tests, then save it as a skill')
	await enter()
	await until(() => sent.length === 2 && shown().includes('Working'), 'the second turn never started')
	harness.stdin.write('\u001b')
	await tick(50)
	release()
	await until(
		() => shown().includes('save as skill · not run: the turn was cancelled'),
		'no row for a cancelled turn',
	)
	await tick(100)
	expect(sent.every((turn) => !turn.prompt.includes(SKILL_PROMPT))).toBe(true)
})

it('checks again when the turn ends: a switch to plan mode meanwhile cancels the save', async () => {
	let release = () => {}
	hold = new Promise<void>((resolve) => {
		release = resolve
	})
	const { typeKeys, enter, shown, now } = await mount()
	await typeKeys('HOLD fix the tests, then save it as a skill')
	await enter()
	await until(() => sent.length === 1 && shown().includes('Working'), 'the turn never started')
	await typeKeys('/permissions plan')
	await enter()
	await tick(50)
	release()
	await until(
		() => shown().includes('save as skill · not run: unavailable in plan mode'),
		`no row for a save the mode no longer allows: ${now()}`,
	)
	await tick(100)
	expect(sent).toHaveLength(1)
})

it('runs /skills save for a message that is only the phrase, and needs a task for hypermode', async () => {
	const { typeKeys, enter, shown } = await mount()
	await typeKeys('bunu skill olarak kaydet')
	expect(shown()).toContain('✦ save as skill · runs /skills save · alt+w drop')
	await enter()
	await until(() => sent.length === 1, '/skills save never ran')
	expect(sent[0]?.prompt).toContain(SKILL_PROMPT)

	await typeKeys('hypermode')
	await enter()
	await until(
		() => shown().includes('hypermode · not applied: the message has no task'),
		'no row for a task-less hypermode',
	)
	await tick(100)
	expect(sent).toHaveLength(1)
})

it('still steers with Enter while a turn runs, and binds the save to that turn', async () => {
	let release = () => {}
	hold = new Promise<void>((resolve) => {
		release = resolve
	})
	const { typeKeys, enter, shown, now } = await mount()
	await typeKeys('HOLD find every TODO')
	await enter()
	await until(() => sent.length === 1 && shown().includes('Working'), 'the first turn never started')
	await typeKeys('also count the FIXMEs and save it as a skill')
	expect(now()).toContain('enter: after the running turn')
	await enter()
	await tick(50)
	expect(sent, 'Enter must steer, not start a turn').toHaveLength(1)
	release()
	await until(() => sent.length === 2, 'the bound save never ran')
	expect(sent[0]?.steered).toEqual(['also count the FIXMEs and save it as a skill'])
	expect(sent[1]?.prompt).toContain(SKILL_PROMPT)
})

it('never lets a model loop’s text carry a trigger', async () => {
	const { shown } = await mount()
	if (!deps) throw new Error('the schedule integration was never created')
	deps.submit('hypermode fix the flaky test', 'model')
	await until(() => shown().includes('ANSWER1'), 'the loop prompt never ran')
	expect(sent[0]?.options?.effort).toBeUndefined()
	expect(sent[0]?.context).toEqual([])
})

it('turns every trigger off with /config triggers off, in the user file', async () => {
	const { typeKeys, enter, shown, now } = await mount()
	await typeKeys('/config triggers off')
	await enter()
	await until(() => shown().includes('Composer triggers are off'), '/config triggers off said nothing')
	expect(readFileSync(join(home, 'config.yaml'), 'utf8')).toMatch(
		/composerTriggers:\s*\n\s+enabled: false/,
	)
	await typeKeys('hypermode fix the flaky test')
	expect(now()).not.toContain('✦')
	await enter()
	await until(() => sent.length === 1, 'the prompt was not sent')
	expect(sent[0]?.options?.effort).toBeUndefined()
	expect(sent[0]?.context).toEqual([])
})
