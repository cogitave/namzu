/** Return steers the active turn; Tab remains a durable next-turn FIFO. */

import type { Message } from '@namzu/sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { Preferences } from '../../integrations/providers/index.js'
import type { AgentEvent, AgentSession, SendOptions } from '../agent.js'
import type { TuiContext } from '../types.js'
import { renderToScreen } from './support/screen.js'

const PREFS: Preferences = {
	version: 3,
	providers: [{ id: 'openai' }],
	subagents: { active: [] },
}
const image = { data: 'AAAA', mediaType: 'image/png' as const }

const sent: Message[][] = []
const sentOptions: SendOptions[] = []
const delivered: Message[][] = []
const replacements: Message[][] = []

let releaseFirstTurn: () => void = () => {}
let firstTurnGate = Promise.resolve()
let drainFirstTurn = true

vi.mock('../../integrations/clipboard/image.js', () => ({
	readClipboardImage: () => ({ kind: 'image' as const, image }),
}))
vi.mock('../../integrations/trust/store.js', () => ({
	isTrusted: () => true,
	trustDir: () => {},
}))
vi.mock('../../integrations/updates.js', () => ({
	checkUpdates: async () => [],
}))
vi.mock('../../user-commands/store.js', () => ({
	discoverUserCommands: () => [],
}))
vi.mock('../../integrations/sessions/store.js', () => ({
	openSessions: async () => ({
		tenantId: 'tenant',
		turnEvidence: {
			recordTurnStarted: async (input: {
				runId: string
				displayText: string
				user: Message
			}) => ({
				...input,
				turnId: `turn_${sent.length + 1}`,
			}),
			recordTurnSettled: async (input: unknown) => input,
		},
	}),
	startConversation: async () => 'ses_live',
	requireWritableConversation: async () => {},
	appendMessages: async () => {},
	replaceConversation: async (_sessions: unknown, _id: string, messages: readonly Message[]) => {
		replacements.push([...messages])
	},
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
			close: async () => {},
			approvalLatched: () => false,
			promptExemptTools: () => [],
			send: async function* (messages, options): AsyncIterable<AgentEvent> {
				const turn = sent.length
				sent.push([...messages])
				sentOptions.push(options ?? {})
				yield {
					kind: 'delta',
					text: turn === 0 ? 'first answer\n\n' : 'queued answer\n\n',
				}
				if (turn === 0) await firstTurnGate
				const live = turn === 0 && !drainFirstTurn ? [] : (options?.inboundMessages?.() ?? [])
				delivered.push([...live])
				if (turn === 0 && live.length > 0) {
					options?.onConversationMessages?.([
						...messages,
						{ role: 'assistant', content: 'first answer', timestamp: 2 },
						...live,
						{ role: 'assistant', content: 'steered answer', timestamp: 4 },
					])
					yield { kind: 'delta', text: 'steered answer\n\n' }
				} else {
					options?.onConversationMessages?.([
						...messages,
						{ role: 'assistant', content: 'queued answer', timestamp: 6 },
					])
				}
				yield { kind: 'done', stopReason: 'end_turn' }
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
	sent.length = 0
	sentOptions.length = 0
	delivered.length = 0
	replacements.length = 0
	drainFirstTurn = true
	firstTurnGate = new Promise<void>((resolve) => {
		releaseFirstTurn = resolve
	})
})

afterEach(() => {
	releaseFirstTurn()
	vi.restoreAllMocks()
})

describe('the two composer destinations', () => {
	it('submits the exact cursor-edited draft through App', async () => {
		const screen = await renderToScreen(<App ctx={ctx} />, {
			cols: 110,
			rows: 28,
		})
		try {
			await waitUntil(
				screen,
				() => screen.scrollback().some((line) => line.includes('Type a message')),
				'App never became ready',
			)
			screen.press('helo')
			await screen.waitForRender()
			screen.press('\x1b[D')
			await screen.waitForRender()
			screen.press('l')
			await screen.waitForRender()
			screen.press('\r')
			await waitUntil(screen, () => sent.length === 1, 'cursor-edited turn did not start')

			expect(sent[0]?.at(-1)).toMatchObject({ role: 'user', content: 'hello' })
			releaseFirstTurn()
		} finally {
			await screen.unmount()
		}
	})

	it('submits an authored multiline draft rather than turning its newline into a paste', async () => {
		const screen = await renderToScreen(<App ctx={ctx} />, {
			cols: 110,
			rows: 28,
		})
		try {
			await waitUntil(
				screen,
				() => screen.scrollback().some((line) => line.includes('Type a message')),
				'App never became ready',
			)
			screen.press('first')
			screen.press('\n')
			screen.press('second')
			await screen.waitForRender()
			screen.press('\r')
			await waitUntil(screen, () => sent.length === 1, 'multiline turn did not start')

			expect(sent[0]?.at(-1)).toMatchObject({ role: 'user', content: 'first\nsecond' })
			releaseFirstTurn()
		} finally {
			await screen.unmount()
		}
	})

	it('searches prior App submissions and sends the selected prompt', async () => {
		const screen = await renderToScreen(<App ctx={ctx} />, {
			cols: 110,
			rows: 28,
		})
		try {
			await waitUntil(
				screen,
				() => screen.scrollback().some((line) => line.includes('Type a message')),
				'App never became ready',
			)
			await typeAndPress(screen, 'fix alpha', '\r')
			await waitUntil(screen, () => sent.length === 1, 'first history turn did not start')
			releaseFirstTurn()
			await waitUntil(screen, () => delivered.length === 1, 'first history turn did not settle')

			screen.press('fix')
			screen.press('\x12')
			await waitUntil(
				screen,
				() => screen.viewport().some((line) => line.includes('history “fix” · 1/1')),
				'App did not expose the history selection',
			)
			screen.press('\r')
			await waitUntil(screen, () => sent.length === 2, 'selected history prompt did not start')

			expect(sent[1]?.at(-1)).toMatchObject({ role: 'user', content: 'fix alpha' })
		} finally {
			await screen.unmount()
		}
	})

	it('drains Return into the active SDK turn and keeps Tab for the following turn', async () => {
		const screen = await renderToScreen(<App ctx={ctx} />, {
			cols: 110,
			rows: 28,
		})
		try {
			await waitUntil(
				screen,
				() => screen.scrollback().some((line) => line.includes('Type a message')),
				'App never became ready',
			)
			await typeAndPress(screen, 'start here', '\r')
			await waitUntil(screen, () => sent.length === 1, 'first turn did not start')
			await waitUntil(
				screen,
				() => screen.viewport().some((line) => line.includes('first answer')),
				'first streamed answer never reached the viewport',
			)
			const firstPromptRow = screen.viewport().findIndex((line) => line.includes('start here'))
			expect(
				firstPromptRow,
				`the submitted prompt did not flow down from the banner:\n${screen.viewport().join('\n')}`,
			).toBeGreaterThanOrEqual(5)
			expect(firstPromptRow).toBeLessThan(14)
			const composerRow = screen.viewport().findIndex((line) => line.includes('Type a message'))
			expect(composerRow).toBeGreaterThan(firstPromptRow)

			// Alt+V belongs to clipboard attachment, independently of computer-use.
			screen.press('\x1bv')
			await screen.waitForRender()
			await typeAndPress(screen, 'also inspect this', '\r')
			await waitUntil(
				screen,
				() => screen.scrollback().some((line) => line.includes('steering the active turn')),
				'live-input preview never appeared',
			)
			expect(delivered).toEqual([])
			expect(screen.scrollback().join('\n')).not.toContain('also inspect this')

			await typeAndPress(screen, 'then do this', '\t')
			await waitUntil(
				screen,
				() => screen.scrollback().some((line) => line.includes('1 message queued')),
				'Tab submission never entered the next-turn queue',
			)

			releaseFirstTurn()
			await waitUntil(screen, () => delivered[0]?.length === 1, 'SDK never drained the live input')
			await waitUntil(screen, () => sent.length === 2, 'Tab-queued turn never started')

			expect(sentOptions[0]?.inboundMessages).toBeTypeOf('function')
			expect(delivered[0]).toMatchObject([
				{ role: 'user', content: 'also inspect this', attachments: [image] },
			])
			expect(sent[1]?.map((message) => [message.role, message.content])).toEqual([
				['user', 'start here'],
				['assistant', 'first answer'],
				['user', 'also inspect this'],
				['assistant', 'steered answer'],
				['user', 'then do this'],
			])
			expect(
				sent[1]?.find(
					(message) => message.role === 'user' && message.content === 'also inspect this',
				),
			).toMatchObject({ attachments: [image] })
			expect(
				replacements.some((history) =>
					history.some((message) => message.content === 'also inspect this'),
				),
			).toBe(true)

			const transcript = screen.scrollback().join('\n')
			expect(transcript.indexOf('first answer')).toBeLessThan(
				transcript.indexOf('also inspect this'),
			)
			expect(transcript.indexOf('also inspect this')).toBeLessThan(
				transcript.indexOf('steered answer'),
			)
		} finally {
			await screen.unmount()
		}
	})

	it('requeues an undrained steer at its original position relative to Tab input', async () => {
		drainFirstTurn = false
		const screen = await renderToScreen(<App ctx={ctx} />, {
			cols: 110,
			rows: 28,
		})
		try {
			await waitUntil(
				screen,
				() => screen.scrollback().some((line) => line.includes('Type a message')),
				'App never became ready',
			)
			await typeAndPress(screen, 'active', '\r')
			await waitUntil(screen, () => sent.length === 1, 'first turn did not start')

			// This Return happened before the Tab submission. If the first run ends
			// without asking the SDK for live input, that chronology must survive the
			// fallback into the ordinary FIFO.
			await typeAndPress(screen, 'return-first', '\r')
			await typeAndPress(screen, 'tab-second', '\t')
			releaseFirstTurn()

			await waitUntil(screen, () => sent.length === 3, 'fallback queue did not drain')
			expect(sent[1]?.at(-1)).toMatchObject({
				role: 'user',
				content: 'return-first',
			})
			expect(sent[2]?.at(-1)).toMatchObject({
				role: 'user',
				content: 'tab-second',
			})
		} finally {
			await screen.unmount()
		}
	})
})
