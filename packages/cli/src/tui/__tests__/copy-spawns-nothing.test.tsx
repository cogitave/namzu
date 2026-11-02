/**
 * With `NAMZU_NO_CLIPBOARD=1` the rendered App, running `/copy` over a REAL
 * copier whose host describes a WSL machine with PowerShell present, starts no
 * process. `node:child_process` is replaced so that a spawn is recorded and
 * refused: the control case proves the same rig would have reached it.
 */

import type { Message, StopReason } from '@namzu/sdk'
import { render } from 'ink-testing-library'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Preferences } from '../../integrations/providers/index.js'
import { genericPresenter } from '../__fixtures__/generic-presenter.js'
import type { AgentEvent, AgentSession } from '../agent.js'
import type { TuiContext } from '../types.js'

const spawned: string[] = []
vi.mock('node:child_process', async (importOriginal) => {
	const actual = await importOriginal<typeof import('node:child_process')>()
	return {
		...actual,
		spawn: (command: string) => {
			spawned.push(command)
			throw new Error('refused by the test')
		},
	}
})

const PREFS: Preferences = { version: 3, providers: [{ id: 'openai' }], subagents: { active: [] } }

type TurnScript = {
	readonly text: string
	readonly stopReason?: StopReason
	readonly hold?: boolean
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
const ctx: TuiContext = { cwd: '/w', version: '0.0.0-test' }
const tick = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms))
const mounted: { unmount: () => void }[] = []

beforeEach(() => {
	spawned.length = 0
	turns = [{ text: 'an answer' }]
	sendCalls = 0
	recentConversations = []
	loadedConversation = []
	resetHeldTurn()
})

afterEach(() => {
	releaseHeldTurn()
	for (const harness of mounted) harness.unmount()
	mounted.length = 0
	vi.unstubAllEnvs()
})

const wslHost = {
	platform: 'linux' as const,
	env: { WSL_DISTRO_NAME: 'test' },
	which: () => '/usr/bin/powershell.exe',
	exists: () => true,
}

async function frameShows(harness: { readonly frames: readonly string[] }, text: string) {
	const wanted = text.replace(/\s+/g, ' ')
	await vi.waitFor(() => expect(harness.frames.join('\n').replace(/\s+/g, ' ')).toContain(wanted))
}

async function copyTheAnswer(): Promise<void> {
	const harness = render(<App ctx={ctx} clipboard={wslHost} />)
	mounted.push(harness)
	await frameShows(harness, '❯ Type a message… (/help for commands)')
	harness.stdin.write('hello')
	await tick()
	harness.stdin.write('\r')
	await frameShows(harness, 'an answer')
	await tick(100)
	harness.stdin.write('/copy')
	await tick()
	harness.stdin.write('\r')
	await frameShows(harness, 'Copy from response')
	harness.stdin.write('\r')
	await frameShows(harness, "Couldn't copy")
}

describe('/copy under the clipboard kill switch', () => {
	it('starts no process when NAMZU_NO_CLIPBOARD=1', async () => {
		vi.stubEnv('NAMZU_NO_CLIPBOARD', '1')
		await copyTheAnswer()
		expect(spawned).toEqual([])
	})

	it('control: the same rig reaches the spawn without the switch', async () => {
		vi.stubEnv('NAMZU_NO_CLIPBOARD', '')
		await copyTheAnswer()
		expect(spawned).toEqual(['/usr/bin/powershell.exe'])
	})
})
