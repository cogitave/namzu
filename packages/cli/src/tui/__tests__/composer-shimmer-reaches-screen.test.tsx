/** Motion belongs to the working frame, and never owns the operator's draft. */

import { createRequire } from 'node:module'

import type { Message } from '@namzu/sdk'
import { Terminal } from '@xterm/headless'
import { Box, Text } from 'ink'
import type { ComponentProps } from 'react'
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'

import type { Preferences } from '../../integrations/providers/index.js'
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

it('travels clockwise through every corner without rendering the input or transcript again', async () => {
	const restoreClock = controlAnimationClock()
	const inputRender = vi.fn()
	const transcriptRender = vi.fn()
	function Input() {
		inputRender()
		return <Text>{'draft\nsecond\nthird\nfourth\nfifth\nsixth\nseventh'}</Text>
	}
	function Transcript() {
		transcriptRender()
		return <Text>Conversation stays steady</Text>
	}
	const screen = await renderToScreen(
		<Box flexDirection="column">
			<Transcript />
			<ComposerFrame working focus>
				<Input />
			</ComposerFrame>
		</Box>,
		{ cols: 32, rows: 20 },
	)
	const border = borderProbe(screen, 32, 20)
	try {
		const stableText = screen.viewport()
		const first = await border.read()
		const geometry = first?.map(({ x, y, glyph }) => ({ x, y, glyph }))
		// These checkpoints cover the top moving right, the right moving down,
		// the bottom moving left, the left moving up, then the next lap.
		const checkpoints = new Map([
			[400, { x: 16, y: 0 }],
			[560, { x: 22, y: 0 }],
			[880, { x: 31, y: 2 }],
			[1040, { x: 31, y: 5 }],
			[1280, { x: 27, y: 8 }],
			[1440, { x: 21, y: 8 }],
			[2080, { x: 0, y: 6 }],
			[2240, { x: 0, y: 3 }],
			[2720, { x: 14, y: 0 }],
		])
		const visitedCorners = new Set<string>()
		const writesBefore = screen.writes().length
		for (let elapsed = 80; elapsed <= 2720; elapsed += 80) {
			await vi.advanceTimersByTimeAsync(80)
			await screen.waitForRender()
			const cells = await border.read()
			expect(cells?.map(({ x, y, glyph }) => ({ x, y, glyph }))).toEqual(geometry)
			expect(screen.viewport()).toEqual(stableText)
			for (const cell of cells ?? []) {
				if ('┌┐└┘'.includes(cell.glyph) && cell.color !== 83) visitedCorners.add(cell.glyph)
			}
			const checkpoint = checkpoints.get(elapsed)
			if (checkpoint)
				expect(cells).toContainEqual(expect.objectContaining({ ...checkpoint, color: 194 }))
		}
		expect(visitedCorners).toEqual(new Set(['┌', '┐', '└', '┘']))
		expect(inputRender).toHaveBeenCalledTimes(1)
		expect(transcriptRender).toHaveBeenCalledTimes(1)
		// At most one terminal repaint per 80 ms animation interval.
		expect(
			screen
				.writes()
				.slice(writesBefore)
				.filter((write) => write.includes('MESSAGE')).length,
		).toBeLessThanOrEqual(34)
	} finally {
		await screen.unmount()
		border.dispose()
		restoreClock()
	}
})

it.each([
	{ name: 'idle', props: { working: false } },
	{ name: 'unfocused', props: { focus: false } },
	{ name: 'hidden', props: { hidden: true } },
	{ name: 'animation disabled', props: { animate: false } },
	{ name: 'NO_COLOR', env: ['NO_COLOR', '1'] },
	{ name: 'FORCE_COLOR=0', env: ['FORCE_COLOR', '0'] },
	{ name: 'TERM=dumb', env: ['TERM', 'dumb'] },
] satisfies readonly {
	readonly name: string
	readonly props?: Partial<ComponentProps<typeof ComposerFrame>>
	readonly env?: readonly [string, string]
}[])('removes the light and its scheduler subscription when $name', async (mode) => {
	const restoreClock = controlAnimationClock()
	const props: ComponentProps<typeof ComposerFrame> = {
		working: true,
		focus: true,
		children: <Text>Retained draft</Text>,
	}
	const screen = await renderToScreen(<ComposerFrame {...props} />, { cols: 32, rows: 12 })
	const border = borderProbe(screen, 32, 12)
	try {
		await vi.advanceTimersByTimeAsync(400)
		await screen.waitForRender()
		expect((await border.read())?.some(({ color }) => color === 194)).toBe(true)
		if ('env' in mode && mode.env) vi.stubEnv(...mode.env)
		screen.rerender(<ComposerFrame {...props} {...('props' in mode ? mode.props : {})} />)
		await screen.waitForRender()
		const stopped = await border.read()
		expect(stopped?.some(({ color }) => color === 194) ?? false).toBe(false)
		const writesBefore = screen.bytesWritten()
		await vi.advanceTimersByTimeAsync(1600)
		await screen.waitForRender()
		expect(await border.read()).toEqual(stopped)
		expect(screen.bytesWritten()).toBe(writesBefore)
		expect(vi.getTimerCount()).toBe(0)
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

it('never schedules decorative motion for a screen reader', async () => {
	vi.stubEnv('INK_SCREEN_READER', 'true')
	const restoreClock = controlAnimationClock()
	const screen = await renderToScreen(
		<ComposerFrame working focus>
			<Text>Accessible draft</Text>
		</ComposerFrame>,
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
