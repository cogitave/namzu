import { describe, expect, it } from 'vitest'
import {
	effortUniforms,
	fillEnd,
	isLight,
	parseColor,
	renderPath,
	shouldAnimate,
	smoothstep,
	stepToward,
} from './effort-shader-core.js'

describe('stepToward', () => {
	it('eases toward the target without overshooting', () => {
		let value = 0
		for (let i = 0; i < 20; i++) {
			const next = stepToward(value, 1, 16)
			expect(next).toBeGreaterThan(value)
			expect(next).toBeLessThanOrEqual(1)
			value = next
		}
	})
	it('lands exactly once close enough and ignores a zero step', () => {
		expect(stepToward(0.9999, 1, 16)).toBe(1)
		expect(stepToward(0.3, 1, 0)).toBe(0.3)
	})
})

describe('shouldAnimate', () => {
	it('runs only when open, visible and motion is allowed', () => {
		expect(shouldAnimate({ active: true, reducedMotion: false, hidden: false })).toBe(true)
		expect(shouldAnimate({ active: false, reducedMotion: false, hidden: false })).toBe(false)
		expect(shouldAnimate({ active: true, reducedMotion: true, hidden: false })).toBe(false)
		expect(shouldAnimate({ active: true, reducedMotion: false, hidden: true })).toBe(false)
	})
})

describe('renderPath', () => {
	it('falls back to the CSS fill without WebGL or after a lost context', () => {
		expect(renderPath({ webgl: false, contextLost: false, reducedMotion: false })).toBe('css')
		expect(renderPath({ webgl: true, contextLost: true, reducedMotion: false })).toBe('css')
		expect(renderPath({ webgl: false, contextLost: false, reducedMotion: true })).toBe('css')
	})
	it('draws one static frame under reduced motion, else animates', () => {
		expect(renderPath({ webgl: true, contextLost: false, reducedMotion: true })).toBe('static')
		expect(renderPath({ webgl: true, contextLost: false, reducedMotion: false })).toBe('animated')
	})
})

describe('effortUniforms', () => {
	it('rises with the level and clamps out-of-range input', () => {
		const low = effortUniforms(0)
		const mid = effortUniforms(0.5)
		const top = effortUniforms(1)
		expect(low.drift).toBeLessThan(mid.drift)
		expect(mid.drift).toBeLessThan(top.drift)
		expect(low.sparkle).toBeLessThan(top.sparkle)
		expect(low.warmth).toBeLessThan(top.warmth)
		expect(effortUniforms(5)).toEqual(top)
		expect(effortUniforms(-1)).toEqual(low)
	})
	it('keeps a faint pulse at the bottom and a full bloom only at the top', () => {
		expect(effortUniforms(0).bloom).toBe(0.12)
		expect(effortUniforms(0.5).bloom).toBe(0.12)
		expect(effortUniforms(1).bloom).toBe(1)
	})
})

describe('geometry', () => {
	it('places the fill end between the paddings and clamps progress', () => {
		expect(fillEnd(200, 14, 0)).toBe(14)
		expect(fillEnd(200, 14, 1)).toBe(186)
		expect(fillEnd(200, 14, 0.5)).toBe(100)
		expect(fillEnd(200, 14, 3)).toBe(186)
		expect(smoothstep(0, 1, 0.5)).toBe(0.5)
	})
})

describe('colours', () => {
	it('parses hex, rgb and srgb forms', () => {
		expect(parseColor('#fff')).toEqual([1, 1, 1])
		expect(parseColor('rgb(255, 0, 0)')).toEqual([1, 0, 0])
		expect(parseColor('color(srgb 0 0.5 1)')).toEqual([0, 0.5, 1])
		expect(parseColor('nonsense')).toBeNull()
	})
	it('tells a light surface from a dark one', () => {
		expect(isLight([1, 1, 1])).toBe(true)
		expect(isLight([0.1, 0.1, 0.1])).toBe(false)
	})
})
