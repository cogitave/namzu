/**
 * A background input that provably had no effect is sent once more on the
 * screen, through the idle gate, the lease and the restore; one that changed
 * the window in a way that cannot be tied to it is never sent twice; and a
 * retry that cannot run says it is waiting for the person to be idle.
 * Fake driver, fake ladder, fake clock: nothing here reaches a desktop or waits.
 */
import { describe, expect, it } from 'vitest'
import { CuaDriverAdapter } from '../adapters/cua-driver/adapter.js'
import {
	MIN_STILL_READS,
	canBeJudgedByStillness,
	escalationDetail,
	judgeStillness,
	shouldRetryOnScreen,
} from '../adapters/cua-driver/escalation.js'
import type { Observation } from '../adapters/cua-driver/observe.js'
import {
	type FakeServerScript,
	type ToolCall,
	fakeSpawner,
	pngHeader,
	toolResult,
} from './fake-mcp-process.js'
import { FakeMonitor, baseState, makeLadder } from './foreground-fakes.js'

interface Line {
	role: string
	label: string
	value?: string
	selected?: boolean
}

function rig(
	onType: (call: ToolCall, page: Line[]) => unknown,
	ladderOptions: Parameters<typeof makeLadder>[0] = {},
) {
	const page: Line[] = [
		{ role: 'Button', label: 'Save' },
		{ role: 'Text', label: 'Notes' },
	]
	const made = makeLadder(ladderOptions)
	const script: FakeServerScript = {
		tool: (call) => {
			switch (call.name) {
				case 'list_windows':
					return toolResult({
						windows: [
							{
								window_id: 0x111,
								pid: 42,
								title: 'Notes',
								app_name: 'editor.exe',
								bounds: { x: 100, y: 80, width: 1200, height: 700 },
								z_index: 1,
							},
						],
					})
				case 'get_window_state':
					return toolResult(
						{
							pid: 42,
							window_id: 0x111,
							window_bounds: { x: 100, y: 80, width: 1200, height: 700 },
							screenshot_width: 1200,
							screenshot_height: 700,
							elements: page.map((line, index) => ({
								element_index: index,
								element_token: `e${index}`,
								role: line.role,
								label: line.label,
								...(line.value !== undefined ? { value: line.value } : {}),
								...(line.selected ? { selected: true } : {}),
								enabled: true,
								actions: ['invoke'],
							})),
						},
						[
							{
								type: 'image',
								data: pngHeader(1200, 700).toString('base64'),
								mimeType: 'image/png',
							},
						],
					)
				case 'type_text':
				case 'hotkey':
				case 'press_key':
				case 'click':
					return onType(call, page) as never
				default:
					return toolResult({})
			}
		},
	}
	const spawner = fakeSpawner(script)
	const adapter = new CuaDriverAdapter({
		executable: '/cache/cua-driver.exe',
		env: {},
		spawnProcess: spawner.spawnProcess,
		requestTimeoutMs: 1_000,
		startTimeoutMs: 1_000,
		settle: async () => undefined,
		foreground: made.ladder,
	})
	const sent = () =>
		spawner.processes
			.flatMap((p) => p.toolCalls)
			.filter((call) => ['type_text', 'hotkey', 'press_key', 'click'].includes(call.name))
	return { adapter, page, sent, ...made }
}

const unverified = () => toolResult({ effect: 'unverifiable', route: 'synthetic_events' })
const modeOf = (call: ToolCall) => call.arguments.delivery_mode

