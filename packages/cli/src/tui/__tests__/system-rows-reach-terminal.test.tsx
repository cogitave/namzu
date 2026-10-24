/**
 * The rows a person meets only when something unusual happens: a hook speaks,
 * the provider changes, a compaction fails, a reply stops or pauses, a `!`
 * command finishes, `/compact` runs. Each is produced by the real mapper from
 * the kernel's own event and drawn by the real App, so the words, the dot and
 * the absence of developer vocabulary are checked where the person reads them.
 */

import type { SessionEvent, SessionId, TurnId } from '@namzu/sdk'
import { beforeEach, expect, it, vi } from 'vitest'

import type { Preferences } from '../../integrations/providers/index.js'
import { fakeAgentSession } from '../__fixtures__/agent-session.js'
import type { AgentEvent } from '../agent.js'
import { type Screen, renderToScreen } from './support/screen.js'

const preferences: Preferences = {
	version: 3,
	providers: [{ id: 'openai' }],
	subagents: { active: [] },
}
const turnId = 'f4e0af37-43f7-48fd-82b0-f1b1c68881d3' as TurnId
const sessionId = '02b19846-c793-4e21-9c6e-21962a7d2de5' as SessionId
const env = { turnId, sessionId, iteration: 1 }
const sdk = (value: object) => ({ ...env, ...value }) as unknown as SessionEvent

/** What each prompt makes the fake model's turn yield. */
let scripts: Record<string, (toAgentEvent: ToAgentEvent) => AgentEvent[]> = {}
type ToAgentEvent = (event: SessionEvent) => AgentEvent | null
let compactCalls = 0

vi.mock('../../integrations/trust/store.js', () => ({ isTrusted: () => true, trustDir: () => {} }))
vi.mock('../../integrations/updates.js', () => ({ checkUpdates: async () => [] }))
vi.mock('../../user-commands/store.js', () => ({ discoverUserCommands: () => [] }))
vi.mock('../../integrations/sessions/store.js', () => ({
	activeConversationTurn: async () => undefined,
	openSessions: async () => ({ tenantId: 'a3b15478-78be-44e8-ad59-f6e4cec8a1ec' }),
	startConversation: async () => 'f173a4b7-62d2-4705-878b-d15f52c8cde8',
	requireWritableConversation: async () => {},
	appendMessages: async () => {},
	listRecent: async () => [],
	loadConversation: async () => [],
}))
vi.mock('../agent.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../agent.js')>()
	const session = () =>
		fakeAgentSession({
			modelSummary: 'rows-fixture',
			compact: async () => {
				compactCalls += 1
				return {
					summary: 'The person asked two things and both were answered.',
					messages: [
						{ role: 'user', content: 'second question' },
						{ role: 'assistant', content: 'second answer' },
					],
				} as never
			},
			send: async function* (messages): AsyncIterable<AgentEvent> {
				const last = messages.at(-1)
				const text = typeof last?.content === 'string' ? last.content : ''
				const script = scripts[text]
				if (script) {
					const map: ToAgentEvent = (event) => actual.toAgentEvent(event, session().presenter)
					for (const event of script(map)) yield event
					return
				}
				yield { kind: 'delta', text: `Answer to ${text}` }
				yield { kind: 'done', stopReason: 'end_turn' }
			},
		})
	return {
		...actual,
		probeAgentSession: async () => ({ preferences, needsRepickReason: null, detected: [] }),
		createAgentSession: async () => session(),
	}
})

const { App } = await import('../App.js')

beforeEach(() => {
	scripts = {}
	compactCalls = 0
})

async function until(screen: Screen, predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 200; attempt += 1) {
		await screen.waitForRender()
		if (predicate()) return
	}
	throw new Error(`The expected state did not reach the terminal:\n${screen.viewport().join('\n')}`)
}

async function submit(screen: Screen, text: string): Promise<void> {
	screen.press(text)
	await screen.waitForRender()
	screen.press('\r')
	await screen.waitForRender()
}

async function boot(): Promise<Screen> {
	const screen = await renderToScreen(<App ctx={{ cwd: process.cwd(), version: '0.0.0-test' }} />, {
		cols: 100,
		rows: 40,
	})
	await until(screen, () => screen.viewport().join('\n').includes('rows-fixture'))
	return screen
}

const text = (screen: Screen) => screen.scrollback().join('\n')

const DEVELOPER_WORDS =
	/reducer|Provider chain|fallback #|HTTP \d{3}|rate_limit|\[COMPACTED|OSC 52/i

it('draws a hook that stops or speaks as a level row in plain words', async () => {
	scripts.hooks = (map) => {
		const halted = map(
			sdk({
				type: 'plugin_hook_completed',
				hookEvent: 'post_tool_use',
				pluginId: 'p',
				result: { action: 'continue', halt: { reason: 'change freeze' } },
			}),
		)
		const said = map(
			sdk({
				type: 'plugin_hook_completed',
				hookEvent: 'post_tool_use',
				pluginId: 'p',
				result: { action: 'continue', notice: 'careful with the lockfile' },
			}),
		)
		return [halted, said, { kind: 'done', stopReason: 'end_turn' }].filter(Boolean) as AgentEvent[]
	}
	const screen = await boot()
	try {
		await submit(screen, 'hooks')
		await until(screen, () => text(screen).includes('careful with the lockfile'))
		const shown = text(screen)
		expect(shown).toContain('● A hook stopped this reply: change freeze')
		expect(shown).toContain('● A hook says: careful with the lockfile')
		expect(shown).not.toMatch(/this turn|^\s*! /m)
	} finally {
		await screen.unmount()
	}
})

