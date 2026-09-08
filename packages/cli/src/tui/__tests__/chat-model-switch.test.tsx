/** A model-control tool request changes the next turn only after host settlement. */
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type Message, createAssistantMessage, createToolMessage } from '@namzu/sdk'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import {
	type DetectedProvider,
	PROVIDER_REGISTRY,
	type Preferences,
} from '../../integrations/providers/index.js'
import { preferencesPath, writePreferences } from '../../integrations/providers/preferences.js'
import { fakeAgentSession } from '../__fixtures__/agent-session.js'
import type {
	AgentEvent,
	AgentSession,
	AgentSessionOptions,
	ModelListing,
	SendOptions,
} from '../agent.js'
import type { ModelSwitchOutcome } from '../model-switch.js'
import { type Screen, renderToScreen } from './support/screen.js'

const OLD = 'gpt-5.6-sol'
const NEXT = 'gpt-5.6-luna'
const SESSION_ID = '535454a0-3284-474e-80c6-c0c73b5d8eb5'
const original: Preferences = {
	version: 3,
	providers: [
		{ id: 'codex', model: OLD },
		{ id: 'openai', model: 'fallback-pin' },
	],
	subagents: { active: [] },
	allowCapabilityMismatch: true,
}
const detected: readonly DetectedProvider[] = [
	{
		entry: PROVIDER_REGISTRY.codex,
		source: { kind: 'codex-file', path: '/fixture/auth.json' },
		apiKey: 'fixture-token',
		codex: { accountId: 'fixture-account', origin: 'codex-file' },
		alternatives: [],
	},
]
const constructed: Array<{ prefs: Preferences; options: AgentSessionOptions }> = []
const sent: Array<{ model: string; messages: readonly Message[]; options?: SendOptions }> = []
const outcomes: ModelSwitchOutcome[] = []
const closeOld = vi.fn(async () => {})
const closeCandidate = vi.fn(async () => {})
const screens: Screen[] = []
let home: string
let sendOld: AgentSession['send']
let oldOverrides: Partial<AgentSession>
let activate: (model: string) => Promise<AgentSession>
let persist: () => Promise<void>
let describe: () => Promise<ModelListing>

function deferred<T>() {
	let resolve: (value: T) => void = () => {}
	const promise = new Promise<T>((r) => {
		resolve = r
	})
	return { promise, resolve }
}
function makeSession(model: string, close = closeCandidate): AgentSession {
	return fakeAgentSession({
		providerSummary: 'Codex',
		modelSummary: model,
		reasoningEffortLevels: ['low', 'high'],
		close,
		send: async function* (messages, options) {
			sent.push({ model, messages, options })
			if (model === OLD) yield* sendOld(messages, options)
			else yield { kind: 'done', stopReason: 'end_turn' }
		},
		...(model === OLD ? oldOverrides : {}),
	})
}
vi.mock('../../integrations/trust/store.js', () => ({ isTrusted: () => true, trustDir: () => {} }))
vi.mock('../../integrations/updates.js', () => ({ checkUpdates: async () => [] }))
vi.mock('../../user-commands/store.js', () => ({ discoverUserCommands: () => [] }))
vi.mock('../../integrations/sessions/store.js', () => ({
	openSessions: async () => ({ tenantId: '29b3a0cc-469e-4536-8e4d-ac3301a586a6' }),
	startConversation: async () => SESSION_ID,
	requireWritableConversation: async () => {},
	appendMessages: async () => persist(),
	replaceConversation: async () => persist(),
	listRecent: async () => [],
	loadConversation: async () => [],
}))
vi.mock('../../integrations/providers/index.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../integrations/providers/index.js')>()
	return {
		...actual,
		writePreferences: (prefs: Preferences) => actual.writePreferences(prefs, home),
	}
})
vi.mock('../agent.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../agent.js')>()
	return {
		...actual,
		probeAgentSession: async () => ({ preferences: original, detected, needsRepickReason: null }),
		describeProviderModels: async () => describe(),
		createAgentSession: async (
			prefs: Preferences,
			_detected: readonly DetectedProvider[],
			options: AgentSessionOptions,
		) => {
			constructed.push({ prefs, options })
			return constructed.length === 1
				? makeSession(OLD, closeOld)
				: activate(prefs.providers[0]?.model ?? '')
		},
	}
})
const { App } = await import('../App.js')
beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), 'namzu-chat-switch-'))
	writePreferences(original, home)
	constructed.length = 0
	sent.length = 0
	outcomes.length = 0
	closeOld.mockClear()
	closeCandidate.mockClear()
	oldOverrides = {}
	activate = async (model) => makeSession(model)
	persist = async () => {}
	describe = async () => ({
		kind: 'ok',
		models: [OLD, NEXT, 'gpt-5.6-terra'].map((id) => ({ id, name: id })),
	})
	sendOld = async function* (_messages, options) {
		if (!options?.onModelSwitch) throw new Error('Model-switch callback missing')
		outcomes.push(await options.onModelSwitch({ model: NEXT }))
		yield { kind: 'delta', text: 'The switch is pending.' }
		yield { kind: 'done', stopReason: 'end_turn' }
	}
})
afterEach(async () => {
	for (const screen of screens.splice(0)) await screen.unmount()
	removeTempDir(home)
})
async function until(screen: Screen, predicate: () => boolean, message: string) {
	await vi.waitFor(async () => {
		await screen.waitForRender()
		expect(predicate(), `${message}\n${screen.viewport().join('\n')}`).toBe(true)
	})
}
async function press(screen: Screen, input: string) {
	screen.press(input)
	await screen.waitForRender()
}
async function submit(screen: Screen, text: string) {
	await press(screen, text)
	await press(screen, '\r')
}
async function open() {
	const screen = await renderToScreen(
		<App ctx={{ cwd: '/workspace/namzu', version: '0.0.0-test' }} />,
		{ cols: 100, rows: 30 },
	)
	screens.push(screen)
	await until(
		screen,
		() => screen.viewport().join('\n').includes('Type a message'),
		'App not ready',
	)
	return screen
}