describe('an input that had no effect in the background', () => {
	it('is sent once more on the screen, and the effect it has there is verified', async () => {
		const { adapter, sent, monitor } = rig((call, page) => {
			if (modeOf(call) === 'foreground') page.push({ role: 'Text', label: 'hi' })
			return unverified()
		})
		const shot = await adapter.captureWindow('0x111')
		const result = await adapter.executeWindow(shot.captureId, { type: 'type_text', text: 'hi' })
		expect(result).toMatchObject({
			delivery: 'delivered_verified',
			readBack: { observed: 'hi' },
		})
		expect(result?.detail).toMatch(/first attempt, in the background, had no effect/)
		expect(sent().map(modeOf)).toEqual([undefined, 'foreground'])
		// One burst: gate, begin, end; the window and pointer put back.
		expect(monitor.calls.filter((call) => call === 'begin')).toHaveLength(1)
		expect(monitor.ends).toMatchObject([{ restore: true }])
		await adapter.dispose()
	})

	it('is tried on the screen once and no more, and a second no-effect is final and says why', async () => {
		const { adapter, sent } = rig(() => unverified())
		const shot = await adapter.captureWindow('0x111')
		const result = await adapter.executeWindow(shot.captureId, { type: 'type_text', text: 'hi' })
		expect(sent()).toHaveLength(2)
		expect(result).toMatchObject({ delivery: 'delivered_unverified', retrySafety: 'safe' })
		expect(result?.detail).toMatch(/still did not change/)
		expect(result?.detail).toMatch(/click the field first/)
		await adapter.dispose()
	})

	it('also retries a key combination, but never a click: its usual effects (focus, caret) are not in the controls', async () => {
		const { adapter, sent } = rig(() => unverified())
		const shot = await adapter.captureWindow('0x111')
		await adapter.executeWindow(shot.captureId, { type: 'key', keys: 'ctrl+o' })
		expect(sent()).toHaveLength(2)
		await adapter.dispose()
		const click = rig(() => unverified())
		const shot2 = await click.adapter.captureWindow('0x111')
		const result = await click.adapter.executeWindow(shot2.captureId, {
			type: 'mouse_click',
			at: { x: 10, y: 10 },
			button: 'left',
		})
		expect(click.sent()).toHaveLength(1)
		expect(result).toMatchObject({ delivery: 'delivered_unverified', retrySafety: 'unsafe' })
		await click.adapter.dispose()
	})

	it('waits for the person to be idle, in words, when the screen is in use: nothing more is sent', async () => {
		const monitor = new FakeMonitor()
		monitor.state_ = () => ({ ...baseState, userIdleMs: 0 })
		const { adapter, sent, clock } = rig(() => unverified(), { monitor })
		const shot = await adapter.captureWindow('0x111')
		const result = await adapter.executeWindow(shot.captureId, { type: 'type_text', text: 'hi' })
		expect(result).toMatchObject({ delivery: 'not_delivered', retrySafety: 'safe' })
		expect(result?.detail).toMatch(/^Waiting for you to be idle/)
		expect(result?.detail).toMatch(/safe to send it again once the keyboard and mouse are still/)
		// Only the background attempt reached the driver; the wait ran on the fake clock.
		expect(sent()).toHaveLength(1)
		expect(clock.sleeps.length).toBeGreaterThan(0)
		await adapter.dispose()
	})

	it('names the blocker when the person refused the screen', async () => {
		const monitor = new FakeMonitor()
		monitor.state_ = () => ({ ...baseState, userIdleMs: 0 })
		const { adapter, sent } = rig(() => unverified(), { monitor, approve: async () => 'deny' })
		const shot = await adapter.captureWindow('0x111')
		const result = await adapter.executeWindow(shot.captureId, { type: 'type_text', text: 'hi' })
		expect(result).toMatchObject({ delivery: 'not_delivered', retrySafety: 'safe' })
		expect(result?.detail).toMatch(/first attempt, in the background, had no effect/)
		expect(result?.detail).toMatch(/did not allow/)
		expect(sent()).toHaveLength(1)
		await adapter.dispose()
	})
})

