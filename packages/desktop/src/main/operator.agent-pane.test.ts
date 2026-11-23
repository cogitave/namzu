import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import type { DesktopEvent } from '../shared/protocol.js'
import type { AgentPaneRelayLike } from './agent-pane-acp.js'
import { RelayError, type RelayEvent } from './agent-pane-relay.js'
import { Operator } from './operator.js'

const operators: Operator[] = []
const folders: string[] = []
afterEach(async () => {
	await Promise.all(operators.splice(0).map((owner) => owner.close()))
	for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true })
})

function fakeRelay() {
	let listener: ((event: RelayEvent) => void) | undefined
	const relay = {
		open: vi.fn(async (_input: { conversationId: string; rules?: unknown }) => ({
			tabId: 'tab-1',
			targetInfo: { targetId: 'F1' },
		})),
		cdp: vi.fn(
			async (_input: {
				conversationId: string
				tabId: string
				method: string
			}) => ({
				ok: true,
			}),
		),
		close: vi.fn(),
		onEvent: (next: (event: RelayEvent) => void) => {
			listener = next
			return () => {
				listener = undefined
			}
		},
		releaseConversation: vi.fn(),
		conversationEnded: vi.fn(),
	}
	return {
		relay: relay as unknown as AgentPaneRelayLike & typeof relay,
		emit: (e: RelayEvent) => listener?.(e),
	}
}

function harness(options: { pane?: boolean; allowed?: () => boolean } = {}) {
	const events = new EventEmitter()
	const folder = mkdtempSync(join(tmpdir(), 'namzu-agent-pane-'))
	folders.push(folder)
	const log = join(folder, 'requests.jsonl')
	const pane = fakeRelay()
	const owner = new Operator(
		{
			program: process.execPath,
			args: [fileURLToPath(new URL('./__fixtures__/rpc-process.mjs', import.meta.url))],
			env: {
				...process.env,
				FIXTURE_REQUEST_LOG: log,
				...(options.pane === false ? {} : { FIXTURE_AGENT_PANE: '1' }),
			},
			capabilities: () => ['namzu/browser-pane'],
		},
		(event: DesktopEvent) => events.emit('update', event),
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		{
			agentPane: {
				relay: pane.relay,
				allowed: options.allowed ?? (() => true),
			},
		},
	)
	operators.push(owner)
	const requests = () =>
		readFileSync(log, 'utf8')
			.split('\n')
			.filter(Boolean)
			.map(
				(line) =>
					JSON.parse(line) as {
						method: string
						params: Record<string, unknown>
					},
			)
	const turnEnded = (id: string): Promise<void> =>
		new Promise((resolve) => {
			const receive = (event: DesktopEvent) => {
				if (event.kind === 'state' && event.sessionId === id && !event.running) {
					events.off('update', receive)
					resolve()
				}
			}
			events.on('update', receive)
		})
	return { owner, pane, requests, turnEnded }
}

async function browse(
	h: ReturnType<typeof harness>,
): Promise<{ answers: Record<string, unknown>; id: string }> {
	const { owner } = h
	const project = await owner.openProject(process.cwd())
	const session = await owner.newConversation(project.id)
	const ended = h.turnEnded(session.id)
	await owner.send(session.id, 'Browse with fixture')
	await ended
	const reply = (await owner.openConversation(project.id, session.id)).thread?.messages.at(-1) as {
		text: string
	}
	return {
		answers: JSON.parse(reply.text) as Record<string, unknown>,
		id: session.id,
	}
}

it('names the capability to the engine, and serves its requests for the conversation that owns the session', async () => {
	const h = harness()
	const { pane, requests } = h
	const { answers, id } = await browse(h)
	const initialize = requests().find((item) => item.method === 'initialize')
	expect(initialize?.params.capabilities).toEqual([
		'permission',
		'namzu/tasks',
		'namzu/browser-pane',
	])
	// The relay is called with the app's conversation, never the engine's own session id.
	expect(pane.relay.open).toHaveBeenCalledTimes(1)
	expect(pane.relay.open.mock.calls[0]?.[0]).toEqual({
		conversationId: id,
		rules: { deny: ['bad.example'] },
	})
	expect(pane.relay.cdp.mock.calls[0]?.[0]).toMatchObject({
		conversationId: id,
		tabId: 'tab-1',
		method: 'Page.enable',
	})
	expect(answers.pane_1).toEqual({
		result: { tabId: 'tab-1', targetInfo: { targetId: 'F1' } },
	})
	expect(answers.pane_2).toEqual({ result: { result: { ok: true } } })
	// A session the app has no conversation for is refused and the relay is not asked.
	expect(answers.pane_3).toMatchObject({
		error: { data: { code: 'unavailable' } },
	})
	expect(pane.relay.close).toHaveBeenCalledWith({
		conversationId: id,
		tabId: 'tab-1',
	})
	expect(answers.pane_4).toEqual({ result: {} })
})