it('draws a provider switch by product name, with no chain, status or code', async () => {
	scripts.switch = (map) =>
		[
			map(
				sdk({
					type: 'provider_fallback',
					fromIndex: 0,
					fromProviderId: 'openai',
					toIndex: 1,
					toProviderId: 'anthropic',
					code: 'rate_limit',
					status: 429,
				}),
			),
			{ kind: 'delta', text: 'Carrying on.' },
			{ kind: 'done', stopReason: 'end_turn' },
		].filter(Boolean) as AgentEvent[]
	const screen = await boot()
	try {
		await submit(screen, 'switch')
		await until(screen, () => text(screen).includes('Namzu used'))
		expect(text(screen)).not.toMatch(DEVELOPER_WORDS)
		expect(text(screen)).not.toContain('⇄')
	} finally {
		await screen.unmount()
	}
})

it('draws a failed compaction as one plain sentence without the reducer or the raw error', async () => {
	scripts.squeeze = (map) =>
		[
			map(
				sdk({
					type: 'compaction_failed',
					cause: 'reducer_threw',
					messages: 31,
					error: 'ECONNRESET',
				}),
			),
			{ kind: 'delta', text: 'Still answering.' },
			{ kind: 'done', stopReason: 'end_turn' },
		].filter(Boolean) as AgentEvent[]
	const screen = await boot()
	try {
		await submit(screen, 'squeeze')
		await until(screen, () => text(screen).includes('Compaction failed'))
		expect(text(screen)).not.toMatch(/reducer|ECONNRESET|messages unchanged/i)
	} finally {
		await screen.unmount()
	}
})

it.each([
	['refusal', 'step_refused', 'The model refused to continue.'],
	['stopcond', 'stop_condition', 'a stop condition you set was met'],
] as const)(
	'draws a %s stop as a warning dot with a sentence',
	async (prompt, reason, sentence) => {
		scripts[prompt] = () => [
			{ kind: 'delta', text: 'Partial work.' },
			{ kind: 'done', stopReason: reason },
		]
		const screen = await boot()
		try {
			await submit(screen, prompt)
			await until(screen, () => text(screen).includes(sentence))
			expect(text(screen)).not.toContain('■')
			expect(text(screen)).not.toMatch(/Stopped:/)
		} finally {
			await screen.unmount()
		}
	},
)

it('draws a pause a tool asked for with what to do, no checkpoint id and no raw keys', async () => {
	scripts.pausing = () => [
		{
			kind: 'paused',
			turnId,
			checkpointId: 'ckpt-0199aaaa-bbbb',
			reason: 'sign in',
			handoff: {
				kind: 'human-required',
				reason: 'Sign in to the site, then continue.',
				detail: { login_url: 'https://x.test/login' },
			},
		},
	]
	const screen = await boot()
	try {
		await submit(screen, 'pausing')
		await until(screen, () => text(screen).includes('Paused'))
		const shown = text(screen)
		expect(shown).toContain('Sign in to the site, then continue.')
		expect(shown).not.toContain('login_url')
		expect(shown).not.toContain('ckpt-0199aaaa-bbbb')
		expect(shown).not.toContain('‖')
	} finally {
		await screen.unmount()
	}
})

it('draws a finished ! command as a level dot and a sentence, not a tick or a bang line', async () => {
	const screen = await boot()
	try {
		await submit(screen, '!echo hello')
		await until(screen, () => text(screen).includes('echo hello finished (exit 0)'))
		const shown = text(screen)
		expect(shown).toContain('● echo hello finished (exit 0)')
		expect(shown).not.toMatch(/✓ echo|✗ echo|^\s*! echo/m)
	} finally {
		await screen.unmount()
	}
})

it('keeps /compact and its result where it ran, below the turns that stay', async () => {
	const screen = await boot()
	try {
		await submit(screen, 'first question')
		await until(screen, () => text(screen).includes('Answer to first question'))
		await submit(screen, 'second question')
		await until(screen, () => text(screen).includes('Answer to second question'))
		await submit(screen, '/compact')
		await until(screen, () => text(screen).includes('Compacted'))
		expect(compactCalls).toBe(1)
		const shown = text(screen)
		const echo = shown.indexOf('› /compact')
		const result = shown.indexOf('Compacted (ctrl+o')
		expect(echo).toBeGreaterThan(shown.indexOf('Answer to second question'))
		expect(result).toBeGreaterThan(echo)
		expect(shown).not.toMatch(/Verifier|\[COMPACTED/)
	} finally {
		await screen.unmount()
	}
})

it('shows the stop-all hint in the footer, below the composer, not in the transcript', async () => {
	const screen = await boot()
	try {
		screen.press('\x18')
		await screen.waitForRender()
		screen.press('\x0b')
		await until(screen, () => screen.viewport().join('\n').includes('No background agents running'))
		// The footer line is below the composer; nothing was written above it.
		const rows = screen.viewport()
		const hintRow = rows.findIndex((row) => row.includes('No background agents running'))
		const composerRow = rows.findIndex((row) => row.includes('Type a message'))
		expect(hintRow).toBeGreaterThan(composerRow)
	} finally {
		await screen.unmount()
	}
})