describe('an input that must not be sent twice', () => {
	it('is not retried when the window changed in a way that is not the text typed', async () => {
		const { adapter, sent, monitor } = rig((_call, page) => {
			page.push({ role: 'Text', label: 'Autosaved' })
			return unverified()
		})
		const shot = await adapter.captureWindow('0x111')
		const result = await adapter.executeWindow(shot.captureId, { type: 'type_text', text: 'hi' })
		expect(sent()).toHaveLength(1)
		expect(monitor.calls).toEqual([])
		expect(result).toMatchObject({ delivery: 'delivered_unverified', retrySafety: 'unsafe' })
		expect(result?.detail).toMatch(/could do it twice/)
		await adapter.dispose()
	})

	it('is not retried when the person asked for background or for the screen', async () => {
		for (const delivery_mode of ['background', 'foreground'] as const) {
			const { adapter, sent } = rig(() => unverified())
			const shot = await adapter.captureWindow('0x111')
			await adapter.executeWindow(shot.captureId, { type: 'type_text', text: 'hi', delivery_mode })
			expect(sent()).toHaveLength(1)
			await adapter.dispose()
		}
	})

	it('is not retried for a key whose effect the window does not show', async () => {
		const { adapter, sent } = rig(() => unverified())
		const shot = await adapter.captureWindow('0x111')
		await adapter.executeWindow(shot.captureId, { type: 'key', keys: 'TAB' })
		expect(sent()).toHaveLength(1)
		await adapter.dispose()
	})

	it('is not called a retry-safe no-op after an attempt a person interrupted', async () => {
		const monitor = new FakeMonitor()
		monitor.during = { inputs: 1, escapes: 0 }
		const { adapter, sent } = rig(() => unverified(), { monitor })
		const shot = await adapter.captureWindow('0x111')
		const result = await adapter.executeWindow(shot.captureId, {
			type: 'type_text',
			text: 'hi',
			delivery_mode: 'foreground',
		})
		expect(sent()).toHaveLength(1)
		expect(result).toMatchObject({ retrySafety: 'unsafe' })
		await adapter.dispose()
	})

	it('is not retried when a control only changed state (a toggle) and then held still: that is its effect', async () => {
		const { adapter, sent } = rig((_call, page) => {
			page[0] = { role: 'Button', label: 'Save', selected: true }
			return unverified()
		})
		const shot = await adapter.captureWindow('0x111')
		const result = await adapter.executeWindow(shot.captureId, {
			type: 'mouse_click',
			at: { x: 5, y: 5 },
			button: 'left',
		})
		expect(sent()).toHaveLength(1)
		expect(result).toMatchObject({ delivery: 'delivered_verified' })
		await adapter.dispose()
	})
})

describe('a shortcut the driver cannot find an accelerator for', () => {
	it('is sent as a key with modifiers, which is real input, instead of being refused', async () => {
		const { adapter, sent } = rig((call, page) => {
			if (call.name === 'hotkey')
				return {
					result: {
						isError: true,
						structuredContent: { code: 'tool_invocation_failed' },
						content: [
							{ type: 'text', text: 'could not find a UIA AcceleratorKey matching ctrl+o' },
						],
					},
				}
			page.push({ role: 'Text', label: 'Open' })
			return unverified()
		})
		const shot = await adapter.captureWindow('0x111')
		const result = await adapter.executeWindow(shot.captureId, {
			type: 'key',
			keys: 'ctrl+o',
			delivery_mode: 'foreground',
		})
		expect(sent().map((call) => call.name)).toEqual(['hotkey', 'press_key'])
		expect(sent()[1]?.arguments).toMatchObject({
			key: 'o',
			modifiers: ['ctrl'],
			delivery_mode: 'foreground',
		})
		// The dialog the shortcut opens is its effect.
		expect(result).toMatchObject({ delivery: 'delivered_verified' })
		await adapter.dispose()
	})
})

describe('a shortcut that is a command of the window menu', () => {
	it('is carried out as that command: no key, no screen, and the dialog it opens is its effect', async () => {
		const monitor = new FakeMonitor()
		const { adapter, sent, page } = rig(() => unverified(), { monitor })
		monitor.menu = (accelerator) => {
			page.push({ role: 'Text', label: 'Open dialog' })
			return accelerator === 'Ctrl+O'
				? { found: true, reason: '', label: '&Open...' }
				: { found: false, reason: 'none' }
		}
		const shot = await adapter.captureWindow('0x111')
		const result = await adapter.executeWindow(shot.captureId, { type: 'key', keys: 'ctrl+o' })
		expect(monitor.menuCommands).toEqual(['Ctrl+O'])
		expect(sent()).toHaveLength(0)
		expect(monitor.calls).not.toContain('begin')
		expect(result).toMatchObject({ delivery: 'delivered_verified' })
		await adapter.dispose()
	})

	it('goes the ordinary way when the window has no such item, and is not asked for a plain key or an explicit mode', async () => {
		const monitor = new FakeMonitor()
		const { adapter, sent } = rig(() => unverified(), { monitor })
		const shot = await adapter.captureWindow('0x111')
		await adapter.executeWindow(shot.captureId, { type: 'key', keys: 'ctrl+o' })
		expect(monitor.menuCommands).toEqual(['Ctrl+O'])
		expect(sent().length).toBeGreaterThan(0)
		monitor.menuCommands.length = 0
		await adapter.executeWindow(shot.captureId, { type: 'key', keys: 'ENTER' })
		await adapter.executeWindow(shot.captureId, {
			type: 'key',
			keys: 'ctrl+o',
			delivery_mode: 'foreground',
		})
		expect(monitor.menuCommands).toEqual([])
		await adapter.dispose()
	})

	it('that left the window as it was is not sent again: the app was handed the command', async () => {
		const monitor = new FakeMonitor()
		monitor.menu = () => ({ found: true, reason: '', label: 'Save' })
		const { adapter, sent } = rig(() => unverified(), { monitor })
		const shot = await adapter.captureWindow('0x111')
		const result = await adapter.executeWindow(shot.captureId, { type: 'key', keys: 'ctrl+s' })
		expect(monitor.menuCommands).toEqual(['Ctrl+S'])
		// A command that succeeds without changing a control (save, copy) reads as unchanged: it must not run twice.
		expect(sent()).toHaveLength(0)
		expect(monitor.calls).not.toContain('begin')
		expect(result).toMatchObject({ delivery: 'delivered_unverified', retrySafety: 'unsafe' })
		expect(result?.detail).not.toMatch(/had no effect/)
		await adapter.dispose()
	})
})

