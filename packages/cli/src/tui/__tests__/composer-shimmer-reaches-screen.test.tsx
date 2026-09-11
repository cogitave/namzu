/** Motion belongs to the Working label, and never owns the operator's draft. */

import { createRequire } from 'node:module'

import type { Message } from '@namzu/sdk'
import { Terminal } from '@xterm/headless'
import { Box, Text } from 'ink'
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'

import type { Preferences } from '../../integrations/providers/index.js'
import { LiveActivity } from '../LiveActivity.js'
import { ComposerFrame } from '../ComposerFrame.js'
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
const realSetTimeout = globalThis.setTimeout

/** Advance Ink's real scheduler without putting the terminal parser on the fake clock. */
function controlAnimationClock() {
	vi.useFakeTimers({
		toFake: ['setTimeout', 'clearTimeout', 'performance'],
		shouldClearNativeTimers: true,
	})
	const fakeSetTimeout = globalThis.setTimeout
	const timer = vi
		.spyOn(globalThis, 'setTimeout')
		.mockImplementation(((...args: Parameters<typeof setTimeout>) =>
			(args[1] ?? 0) === 0
				? realSetTimeout(...args)
				: fakeSetTimeout(...args)) as typeof setTimeout)
	return () => {
		timer.mockRestore()
		vi.useRealTimers()
	}
}

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
		workingColors() {
			const buffer = terminal.buffer.active
			for (let y = rows - 1; y >= 0; y--) {
				const line = buffer.getLine(buffer.baseY + y)
				if (line?.translateToString(true).startsWith('Working')) {
					return Array.from({ length: 7 }, (_, x) => line.getCell(x)?.getFgColor())
				}
			}
			return []
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

async function expectStaticBorder(screen: Screen, border: ReturnType<typeof borderProbe>) {
	const first = await border.read()
	expect(first?.length).toBeGreaterThan(20)
	await new Promise((resolve) => setTimeout(resolve, 300))
	await screen.waitForRender()
	expect(await border.read()).toEqual(first)
}

it('keeps the working border still through prompts and resizing and preserves the typed draft', async () => {
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

		await expectStaticBorder(screen, border)

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

		// A wrapping draft changes geometry; the border must remain intact.
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
		await expectStaticBorder(screen, border)

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

it('fills the Working label without rerendering the input, and stops when animation is disabled', async () => {
	const restoreClock = controlAnimationClock()
	const inputRender = vi.fn()
	function Input() {
		inputRender()
		return <Text>Retained draft</Text>
	}
	const view = (animate: boolean) => (
		<Box flexDirection="column">
			<LiveActivity activeTools={[]} working animate={animate} />
			<ComposerFrame focus>
				<Input />
			</ComposerFrame>
		</Box>
	)
	const screen = await renderToScreen(view(true), { cols: 80, rows: 20 })
	const border = borderProbe(screen, 80, 20)
	try {
		const first = await border.read()
		const colors = border.workingColors()
		expect(colors.length).toBeGreaterThan(0)
		const before = screen.bytesWritten()
		await vi.advanceTimersByTimeAsync(480)
		await screen.waitForRender()
		expect(screen.bytesWritten()).toBeGreaterThan(before)
		expect(screen.viewport().join('\n')).toContain('Working')
		expect(screen.viewport().join('\n')).not.toMatch(/█|∴ namzu/)
		expect(await border.read()).toEqual(first)
		expect(border.workingColors()).not.toEqual(colors)
		expect(inputRender).toHaveBeenCalledTimes(1)
		screen.rerender(view(false))
		await screen.waitForRender()
		const stopped = screen.bytesWritten()
		await vi.advanceTimersByTimeAsync(1600)
		await screen.waitForRender()
		expect(screen.bytesWritten()).toBe(stopped)
	} finally {
		await screen.unmount()
		border.dispose()
		restoreClock()
	}
})

it.each([2, 8, 11, 12, 40])('keeps both frame corners on one row at %i columns', async (cols) => {
	const screen = await renderToScreen(
		<ComposerFrame focus animate={false}>
			<Box height={1} />
		</ComposerFrame>,
		{ cols, rows: 12 },
	)
	try {
		const lines = screen.viewport().filter((line) => line.trim())
		expect(lines).toHaveLength(3)
		expect(lines[0]?.at(0)).toBe('┌')
		expect(lines[0]?.at(-1)).toBe('┐')
		expect(lines[0]?.length).toBe(cols)
		expect(lines[2]?.at(0)).toBe('└')
		expect(lines[2]?.at(-1)).toBe('┘')
		expect(lines[2]?.length).toBe(cols)
	} finally {
		await screen.unmount()
	}
})

it.each([
	['INK_SCREEN_READER', 'true'],
	['NO_COLOR', '1'],
	['FORCE_COLOR', '0'],
	['TERM', 'dumb'],
])('never schedules decorative motion with %s=%s', async (key, value) => {
	vi.stubEnv(key, value)
	const restoreClock = controlAnimationClock()
	const screen = await renderToScreen(
		<Box flexDirection="column">
			<LiveActivity working activeTools={[]} />
			<ComposerFrame focus>
				<Text>Accessible draft</Text>
			</ComposerFrame>
		</Box>,
		{ cols: 32, rows: 12 },
	)
	try {
		expect(screen.viewport().join('\n')).toContain('Accessible draft')
		const bytesBefore = screen.bytesWritten()
		await vi.advanceTimersByTimeAsync(1600)
		await screen.waitForRender()
		expect(screen.bytesWritten()).toBe(bytesBefore)
		expect(vi.getTimerCount()).toBe(0)
	} finally {
		await screen.unmount()
		restoreClock()
	}
})
