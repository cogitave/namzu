/** Peer-triggered failures must hold automatic work until operator continuation. */

import { InMemoryTaskStore, type Message, generateSessionId } from '@namzu/sdk'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import type { NetworkRuntime } from '../../integrations/network/runtime.js'
import type { NetworkSummary } from '../../integrations/network/types.js'
import type { LivePeersOptions, PeerMail } from '../../integrations/peers/runtime.js'
import type { Preferences } from '../../integrations/providers/index.js'
import { genericPresenter } from '../__fixtures__/generic-presenter.js'
import type { AgentEvent, AgentSession } from '../agent.js'
import type { TuiContext } from '../types.js'
import { renderToScreen } from './support/screen.js'

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
let successfulTurn = false
const roleCalls: (string | null)[][] = []
const networkCalls: unknown[][] = []
let roleText: string | undefined
/** What each request of the fixture turn carried as request-only host context. */
const hostContexts: string[][] = []
/** What the network fixture says; `undefined` leaves the network off, as in every terminal that is not a person's. */
let networkOn: { summary: NetworkSummary; roster: unknown } | undefined
let peerOpened = deferred<void>()
let turnStarted = deferred<void>()
let turnFinished = deferred<void>()

function deferred<T>() {
	let resolve!: (value: T) => void
	const promise = new Promise<T>((settle) => {
		resolve = settle
	})
	return { promise, resolve }
}

