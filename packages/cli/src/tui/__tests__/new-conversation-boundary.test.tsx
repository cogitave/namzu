/**
 * `/clear` and `/new` are conversation boundaries, not transcript cosmetics.
 *
 * These are rendered App observers because every local helper can be correct
 * while the mutable scope, model-history ref, queue, or provider admission in
 * App still points at the conversation being left. The store is real: each
 * assertion reloads the durable projection from disk.
 */

import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Message } from '@namzu/sdk'
import { render } from 'ink-testing-library'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import type { Preferences } from '../../integrations/providers/index.js'
import type { AgentEvent, AgentSession, RunScope } from '../agent.js'
import type { TuiContext } from '../types.js'

const PREFS: Preferences = {
	version: 3,
	providers: [{ id: 'openai' }],
	subagents: { active: [] },
}

let holdFirstEvidenceStart = false
let failFreshStart = false
let evidenceStarts = 0
let evidenceReached: Promise<void>
let markEvidenceReached: () => void = () => {}
let evidenceRelease: Promise<void>
let releaseEvidence: () => void = () => {}

let runningRelease: Promise<void>
let releaseRunning: () => void = () => {}

const sends: Array<{
	messages: readonly Message[]
	sessionId: string | null
	signal: AbortSignal | undefined
}> = []
let sharedScope: RunScope | undefined

function resetGates(): void {
	evidenceReached = new Promise<void>((resolve) => {
		markEvidenceReached = resolve
	})
	evidenceRelease = new Promise<void>((resolve) => {
		releaseEvidence = resolve
	})
	runningRelease = new Promise<void>((resolve) => {
		releaseRunning = resolve
	})
}

vi.mock('../../integrations/trust/store.js', () => ({
	isTrusted: () => true,
	trustDir: () => {},
}))

vi.mock('../../integrations/updates.js', () => ({
	checkUpdates: async () => [],
}))

vi.mock('../../integrations/sessions/store.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../integrations/sessions/store.js')>()
	return {
		...actual,
		startConversation: async (sessions: Parameters<typeof actual.startConversation>[0]) => {
			if (failFreshStart) {
				failFreshStart = false
				throw new Error('TARGET_CREATE_FAILED')
			}
			return await actual.startConversation(sessions)
		},
		openSessions: async (cwd: string) => {
			const sessions = await actual.openSessions(cwd)
			const evidence = sessions.turnEvidence
			if (!evidence) return sessions
			const wrapped = new Proxy(evidence, {
				get(target, property, receiver) {
					if (property === 'recordTurnStarted') {
						return async (input: Parameters<typeof evidence.recordTurnStarted>[0]) => {
							const record = await evidence.recordTurnStarted(input)
							evidenceStarts += 1
							if (holdFirstEvidenceStart && evidenceStarts === 1) {
								markEvidenceReached()
								await evidenceRelease
							}
							return record
						}
					}
					const value = Reflect.get(target, property, receiver)
					return typeof value === 'function' ? value.bind(target) : value
				},
			})
			return { ...sessions, turnEvidence: wrapped }
		},
	}
})

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
		createAgentSession: async (
			_preferences: Preferences,
			_detected: readonly unknown[],
			options: { readonly scope?: RunScope },
		): Promise<AgentSession> => {
			sharedScope = options.scope
			return {
				hasProvider: true,
				sandbox: { unconfined: true, enforced: [], required: [] },
				compact: async () => null,
				providerSummary: 'boundary-provider',
				modelSummary: 'boundary-model',
				toolNames: () => [],
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
				close: async () => {},
				approvalLatched: () => false,
				promptExemptTools: () => [],
				send: async function* (messages, sendOptions): AsyncIterable<AgentEvent> {
					const sessionId = sharedScope?.sessionId ?? null
					sends.push({
						messages: [...messages],
						sessionId,
						signal: sendOptions?.signal,
					})
					const prompt = messages.at(-1)?.content
					const text = typeof prompt === 'string' ? prompt : JSON.stringify(prompt)
					yield { kind: 'delta', text: `answer:${text}` } as AgentEvent
					if (text.includes('HOLD_RUNNING')) {
						await runningRelease
						yield { kind: 'delta', text: ' LATE_OLD_REPLY' } as AgentEvent
					}
					yield { kind: 'done', stopReason: 'end_turn' } as AgentEvent
				},
			}
		},
	}
})

const { App } = await import('../App.js')
const { listRecent, loadConversation, openSessions } = await import(
	'../../integrations/sessions/store.js'
)
const { conversationMarkdown } = await import('../../integrations/sessions/transcript-export.js')

const roots: string[] = []
const mounted: Array<{ unmount: () => void }> = []
const tick = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms))

beforeEach(() => {
	holdFirstEvidenceStart = false
	failFreshStart = false
	evidenceStarts = 0
	sends.length = 0
	sharedScope = undefined
	resetGates()
})

afterEach(() => {
	releaseEvidence()
	releaseRunning()
	for (const harness of mounted.splice(0)) harness.unmount()
	for (const root of roots.splice(0)) removeTempDir(root)
})

