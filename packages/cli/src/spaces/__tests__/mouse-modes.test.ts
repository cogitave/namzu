import { describe, expect, it } from 'vitest'
import { HeadlessScreen } from '../../terminal/screen.js'
import type { EndingSignal, SignalHooks } from '../host.js'
import {
	LEAVE_SCREEN,
	MOUSE_OFF,
	type MouseMode,
	enterScreen,
	mouseOn,
	resolveMouseMode,
	writeLaunchMouseReset,
} from '../mouse.js'
import type { LocalPaneSession, SessionEnding, SessionStatus } from '../session.js'
import { setup } from './support/harness.js'

const PRIVATE_MODE = new RegExp(`${String.fromCharCode(27)}\\[\\?([0-9;]+)([hl])`, 'gu')

/** The private modes a stream of writes leaves on, by number. */
function modesAfter(writes: readonly string[]): Set<number> {
	const on = new Set<number>()
	for (const match of writes.join('').matchAll(PRIVATE_MODE)) {
		for (const mode of (match[1] as string).split(';'))
			if (match[2] === 'h') on.add(Number(mode))
			else on.delete(Number(mode))
	}
	return on
}

const POINTER = [9, 1000, 1002, 1003, 1005, 1006, 1015, 1016]
const pointerOn = (writes: readonly string[]): number[] =>
	[...modesAfter(writes)].filter((m) => POINTER.includes(m))

class FakeLocal implements LocalPaneSession {
	readonly local = true as const
	status: SessionStatus = 'running'
	ending: SessionEnding | undefined
	readonly pid = 4242
	screen = new HeadlessScreen(80, 24, 100)
	attach(cols: number, rows: number): void {
		this.screen.dispose()
		this.screen = new HeadlessScreen(cols, rows, 100)
	}
	detach(): void {}
	private listener: (() => void) | undefined
	observe(listener: () => void): void {
		this.listener = listener
	}
	exit(): void {
		this.status = 'exited'
		this.ending = 'finished'
		this.listener?.()
	}
	write(): void {}
	resize(): void {}
	stop(): void {}
	dispose(): void {
		this.screen.dispose()
	}
}

class FakeSignals implements SignalHooks {
	readonly listeners = new Map<EndingSignal, Set<() => void>>()
	readonly raised: EndingSignal[] = []
	readonly now: string[] = []
	others = 0
	on(signal: EndingSignal, listener: () => void): void {
		const set = this.listeners.get(signal) ?? new Set()
		set.add(listener)
		this.listeners.set(signal, set)
	}
	off(signal: EndingSignal, listener: () => void): void {
		this.listeners.get(signal)?.delete(listener)
	}
	count(signal: EndingSignal): number {
		return (this.listeners.get(signal)?.size ?? 0) + this.others
	}
	raise(signal: EndingSignal): void {
		this.raised.push(signal)
	}
	writeNow(text: string): void {
		this.now.push(text)
	}
	emit(signal: EndingSignal): void {
		for (const l of [...(this.listeners.get(signal) ?? [])]) l()
	}
	total(): number {
		return [...this.listeners.values()].reduce((n, s) => n + s.size, 0)
	}
}

