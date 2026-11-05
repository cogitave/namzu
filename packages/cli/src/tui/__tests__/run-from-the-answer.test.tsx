/**
 * `/run` puts a command from the latest answer in the prompt after `!`. The person
 * reads it, may change it, and presses Enter: nothing runs on its own. These drive
 * the rendered App, because the command, the picker and the composer draft have to
 * agree end to end.
 */

import { tmpdir } from 'node:os'
import type { Message, StopReason } from '@namzu/sdk'

import { render } from 'ink-testing-library'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import type { ClipboardCopier, CopyOutcome } from '../../integrations/clipboard/copy.js'
import type { Preferences } from '../../integrations/providers/index.js'
import { genericPresenter } from '../__fixtures__/generic-presenter.js'
import type { AgentEvent, AgentSession } from '../agent.js'
import type { TuiContext } from '../types.js'

const PREFS: Preferences = { version: 3, providers: [{ id: 'openai' }], subagents: { active: [] } }

type TurnScript = {
	readonly text: string
	readonly stopReason?: StopReason
	readonly hold?: boolean
}

const requested: string[] = []
const sentOutcome = (text: string): CopyOutcome => ({
	chars: [...text].length,
	bytes: Buffer.byteLength(text, 'utf8'),
	native: null,
	osc52: 'sent',
	tmuxBuffer: false,
})
let clipboardResult: ((text: string) => CopyOutcome) | undefined
const copier: ClipboardCopier = {
	copy: async (text) => {
		requested.push(text)
		return (clipboardResult ?? sentOutcome)(text)
	},
}
let turns: TurnScript[] = []
let sendCalls = 0
let releaseHeldTurn: () => void = () => {}
let heldTurn: Promise<void> = Promise.resolve()
let recentConversations: Array<{ id: string; title: string; updatedAt: string; count: number }> = []
let loadedConversation: Message[] = []

function resetHeldTurn(): void {
	heldTurn = new Promise<void>((resolve) => {
		releaseHeldTurn = resolve
	})
}

vi.mock('../../integrations/trust/store.js', () => ({ isTrusted: () => true, trustDir: () => {} }))
vi.mock('../../integrations/updates.js', () => ({ checkUpdates: async () => [] }))
vi.mock('../../integrations/sessions/store.js', () => ({
	// The /resume and /abandon paths ask for the parked turn first; none here.
	activeConversationTurn: async () => undefined,
	openSessions: async () => ({ tenantId: 't', root: '/tmp/.namzu' }),
	startConversation: async () => 'conv',
	requireWritableConversation: async () => {},
	appendMessages: async () => {},
	replaceConversation: async () => {},
	listRecent: async () => recentConversations,
	loadConversation: async () => loadedConversation,
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
			providerSummary: 'a-provider',
			modelSummary: 'a-model',
			toolNames: () => [],
			presenter: genericPresenter,
			errorHint: null,
			errorKind: null,
			instructionFiles: [],
			skippedInstructionFiles: [],
			mcpConnected: [],
			mcpFailed: [],
			agentIds: [],
			configNotices: [],
			promptExemptTools: () => [],
			compact: async () => null,
			resumeDurable: async () => {
				throw new Error('not used by the TUI')
			},
			resumePaused: () => {
				throw new Error('resumePaused is not part of this test')
			},
			close: async () => {},
			send: async function* (): AsyncIterable<AgentEvent> {
				const script = turns[sendCalls]
				sendCalls += 1
				if (!script) throw new Error(`No turn script at index ${sendCalls - 1}`)
				yield { kind: 'delta', text: script.text } as AgentEvent
				if (script.hold) await heldTurn
				yield {
					kind: 'done',
					...(script.stopReason ? { stopReason: script.stopReason } : {}),
				} as AgentEvent
			},
		}),
	}
})

const { App } = await import('../App.js')
// A real folder: the `!` line runs a real shell in it.
const ctx: TuiContext = { cwd: tmpdir(), version: '0.0.0-test' }
const tick = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms))
const mounted: { unmount: () => void }[] = []

beforeEach(() => {
	requested.length = 0
	clipboardResult = undefined
	turns = []
	sendCalls = 0
	recentConversations = []
	loadedConversation = []
	resetHeldTurn()
})

afterEach(() => {
	releaseHeldTurn()
	for (const harness of mounted) harness.unmount()
	mounted.length = 0
	vi.restoreAllMocks()
})

// No deadline of its own: a frame that never shows the text is a hang, and the per-test timeout says so.
async function frameShows(harness: { readonly frames: readonly string[] }, text: string) {
	const wanted = text.replace(/\s+/g, ' ')
	while (!harness.frames.join('\n').replace(/\s+/g, ' ').includes(wanted)) await tick(20)
}

async function submit(harness: { stdin: { write: (value: string) => void } }, text: string) {
	harness.stdin.write(text)
	await tick()
	harness.stdin.write('\r')
}

async function mountReady() {
	const harness = render(<App ctx={ctx} clipboard={copier} />)
	mounted.push(harness)
	await frameShows(harness, '❯ Type a message… (/help for commands)')
	return harness
}

async function answered(text: string) {
	turns = [{ text }]
	const harness = await mountReady()
	await submit(harness, 'answer me')
	while (sendCalls < 1) await tick(20)
	await tick(80)
	return harness
}

it('says so when the latest answer has no command', async () => {
	const harness = await answered('Nothing to run here, only prose.')
	await submit(harness, '/run')
	await frameShows(harness, 'No command to run in the latest answer')
})

it('puts the one command of the answer in the prompt after `!`, and runs nothing until Enter', async () => {
	const harness = await answered('Run this:\n\n```bash\nprintf run-ok\n```\n')
	await submit(harness, '/run')
	await frameShows(harness, 'The command is in the prompt: press Enter to run it')
	await frameShows(harness, '!printf run-ok')
	expect(harness.frames.join('\n')).not.toContain('exit 0')
	await tick(100)
	harness.stdin.write('\r')
	await frameShows(harness, 'exit 0')
	await frameShows(harness, 'run-ok')
	expect(requested).toEqual([])
})

it('offers a picker when the answer has several, and puts the chosen one in the prompt', async () => {
	const harness = await answered(
		'First:\n\n```sh\nprintf one\n```\n\nA config, not a command:\n\n```json\n{"a":1}\n```\n\nThen:\n\n```bash\nprintf two\n```\n',
	)
	await submit(harness, '/run')
	await frameShows(harness, 'Run from response')
	// Two entries: the sh block and the bash one; the json block is not a command.
	await frameShows(harness, '1/2')
	harness.stdin.write('2')
	await frameShows(harness, '!printf two')
	expect(requested).toEqual([])
})
