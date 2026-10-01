/** Peer-triggered failures must hold automatic work until operator continuation. */

import { InMemoryTaskStore, type Message, generateSessionId } from '@namzu/sdk'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import type { Preferences } from '../../integrations/providers/index.js'
import type { AgentEvent, AgentSession } from '../agent.js'
import type { LivePeersOptions, PeerMail } from '../../integrations/peers/runtime.js'
import type { TuiContext } from '../types.js'
import { renderToScreen } from './support/screen.js'
import { genericPresenter } from '../__fixtures__/generic-presenter.js'

const PREFS: Preferences = {
	version: 3,
	providers: [{ id: 'openai' }],
	subagents: { active: [] },
}

const sent: Message[][] = []
const delivered: Message[][] = []
let taskStore = new InMemoryTaskStore()
let releaseFirstTurn: () => void = () => {}
let firstTurnGate = Promise.resolve()
let peerOptions: LivePeersOptions | undefined
const peerInbox: PeerMail[] = []
let peerEnabled = true

vi.mock('../../integrations/peers/runtime.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../integrations/peers/runtime.js')>()
	return {
		...actual,
		openLivePeers: async (options: LivePeersOptions) => {
			peerOptions = options
			return {
				id: generateSessionId(),
				ref: 'fixture',
				publish: () => {},
				list: async () => [],
				send: async () => ({ status: 'refused' }),
				get enabled() {
					return peerEnabled
				},
				get pending() {
					return peerInbox.length
				},
				setEnabled(value: boolean) {
					peerEnabled = value
					if (value) options.available()
				},
				peek(owner: number) {
					return owner === options.owner() && peerEnabled ? [...peerInbox] : []
				},
				take(owner: number) {
					return owner === options.owner() && peerEnabled ? peerInbox.splice(0) : []
				},
				takeExact(owner: number, id: string) {
					const index = peerInbox.findIndex((m) => m.owner === owner && m.id === id)
					return index < 0 ? undefined : peerInbox.splice(index, 1)[0]
				},
				close: async () => {
					peerEnabled = false
				},
			}
		},
	}
})

vi.mock('../../integrations/trust/store.js', () => ({
	isTrusted: () => true,
	trustDir: () => {},
}))
vi.mock('../../integrations/updates.js', () => ({
	checkUpdates: async () => [],
}))
vi.mock('../../integrations/sessions/store.js', () => ({
	// The /resume and /abandon paths ask for the parked turn first; none here.
	activeConversationTurn: async () => undefined,
	openSessions: async () => ({
		tenantId: 'tenant',
	}),
	startConversation: async () => 'd5700245-2b3e-4529-b3fb-bf747e847ca0',
	requireWritableConversation: async () => {},
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
			compact: async () => null,
			providerSummary: 'provider',
			modelSummary: 'model',
			reasoningEffortLevels: [],
			toolNames: () => [],
			presenter: genericPresenter,
			currentTaskStore: () => taskStore,
			errorHint: null,
			errorKind: null,
			instructionFiles: [],
			skippedInstructionFiles: [],
			mcpConnected: [],
			mcpFailed: [],
			agentIds: [],
			configNotices: [],
			resumeDurable: async () => {
				throw new Error('not used')
			},
			resumePaused: () => {
				throw new Error('resumePaused is not part of this test')
			},
			close: async () => {},
			approvalLatched: () => false,
			promptExemptTools: () => [],
			send: async function* (messages, options): AsyncIterable<AgentEvent> {
				const turn = sent.length
				sent.push([...messages])
				yield {
					kind: 'delta',
					text: turn === 0 ? 'first answer\n\n' : 'queued answer\n\n',
				}
				if (turn === 0) await firstTurnGate
				const live = options?.inboundMessages?.() ?? []
				delivered.push([...live])
				yield { kind: 'error', message: 'peer failure fixture' }
			},
		}),
	}
})

const { App } = await import('../App.js')

const ctx: TuiContext = { cwd: '/w', version: '0.0.0-test' }

async function waitUntil(
	screen: Awaited<ReturnType<typeof renderToScreen>>,
	predicate: () => boolean,
	message: string,
): Promise<void> {
	for (let attempt = 0; attempt < 120; attempt += 1) {
		await screen.waitForRender()
		if (predicate()) return
		await new Promise<void>((resolve) => setImmediate(resolve))
	}
	throw new Error(message)
}

async function typeAndPress(
	screen: Awaited<ReturnType<typeof renderToScreen>>,
	text: string,
	key: string,
): Promise<void> {
	screen.press(text)
	await screen.waitForRender()
	screen.press(key)
	await screen.waitForRender()
}

beforeEach(() => {
	peerOptions = undefined
	peerInbox.length = 0
	peerEnabled = true
	sent.length = 0
	delivered.length = 0
	taskStore = new InMemoryTaskStore()
	firstTurnGate = new Promise<void>((resolve) => {
		releaseFirstTurn = resolve
	})
})

afterEach(() => {
	releaseFirstTurn()
	vi.restoreAllMocks()
})

function enqueuePeer(text: string) {
	if (!peerOptions) throw new Error('peer host was not opened')
	peerInbox.push({
		id: generateSessionId(),
		owner: peerOptions.owner(),
		from: {
			sessionId: generateSessionId(),
			ref: 'sender',
			name: 'Other terminal',
			address: 'uds:/fixture',
			mode: 'default',
			kind: 'tui',
		},
		text,
	})
	peerOptions.available()
}

it('holds later peer mail after an empty-queue failure, and resumes only on operator input', async () => {
	const screen = await renderToScreen(<App ctx={ctx} />, { cols: 110, rows: 30 })
	try {
		await waitUntil(
			screen,
			() => peerOptions?.ready() === true,
			'App did not open its ready peer host',
		)
		enqueuePeer('first peer message')
		await waitUntil(screen, () => sent.length === 1, 'idle peer mail did not start a turn')
		expect(sent[0]?.at(-1)).toMatchObject({
			source: { type: 'runtime-context', kind: 'peer-message' },
		})
		releaseFirstTurn()
		await waitUntil(
			screen,
			() => screen.scrollback().some((line) => line.includes('peer failure fixture')),
			'peer failure was not shown',
		)
		// Settle the iterator and the real React queue effects, rather than measuring a timeout.
		for (let i = 0; i < 4; i++) await screen.waitForRender()
		enqueuePeer('held second peer message')
		await typeAndPress(screen, '/peers', '\r')
		await waitUntil(
			screen,
			() => screen.scrollback().some((line) => line.includes('1 pending')),
			'held inbox was not reported',
		)
		expect(sent).toHaveLength(1)
		expect(peerInbox).toHaveLength(1)
		await typeAndPress(screen, 'continue after checking the error', '\r')
		await waitUntil(
			screen,
			() =>
				delivered.some((messages) =>
					messages.some((message) => String(message.content).includes('held second peer message')),
				),
			'explicit continuation did not deliver held mail',
		)
		for (let i = 0; i < 4; i++) await screen.waitForRender()
		expect(sent).toHaveLength(2)
		expect(peerInbox).toHaveLength(0)
		expect(
			screen
				.viewport()
				.filter((line) => line.includes('│'))
				.join('\n'),
		).not.toContain('held second peer message')
		expect(
			delivered
				.flat()
				.find((message) => String(message.content).includes('held second peer message')),
		).toMatchObject({ source: { type: 'runtime-context', kind: 'peer-message' } })
	} finally {
		await screen.unmount()
	}
})