it('answers a refused call with the relay’s own words and code', async () => {
	const h = harness()
	const { pane } = h
	pane.relay.cdp.mockRejectedValueOnce(
		new RelayError('human-in-control', 'The person has taken over this tab.'),
	)
	const { answers } = await browse(h)
	expect(answers.pane_2).toEqual({
		error: {
			code: -32000,
			message: 'The person has taken over this tab.',
			data: { code: 'human-in-control' },
		},
	})
})

it('stops serving when the setting moves the agent’s browser to its own window', async () => {
	const h = harness({ allowed: () => false })
	const { pane } = h
	const { answers } = await browse(h)
	expect(pane.relay.open).not.toHaveBeenCalled()
	expect(answers.pane_1).toMatchObject({
		error: {
			message: 'Namzu is set to browse in a window of its own.',
			data: { code: 'unavailable' },
		},
	})
})

it('says the relay’s events to the engine of the conversation, with the engine’s own session id', async () => {
	const h = harness()
	const { owner, pane, requests } = h
	const { id } = await browse(h)
	pane.emit({
		kind: 'cdp',
		conversationId: id,
		tabId: 'tab-1',
		method: 'Page.loadEventFired',
		params: { timestamp: 1 },
		sessionId: 'child',
	})
	pane.emit({ kind: 'tab-closed', conversationId: id, tabId: 'tab-2' })
	pane.emit({
		kind: 'state',
		conversationId: id,
		tabId: 'tab-1',
		state: 'person',
	})
	pane.emit({
		kind: 'detached',
		conversationId: 'someone-else',
		tabId: 'tab-1',
		reason: 'x',
	})
	// The engine handles its lines in order, so its answer to this one means it has read the rest.
	await owner.jobs(id)
	const sent = requests().filter((item) => item.method.startsWith('namzu/browser/pane/'))
	const mine = sent.filter(
		(item) =>
			item.method === 'namzu/browser/pane/event' || item.method === 'namzu/browser/pane/state',
	)
	expect(mine.map((item) => item.method)).toEqual([
		'namzu/browser/pane/event',
		'namzu/browser/pane/event',
		'namzu/browser/pane/state',
	])
	expect(mine[0]?.params).toMatchObject({
		kind: 'cdp',
		tabId: 'tab-1',
		method: 'Page.loadEventFired',
		cdpSessionId: 'child',
	})
	expect(typeof mine[0]?.params.sessionId).toBe('string')
	expect(mine[2]?.params).toMatchObject({ tabId: 'tab-1', state: 'person' })
})

it('sends the engine nothing when it did not list the Browser pane methods', async () => {
	const { owner, pane, requests } = harness({ pane: false })
	const project = await owner.openProject(process.cwd())
	const session = await owner.newConversation(project.id)
	pane.emit({ kind: 'tab-closed', conversationId: session.id, tabId: 'tab-1' })
	await owner.jobs(session.id)
	expect(requests().some((item) => item.method.startsWith('namzu/browser/pane/'))).toBe(false)
})

it('lets go of the tabs when its engine goes, and closes them when the conversation is removed', async () => {
	const { owner, pane } = harness()
	const project = await owner.openProject(process.cwd())
	const session = await owner.newConversation(project.id)
	await owner.close()
	expect(pane.relay.releaseConversation).toHaveBeenCalledWith(session.id, 'engine-closed', false)

	const second = harness()
	const secondProject = await second.owner.openProject(process.cwd())
	const secondSession = await second.owner.newConversation(secondProject.id)
	await second.owner.removeConversation(secondSession.id)
	expect(second.pane.relay.conversationEnded).toHaveBeenCalledWith(secondSession.id)
})