describe('mouse mode sequences', () => {
	it('full asks for presses, drags and SGR; scroll for the wheel; off for nothing', () => {
		expect(mouseOn('full')).toBe('\x1b[?1000h\x1b[?1002h\x1b[?1006h')
		expect(mouseOn('scroll')).toBe('\x1b[?1000h\x1b[?1006h')
		expect(mouseOn('off')).toBe('')
	})

	it('the off sequence covers every pointer mode', () => {
		expect(MOUSE_OFF).toBe(
			'\x1b[?1006l\x1b[?1016l\x1b[?1015l\x1b[?1005l\x1b[?1003l\x1b[?1002l\x1b[?1000l\x1b[?9l',
		)
		for (const mode of ['full', 'scroll', 'off'] as const)
			expect(pointerOn([enterScreen(mode), LEAVE_SCREEN])).toEqual([])
	})

	it('reads the environment before the setting, and the kill switch before the wheel-only one', () => {
		expect(resolveMouseMode({})).toBe('full')
		expect(resolveMouseMode({}, 'scroll')).toBe('scroll')
		expect(resolveMouseMode({}, 'off')).toBe('off')
		expect(resolveMouseMode({ NAMZU_DISABLE_MOUSE_CLICKS: '1' }, 'full')).toBe('scroll')
		expect(resolveMouseMode({ NAMZU_DISABLE_MOUSE: '1' }, 'full')).toBe('off')
		expect(resolveMouseMode({ NAMZU_DISABLE_MOUSE: '1', NAMZU_DISABLE_MOUSE_CLICKS: '1' })).toBe(
			'off',
		)
		expect(resolveMouseMode({ NAMZU_DISABLE_MOUSE: '0' }, 'full')).toBe('full')
		expect(resolveMouseMode({ NAMZU_DISABLE_MOUSE: 'false' })).toBe('full')
	})
})

describe('the launch reset', () => {
	it('clears the pointer once on a terminal and never turns anything on', () => {
		const writes: string[] = []
		expect(writeLaunchMouseReset({ isTTY: true, write: (t) => writes.push(t) }, false)).toBe(true)
		expect(writes).toEqual([MOUSE_OFF])
		expect(modesAfter(writes).size).toBe(0)
		expect(writes.join('')).not.toMatch(/\?(1000|1002|1003|1006|1049)h/u)
	})

	it('writes nothing to a stream that is not a terminal, or inside a host', () => {
		const writes: string[] = []
		const out = (isTTY: boolean) => ({ isTTY, write: (t: string) => writes.push(t) })
		expect(writeLaunchMouseReset(out(false), false)).toBe(false)
		expect(writeLaunchMouseReset(out(true), true)).toBe(false)
		expect(writes).toEqual([])
	})
})

