/**
 * The proposal to save a multi-step task as a skill, in the rendered App:
 * printed once per conversation under the reply, counted in the ignore
 * ledger, and switched off for good by `/skills save off`, which writes the
 * user config.
 */

import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { render } from 'ink-testing-library'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import type { Preferences } from '../../integrations/providers/index.js'
import type { AgentEvent, AgentSession } from '../agent.js'
import { readSuggestionLedger } from '../skills/suggestion-ledger.js'
import type { TuiContext } from '../types.js'

const PREFS: Preferences = { version: 3, providers: [{ id: 'openai' }], subagents: { active: [] } }

vi.mock('../../integrations/trust/store.js', () => ({ isTrusted: () => true, trustDir: () => {} }))
vi.mock('../../integrations/updates.js', () => ({ checkUpdates: async () => [] }))
vi.mock('../../integrations/sessions/store.js', () => ({
	activeConversationTurn: async () => undefined,
	openSessions: async () => ({ tenantId: 't' }),
	startConversation: async () => 'conv-skill-suggestion',
	requireWritableConversation: async () => {},
	appendMessages: async () => {},
	listRecent: async () => [],
	loadConversation: async () => [],
}))
vi.mock('../../user-commands/store.js', () => ({ discoverUserCommands: () => [] }))

/** Seven successful steps across four tools, one of which writes. */
function* multiStepTurn(n: number): Generator<AgentEvent> {
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
	yield { kind: 'delta', text: `ANSWER${n}` }
	yield { kind: 'done', stopReason: 'end_turn' }
}

let sends = 0
/** Holds the first turn open before its end, so a prompt can arrive meanwhile. */
let hold: Promise<void> | null = null
/** Each send: the prompt it was given, and what it was steered with before it ended. */
const sent: Array<{ prompt: string; steered: string[] }> = []
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
			toolNames: () => [],
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
			promptExemptTools: () => [],
			send: async function* (messages, opts): AsyncIterable<AgentEvent> {
				sends += 1
				const n = sends
				const record = { prompt: String(messages.at(-1)?.content ?? ''), steered: [] as string[] }
				sent.push(record)
				const events = [...multiStepTurn(n)]
				const end = events.pop() as AgentEvent
				yield* events
				if (n === 1 && hold) await hold
				for (const message of opts?.inboundMessages?.() ?? []) {
					record.steered.push(String(message.content))
				}
				yield end
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
	sends = 0
	hold = null
	sent.length = 0
	savedHome = process.env.NAMZU_HOME
	home = mkdtempSync(join(tmpdir(), 'namzu-skill-suggestion-'))
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
const PROPOSAL = 'Save it as a reusable skill?'

async function until(check: () => boolean, why: string): Promise<void> {
	const by = Date.now() + 5_000
	while (!check() && Date.now() < by) await tick()
	expect(check(), why).toBe(true)
}

async function mount() {
	const harness = render(
		<App
			ctx={
				{
					cwd: home,
					version: '0.0.0-test',
					rules: [],
					skipPermissions: false,
				} as TuiContext
			}
		/>,
	)
	mounted.push(harness)
	await until(() => (harness.lastFrame() ?? '').includes('test-model'), 'App never became ready')
	const type = async (text: string) => {
		harness.stdin.write(text)
		await tick()
		harness.stdin.write('\r')
	}
	// Everything ever drawn, for "did it appear"; the last frame, for "how many".
	const shown = () => plain(harness.frames.join('\n'))
	const now = () => plain(harness.lastFrame() ?? '')
	return { harness, type, shown, now }
}

it('proposes a multi-step task once per conversation, and /skills save off persists', async () => {
	const { type, shown, now } = await mount()

	await type('find every TODO and write TODO.md')
	await until(() => shown().includes(PROPOSAL), 'no proposal after a multi-step turn')
	expect(shown()).toContain('That took 7 steps across 4 tools.')
	expect(shown()).toContain('/skills save [name] · /skills save off to stop suggesting')
	expect(readSuggestionLedger(home).unanswered).toBe(1)
	// Under the reply, not above it.
	expect(now()).toContain('ANSWER1')
	expect(now().indexOf(PROPOSAL)).toBeGreaterThan(now().indexOf('ANSWER1'))

	await type('now do the same for FIXME')
	await until(() => shown().includes('ANSWER2'), 'second turn never finished')
	await tick(100)
	expect(now().split(PROPOSAL).length - 1, 'a conversation proposes once').toBe(1)
	expect(readSuggestionLedger(home).unanswered).toBe(1)

	await type('/skills save off')
	await until(() => shown().includes('Skill suggestions are off'), '/skills save off said nothing')
	const config = join(home, 'config.yaml')
	expect(shown()).toContain(config)
	expect(readFileSync(config, 'utf8')).toMatch(/skills:\s*\n\s+suggest: false/)

	// A fresh conversation would propose again, but the switch is off.
	await type('/clear')
	await tick(200)
	await type('one more multi-step task')
	await until(() => shown().includes('ANSWER3'), 'third turn never finished')
	await tick(100)
	expect(now()).not.toContain(PROPOSAL)
	expect(readSuggestionLedger(home).unanswered).toBe(1)
})

it('stops after three proposals went unused, and says so once', async () => {
	const { writeSuggestionLedger } = await import('../skills/suggestion-ledger.js')
	writeSuggestionLedger(home, { v: 1, unanswered: 3, stopped: false })
	const { type, shown, now } = await mount()

	await type('a multi-step task')
	await until(() => shown().includes('ANSWER1'), 'turn never finished')
	await until(() => shown().includes('Not suggesting skills any more'), 'no stop notice')
	expect(shown()).not.toContain(PROPOSAL)
	expect(readSuggestionLedger(home).stopped).toBe(true)

	await type('/clear')
	await tick(200)
	await type('another multi-step task')
	await until(() => shown().includes('ANSWER2'), 'second turn never finished')
	await tick(100)
	expect(now()).not.toContain('Not suggesting skills any more')
	expect(now()).not.toContain(PROPOSAL)
})

it('/skills save typed during a turn waits for it, and neither turn is proposed', async () => {
	let release = () => {}
	hold = new Promise<void>((resolve) => {
		release = resolve
	})
	const { type, shown, now } = await mount()

	await type('find every TODO and write TODO.md')
	await until(() => sends === 1 && shown().includes('Working'), 'first turn never started')
	await type('/skills save todo-report')
	await until(
		() => shown().includes('Queued: this runs when the current turn ends.'),
		'/skills save during a turn said nothing',
	)
	await tick(100)
	expect(sends, 'it must not start beside the running turn').toBe(1)

	release()
	await until(() => sends === 2, '/skills save never ran after the turn')
	await until(() => shown().includes('ANSWER2'), 'the skill turn never finished')
	await tick(100)
	expect(sent[0]?.steered, 'it was steered into the running turn').toEqual([])
	expect(sent[1]?.prompt).toContain('"from this conversation" mode')
	expect(sent[1]?.prompt).toContain('Name it todo-report.')
	// The first turn was taken up by /skills save, the second is the skill flow.
	expect(now()).not.toContain(PROPOSAL)
	expect(readSuggestionLedger(home).unanswered).toBe(0)
})
