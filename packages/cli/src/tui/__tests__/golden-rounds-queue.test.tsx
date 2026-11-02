/**
 * Golden transcript of queued messages through the rendered App.
 *
 * Tab queues a message behind the running reply; Enter steers it into the
 * reply; a failed reply pauses what is queued; Esc keeps the queue visible but
 * paused; Ctrl+C throws it away. These scenarios record what the session was
 * asked and must pass unchanged after the round machinery moves out of the
 * screen. Each wait is a rendered frame or a deferred the test releases.
 */

import { afterEach, expect, it, vi } from 'vitest'

import type { Preferences } from '../../integrations/providers/index.js'
import { fakeAgentSession } from '../__fixtures__/agent-session.js'
import { RoundLog } from '../__fixtures__/round-log.js'
import type { AgentEvent, SendOptions } from '../agent.js'
import type { TuiContext } from '../types.js'
import { type Screen, renderToScreen } from './support/screen.js'

const PREFS: Preferences = {
	version: 3,
	providers: [{ id: 'openai' }],
	subagents: { active: [] },
}

const roundLog = new RoundLog()
/** What each send does, by its index; the last repeats. */
type Behaviour = (index: number, options: SendOptions | undefined) => AsyncIterable<AgentEvent>
let behaviour: Behaviour = async function* () {
	yield { kind: 'done', stopReason: 'end_turn' }
}

vi.mock('../../integrations/trust/store.js', () => ({
	isTrusted: () => true,
	trustDir: () => {},
}))
vi.mock('../../integrations/updates.js', () => ({
	checkUpdates: async () => [],
}))
vi.mock('../../integrations/sessions/store.js', () => ({
	activeConversationTurn: async () => undefined,
	openSessions: async () => ({ tenantId: 't' }),
	startConversation: async () => 'conv',
	requireWritableConversation: async () => {},
	appendMessages: async () => {},
	listRecent: async () => [],
	loadConversation: async () => [],
}))
vi.mock('../../user-commands/store.js', () => ({
	discoverUserCommands: () => [],
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
		createAgentSession: async () =>
			fakeAgentSession({
				providerSummary: 'a-provider',
				modelSummary: 'a-model',
				send: (messages, options) => {
					const index = roundLog.entries.length
					roundLog.record(messages, options)
					return behaviour(index, options)
				},
			}),
	}
})

const { App } = await import('../App.js')
const ctx: TuiContext = { cwd: '/work', version: '0.0.0-test' }
let mounted: Screen | null = null

afterEach(async () => {
	await mounted?.unmount()
	mounted = null
	roundLog.clear()
	behaviour = async function* () {
		yield { kind: 'done', stopReason: 'end_turn' }
	}
	vi.restoreAllMocks()
})

function deferred(): {
	readonly promise: Promise<void>
	readonly resolve: () => void
} {
	let resolve!: () => void
	return {
		promise: new Promise<void>((done) => {
			resolve = done
		}),
		resolve,
	}
}

async function waitUntil(screen: Screen, predicate: () => boolean, attempts = 160): Promise<void> {
	for (let index = 0; index < attempts && !predicate(); index += 1) {
		await screen.waitForRender()
	}
	expect(predicate(), screen.viewport().join('\n')).toBe(true)
}

async function boot(): Promise<Screen> {
	const screen = await renderToScreen(<App ctx={ctx} />, {
		cols: 120,
		rows: 40,
		scrollback: 200,
	})
	mounted = screen
	await waitUntil(screen, () => screen.scrollback().join('\n').includes('a-model'))
	return screen
}

async function type(screen: Screen, text: string, key: string): Promise<void> {
	screen.press(text)
	await screen.waitForRender()
	screen.press(key)
	await screen.waitForRender()
}

it('G3 runs Tab-queued messages in the order they were queued', async () => {
	const hold = deferred()
	behaviour = async function* (index) {
		if (index === 0) await hold.promise
		yield { kind: 'done', stopReason: 'end_turn' }
	}
	const screen = await boot()
	await type(screen, 'one', '\r')
	await waitUntil(screen, () => roundLog.entries.length === 1)
	await type(screen, 'two', '\t')
	await type(screen, 'three', '\t')
	expect(roundLog.entries).toHaveLength(1)
	hold.resolve()
	await waitUntil(screen, () => roundLog.entries.length === 3)
	expect(roundLog.lines()).toMatchInlineSnapshot(`
		[
		  "#0 typed rows=1 "one"",
		  "#1 typed rows=1 "two"",
		  "#2 typed rows=1 "three"",
		]
	`)
})

it('G3 holds the rest of the queue after a failed reply and runs it once continued', async () => {
	const hold = deferred()
	behaviour = async function* (index) {
		if (index === 0) {
			await hold.promise
			yield { kind: 'error', message: 'provider failed' }
			return
		}
		yield { kind: 'done', stopReason: 'end_turn' }
	}
	const screen = await boot()
	await type(screen, 'one', '\r')
	await waitUntil(screen, () => roundLog.entries.length === 1)
	await type(screen, 'two', '\t')
	await type(screen, 'three', '\t')
	hold.resolve()
	await waitUntil(screen, () =>
		screen.viewport().join('\n').includes('Paused after the failed reply'),
	)
	// Give a wrongly started queued message every chance to run before asserting.
	await screen.waitForRender()
	await screen.waitForRender()
	expect(roundLog.entries).toHaveLength(1)
	// The panel says a message sent now runs first, then the held ones.
	await type(screen, 'four', '\r')
	await waitUntil(screen, () => roundLog.entries.length === 4)
	expect(roundLog.lines()).toMatchInlineSnapshot(`
		[
		  "#0 typed rows=1 "one"",
		  "#1 typed rows=1 "two"",
		  "#2 typed rows=1 "three"",
		  "#3 typed rows=1 "four"",
		]
	`)
})