async function cwd(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), 'namzu-new-conversation-'))
	roots.push(root)
	return root
}

async function until(check: () => boolean, why: string, timeoutMs = 4_000): Promise<void> {
	const started = performance.now()
	while (!check() && performance.now() - started < timeoutMs) await tick(20)
	expect(check(), why).toBe(true)
}

async function submit(
	harness: { stdin: { write: (value: string) => void } },
	text: string,
): Promise<void> {
	harness.stdin.write(text)
	await tick(20)
	harness.stdin.write('\r')
	await tick(40)
}

function textOf(messages: readonly Message[]): string {
	return messages
		.map((message) => (typeof message.content === 'string' ? message.content : ''))
		.join(' ')
}

async function durableConversations(root: string): Promise<readonly (readonly Message[])[]> {
	const sessions = await openSessions(root)
	return await Promise.all(
		(await listRecent(sessions)).map((item) => loadConversation(sessions, item.id)),
	)
}

async function renderApp(root: string) {
	const ctx: TuiContext = { cwd: root, version: '0.0.0-test' }
	const harness = render(<App ctx={ctx} />)
	mounted.push(harness)
	await until(() => sharedScope !== undefined, 'the durable session never became ready')
	return harness
}

it('/clear isolates provider context and durable history while keeping the source resumable', async () => {
	const root = await cwd()
	const harness = await renderApp(root)

	await submit(harness, 'FIRST_PRIVATE_FACT')
	await until(() => sends.length === 1, 'the first turn never reached the provider')
	const sourceSession = sharedScope?.sessionId
	if (!sourceSession) throw new Error('fixture requires a durable source conversation')
	await until(
		asyncFlag(async () =>
			(await durableConversations(root)).some((m) => textOf(m).includes('FIRST_PRIVATE_FACT')),
		),
		'the first turn never reached durable history',
	)

	await submit(harness, '/clear')
	await until(
		() => (harness.lastFrame() ?? '').includes('Started a fresh conversation'),
		'the fresh conversation boundary was not reported',
	)
	const freshSession = sharedScope?.sessionId
	expect(freshSession).not.toBe(sourceSession)

	await submit(harness, 'SECOND_ONLY')
	await until(() => sends.length === 2, 'the second turn never reached the provider')
	await until(
		asyncFlag(async () => (await durableConversations(root)).length === 2),
		'the two conversations were not durably isolated',
	)

	expect(textOf(sends[1]?.messages ?? [])).toContain('SECOND_ONLY')
	expect(textOf(sends[1]?.messages ?? [])).not.toContain('FIRST_PRIVATE_FACT')
	const durable = await durableConversations(root)
	expect(durable).toHaveLength(2)
	expect(
		durable.filter((messages) => textOf(messages).includes('FIRST_PRIVATE_FACT')),
	).toHaveLength(1)
	expect(durable.filter((messages) => textOf(messages).includes('SECOND_ONLY'))).toHaveLength(1)
	expect(
		durable.some(
			(messages) =>
				textOf(messages).includes('FIRST_PRIVATE_FACT') && textOf(messages).includes('SECOND_ONLY'),
		),
	).toBe(false)
})

it('/new keeps the old display but resets model and copy targets', async () => {
	const root = await cwd()
	const harness = await renderApp(root)

	await submit(harness, 'VISIBLE_OLD_TURN')
	await until(() => sends.length === 1, 'the old turn never reached the provider')
	await submit(harness, '/new')
	await until(
		() => (harness.lastFrame() ?? '').includes('Earlier rows above are display only'),
		'/new did not describe the visible context boundary',
	)
	await submit(harness, '/copy')
	await until(
		() => (harness.lastFrame() ?? '').includes('Nothing to copy yet'),
		'/new retained the prior conversation copy target',
	)
	await submit(harness, 'FRESH_VISIBLE_TURN')
	await until(() => sends.length === 2, 'the fresh visible turn never reached the provider')

	expect(textOf(sends[1]?.messages ?? [])).toContain('FRESH_VISIBLE_TURN')
	expect(textOf(sends[1]?.messages ?? [])).not.toContain('VISIBLE_OLD_TURN')
	await until(
		asyncFlag(async () => (await durableConversations(root)).length === 2),
		'/new did not persist both isolated conversations',
	)
})

