/** Combined live furniture must leave the operator's draft and controls on screen. */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { Message } from '@namzu/sdk'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import type { Preferences } from '../../integrations/providers/index.js'
import { fakeAgentSession } from '../__fixtures__/agent-session.js'
import type { AgentEvent } from '../agent.js'
import type { TuiContext } from '../types.js'
import { type Screen, renderToScreen } from './support/screen.js'

const preferences: Preferences = {
	version: 3,
	providers: [{ id: 'openai' }],
	subagents: { active: [] },
}
const sent: Message[][] = []
const historyMarker = 'EARLIER ANSWER KEPT IN NATIVE HISTORY'
const draft = 'Check keyboard\nthen compare output'
const taskSubjects = [
	'Read the entry point',
	'Inspect terminal ownership',
	'Review layout constraints',
	'Compare narrow layouts',
	'Check keyboard routing',
	'Inspect streamed output',
	'Verify native history',
	'Summarize findings',
]
let releaseProgress: () => void = () => {}
let progressGate = Promise.resolve()
let releaseTurn: () => void = () => {}
let turnGate = Promise.resolve()

vi.mock('../../integrations/trust/store.js', () => ({ isTrusted: () => true, trustDir: () => {} }))
vi.mock('../../integrations/updates.js', () => ({ checkUpdates: async () => [] }))
vi.mock('../../user-commands/store.js', () => ({ discoverUserCommands: () => [] }))
vi.mock('../../integrations/sessions/store.js', () => ({
	openSessions: async () => ({ tenantId: '29b3a0cc-469e-4536-8e4d-ac3301a586a6' }),
	startConversation: async () => '535454a0-3284-474e-80c6-c0c73b5d8eb5',
	requireWritableConversation: async () => {},
	appendMessages: async () => {},
	listRecent: async () => [],
	loadConversation: async () => [],
}))
vi.mock('../agent.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../agent.js')>()
	return {
		...actual,
		probeAgentSession: async () => ({ preferences, needsRepickReason: null, detected: [] }),
		createAgentSession: async () =>
			fakeAgentSession({
				providerSummary: 'fixture-provider',
				modelSummary: 'fixture-model',
				toolNames: () => ['read'],
				send: async function* (messages): AsyncIterable<AgentEvent> {
					sent.push([...messages])
					if (sent.length === 1) {
						yield {
							kind: 'delta',
							text: `${historyMarker}\n\n${Array.from({ length: 35 }, (_, index) => `Retained evidence ${index + 1}.`).join('\n\n')}`,
						}
					} else if (sent.length === 2) {
						for (const [index, subject] of taskSubjects.entries()) {
							yield { kind: 'task', taskId: `layout-task-${index}`, subject, status: 'pending' }
						}
						yield {
							kind: 'task',
							taskId: 'layout-task-2',
							subject: taskSubjects[2] ?? '',
							status: 'in_progress',
						}
						for (const [index, path] of ['src/index.ts', 'src/view.ts', 'src/input.ts'].entries()) {
							yield {
								kind: 'tool-start',
								toolUseId: `layout-read-${index}`,
								toolName: 'read',
								summary: path,
							}
							yield {
								kind: 'tool-progress',
								toolUseId: `layout-read-${index}`,
								toolName: 'read',
								message: 'Inspecting source',
								fraction: 0.25,
							}
						}
						await progressGate
						yield {
							kind: 'tool-progress',
							toolUseId: 'layout-read-0',
							toolName: 'read',
							message: 'Source inspected',
							fraction: 0.75,
						}
						await turnGate
						for (let index = 0; index < 3; index += 1) {
							yield {
								kind: 'tool-end',
								toolUseId: `layout-read-${index}`,
								toolName: 'read',
								isError: false,
								summary: 'Source inspected',
							}
						}
						for (const [index, subject] of taskSubjects.entries()) {
							yield { kind: 'task', taskId: `layout-task-${index}`, subject, status: 'completed' }
						}
						yield { kind: 'delta', text: 'Inspection finished.' }
					} else {
						yield { kind: 'delta', text: 'Draft received intact.' }
					}
					yield { kind: 'done', stopReason: 'end_turn' }
				},
			}),
	}
})

const { App } = await import('../App.js')
const ctx: TuiContext = { cwd: '/workspace/namzu', version: '0.0.0-test' }

beforeEach(() => {
	sent.length = 0
	progressGate = new Promise<void>((resolve) => {
		releaseProgress = resolve
	})
	turnGate = new Promise<void>((resolve) => {
		releaseTurn = resolve
	})
})

afterEach(() => {
	releaseProgress()
	releaseTurn()
})