it('G3 throws the queue away on Ctrl+C', async () => {
	const hold = deferred()
	behaviour = async function* (index) {
		if (index === 0) await hold.promise
		yield { kind: 'done', stopReason: 'end_turn' }
	}
	const screen = await boot()
	await type(screen, 'one', '\r')
	await waitUntil(screen, () => roundLog.entries.length === 1)
	await type(screen, 'two', '\t')
	screen.press('\x03')
	await screen.waitForRender()
	hold.resolve()
	await screen.waitForRender()
	await screen.waitForRender()
	await screen.waitForRender()
	expect(roundLog.lines()).toMatchInlineSnapshot(`
		[
		  "#0 typed rows=1 "one"",
		]
	`)
})

it('G3 keeps the queue held after Esc and runs the next message before it', async () => {
	const hold = deferred()
	behaviour = async function* (index) {
		if (index === 0) await hold.promise
		yield { kind: 'done', stopReason: 'end_turn' }
	}
	const screen = await boot()
	await type(screen, 'one', '\r')
	await waitUntil(screen, () => roundLog.entries.length === 1)
	await type(screen, 'two', '\t')
	screen.press('\x1b')
	// A lone Esc is told apart from a key sequence by the terminal layer; wait for its effect.
	while (!screen.viewport().join('\n').includes('Held after you stopped the reply')) {
		await screen.waitForRender()
		await new Promise<void>((resolve) => setImmediate(resolve))
	}
	hold.resolve()
	await screen.waitForRender()
	await screen.waitForRender()
	await screen.waitForRender()
	expect(roundLog.lines()).toMatchInlineSnapshot(`
		[
		  "#0 typed rows=1 "one"",
		]
	`)
	await type(screen, 'next', '\r')
	await waitUntil(screen, () => roundLog.entries.length === 3)
	expect(roundLog.lines()).toMatchInlineSnapshot(`
		[
		  "#0 typed rows=1 "one"",
		  "#1 typed rows=1 "next"",
		  "#2 typed rows=1 "two"",
		]
	`)
})

it('G5 holds queued messages while a call question is open and runs them after the answer', async () => {
	const hold = deferred()
	let answered: unknown
	behaviour = async function* (index, options) {
		if (index === 0) {
			await hold.promise
			answered = await options?.onPermission?.({
				toolCalls: [
					{
						id: 'c1',
						name: 'bash',
						input: { command: 'npm test' },
						isDestructive: false,
					},
				],
				perCall: true,
				signal: new AbortController().signal,
				turnId: 'turn-1',
			} as never)
		}
		yield { kind: 'done', stopReason: 'end_turn' }
	}
	const screen = await boot()
	await type(screen, 'one', '\r')
	await waitUntil(screen, () => roundLog.entries.length === 1)
	await type(screen, 'two', '\t')
	hold.resolve()
	await waitUntil(screen, () => screen.viewport().join('\n').includes('enter confirm'))
	await screen.waitForRender()
	// The question is open: the screen is waiting on a person, so the queued message waits.
	expect(roundLog.lines()).toMatchInlineSnapshot(`
		[
		  "#0 typed rows=1 "one"",
		]
	`)
	// A question ignores keys for a short guard after it opens; offer the answer until it is taken.
	while (answered === undefined) {
		screen.press('y')
		await screen.waitForRender()
		await new Promise<void>((resolve) => setImmediate(resolve))
	}
	while (roundLog.entries.length < 2) {
		await screen.waitForRender()
		await new Promise<void>((resolve) => setImmediate(resolve))
	}
	expect(roundLog.lines()).toMatchInlineSnapshot(`
		[
		  "#0 typed rows=1 "one"",
		  "#1 typed rows=1 "two"",
		]
	`)
	expect(answered).toMatchObject({ kind: 'approve' })
})

it('G5 ends the turn and holds the queue when Esc closes a call question', async () => {
	const hold = deferred()
	let answered: unknown
	behaviour = async function* (index, options) {
		if (index === 0) {
			await hold.promise
			answered = await options?.onPermission?.({
				toolCalls: [
					{
						id: 'c1',
						name: 'bash',
						input: { command: 'npm test' },
						isDestructive: false,
					},
				],
				perCall: true,
				signal: new AbortController().signal,
				turnId: 'turn-1',
			} as never)
		}
		yield { kind: 'done', stopReason: 'cancelled' }
	}
	const screen = await boot()
	await type(screen, 'one', '\r')
	await waitUntil(screen, () => roundLog.entries.length === 1)
	await type(screen, 'two', '\t')
	hold.resolve()
	await waitUntil(screen, () => screen.viewport().join('\n').includes('enter confirm'))
	screen.press('\x1b')
	while (answered === undefined) {
		await screen.waitForRender()
		await new Promise<void>((resolve) => setImmediate(resolve))
	}
	expect(answered).toMatchObject({ kind: 'reject' })
	await screen.waitForRender()
	await screen.waitForRender()
	expect(roundLog.lines()).toMatchInlineSnapshot(`
		[
		  "#0 typed rows=1 "one"",
		  "#1 typed rows=1 "two"",
		]
	`)
})
