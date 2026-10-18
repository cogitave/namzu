/** Motion belongs to the Working label, and never owns the operator's draft. */

import { createRequire } from 'node:module'

import type { Message } from '@namzu/sdk'
import { Terminal } from '@xterm/headless'
import { Box, Text } from 'ink'
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'

import type { Preferences } from '../../integrations/providers/index.js'
import { ComposerFrame } from '../ComposerFrame.js'
import { LiveActivity } from '../LiveActivity.js'
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
	// The /resume and /abandon paths ask for the parked turn first; none here.
	activeConversationTurn: async () => undefined,
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
			// The last pair of rules belongs to the current composer.
			const text = lines.map((line) => line?.translateToString(true) ?? '')
			const isRule = (line: string) => /^\s*─{3,}/u.test(line)
			let bottom = -1
			for (let at = text.length - 1; at >= 0 && bottom < 0; at--) {
				if (/^\s*─{3,}\s*$/u.test(text[at] ?? '')) bottom = at
			}
			if (bottom < 0) return null
			let top = -1
			for (let at = bottom - 1; at >= 0 && top < 0; at--) {
				if (isRule(text[at] ?? '')) top = at
			}
			if (top < 0) throw new Error('Composer frame is incomplete')
			const left = Math.max(0, text[top]?.indexOf('─') ?? 0)
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
					if (cell && glyph === '─') {
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
		expect(decisions).toEqual([{ kind: 'reject', declined: {} }])

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

it('glows symmetrically from the composer center once, then settles without moving the draft', async () => {
	const restoreClock = controlAnimationClock()
	const view = (activation: number) => (
		<ComposerFrame focus mode="hypermode" activation={activation}>
			<Text>Retained draft</Text>
		</ComposerFrame>
	)
	const screen = await renderToScreen(view(0), { cols: 80, rows: 12 })
	const border = borderProbe(screen, 80, 12)
	try {
		const rule = async () =>
			(await border.read())?.filter(({ x, y, glyph }) => y === 0 && glyph === '─' && x <= 67) ?? []
		expect(new Set((await rule()).map(({ color }) => color))).toEqual(new Set([239]))
		const baseline = screen.bytesWritten()
		await vi.advanceTimersByTimeAsync(1_600)
		await screen.waitForRender()
		expect(screen.bytesWritten()).toBe(baseline)
		screen.rerender(view(1))
		await screen.waitForRender()
		await vi.advanceTimersByTimeAsync(80)
		await screen.waitForRender()
		const near = (await rule()).filter(({ color }) => color === 183).map(({ x }) => x)
		expect(near.length).toBeGreaterThan(0)
		expect(near.every((x) => Math.abs(x - 33.5) < 8)).toBe(true)
		const beforeGlow = screen.bytesWritten()
		await vi.advanceTimersByTimeAsync(320)
		await screen.waitForRender()
		expect(screen.bytesWritten()).toBeGreaterThan(beforeGlow)
		const active = await rule()
		const bright = active.filter(({ color }) => color === 183).map(({ x }) => x)
		expect(bright.length).toBeGreaterThan(0)
		expect(Math.min(...bright)).toBeLessThan(Math.min(...near))
		expect(Math.max(...bright)).toBeGreaterThan(Math.max(...near))
		expect(bright).toEqual(bright.map((x) => 67 - x).reverse())
		expect(active.every(({ color }) => [239, 97, 141, 183].includes(color))).toBe(true)
		const top = screen.viewport().find((line) => line.includes('hypermode')) ?? ''
		expect([...top]).toHaveLength(80)
		expect(top).toMatch(/^─+ hypermode ─$/u)
		expect(screen.viewport().join('\n')).toContain('Retained draft')
		await vi.advanceTimersByTimeAsync(1_600)
		await screen.waitForRender()
		const settled = screen.bytesWritten()
		await vi.advanceTimersByTimeAsync(600)
		await screen.waitForRender()
		expect(screen.bytesWritten()).toBe(settled)
		expect(new Set((await rule()).map(({ color }) => color))).toEqual(new Set([239]))
		expect(vi.getTimerCount()).toBe(0)
		screen.rerender(view(1))
		await screen.waitForRender()
		const afterRepeatedSelection = screen.bytesWritten()
		await vi.advanceTimersByTimeAsync(600)
		await screen.waitForRender()
		expect(screen.bytesWritten()).toBe(afterRepeatedSelection)
	} finally {
		await screen.unmount()
		border.dispose()
		restoreClock()
	}
})

it('cancels the hypermode glow while another surface owns the terminal', async () => {
	const restoreClock = controlAnimationClock()
	const view = (activation: number, animate: boolean) => (
		<ComposerFrame focus mode="hypermode" activation={activation} animate={animate}>
			<Text>Retained draft</Text>
		</ComposerFrame>
	)
	const screen = await renderToScreen(view(0, true), { cols: 80, rows: 12 })
	try {
		screen.rerender(view(1, true))
		await screen.waitForRender()
		await vi.advanceTimersByTimeAsync(240)
		await screen.waitForRender()
		screen.rerender(view(1, false))
		await screen.waitForRender()
		const stopped = screen.bytesWritten()
		await vi.advanceTimersByTimeAsync(1_600)
		await screen.waitForRender()
		expect(screen.bytesWritten()).toBe(stopped)
		expect(vi.getTimerCount()).toBe(0)
		screen.rerender(view(1, true))
		await screen.waitForRender()
		const afterReturn = screen.bytesWritten()
		await vi.advanceTimersByTimeAsync(400)
		await screen.waitForRender()
		expect(screen.bytesWritten()).toBe(afterReturn)
	} finally {
		await screen.unmount()
		restoreClock()
	}
})

it('keeps the mode label and settles after one pulse on a 24 column rule', async () => {
	const restoreClock = controlAnimationClock()
	const view = (activation: number) => (
		<ComposerFrame focus mode="hypermode" activation={activation}>
			<Text>Draft</Text>
		</ComposerFrame>
	)
	const screen = await renderToScreen(view(0), { cols: 24, rows: 8 })
	try {
		expect(screen.viewport().join('\n')).toContain('hypermode')
		screen.rerender(view(1))
		await screen.waitForRender()
		await vi.advanceTimersByTimeAsync(1_600)
		await screen.waitForRender()
		const settled = screen.bytesWritten()
		await vi.advanceTimersByTimeAsync(1_200)
		await screen.waitForRender()
		expect(screen.bytesWritten()).toBe(settled)
		expect(vi.getTimerCount()).toBe(0)
		expect(screen.viewport().join('\n')).toContain('hypermode')
	} finally {
		await screen.unmount()
		restoreClock()
	}
})

it.each([2, 8, 11, 12, 40])(
	'draws two full-width rules and nothing else at %i columns',
	async (cols) => {
		const screen = await renderToScreen(
			<ComposerFrame focus animate={false}>
				<Box height={1} />
			</ComposerFrame>,
			{ cols, rows: 12 },
		)
		try {
			const lines = screen.viewport().filter((line) => line.trim())
			expect(lines).toEqual(['─'.repeat(cols), '─'.repeat(cols)])
		} finally {
			await screen.unmount()
		}
	},
)

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
			<ComposerFrame focus mode="hypermode" activation={0}>
				<Text>Accessible draft</Text>
			</ComposerFrame>
		</Box>,
		{ cols: 80, rows: 12 },
	)
	try {
		expect(screen.viewport().join('\n')).toContain('Accessible draft')
		screen.rerender(
			<Box flexDirection="column">
				<LiveActivity working activeTools={[]} />
				<ComposerFrame focus mode="hypermode" activation={1}>
					<Text>Accessible draft</Text>
				</ComposerFrame>
			</Box>,
		)
		await screen.waitForRender()
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