describe('the spaces host and the pointer', () => {
	const modes: MouseMode[] = ['full', 'scroll', 'off']

	it('turns on what the mode names after the alternate screen, and all off on quit', () => {
		for (const mode of modes) {
			const t = setup({ columns: 100, rows: 30 }, { mouse: mode })
			t.host.start()
			const expected = { full: [1000, 1002, 1006], scroll: [1000, 1006], off: [] }[mode]
			expect(pointerOn(t.written).sort()).toEqual(expected)
			expect(modesAfter(t.written).has(1049)).toBe(true)
			t.host.quit()
			for (const pty of t.spawned) (pty as unknown as { end(c?: number): void }).end(0)
			expect(pointerOn(t.written)).toEqual([])
			expect(modesAfter(t.written).has(1049)).toBe(false)
		}
	})

	it('defaults to full', () => {
		const t = setup()
		t.host.start()
		expect(pointerOn(t.written).sort()).toEqual([1000, 1002, 1006])
		t.host.quit()
	})

	it('inside a conversation draws nothing until opened, then every mode on is off again after each close', () => {
		const local = new FakeLocal()
		const t = setup(
			{ columns: 120, rows: 36 },
			{ local: { session: local, conversationId: () => undefined } },
		)
		t.host.start()
		expect(t.written).toEqual([])
		for (let round = 0; round < 3; round++) {
			t.host.openSpaces()
			expect(pointerOn(t.written).sort()).toEqual([1000, 1002, 1006])
			expect(t.written.join('')).toContain('\x1b[?1049h')
			expect(t.host.releaseTerminal()).toBe(true)
			expect(pointerOn(t.written)).toEqual([])
			expect(modesAfter(t.written).has(1049)).toBe(false)
		}
		t.host.openSpaces()
		local.exit()
		t.host.quit()
		expect(pointerOn(t.written)).toEqual([])
		expect(modesAfter(t.written).has(1049)).toBe(false)
	})

	it('sends the mode again on a resize while shown and nothing while hidden', () => {
		const local = new FakeLocal()
		const t = setup(
			{ columns: 120, rows: 36 },
			{ local: { session: local, conversationId: () => undefined } },
		)
		t.host.start()
		const resize = () => {
			for (const l of t.resizeListeners) l()
		}
		resize()
		expect(t.written).toEqual([])
		t.host.openSpaces()
		const mark = t.written.length
		resize()
		expect(t.written.slice(mark).join('')).toContain(mouseOn('full'))
		t.host.releaseTerminal()
		const hidden = t.written.length
		resize()
		expect(t.written.slice(hidden).join('')).not.toContain('\x1b[?1000h')
		t.host.quit()
	})

	it('ignores presses and drags when only the wheel is asked for', () => {
		const t = setup({ columns: 100, rows: 30 }, { mouse: 'scroll' })
		t.host.start()
		const before = t.host.roster.selected
		t.type('\x1b[<0;60;5M')
		t.type('\x1b[<0;60;5m')
		expect(t.host.roster.selected).toBe(before)
		t.host.quit()
	})

	it('the off mode still enters the alternate screen', () => {
		const t = setup({ columns: 100, rows: 30 }, { mouse: 'off' })
		t.host.start()
		expect(t.written.join('')).toContain('\x1b[?1049h')
		expect(t.written.join('')).not.toMatch(/\?(1000|1002|1003|1006)h/u)
		t.host.quit()
	})

	it('hands the terminal over for a handoff and takes it back even when it throws', async () => {
		const local = new FakeLocal()
		const t = setup(
			{ columns: 120, rows: 36 },
			{ local: { session: local, conversationId: () => undefined } },
		)
		t.host.start()
		t.host.openSpaces()
		const mark = t.written.length
		let during: number[] | undefined
		await expect(
			t.host.withTerminalHandoff(() => {
				during = pointerOn(t.written)
				throw new Error('editor failed')
			}),
		).rejects.toThrow('editor failed')
		expect(during).toEqual([])
		expect(modesAfter(t.written).has(1049)).toBe(true)
		expect(pointerOn(t.written).sort()).toEqual([1000, 1002, 1006])
		expect(t.written.slice(mark).join('')).toContain('\x1b[?1049l')
		// Nothing is written around a handoff when the host is hidden.
		t.host.releaseTerminal()
		const hidden = t.written.length
		await t.host.withTerminalHandoff(() => 1)
		expect(t.written.length).toBe(hidden)
		t.host.quit()
	})
})

describe('signals', () => {
	it('writes the leave sequence at once and re-raises when nothing else listens', () => {
		const signals = new FakeSignals()
		const t = setup({ columns: 100, rows: 30 }, { signals })
		t.host.start()
		expect(signals.total()).toBe(3)
		signals.emit('SIGTERM')
		expect(signals.now).toEqual([LEAVE_SCREEN])
		expect(signals.raised).toEqual(['SIGTERM'])
		expect(signals.total()).toBe(0)
		expect(t.host.visible).toBe(false)
		t.host.quit()
	})

	it('leaves the signal to its other listeners but still gives the terminal back', () => {
		const signals = new FakeSignals()
		signals.others = 1
		const t = setup({ columns: 100, rows: 30 }, { signals })
		t.host.start()
		signals.emit('SIGHUP')
		expect(signals.now).toEqual([LEAVE_SCREEN])
		expect(signals.raised).toEqual([])
		t.host.quit()
	})

	it('removes its listeners when it closes', () => {
		const signals = new FakeSignals()
		const t = setup({ columns: 100, rows: 30 }, { signals })
		t.host.start()
		t.host.quit()
		for (const pty of t.spawned) (pty as unknown as { end(c?: number): void }).end(0)
		expect(signals.total()).toBe(0)
	})
})
