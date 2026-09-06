/** Motion belongs to the working frame, and never owns the operator's draft. */

import { createRequire } from 'node:module'

import type { Message } from '@namzu/sdk'
import { Terminal } from '@xterm/headless'
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'

import type { Preferences } from '../../integrations/providers/index.js'
import { fakeAgentSession } from '../__fixtures__/agent-session.js'
import type { AgentEvent, PermissionDecision } from '../agent.js'
import { type Screen, renderToScreen } from './support/screen.js'

const preferences: Preferences = {
	version: 3,
	providers: [{ id: 'openai' }],
	subagents: { active: [] },
}
const sent: Message[][] = []
const decisions: PermissionDecision[] = []
let requestPermission: () => void = () => {}
let permissionGate = Promise.resolve()
let completeTurn: () => void = () => {}
let turnGate = Promise.resolve()

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
		tenantId: '29b3a0cc-469e-4536-8e4d-ac3301a586a6',
	}),
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
		probeAgentSession: async () => ({
			preferences,
			needsRepickReason: null,
			detected: [],
		}),
		createAgentSession: async () =>
			fakeAgentSession({
				providerSummary: 'fixture-provider',
				modelSummary: 'fixture-model',
				toolNames: () => ['read', 'write'],
				send: async function* (messages, options): AsyncIterable<AgentEvent> {
					sent.push([...messages])
					if (sent.length === 1) {
						yield {
							kind: 'tool-start',
							toolUseId: 'read-preview',
							toolName: 'read',
							summary: 'src/view.ts',
						}
						await permissionGate
						const decision = await options?.onPermission?.({
							toolCalls: [
								{
									id: 'write-preview',
									name: 'write',
									input: { path: 'preview.txt', content: 'preview' },
									isDestructive: false,
								},
							],
						})
						if (decision) decisions.push(decision)
						await turnGate
						yield {
							kind: 'tool-end',
							toolUseId: 'read-preview',
							toolName: 'read',
							isError: false,
							summary: 'Source inspected',
						}
						yield { kind: 'delta', text: 'Inspection finished.' }
					}
					yield { kind: 'done', stopReason: 'end_turn' }
				},
			}),
	}
})

const { App } = await import('../App.js')

// The test terminal is a color TTY; the Vitest process itself usually is not.
// Enable color on Ink's actual Chalk instance without replacing any renderer.
const inkRequire = createRequire(createRequire(import.meta.url).resolve('ink'))
const chalk = (await import(inkRequire.resolve('chalk'))).default as {
	level: number
}
const originalColorLevel = chalk.level

beforeAll(() => {
	chalk.level = 3
})
afterAll(() => {
	chalk.level = originalColorLevel
})
beforeEach(() => {
	vi.stubEnv('NO_COLOR', undefined)
	vi.stubEnv('FORCE_COLOR', '3')
	vi.stubEnv('TERM', 'xterm-256color')
	sent.length = 0
	decisions.length = 0
	permissionGate = new Promise<void>((resolve) => {
		requestPermission = resolve
	})
	turnGate = new Promise<void>((resolve) => {
		completeTurn = resolve
	})
})
afterEach(() => {
	requestPermission()
	completeTurn()
	vi.unstubAllEnvs()
})

const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 20))

async function waitUntil(screen: Screen, predicate: () => boolean, message: string): Promise<void> {
	const deadline = performance.now() + 3_000
	do {
		await screen.waitForRender()
		if (predicate()) return
		await pause()
	} while (performance.now() < deadline)
	throw new Error(`${message}\n${screen.viewport().join('\n')}`)
}

/** Read real terminal cells; a changing Working spinner cannot satisfy this probe. */
function borderProbe(screen: Screen, initialCols: number, initialRows: number) {
	let cols = initialCols
	let rows = initialRows
	const terminal = new Terminal({
		cols,
		rows,
		scrollback: 1_000,
		convertEol: true,
		allowProposedApi: true,
	})
	let offset = 0
	return {
		async read() {
			const chunks = screen.writes().slice(offset)
			offset += chunks.length
			await new Promise<void>((resolve) => terminal.write(chunks.join(''), resolve))
			const buffer = terminal.buffer.active
			const lines = Array.from({ length: rows }, (_, index) => buffer.getLine(buffer.baseY + index))
			// Terminal reflow can leave an older frame fragment in native history.
			// The last caption belongs to the current composer.
			const top = lines.reduce(
				(last, line, index) => (line?.translateToString(true).includes('MESSAGE') ? index : last),
				-1,
			)
			if (top < 0) return null
			const left = lines[top]?.translateToString(true).indexOf('┌') ?? -1
			const bottom = lines.findIndex(
				(line, index) => index > top && line?.getCell(left)?.getChars() === '└',
			)
			if (left < 0 || bottom < 0) throw new Error('Composer frame is incomplete')
			const cells: {
				x: number
				y: number
				glyph: string
				color: number
				mode: number
			}[] = []
			for (let y = top; y <= bottom; y += 1) {
				for (let x = left; x < cols; x += 1) {
					const cell = lines[y]?.getCell(x)
					const glyph = cell?.getChars() ?? ''
					if (cell && '─│┌┐└┘'.includes(glyph) && glyph !== '') {
						cells.push({
							x: x - left,
							y: y - top,
							glyph,
							color: cell.getFgColor(),
							mode: cell.getFgColorMode(),
						})
					}
				}
			}
			return cells
		},
		resize(nextCols: number, nextRows: number) {
			cols = nextCols
			rows = nextRows
			terminal.resize(cols, rows)
		},
		dispose() {
			terminal.dispose()
		},
	}
}