it('leaves the current context and running turn intact when the durable target cannot be created', async () => {
	const root = await cwd()
	const harness = await renderApp(root)

	await submit(harness, 'HOLD_RUNNING_FAIL_TARGET')
	await until(() => sends.length === 1, 'the source turn never reached the provider')
	const sourceSession = sharedScope?.sessionId
	failFreshStart = true
	await submit(harness, '/clear')
	await until(
		() => (harness.lastFrame() ?? '').includes('TARGET_CREATE_FAILED'),
		'the failed target creation was not reported',
	)

	expect(sharedScope?.sessionId, 'the failed operation moved the durable scope').toBe(sourceSession)
	expect(sends[0]?.signal?.aborted, 'the failed operation interrupted the source turn').toBe(false)
	releaseRunning()
	await until(
		asyncFlag(async () =>
			(await durableConversations(root)).some((messages) =>
				textOf(messages).includes('LATE_OLD_REPLY'),
			),
		),
		'the unchanged source turn stopped settling after the failed operation',
	)
	await submit(harness, 'AFTER_FAILED_CLEAR')
	await until(() => sends.length === 2, 'the source conversation did not accept another turn')
	expect(textOf(sends[1]?.messages ?? [])).toContain('HOLD_RUNNING_FAIL_TARGET')
	expect(textOf(sends[1]?.messages ?? [])).toContain('LATE_OLD_REPLY')
	expect(textOf(sends[1]?.messages ?? [])).toContain('AFTER_FAILED_CLEAR')
})

it('does not admit an old turn to session.send after clear crosses its durable-start await', async () => {
	holdFirstEvidenceStart = true
	const root = await cwd()
	const harness = await renderApp(root)

	await submit(harness, 'HELD_BEFORE_PROVIDER')
	await evidenceReached
	const sourceSession = sharedScope?.sessionId
	if (!sourceSession) throw new Error('fixture requires a durable source conversation')
	expect(sends).toHaveLength(0)

	await submit(harness, '/clear')
	await until(
		() =>
			sharedScope?.sessionId !== sourceSession &&
			(harness.lastFrame() ?? '').includes('Started a fresh conversation'),
		'the conversation did not switch while turn evidence was held',
	)
	await submit(harness, 'NEW_AFTER_HELD')
	await until(() => sends.length === 1, 'the new conversation turn never reached the provider')
	expect(textOf(sends[0]?.messages ?? [])).toContain('NEW_AFTER_HELD')
	expect(textOf(sends[0]?.messages ?? [])).not.toContain('HELD_BEFORE_PROVIDER')

	releaseEvidence()
	await until(
		asyncFlag(async () =>
			(await durableConversations(root)).some((messages) =>
				textOf(messages).includes('HELD_BEFORE_PROVIDER'),
			),
		),
		'the cancelled pre-provider turn was not saved to its source conversation',
	)
	expect(sends, 'the abandoned turn entered the provider after its ledger await').toHaveLength(1)
	const sessions = await openSessions(root)
	const exportedSource = await conversationMarkdown(sessions, sourceSession)
	expect(exportedSource.markdown).toContain('HELD_BEFORE_PROVIDER')
	expect(exportedSource.markdown).toContain('cancelled before model execution began')
})

it('fences late events and persistence from a running turn after /clear', async () => {
	const root = await cwd()
	const harness = await renderApp(root)

	await submit(harness, 'HOLD_RUNNING')
	await until(() => sends.length === 1, 'the running turn never reached the provider')
	const sourceSession = sharedScope?.sessionId
	await submit(harness, '/clear')
	await until(
		() => sharedScope?.sessionId !== sourceSession,
		'the running turn did not yield to a new conversation',
	)
	await submit(harness, 'NEW_SETTLES_FIRST')
	await until(() => sends.length === 2, 'the fresh turn never settled ahead of the old one')
	releaseRunning()
	await until(
		asyncFlag(async () => (await durableConversations(root)).length === 2),
		'the old and new turns did not settle into separate conversations',
	)

	expect(sends[0]?.signal?.aborted, 'the old provider turn was not interrupted').toBe(true)
	expect(textOf(sends[1]?.messages ?? [])).toContain('NEW_SETTLES_FIRST')
	expect(textOf(sends[1]?.messages ?? [])).not.toContain('HOLD_RUNNING')
	expect(harness.frames.join('\n')).not.toContain('LATE_OLD_REPLY')
	const durable = await durableConversations(root)
	expect(
		durable.some(
			(messages) =>
				textOf(messages).includes('HOLD_RUNNING') && textOf(messages).includes('NEW_SETTLES_FIRST'),
		),
	).toBe(false)

	await submit(harness, 'THIRD_AFTER_OLD_UNWINDS')
	await until(() => sends.length === 3, 'the conversation did not accept a turn after old unwind')
	expect(textOf(sends[2]?.messages ?? [])).toContain('NEW_SETTLES_FIRST')
	expect(textOf(sends[2]?.messages ?? [])).toContain('THIRD_AFTER_OLD_UNWINDS')
	expect(textOf(sends[2]?.messages ?? [])).not.toContain('HOLD_RUNNING')
	expect(textOf(sends[2]?.messages ?? [])).not.toContain('LATE_OLD_REPLY')
})

/** Lift an async disk predicate into the polling helper without fixed sleeps. */
function asyncFlag(check: () => Promise<boolean>): () => boolean {
	let value = false
	let running = false
	return () => {
		if (!running && !value) {
			running = true
			void check().then(
				(result) => {
					value = result
					running = false
				},
				() => {
					running = false
				},
			)
		}
		return value
	}
}