describe('a person who uses the computer while the input waits for the screen', () => {
	it('stops the burst before anything is sent, waits for the next pause and goes then', async () => {
		const monitor = new FakeMonitor()
		let flipped = false
		monitor.beginState = () => baseState
		monitor.state_ = () => {
			// The first look after the first burst began finds a person's input.
			if (!flipped && monitor.calls.includes('begin')) {
				flipped = true
				return { ...baseState, userInputs: baseState.userInputs + 1 }
			}
			return baseState
		}
		const { adapter, sent } = rig(
			(call, page) => {
				if (modeOf(call) === 'foreground') page.push({ role: 'Text', label: 'hi' })
				return unverified()
			},
			{ monitor },
		)
		const shot = await adapter.captureWindow('0x111')
		const result = await adapter.executeWindow(shot.captureId, {
			type: 'type_text',
			text: 'hi',
			delivery_mode: 'foreground',
		})
		expect(monitor.calls.filter((call) => call === 'begin')).toHaveLength(2)
		// Nothing was sent by the stopped burst: the one send is the retry's.
		expect(sent()).toHaveLength(1)
		expect(result).toMatchObject({ delivery: 'delivered_verified' })
		await adapter.dispose()
	})

	it('gives up after a bounded number of stopped bursts and says nothing was sent', async () => {
		const monitor = new FakeMonitor()
		monitor.beginState = () => baseState
		let n = 0
		monitor.state_ = () =>
			monitor.calls.includes('begin')
				? { ...baseState, userInputs: baseState.userInputs + ++n }
				: baseState
		const { adapter, sent } = rig(() => unverified(), { monitor })
		const shot = await adapter.captureWindow('0x111')
		const result = await adapter.executeWindow(shot.captureId, {
			type: 'type_text',
			text: 'hi',
			delivery_mode: 'foreground',
		})
		expect(sent()).toHaveLength(0)
		expect(result).toMatchObject({ delivery: 'not_delivered', retrySafety: 'safe' })
		expect(result?.detail).toMatch(/nothing was sent/)
		await adapter.dispose()
	})
})