async function waitUntil(screen: Screen, predicate: () => boolean, message: string): Promise<void> {
	for (let attempt = 0; attempt < 160; attempt += 1) {
		await screen.waitForRender()
		if (predicate()) return
	}
	throw new Error(`${message}\n${screen.viewport().join('\n')}`)
}

async function submit(screen: Screen, text: string): Promise<void> {
	screen.press(text)
	await screen.waitForRender()
	screen.press('\r')
	await screen.waitForRender()
}

/** Optional local evidence preserves the actual Ink bytes, including every resize boundary. */
function recorder(screen: Screen, initialColumns: number, initialRows: number) {
	const directory = process.env.NAMZU_TUI_CAPTURE_DIR
	let offset = 0
	let columns = initialColumns
	let rows = initialRows
	const events: (
		| { type: 'output'; data: string }
		| { type: 'resize'; columns: number; rows: number }
	)[] = []
	const drain = () => {
		for (const data of screen.writes().slice(offset)) events.push({ type: 'output', data })
		offset = screen.writes().length
	}
	return {
		capture(name: string) {
			if (!directory) return
			drain()
			mkdirSync(directory, { recursive: true })
			writeFileSync(join(directory, `${name}.viewport.txt`), `${screen.viewport().join('\n')}\n`)
			writeFileSync(join(directory, `${name}.ansi`), screen.writes().join(''))
			writeFileSync(
				join(directory, `${name}.recording.json`),
				JSON.stringify({ initialColumns, initialRows, columns, rows, events }, null, 2),
			)
		},
		async resize(nextColumns: number, nextRows: number) {
			drain()
			events.push({ type: 'resize', columns: nextColumns, rows: nextRows })
			columns = nextColumns
			rows = nextRows
			await screen.resize(columns, rows)
		},
	}
}

function expectActiveLayout(screen: Screen): void {
	const viewport = screen.viewport().join('\n')
	// Check every size even if one fails, so the same run records all affected layouts.
	expect.soft(viewport).toContain('Check keyboard')
	expect.soft(viewport).toContain('then compare output')
	expect.soft(viewport).toContain('Working')
	expect.soft(viewport).toContain('Read(')
	expect.soft(viewport).toContain('Review layout constraints')
	expect
		.soft(
			screen
				.viewport()
				.filter((line) => line.trim())
				.at(-1),
		)
		.toContain('interrupt')
	expect.soft(screen.bufferType()).toBe('normal')
	expect.soft(screen.scrollback().join('\n').split(historyMarker)).toHaveLength(2)
}

it('keeps live work, a multiline draft and controls reachable across terminal sizes', async () => {
	const screen = await renderToScreen(<App ctx={ctx} />, { cols: 100, rows: 30, scrollback: 2_000 })
	const capture = recorder(screen, 100, 30)
	try {
		await waitUntil(
			screen,
			() => screen.scrollback().join('\n').includes('Connected to fixture-provider'),
			'App did not become ready',
		)
		capture.capture('idle-100x30')
		await capture.resize(60, 18)
		capture.capture('idle-60x18')
		await capture.resize(100, 30)
		await submit(screen, 'Keep earlier evidence')
		await waitUntil(
			screen,
			() => screen.scrollback().join('\n').includes('Retained evidence 35.'),
			'Earlier answer did not settle',
		)
		await submit(screen, 'Inspect the layout')
		await waitUntil(
			screen,
			() => screen.viewport().join('\n').includes('src/input.ts'),
			'Concurrent tool activity did not arrive',
		)
		screen.press('Check keyboard')
		await screen.waitForRender()
		screen.press('\x0a')
		await screen.waitForRender()
		screen.press('then compare output')
		await screen.waitForRender()
		capture.capture('active-100x30')
		expectActiveLayout(screen)

		const fromWrite = screen.writes().length
		releaseProgress()
		await waitUntil(
			screen,
			() => screen.viewport().join('\n').includes('Source inspected'),
			'Tool progress did not repaint',
		)
		expect(screen.writes().slice(fromWrite).join('')).not.toContain(historyMarker)

		for (const [columns, rows] of [
			[60, 18],
			[60, 14],
			[40, 14],
			[100, 30],
		] as const) {
			await capture.resize(columns, rows)
			capture.capture(`active-${columns}x${rows}`)
			expectActiveLayout(screen)
		}
		releaseTurn()
		await waitUntil(
			screen,
			() => screen.scrollback().join('\n').includes('Inspection finished.'),
			'Active turn did not finish',
		)
		screen.press('\r')
		await waitUntil(screen, () => sent.length === 3, 'Preserved draft did not submit')
		expect(sent[2]?.at(-1)).toMatchObject({ role: 'user', content: draft })
	} finally {
		releaseProgress()
		releaseTurn()
		await screen.unmount()
	}
})