it('switches the queued next turn after settlement and durability, preserving history and saved preferences', async () => {
	const turn = deferred<void>()
	const write = deferred<void>()
	persist = () => write.promise
	let projected: readonly Message[] = []
	sendOld = async function* (messages, options) {
		if (!options?.onModelSwitch) throw new Error('Model-switch callback missing')
		const toolLifetime = new AbortController()
		outcomes.push(await options.onModelSwitch({ model: NEXT }, toolLifetime.signal))
		toolLifetime.abort(new Error('tool completed'))
		projected = [
			...messages,
			createAssistantMessage(null, [
				{
					id: 'switch-1',
					type: 'function',
					function: { name: 'switch_model', arguments: JSON.stringify({ model: NEXT }) },
				},
			]),
			createToolMessage(JSON.stringify(outcomes[0]), 'switch-1'),
			createAssistantMessage('The switch is pending.'),
		]
		options.onConversationMessages?.(projected)
		await turn.promise
		yield { kind: 'delta', text: 'The switch is pending.' }
		yield { kind: 'done', stopReason: 'end_turn' }
	}
	const screen = await open()
	const before = readFileSync(preferencesPath(home), 'utf8')
	await submit(screen, '/effort high')
	await submit(screen, 'switch to gpt-5.6-luna')
	await until(screen, () => outcomes.length === 1, 'Request was not reserved')
	expect(outcomes[0]).toEqual({ kind: 'pending', selection: { id: 'codex', model: NEXT } })
	expect(constructed).toHaveLength(1)
	turn.resolve()
	await until(
		screen,
		() => screen.viewport().join('\n').includes('Type a message'),
		'Turn did not settle',
	)
	await submit(screen, 'continue with the same context')
	expect(sent).toHaveLength(1)
	expect(constructed).toHaveLength(1)
	write.resolve()
	await until(screen, () => sent.length === 2, 'Queued prompt did not use replacement')
	expect(sent.map((request) => request.model)).toEqual([OLD, NEXT])
	expect(sent[1]?.messages.slice(0, projected.length)).toEqual(projected)
	expect(sent[0]?.options?.effort).toBe('high')
	expect(sent[1]?.options?.effort).toBeUndefined()
	expect(constructed[1]?.options.scope?.sessionId).toBe(SESSION_ID)
	expect(constructed[1]?.options.scope).toBe(constructed[0]?.options.scope)
	expect(constructed[1]?.prefs).toEqual({
		...original,
		providers: [{ id: 'codex', model: NEXT }, original.providers[1]],
	})
	expect(constructed.every(({ options }) => options.allowModelSwitch)).toBe(true)
	expect(readFileSync(preferencesPath(home), 'utf8')).toBe(before)
	expect(closeOld).toHaveBeenCalledTimes(1)
})

it('keeps the old session usable when replacement construction fails', async () => {
	activate = async () => {
		throw new Error('Candidate unavailable')
	}
	const screen = await open()
	await submit(screen, 'switch to gpt-5.6-luna')
	await until(
		screen,
		() => screen.viewport().join('\n').includes('Model switch failed: Candidate unavailable'),
		'Refusal missing',
	)
	expect(closeOld).not.toHaveBeenCalled()
	sendOld = async function* (): AsyncIterable<AgentEvent> {
		yield { kind: 'done', stopReason: 'end_turn' }
	}
	await submit(screen, 'continue on the original model')
	await until(screen, () => sent.length === 2, 'Old session stopped working')
	expect(sent.map((request) => request.model)).toEqual([OLD, OLD])
})

it('cancels an in-flight replacement and closes its late candidate without publishing it', async () => {
	const candidate = deferred<AgentSession>()
	activate = () => candidate.promise
	const screen = await open()
	await submit(screen, 'switch to gpt-5.6-luna')
	await until(screen, () => constructed.length === 2, 'Candidate did not start')
	await press(screen, '\x1b')
	await until(
		screen,
		() => screen.viewport().join('\n').includes('Interrupted.'),
		'Pending switch was not interrupted',
	)
	candidate.resolve(makeSession(NEXT))
	await until(screen, () => closeCandidate.mock.calls.length === 1, 'Late candidate was not closed')
	expect(closeOld).not.toHaveBeenCalled()
	expect(screen.viewport().join('\n')).not.toContain(`Switched to codex · ${NEXT}`)
})