describe('the retry decision', () => {
	const obs = (...keys: string[]): Observation => new Map(keys.map((key) => [key, 1]))
	const still = obs('Button\u0000Save')

	it('needs enough reads, something to read, and a window that did not move by itself', () => {
		const base = { before: still, afters: [still, still], opened: false }
		expect(MIN_STILL_READS).toBe(2)
		expect(judgeStillness(base)).toMatchObject({ outcome: 'no_effect', retrySafety: 'safe' })
		expect(judgeStillness({ ...base, afters: [still] })).toBeUndefined()
		expect(judgeStillness({ ...base, before: obs(), afters: [obs(), obs()] })).toBeUndefined()
		expect(judgeStillness({ ...base, earlier: obs('Text\u0000clock 1') })).toBeUndefined()
		expect(judgeStillness({ ...base, opened: true })).toBeUndefined()
		expect(judgeStillness({ ...base, edit: 'unknown' })).toBeUndefined()
	})

	it('never calls a read that left something out proof of no effect', () => {
		const cut = new Map<string, number>([...still, ['\u0002cut', 1]])
		const base = { before: still, afters: [still, still], opened: false }
		expect(judgeStillness({ ...base, before: cut })).toBeUndefined()
		expect(judgeStillness({ ...base, afters: [still, cut] })).toBeUndefined()
	})

	it('calls a change unexplained, never no effect', () => {
		const moved = obs('Button\u0000Save', 'Text\u0000new')
		expect(judgeStillness({ before: still, afters: [still, moved], opened: false })).toMatchObject({
			outcome: 'unexplained',
			retrySafety: 'unsafe',
		})
		expect(
			judgeStillness({ before: still, afters: [still, still], opened: false, edit: 'changed' }),
		).toMatchObject({ outcome: 'unexplained' })
		expect(
			judgeStillness({ before: still, afters: [still, still], opened: false, edit: 'unchanged' }),
		).toMatchObject({ outcome: 'no_effect' })
	})

	it('retries only a first background attempt that left no effect, with no mode asked for', () => {
		const first = {
			delivery: 'delivered_unverified',
			retrySafety: 'safe',
			outcome: 'no_effect',
			onScreen: false,
		} as const
		const screen = { hasScreen: true, explicitMode: undefined }
		expect(shouldRetryOnScreen(first, screen)).toBe(true)
		expect(shouldRetryOnScreen(first, { ...screen, hasScreen: false })).toBe(false)
		expect(shouldRetryOnScreen(first, { ...screen, explicitMode: 'background' })).toBe(false)
		expect(shouldRetryOnScreen({ ...first, onScreen: true }, screen)).toBe(false)
		expect(shouldRetryOnScreen({ ...first, outcome: 'unexplained' }, screen)).toBe(false)
		expect(shouldRetryOnScreen({ ...first, retrySafety: 'unsafe' }, screen)).toBe(false)
	})

	it('judges only the inputs a read of the window can show the absence of', () => {
		expect(canBeJudgedByStillness({ type: 'type_text' })).toBe(true)
		expect(canBeJudgedByStillness({ type: 'key', keys: 'ctrl+o' })).toBe(true)
		// Keys that edit or undo in place may act where a tree read shows nothing.
		for (const keys of ['ENTER', 'backspace', 'delete', 'ctrl+z', 'ctrl+y', 'ctrl+x', 'ctrl+v'])
			expect(canBeJudgedByStillness({ type: 'key', keys })).toBe(false)
		for (const keys of ['TAB', 'ctrl+END', 'down', 'pagedown'])
			expect(canBeJudgedByStillness({ type: 'key', keys })).toBe(false)
		expect(canBeJudgedByStillness({ type: 'scroll' })).toBe(false)
		expect(canBeJudgedByStillness({ type: 'mouse_click' })).toBe(false)
	})

	it('writes each ending in words', () => {
		const second = { delivery: 'not_delivered', retrySafety: 'safe', onScreen: false } as const
		expect(escalationDetail({ ...second, blocked: 'lease_busy' })).toMatch(
			/^Waiting for you to be idle/,
		)
		expect(escalationDetail({ ...second, blocked: 'locked_desktop', detail: 'locked' })).toMatch(
			/not possible, so nothing more was sent. locked/,
		)
		expect(escalationDetail({ ...second, onScreen: true, outcome: 'unexplained' })).toMatch(
			/not safe to send it again/,
		)
	})
})

describe('the name a classic menu gives a shortcut', () => {
	it('is the modifiers and the key, and only for a combination a menu can name', async () => {
		const { menuAcceleratorOf } = await import('../adapters/cua-driver/keys.js')
		expect(menuAcceleratorOf('ctrl+o')).toBe('Ctrl+O')
		expect(menuAcceleratorOf('ctrl+shift+s')).toBe('Ctrl+Shift+S')
		expect(menuAcceleratorOf('cmd+f')).toBe('Ctrl+F')
		expect(menuAcceleratorOf('ctrl+F3')).toBe('Ctrl+F3')
		expect(menuAcceleratorOf('ENTER')).toBeUndefined()
		expect(menuAcceleratorOf('o')).toBeUndefined()
		expect(menuAcceleratorOf('ctrl+enter')).toBeUndefined()
		expect(menuAcceleratorOf('win+r')).toBeUndefined()
	})
})
