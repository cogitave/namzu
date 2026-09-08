/** Interactive model selection offers the hydrated replacement's exact effort menu. */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Message } from '@namzu/sdk'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import {
	type DetectedProvider,
	PROVIDER_REGISTRY,
	type Preferences,
} from '../../integrations/providers/index.js'
import { writePreferences } from '../../integrations/providers/preferences.js'
import { fakeAgentSession } from '../__fixtures__/agent-session.js'
import type { AgentSession, AgentSessionOptions, SendOptions } from '../agent.js'
import { type Screen, renderToScreen } from './support/screen.js'

const OLD = 'gpt-5.6-sol'
const NEXT = 'gpt-5.6-luna'
const original: Preferences = {
	version: 3,
	providers: [{ id: 'codex', model: OLD }],
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
const closeOld = vi.fn(async () => {})
const closeCandidate = vi.fn(async () => {})
const screens: Screen[] = []
let home: string
let candidateLevels: AgentSession['reasoningEffortLevels']
let sendOld: AgentSession['send']
let activate: (model: string) => Promise<AgentSession>

function deferred<T>() {
	let resolve: (value: T) => void = () => {}
	const promise = new Promise<T>((r) => {
		resolve = r
	})
	return { promise, resolve }
}

function makeSession(model: string): AgentSession {
	return fakeAgentSession({
		providerSummary: 'Codex',
		modelSummary: model,
		// The model listing carries no effort metadata. Only session construction
		// reveals this menu, which deliberately differs from the old session.
		reasoningEffortLevels: model === OLD ? ['low', 'high'] : candidateLevels,
		close: model === OLD ? closeOld : closeCandidate,
		send: async function* (messages, options) {
			sent.push({ model, messages, options })
			if (model === OLD) yield* sendOld(messages, options)
			else yield { kind: 'done', stopReason: 'end_turn' }
		},
	})
}

vi.mock('../../integrations/trust/store.js', () => ({ isTrusted: () => true, trustDir: () => {} }))
vi.mock('../../integrations/updates.js', () => ({ checkUpdates: async () => [] }))
vi.mock('../../user-commands/store.js', () => ({ discoverUserCommands: () => [] }))
vi.mock('../../integrations/sessions/store.js', () => ({
	openSessions: async () => ({ tenantId: '29b3a0cc-469e-4536-8e4d-ac3301a586a6' }),
	startConversation: async () => '535454a0-3284-474e-80c6-c0c73b5d8eb5',
	requireWritableConversation: async () => {},
	appendMessages: async () => {},
	replaceConversation: async () => {},
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
		describeProviderModels: async () => ({
			kind: 'ok',
			models: [OLD, NEXT].map((id) => ({ id, name: id })),
		}),
		createAgentSession: async (
			prefs: Preferences,
			_detected: readonly DetectedProvider[],
			options: AgentSessionOptions,
		) => {
			constructed.push({ prefs, options })
			return constructed.length === 1 ? makeSession(OLD) : activate(prefs.providers[0]?.model ?? '')
		},
	}
})
const { App } = await import('../App.js')

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), 'namzu-model-effort-'))
	writePreferences(original, home)
	constructed.length = 0
	sent.length = 0
	closeOld.mockClear()
	closeCandidate.mockClear()
	candidateLevels = ['medium', 'xhigh']
	activate = async (model) => makeSession(model)
	sendOld = async function* () {
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
async function shows(screen: Screen, text: string) {
	await until(screen, () => screen.viewport().join('\n').includes(text), `Missing ${text}`)
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
	await shows(screen, 'Type a message')
	return screen
}
async function chooseNextModel(screen: Screen) {
	await submit(screen, '/model')
	await shows(screen, 'Choose a model')
	await shows(screen, NEXT)
	await press(screen, '\x1b[F')
	await press(screen, '\r')
	await until(screen, () => constructed.length === 2, 'Replacement construction did not start')
	expect(constructed[1]?.prefs.providers[0]?.model).toBe(NEXT)
}
function choices(screen: Screen) {
	return screen.viewport().flatMap((row) => {
		const match = /^\s*│\s*(?:›\s*)?\d+\.\s+(\S+)/u.exec(row)
		return match ? [match[1]] : []
	})
}

it('offers exactly the hydrated model levels and sends the chosen effort on the replacement', async () => {
	const screen = await open()
	await submit(screen, '/effort high')
	await shows(screen, 'Reasoning: high (this session).')
	await chooseNextModel(screen)
	await shows(screen, `Select Reasoning Level for ${NEXT}`)
	expect(choices(screen), screen.viewport().join('\n')).toEqual(['default', 'medium', 'xhigh'])
	expect(screen.viewport().join('\n')).toMatch(/›\s*1\.\s+default\s+\[current\] \[default\]/u)
	expect(closeOld).toHaveBeenCalledTimes(1)
	expect(sent).toHaveLength(0)
	await press(screen, '\x1b[F')
	await press(screen, '\r')
	await shows(screen, 'Reasoning: xhigh (this session).')
	await submit(screen, 'Continue this task')
	await until(screen, () => sent.length === 1, 'Prompt did not reach replacement')
	expect(sent[0]?.model).toBe(NEXT)
	expect(sent[0]?.options?.effort).toBe('xhigh')
	await shows(screen, 'Type a message')
	await submit(screen, '/effort')
	await shows(screen, `Select Reasoning Level for ${NEXT}`)
	expect(choices(screen)).toEqual(['default', 'medium', 'xhigh'])
	await press(screen, '1')
	await shows(screen, 'Reasoning: provider default.')
	await submit(screen, 'Use the provider default now')
	await until(screen, () => sent.length === 2, 'Separate effort command did not resume composer')
	expect(sent[1]?.model).toBe(NEXT)
	expect(sent[1]?.options?.effort).toBeUndefined()
})

it('keeps the selected model with provider-default effort when the effort menu is cancelled', async () => {
	const screen = await open()
	await submit(screen, '/effort high')
	await shows(screen, 'Reasoning: high (this session).')
	await chooseNextModel(screen)
	await shows(screen, `Select Reasoning Level for ${NEXT}`)
	await press(screen, '\x1b')
	await shows(screen, 'Type a message')
	expect(screen.viewport().join('\n')).not.toContain('Select Reasoning Level')
	await submit(screen, 'Use the selected model')
	await until(screen, () => sent.length === 1, 'Effort cancellation stranded composer')
	expect(sent[0]?.model).toBe(NEXT)
	expect(sent[0]?.options?.effort).toBeUndefined()
	expect(closeOld).toHaveBeenCalledTimes(1)
	expect(closeCandidate).not.toHaveBeenCalled()
})

it.each([
	{ label: 'unknown', levels: undefined },
	{ label: 'known-empty', levels: [] },
])('skips the effort menu for a $label replacement menu', async ({ levels }) => {
	candidateLevels = levels
	const screen = await open()
	await chooseNextModel(screen)
	await shows(screen, 'Type a message')
	expect(screen.viewport().join('\n')).not.toContain('Select Reasoning Level')
	await submit(screen, 'Continue without an effort override')
	await until(screen, () => sent.length === 1, 'Composer did not resume')
	expect(sent[0]?.model).toBe(NEXT)
	expect(sent[0]?.options?.effort).toBeUndefined()
})

it('does not show a late effort menu after model construction is cancelled', async () => {
	const candidate = deferred<AgentSession>()
	activate = () => candidate.promise
	const screen = await open()
	await chooseNextModel(screen)
	await press(screen, '\x1b')
	await shows(screen, 'Type a message')
	candidate.resolve(makeSession(NEXT))
	await until(screen, () => closeCandidate.mock.calls.length === 1, 'Late candidate was not closed')
	expect(screen.viewport().join('\n')).not.toContain('Select Reasoning Level')
	expect(closeOld).not.toHaveBeenCalled()
	await submit(screen, 'Continue on the original model')
	await until(screen, () => sent.length === 1, 'Original session did not remain usable')
	expect(sent[0]?.model).toBe(OLD)
})

it.each([
	{ action: 'chosen', input: '\r', effort: 'xhigh' },
	{ action: 'cancelled', input: '\x1b', effort: undefined },
])(
	'holds a failed turn queue until the replacement effort is $action',
	async ({ input, effort }) => {
		const releaseFailure = deferred<void>()
		sendOld = async function* () {
			await releaseFailure.promise
			yield { kind: 'error', message: 'Old model refused this task' }
		}
		const screen = await open()
		await submit(screen, '/effort high')
		await shows(screen, 'Reasoning: high (this session).')
		await submit(screen, 'Initial task')
		await until(screen, () => sent.length === 1, 'Old turn did not start')
		await submit(screen, 'Dependent queued task')
		releaseFailure.resolve()
		await shows(screen, 'paused after a failed turn')
		await chooseNextModel(screen)
		await shows(screen, `Select Reasoning Level for ${NEXT}`)
		await screen.waitForRender()
		expect(sent).toHaveLength(1)
		await press(screen, '\x1b[F')
		await press(screen, input)
		await until(screen, () => sent.length === 2, 'Effort choice did not release queued prompt')
		expect(sent.map((request) => request.model)).toEqual([OLD, NEXT])
		expect(sent.map((request) => request.options?.effort)).toEqual(['high', effort])
		expect(sent[1]?.messages.at(-1)).toMatchObject({
			role: 'user',
			content: 'Dependent queued task',
		})
	},
)