it('does not carry a reserved switch into a newly selected conversation', async () => {
	const turn = deferred<void>()
	sendOld = async function* (_messages, options) {
		if (!options?.onModelSwitch) throw new Error('Model-switch callback missing')
		outcomes.push(await options.onModelSwitch({ model: NEXT }))
		await turn.promise
		yield { kind: 'done', stopReason: 'end_turn' }
	}
	const screen = await open()
	await submit(screen, 'switch to gpt-5.6-luna')
	await until(screen, () => outcomes.length === 1, 'Switch not reserved')
	await submit(screen, '/new')
	await until(
		screen,
		() => screen.viewport().join('\n').includes('Started a fresh conversation'),
		'New conversation not selected',
	)
	turn.resolve()
	await screen.waitForRender()
	expect(constructed).toHaveLength(1)
	expect(closeOld).not.toHaveBeenCalled()
})

it.each(['child', 'job'] as const)(
	'refuses to replace a session that still owns an active %s',
	async (kind) => {
		if (kind === 'child')
			oldOverrides = {
				subagents: {
					getSnapshot: () => [
						{
							viewId: 'child',
							agentId: 'worker',
							description: 'Read a file',
							prompt: 'Read a file',
							batchId: 'batch',
							workflowId: 'workflow',
							workflowGroupId: 'workflow',
							phaseId: 'phase',
							workflow: 'Review',
							phase: 'Inspect',
							phaseSequence: 0,
							status: 'working',
							startedAt: Date.now(),
							transcript: [],
						},
					],
					subscribe: () => () => {},
					reset: () => {},
				},
			}
		else
			oldOverrides = {
				jobs: () => [
					{
						id: 'job',
						owner: 'session',
						command: 'build',
						status: 'running',
						startedAt: Date.now(),
					},
				],
			}
		const screen = await open()
		await submit(screen, 'switch to gpt-5.6-luna')
		await until(
			screen,
			() =>
				screen
					.viewport()
					.join('\n')
					.includes(
						kind === 'child'
							? 'Delegated agents are still active'
							: 'Background jobs are still running',
					),
			'Active work was not protected',
		)
		expect(constructed).toHaveLength(1)
		expect(closeOld).not.toHaveBeenCalled()
	},
)

it('rejects an unknown model without constructing or changing a session', async () => {
	sendOld = async function* (_messages, options) {
		if (!options?.onModelSwitch) throw new Error('Model-switch callback missing')
		outcomes.push(await options.onModelSwitch({ model: 'missing-model' }))
		yield { kind: 'done', stopReason: 'end_turn' }
	}
	const screen = await open()
	await submit(screen, 'switch to missing-model')
	await until(screen, () => outcomes.length === 1, 'No rejection')
	expect(outcomes[0]?.kind).toBe('rejected')
	expect(constructed).toHaveLength(1)
})

it('lets the later request win even if an older model lookup finishes last', async () => {
	const first = deferred<ModelListing>()
	let lookups = 0
	describe = async () =>
		++lookups === 1
			? first.promise
			: { kind: 'ok', models: [{ id: 'gpt-5.6-terra', name: 'Terra' }] }
	sendOld = async function* (_messages, options) {
		if (!options?.onModelSwitch) throw new Error('Model-switch callback missing')
		const older = options.onModelSwitch({ model: NEXT })
		await Promise.resolve()
		outcomes.push(await options.onModelSwitch({ model: 'gpt-5.6-terra' }))
		first.resolve({ kind: 'ok', models: [{ id: NEXT, name: 'Luna' }] })
		outcomes.push(await older)
		yield { kind: 'done', stopReason: 'end_turn' }
	}
	const screen = await open()
	await submit(screen, 'switch the model')
	await until(screen, () => constructed.length === 2, 'Latest request did not publish')
	expect(constructed[1]?.prefs.providers[0]?.model).toBe('gpt-5.6-terra')
	expect(outcomes.map((outcome) => outcome.kind)).toEqual(['pending', 'rejected'])
})

it('reuses an accepted request instead of resolving and reserving the same switch again', async () => {
	let lookups = 0
	describe = async () => {
		lookups += 1
		return { kind: 'ok', models: [{ id: NEXT, name: NEXT }] }
	}
	sendOld = async function* (_messages, options) {
		if (!options?.onModelSwitch) throw new Error('Model-switch callback missing')
		outcomes.push(await options.onModelSwitch({ model: NEXT, provider: 'codex' }))
		outcomes.push(await options.onModelSwitch({ model: NEXT }))
		yield { kind: 'done', stopReason: 'end_turn' }
	}
	const screen = await open()
	await submit(screen, 'switch to gpt-5.6-luna')
	await until(screen, () => constructed.length === 2, 'Switch did not publish')
	expect(outcomes).toHaveLength(2)
	expect(outcomes[0]).toEqual(outcomes[1])
	expect(lookups).toBe(1)
	expect(closeOld).toHaveBeenCalledTimes(1)
})