async function expectBorderMotion(screen: Screen, border: ReturnType<typeof borderProbe>) {
	const first = await border.read()
	expect(first?.length).toBeGreaterThan(20)
	let moved = false
	const deadline = performance.now() + 3_000
	do {
		await pause()
		await screen.waitForRender()
		const next = await border.read()
		expect(next?.map(({ x, y, glyph }) => ({ x, y, glyph }))).toEqual(
			first?.map(({ x, y, glyph }) => ({ x, y, glyph })),
		)
		moved = JSON.stringify(next) !== JSON.stringify(first)
	} while (!moved && performance.now() < deadline)
	expect(moved, 'Working never changed the rendered border colors').toBe(true)
}

it('moves the working border, stops for a prompt and idle, and preserves the typed draft', async () => {
	const screen = await renderToScreen(
		<App ctx={{ cwd: '/workspace/namzu', version: '0.0.0-test' }} />,
		{ cols: 60, rows: 22 },
	)
	const border = borderProbe(screen, 60, 22)
	const firstLine = 'Keep this draft intact'
	const secondLine = 'then compare narrow terminal layouts'
	const draft = `${firstLine}\n${secondLine}`
	try {
		await waitUntil(
			screen,
			() => screen.viewport().join('\n').includes('Type a message'),
			'App did not become ready',
		)
		screen.press('Inspect the view')
		await screen.waitForRender()
		screen.press('\r')
		await waitUntil(
			screen,
			() => screen.viewport().join('\n').includes('src/view.ts'),
			'Tool did not start',
		)
		screen.press(firstLine)
		await screen.waitForRender()
		screen.press('\x0a')
		await screen.waitForRender()
		screen.press(secondLine)
		await waitUntil(
			screen,
			() => screen.viewport().join('\n').includes(secondLine),
			'Draft did not appear',
		)

		await expectBorderMotion(screen, border)

		requestPermission()
		await waitUntil(
			screen,
			() => screen.viewport().join('\n').includes('Do you want to'),
			'Permission prompt did not open',
		)
		const promptUntil = performance.now() + 320
		do {
			await pause()
			await screen.waitForRender()
			expect(await border.read()).toBeNull()
			expect(screen.viewport().join('\n')).not.toContain(firstLine)
		} while (performance.now() < promptUntil)
		screen.press('\x1b')
		await waitUntil(
			screen,
			() => screen.viewport().join('\n').includes(firstLine),
			'Prompt discarded the draft',
		)
		expect(decisions).toEqual([{ kind: 'reject' }])

		// A wrapping draft changes the perimeter; the light must remain on it.
		await border.read()
		border.resize(40, 22)
		await screen.resize(40, 22)
		await waitUntil(
			screen,
			() => screen.viewport().join('\n').includes(firstLine),
			'Resize lost the draft',
		)
		const narrow = await border.read()
		expect(narrow?.length).toBeGreaterThan(20)
		expect(
			narrow?.every(({ x }) => x < 38),
			screen.viewport().join('\n'),
		).toBe(true)
		const bottom = Math.max(...(narrow?.map(({ y }) => y) ?? []))
		expect(narrow?.every(({ x, y }) => x === 0 || x === 37 || y === 0 || y === bottom)).toBe(true)
		expect(screen.viewport().join('\n')).toContain('layouts')
		await expectBorderMotion(screen, border)

		completeTurn()
		await waitUntil(
			screen,
			() =>
				!screen
					.viewport()
					.filter((line) => line.trim())
					.at(-1)
					?.includes('interrupt') &&
				screen.scrollback().join('\n').includes('Inspection finished.'),
			'Turn did not finish',
		)
		const idle = await border.read()
		expect(idle?.length).toBeGreaterThan(20)
		const idleUntil = performance.now() + 320
		do {
			await pause()
			await screen.waitForRender()
			expect(await border.read(), 'Idle border kept animating').toEqual(idle)
		} while (performance.now() < idleUntil)
		screen.press('\r')
		await waitUntil(screen, () => sent.length === 2, 'Retained draft did not submit')
		expect(sent[1]?.at(-1)).toMatchObject({ role: 'user', content: draft })
	} finally {
		requestPermission()
		completeTurn()
		await screen.unmount()
		border.dispose()
	}
})