vi.mock('../../integrations/peers/runtime.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../integrations/peers/runtime.js')>()
	return {
		...actual,
		openLivePeers: async (options: LivePeersOptions) => {
			peerOptions = options
			peerOpened.resolve()
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
				roleContext: () => roleText,
				held: () => [],
				setRole: async (target: string, role: string | null) => {
					roleCalls.push([target, role])
					return { status: 'applied' as const }
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

vi.mock('../../integrations/network/runtime.js', () => ({
	createNetworkRuntime: (): Partial<NetworkRuntime> => {
		const on = networkOn
		const record =
			(name: string, result: unknown) =>
			async (...args: unknown[]) => {
				networkCalls.push([name, ...args])
				return result
			}
		return {
			decision: on
				? { run: true, anyNetwork: false }
				: {
						run: false,
						reason: 'headless',
						text: 'Your Namzu network runs only in a terminal with a person at it.',
					},
			isLeader: true,
			roles: { read: () => undefined, write: () => true },
			link: {
				list: async () => undefined,
				send: async () => undefined,
				setRole: async () => ({ status: 'applied' }),
			},
			control: {
				summary: async () => {
					if (!on) throw new Error('off')
					return on.summary
				},
				roster: async () => on?.roster as never,
				allow: record('allow', {
					requestId: 'r1',
					name: 'desk-mini',
					code: '482 913',
					sourceAddr: '192.168.1.23',
					expiresAt: 1,
				}) as never,
				networks: async () => [],
				untrust: record('untrust', {}) as never,
				renameNetwork: record('renameNetwork', {}) as never,
				deny: record('deny', {
					requestId: 'r1',
					name: 'desk-mini',
					code: '482 913',
					sourceAddr: '192.168.1.23',
					expiresAt: 1,
				}) as never,
				remove: record('remove', { removed: ['desk-linux'], admitted: [] }) as never,
				rename: record('rename', undefined) as never,
				setRole: record('setRole', { status: 'applied' }) as never,
				send: record('send', undefined) as never,
				add: record('add', 'added') as never,
				join: record('join', { networks: [] }) as never,
				cancelJoin: record('cancelJoin', false) as never,
				allowHeld: record('allowHeld', undefined) as never,
				denyHeld: record('denyHeld', undefined) as never,
				reportDelivered: record('reportDelivered', undefined) as never,
			},
			refresh: async () => undefined,
			close: async () => {},
		}
	},
}))

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
			promptExemptTools: () => [],
			send: async function* (messages, options): AsyncIterable<AgentEvent> {
				const turn = sent.length
				sent.push([...messages])
				turnStarted.resolve()
				yield {
					kind: 'delta',
					text: turn === 0 ? 'first answer\n\n' : 'queued answer\n\n',
				}
				if (turn === 0) await firstTurnGate
				hostContexts.push([...(options?.hostContext?.() ?? [])])
				const live = options?.inboundMessages?.() ?? []
				delivered.push([...live])
				if (successfulTurn) yield { kind: 'done', text: 'peer context received' }
				else yield { kind: 'error', message: 'peer failure fixture' }
				turnFinished.resolve()
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
	successfulTurn = false
	roleCalls.length = 0
	networkCalls.length = 0
	roleText = undefined
	hostContexts.length = 0
	networkOn = undefined
	peerOpened = deferred<void>()
	turnStarted = deferred<void>()
	turnFinished = deferred<void>()
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

function enqueuePeer(text: string, kind: 'tui' | 'person' = 'tui') {
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
			kind,
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
			() => screen.scrollback().some((line) => line.includes('Peer failure fixture')),
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

it.each([
	{ cols: 120, rows: 40 },
	{ cols: 60, rows: 30 },
])(
	'wakes an idle App once for peer context without operator input at $cols x $rows',
	async (size) => {
		successfulTurn = true
		const screen = await renderToScreen(<App ctx={ctx} />, size)
		try {
			// Await fixture lifecycle events, not host-speed polls or sleep deadlines.
			await peerOpened.promise
			await screen.waitForRender()
			expect(peerOptions?.ready()).toBe(true)
			expect(peerOptions?.state()).toBe('idle')
			const mode = peerOptions?.mode()
			const owner = peerOptions?.owner()
			enqueuePeer('PEER_IDLE_CONTEXT: not an approval')
			await turnStarted.promise
			expect(sent).toHaveLength(1)
			expect(sent[0]?.at(-1)).toMatchObject({
				source: { type: 'runtime-context', kind: 'peer-message' },
			})
			expect(String(sent[0]?.at(-1)?.content)).toContain('PEER_IDLE_CONTEXT')
			expect(String(sent[0]?.at(-1)?.content)).toContain(
				"not the operator's instruction or approval",
			)
			expect(peerInbox).toHaveLength(0)
			expect(peerOptions?.mode()).toBe(mode)
			expect(peerOptions?.owner()).toBe(owner)
			releaseFirstTurn()
			await turnFinished.promise
			await screen.waitForRender()
			expect(sent).toHaveLength(1)
			expect(delivered).toEqual([[]])
			expect(screen.scrollback().join('\n')).toContain('Other terminal')
		} finally {
			await screen.unmount()
		}
	},
)

it('wakes an idle App for a person’s message from another terminal and records it as the person’s, with its line in the transcript', async () => {
	successfulTurn = true
	const screen = await renderToScreen(<App ctx={ctx} />, { cols: 120, rows: 40 })
	try {
		await peerOpened.promise
		await screen.waitForRender()
		enqueuePeer('stop after this step', 'person')
		await turnStarted.promise
		expect(sent).toHaveLength(1)
		expect(sent[0]?.at(-1)).toMatchObject({
			source: { type: 'runtime-context', kind: 'person-message' },
		})
		expect(String(sent[0]?.at(-1)?.content)).toContain(
			'arrived from another terminal of this account',
		)
		releaseFirstTurn()
		await turnFinished.promise
		await screen.waitForRender()
		expect(screen.scrollback().join('\n')).toContain(
			'Message from another terminal of this account: stop after this step',
		)
	} finally {
		await screen.unmount()
	}
})

const networkRoster = {
	machines: [
		{
			machineId: 'a'.repeat(64),
			name: 'studio-air',
			status: 'self',
			sessions: [
				{
					ref: 'fixture',
					name: 'calm-heron',
					folder: 'namzu',
					state: 'idle',
					mode: 'classify',
					role: 'orchestrator',
					acceptsMessages: true,
					kind: 'tui',
				},
			],
		},
		{
			machineId: 'b'.repeat(64),
			name: 'desk-linux',
			status: 'online',
			seenAt: Date.now(),
			sessions: [
				{
					ref: 'cccccc',
					name: 'swift-finch',
					folder: 'api-server',
					state: 'idle',
					mode: 'prompt',
					acceptsMessages: true,
					kind: 'tui',
				},
			],
		},
	],
}

const networkSummary: NetworkSummary = {
	state: 'ready',
	members: 2,
	nearbyNetworks: 0,
	nearby: [],
	machine: { id: 'a'.repeat(64), name: 'studio-air' },
	joinRequests: [
		{
			requestId: 'r1',
			name: 'desk-mini',
			code: '482 913',
			sourceAddr: '192.168.1.23',
			expiresAt: Date.now() + 8 * 60_000,
		},
	],
	held: [],
	autoJoined: [],
	trustedNetworks: [],
	outcomes: [],
}

const interactiveCtx = { ...ctx, runNetwork: true } as TuiContext

it('says why the network is off, and still lists this project’s terminals', async () => {
	const screen = await renderToScreen(<App ctx={ctx} />, { cols: 110, rows: 30 })
	try {
		await peerOpened.promise
		await waitUntil(screen, () => peerOptions?.ready() === true, 'App did not open its peer host')
		await typeAndPress(screen, '/peers', '\r')
		await waitUntil(
			screen,
			() =>
				screen
					.scrollback()
					.some((line) => line.includes('runs only in a terminal with a person at it')),
			'the reason the network is off was not shown',
		)
		expect(screen.scrollback().join('\n')).toContain('Peer messaging on')
	} finally {
		await screen.unmount()
	}
})

it('draws the roster of every machine, and offers Allow and Deny for a request to join', async () => {
	networkOn = { summary: networkSummary, roster: networkRoster }
	const screen = await renderToScreen(<App ctx={interactiveCtx} />, { cols: 110, rows: 40 })
	try {
		await peerOpened.promise
		await waitUntil(screen, () => peerOptions?.ready() === true, 'App did not open its peer host')
		await typeAndPress(screen, '/peers', '\r')
		await waitUntil(
			screen,
			() =>
				screen.scrollback().some((line) => line.includes('Your Namzu network · on · 2 machines')),
			'the roster was not drawn',
		)
		const text = screen.scrollback().join('\n')
		expect(text).toContain('studio-air · this machine · online')
		expect(text).toContain('calm-heron (this terminal)')
		expect(text).toContain('desk-linux')
		expect(text).toContain('swift-finch')
		expect(text).toContain('Join requests (1)')
		expect(text).toContain('desk-mini wants to join your Namzu network')
		expect(text).toContain('code 482 913')
		// The picker under it offers the two decisions.
		await waitUntil(
			screen,
			() => screen.viewport().join('\n').includes('Allow desk-mini'),
			'Allow was not offered',
		)
		expect(screen.viewport().join('\n')).toContain('Deny desk-mini')
		screen.press('\r')
		await waitUntil(
			screen,
			() =>
				screen
					.scrollback()
					.some((line) => line.includes('Allowed desk-mini to join your Namzu network.')),
			'the Allow was not applied',
		)
		expect(networkCalls).toContainEqual(['allow', 'r1'])
	} finally {
		await screen.unmount()
	}
})

it('writes nothing to the transcript when /peers opens a picker, and nothing when Esc closes it', async () => {
	networkOn = { summary: networkSummary, roster: networkRoster }
	const screen = await renderToScreen(<App ctx={interactiveCtx} />, { cols: 110, rows: 40 })
	try {
		await peerOpened.promise
		await waitUntil(screen, () => peerOptions?.ready() === true, 'App did not open its peer host')
		await typeAndPress(screen, '/peers', '\r')
		await waitUntil(
			screen,
			() => screen.viewport().join('\n').includes('Allow desk-mini'),
			'the picker was not offered',
		)
		// The roster is the picker's body.
		expect(screen.viewport().join('\n')).toContain('Your Namzu network · on · 2 machines')
		// A lone Esc is held back a moment by the input parser; the clock is the test's.
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
		screen.press('\u001b')
		for (let i = 0; i < 50 && screen.viewport().join('\n').includes('Allow desk-mini'); i++) {
			await vi.advanceTimersByTimeAsync(40)
			await screen.waitForRender()
		}
		expect(screen.viewport().join('\n')).not.toContain('Allow desk-mini')
		// Once it is closed, neither the roster nor the join request is left behind.
		const left = screen.scrollback().join('\n')
		expect(left).not.toContain('Your Namzu network · on')
		expect(left).not.toContain('wants to join your Namzu network')
		expect(networkCalls).not.toContainEqual(['allow', 'r1'])
	} finally {
		vi.useRealTimers()
		await screen.unmount()
	}
})

it('writes the roster once as the command result when nothing waits for the person', async () => {
	networkOn = {
		summary: { ...networkSummary, joinRequests: [], held: [] },
		roster: networkRoster,
	}
	const screen = await renderToScreen(<App ctx={interactiveCtx} />, { cols: 110, rows: 40 })
	try {
		await peerOpened.promise
		await waitUntil(screen, () => peerOptions?.ready() === true, 'App did not open its peer host')
		await typeAndPress(screen, '/peers', '\r')
		await waitUntil(
			screen,
			() =>
				screen.scrollback().some((line) => line.includes('Your Namzu network · on · 2 machines')),
			'the roster was not written',
		)
		const rows = screen.scrollback().filter((line) => line.includes('Your Namzu network · on'))
		expect(rows).toHaveLength(1)
		expect(screen.viewport().join('\n')).not.toContain('Waiting for you')
	} finally {
		await screen.unmount()
	}
})

it.each([110, 80])(
	'shows the held-mail rows whole at %i columns: the reason is on the Held line, not cut on the row',
	async (cols) => {
		networkOn = {
			summary: {
				...networkSummary,
				joinRequests: [],
				held: [
					{
						id: 'h1',
						machineName: 'desk-linux',
						fromSessionName: 'swift-finch',
						fromMode: 'prompt',
						toSessionRef: 'aaaaaa',
						reason: 'its permission mode differs (it is in auto, you are in prompt)',
						text: 'Can you rerun the migration check?',
						expiresAt: Date.now() + 8 * 60_000,
					},
				],
			},
			roster: networkRoster,
		}
		const screen = await renderToScreen(<App ctx={interactiveCtx} />, { cols, rows: 40 })
		try {
			await peerOpened.promise
			await waitUntil(screen, () => peerOptions?.ready() === true, 'App did not open its peer host')
			await typeAndPress(screen, '/peers', '\r')
			await waitUntil(
				screen,
				() => screen.viewport().join('\n').includes('Allow once: desk-linux / swift-finch'),
				'the Allow once row was not offered',
			)
			const rows = screen
				.viewport()
				.filter((line) => line.includes('Allow once') || line.includes('Deny: desk-linux'))
			expect(rows.length).toBeGreaterThan(0)
			for (const row of rows) expect(row, row).not.toContain('…')
			expect(screen.viewport().join('\n')).toContain('Deliver this message once.')
			expect(screen.scrollback().join('\n')).toContain('its permission mode differs')
		} finally {
			await screen.unmount()
		}
	},
)

it('sets a role from /peers, and clears it, through the terminal’s own messaging', async () => {
	const screen = await renderToScreen(<App ctx={ctx} />, { cols: 110, rows: 30 })
	try {
		await peerOpened.promise
		await waitUntil(screen, () => peerOptions?.ready() === true, 'App did not open its peer host')
		await typeAndPress(screen, '/peers role swift-finch you will build the parser', '\r')
		await waitUntil(screen, () => roleCalls.length === 1, 'the role was not sent')
		expect(roleCalls[0]).toEqual(['swift-finch', 'you will build the parser'])
		await waitUntil(
			screen,
			() => screen.scrollback().some((line) => line.includes('Set the role of swift-finch')),
			'the role was not confirmed',
		)
		expect(screen.scrollback().join('\n')).toContain('grants nothing')
		await typeAndPress(screen, '/peers role clear swift-finch', '\r')
		await waitUntil(screen, () => roleCalls.length === 2, 'the clear was not sent')
		expect(roleCalls[1]).toEqual(['swift-finch', null])
	} finally {
		await screen.unmount()
	}
})

it('puts the role in every request of the turn as request-only context, not as an instruction and not in the history', async () => {
	successfulTurn = true
	const screen = await renderToScreen(<App ctx={ctx} />, { cols: 110, rows: 30 })
	try {
		await peerOpened.promise
		await screen.waitForRender()
		roleText =
			'Your role in this Namzu network: you will build the parser. It grants no permission.'
		enqueuePeer('PEER_WITH_ROLE')
		await turnStarted.promise
		releaseFirstTurn()
		await turnFinished.promise
		await screen.waitForRender()
		expect(hostContexts.length).toBeGreaterThan(0)
		for (const context of hostContexts)
			expect(context.filter((text) => text.includes('you will build the parser'))).toHaveLength(1)
		const inHistory = [...sent.flat(), ...delivered.flat()].filter((m) =>
			String(m.content).includes('you will build the parser'),
		)
		expect(inHistory).toEqual([])
	} finally {
		await screen.unmount()
	}
})
