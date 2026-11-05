/**
 * The presence overlay's motion maths and the development preview command.
 * The C# in the helper script follows these formulas; its constants are
 * written into it from `motion.ts`, so what is pinned here is what runs.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { PRESENCE_HELPER_SCRIPT } from '../presence/helper-script.js'
import {
	APPEAR_FROM_SCALE,
	CLICK_RIPPLE,
	DIP_DOWN_MS,
	DIP_SCALE,
	DIP_UP_MS,
	FADE_MS,
	FRAME_PULSE_DEPTH,
	FRAME_PULSE_MS,
	GLIDE_BOW,
	GLIDE_MAX_MS,
	GLIDE_MIN_MS,
	HOLD_MS,
	KEY_RIPPLE,
	RIPPLE_MS,
	dipScale,
	displayScale,
	easeInOut,
	easeOut,
	framePulse,
	glideControl,
	glideDurationMs,
	glidePoint,
	idleAlpha,
	rippleFrame,
} from '../presence/motion.js'
import { PREVIEW_DPIS, PREVIEW_STATES, previewCommandLine } from '../presence/preview.js'

describe('the glide', () => {
	it('takes 140 ms for a short hop, grows with distance and stops at 420 ms', () => {
		expect(glideDurationMs(0)).toBe(GLIDE_MIN_MS)
		expect(glideDurationMs(100)).toBeGreaterThan(GLIDE_MIN_MS)
		expect(glideDurationMs(300)).toBeGreaterThan(glideDurationMs(100))
		expect(glideDurationMs(5_000)).toBe(GLIDE_MAX_MS)
		expect(GLIDE_MIN_MS).toBe(140)
		expect(GLIDE_MAX_MS).toBe(420)
	})

	it('eases in and out, and settles', () => {
		expect(easeInOut(0)).toBe(0)
		expect(easeInOut(1)).toBe(1)
		expect(easeInOut(0.5)).toBeCloseTo(0.5, 10)
		expect(easeInOut(0.1)).toBeLessThan(0.1)
		expect(easeInOut(0.9)).toBeGreaterThan(0.9)
		expect(easeOut(0.5)).toBeGreaterThan(0.5)
		expect(easeInOut(-1)).toBe(0)
		expect(easeInOut(2)).toBe(1)
	})

	it('bows the path by a tenth of its length, perpendicular to it', () => {
		const from = { x: 0, y: 0 }
		const to = { x: 200, y: 0 }
		const c = glideControl(from, to)
		expect(c.x).toBeCloseTo(100, 10)
		expect(Math.abs(c.y)).toBeCloseTo(200 * GLIDE_BOW, 10)
		// A path of no length has nothing to bow.
		expect(glideControl(from, from)).toEqual(from)
	})

	it('bows to the same side of a line whichever way it is travelled, so repeated moves do not zigzag', () => {
		const a = { x: 40, y: 300 }
		const b = { x: 420, y: 180 }
		const there = glideControl(a, b)
		const back = glideControl(b, a)
		expect(back.x).toBeCloseTo(there.x, 10)
		expect(back.y).toBeCloseTo(there.y, 10)
		// Up on the screen for a sloped or level line.
		const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
		const sideOfChord = (p: { x: number; y: number }): number =>
			(b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x)
		expect(sideOfChord(there)).not.toBe(0)
		expect(there.y).toBeLessThan(mid.y)
		// To the right for a vertical line, in both directions.
		const up = glideControl({ x: 10, y: 0 }, { x: 10, y: 100 })
		const down = glideControl({ x: 10, y: 100 }, { x: 10, y: 0 })
		expect(up.x).toBeGreaterThan(10)
		expect(down.x).toBeCloseTo(up.x, 10)
	})

	it('runs along the curve from the start to the end', () => {
		const from = { x: 10, y: 20 }
		const to = { x: 310, y: 120 }
		const c = glideControl(from, to)
		expect(glidePoint(from, c, to, 0)).toEqual(from)
		expect(glidePoint(from, c, to, 1)).toEqual(to)
		// The midpoint of a quadratic curve is a quarter of the way from the chord to the control point.
		const mid = glidePoint(from, c, to, 0.5)
		expect(mid.x).toBeCloseTo(0.25 * from.x + 0.5 * c.x + 0.25 * to.x, 10)
		expect(mid.y).toBeCloseTo(0.25 * from.y + 0.5 * c.y + 0.25 * to.y, 10)
	})
})

describe('a click and a key press', () => {
	it('dips to 0.88 over 70 ms and is back to 1 after a further 110 ms', () => {
		expect(DIP_SCALE).toBe(0.88)
		expect(dipScale(-5)).toBe(1)
		expect(dipScale(0)).toBe(1)
		expect(dipScale(DIP_DOWN_MS)).toBeCloseTo(DIP_SCALE, 10)
		expect(dipScale(DIP_DOWN_MS / 2)).toBeLessThan(1)
		expect(dipScale(DIP_DOWN_MS / 2)).toBeGreaterThan(DIP_SCALE)
		expect(dipScale(DIP_DOWN_MS + DIP_UP_MS)).toBe(1)
		expect(DIP_DOWN_MS).toBe(70)
		expect(DIP_UP_MS).toBe(110)
	})

	it('sends out a ripple from 5 to 26 logical px over 420 ms, fading to nothing', () => {
		expect(CLICK_RIPPLE).toMatchObject({ from: 5, to: 26, alpha: 0.55, stroke: 2 })
		expect(RIPPLE_MS).toBe(420)
		expect(rippleFrame('click', -1)).toBeUndefined()
		expect(rippleFrame('click', RIPPLE_MS)).toBeUndefined()
		const start = rippleFrame('click', 0)
		expect(start).toEqual({ radius: 5, alpha: 0.55, stroke: 2 })
		const mid = rippleFrame('click', RIPPLE_MS / 2)
		expect(mid?.radius).toBeGreaterThan(5)
		expect(mid?.radius).toBeLessThan(26)
		expect(mid?.alpha).toBeCloseTo(0.275, 10)
		const near = rippleFrame('click', RIPPLE_MS - 1)
		expect(near?.radius).toBeCloseTo(26, 0)
		expect(near?.alpha).toBeLessThan(0.01)
	})

	it('makes a smaller, softer ripple for typing', () => {
		expect(KEY_RIPPLE).toMatchObject({ from: 4, to: 14 })
		expect(KEY_RIPPLE.alpha).toBeLessThan(CLICK_RIPPLE.alpha)
		expect(KEY_RIPPLE.to).toBeLessThan(CLICK_RIPPLE.from + 10)
		expect(rippleFrame('type', 0)?.radius).toBe(4)
	})
})

describe('the first appearance, the frame and the idle fade', () => {
	it('grows from 0.85 over 160 ms', () => {
		expect(APPEAR_FROM_SCALE).toBe(0.85)
	})

	it('holds for 2 s, then fades over 0.5 s', () => {
		expect(HOLD_MS).toBe(2_000)
		expect(FADE_MS).toBe(500)
		expect(idleAlpha(0)).toBe(1)
		expect(idleAlpha(HOLD_MS)).toBe(1)
		expect(idleAlpha(HOLD_MS + FADE_MS / 2)).toBeCloseTo(0.5, 10)
		expect(idleAlpha(HOLD_MS + FADE_MS)).toBe(0)
		expect(idleAlpha(HOLD_MS + FADE_MS * 3)).toBe(0)
	})

	it('breathes by 8 percent every 2.4 s and never brighter than whole', () => {
		expect(FRAME_PULSE_MS).toBe(2_400)
		const values = Array.from({ length: 240 }, (_, i) => framePulse((i * FRAME_PULSE_MS) / 240))
		expect(Math.max(...values)).toBeLessThanOrEqual(1)
		expect(Math.min(...values)).toBeGreaterThanOrEqual(1 - 2 * FRAME_PULSE_DEPTH - 1e-9)
		expect(framePulse(0)).toBeCloseTo(1 - FRAME_PULSE_DEPTH, 10)
		expect(framePulse(FRAME_PULSE_MS)).toBeCloseTo(framePulse(0), 10)
	})

	it('follows the window display scale', () => {
		expect(displayScale(96)).toBe(1)
		expect(displayScale(144)).toBe(1.5)
		expect(displayScale(192)).toBe(2)
		expect(displayScale(0)).toBe(1)
	})
})

describe('the numbers in the helper script are the ones in motion.ts', () => {
	it('writes each of them into the C#', () => {
		const script = PRESENCE_HELPER_SCRIPT
		expect(script).toContain(`GlideBow = ${GLIDE_BOW}`)
		expect(script).toContain(`DipScale = ${DIP_SCALE}`)
		expect(script).toContain(`DipDownMs = ${DIP_DOWN_MS}`)
		expect(script).toContain(`DipUpMs = ${DIP_UP_MS}`)
		expect(script).toContain(`RippleMs = ${RIPPLE_MS}`)
		expect(script).toContain(`AppearFrom = ${APPEAR_FROM_SCALE}`)
		expect(script).toContain(`ClickFrom = ${CLICK_RIPPLE.from}, ClickTo = ${CLICK_RIPPLE.to}`)
		expect(script).toContain(`KeyFrom = ${KEY_RIPPLE.from}, KeyTo = ${KEY_RIPPLE.to}`)
		expect(script).toContain(`FramePulseMs = ${FRAME_PULSE_MS}`)
	})
})

describe('the preview command', () => {
	it('is one JSON line naming the dpi, the state and the file', () => {
		expect(
			JSON.parse(previewCommandLine({ dpi: 144, state: 'press', path: 'C:\\x\\p.png' })),
		).toEqual({ cmd: 'preview', dpi: 144, state: 'press', path: 'C:\\x\\p.png' })
		expect(PREVIEW_DPIS).toEqual([96, 144, 192])
		expect(PREVIEW_STATES).toEqual(expect.arrayContaining(['rest', 'press', 'ripple']))
	})

	it('refuses what the helper would refuse', () => {
		expect(() => previewCommandLine({ dpi: 100 as 96, state: 'rest', path: 'a.png' })).toThrow(
			/dpi/,
		)
		expect(() => previewCommandLine({ dpi: 96, state: 'spin' as 'rest', path: 'a.png' })).toThrow(
			/state/,
		)
		expect(() => previewCommandLine({ dpi: 96, state: 'rest', path: '  ' })).toThrow(/path/)
	})
})

describe('the host and the helper agree on the commands', () => {
	const source = (name: string): string =>
		readFileSync(new URL(`../presence/${name}`, import.meta.url), 'utf8')

	it('handles every command the TypeScript side sends, and the ones it answers', () => {
		const sent = new Set<string>()
		for (const file of ['presence.ts', 'preview.ts']) {
			for (const m of source(file).matchAll(/cmd:\s*'(\w+)'/g)) sent.add(m[1] as string)
		}
		expect([...sent].sort()).toEqual(['act', 'hide', 'preview'])
		for (const cmd of [...sent, 'info', 'quit']) {
			expect(PRESENCE_HELPER_SCRIPT, `the helper does not handle '${cmd}'`).toContain(`'${cmd}' {`)
		}
	})

	it('names the same states and dpis the TypeScript builder accepts', () => {
		for (const state of PREVIEW_STATES) {
			expect(PRESENCE_HELPER_SCRIPT).toContain(`"${state}"`)
		}
		expect(PRESENCE_HELPER_SCRIPT).toContain('dpi < 48 || dpi > 576')
	})
})
