import { expect, it } from 'vitest'
import {
	computerFrameReady,
	computerKeyboardInput,
	computerScreenPoint,
} from './pal-computer-input.js'

it('keeps decoded geometry usable across PNG refreshes and blocks resized or failed frames', () => {
	const first = { source: 'first-actual-frame', width: 1280, height: 800 }
	const replacement = { ...first, source: 'updated-actual-frame' }
	const loaded = { width: first.width, height: first.height }
	expect(computerFrameReady(null, first)).toBe(false)
	expect(computerFrameReady(loaded, first)).toBe(true)
	expect(computerFrameReady(loaded, replacement)).toBe(true)
	expect(computerFrameReady(loaded, { ...replacement, width: 1024 })).toBe(false)
	expect(computerFrameReady(null, replacement)).toBe(false)
	expect(computerFrameReady(loaded, null)).toBe(false)
	for (const width of [0, -1, Number.NaN, Number.POSITIVE_INFINITY])
		expect(computerFrameReady({ width, height: 800 }, { width, height: 800 })).toBe(false)
})

it('maps guest pixels correctly when the displayed screen is scaled and letterboxed', () => {
	const screen = { width: 1280, height: 800 }
	const box = { left: 20, top: 30, width: 640, height: 480 }
	expect(computerScreenPoint({ x: 340, y: 270 }, box, screen)).toEqual({ x: 640, y: 400 })
	expect(computerScreenPoint({ x: 20, y: 70 }, box, screen)).toEqual({ x: 0, y: 0 })
	expect(computerScreenPoint({ x: 659.5, y: 469.5 }, box, screen)).toEqual({ x: 1279, y: 799 })
	for (const client of [
		{ x: 340, y: 40 },
		{ x: 340, y: 500 },
		{ x: 660, y: 270 },
	])
		expect(computerScreenPoint(client, box, screen)).toBeNull()
})

it('excludes horizontal letterboxing and refuses missing or non-finite capture geometry', () => {
	const screen = { width: 800, height: 600 }
	const box = { left: 0, top: 0, width: 1000, height: 500 }
	expect(computerScreenPoint({ x: 500, y: 250 }, box, screen)).toEqual({ x: 400, y: 300 })
	expect(computerScreenPoint({ x: 100, y: 250 }, box, screen)).toBeNull()
	expect(computerScreenPoint({ x: 900, y: 250 }, box, screen)).toBeNull()
	for (const width of [0, -1, Number.NaN, Number.POSITIVE_INFINITY])
		expect(computerScreenPoint({ x: 500, y: 250 }, box, { ...screen, width })).toBeNull()
})

const keyboard = { ctrlKey: false, altKey: false, shiftKey: false, metaKey: false }

it('preserves the actual keyboard layout for typed text and translates guest shortcuts', () => {
	for (const key of ['a', 'İ', 'ç', ' ', '🐰'])
		expect(computerKeyboardInput({ ...keyboard, key })).toEqual({ type: 'type_text', text: key })
	expect(
		computerKeyboardInput({ ...keyboard, key: '@', ctrlKey: true, altKey: true, altGraph: true }),
	).toEqual({ type: 'type_text', text: '@' })
	expect(computerKeyboardInput({ ...keyboard, key: 'R', ctrlKey: true, shiftKey: true })).toEqual({
		type: 'key',
		keys: 'CTRL+SHIFT+r',
	})
	expect(computerKeyboardInput({ ...keyboard, key: 'ArrowLeft', altKey: true })).toEqual({
		type: 'key',
		keys: 'ALT+ARROWLEFT',
	})
	expect(computerKeyboardInput({ ...keyboard, key: 'Enter' })).toEqual({
		type: 'key',
		keys: 'ENTER',
	})
})

it('uses the current guest worker aliases and exact X keysyms for navigation keys', () => {
	for (const [key, keys] of [
		['ArrowUp', 'ARROWUP'],
		['ArrowDown', 'ARROWDOWN'],
		['ArrowLeft', 'ARROWLEFT'],
		['ArrowRight', 'ARROWRIGHT'],
		['Home', 'Home'],
		['End', 'End'],
		['Insert', 'Insert'],
		['PageUp', 'PAGEUP'],
		['PageDown', 'PAGEDOWN'],
	])
		expect(computerKeyboardInput({ ...keyboard, key })).toEqual({ type: 'key', keys })
})

it('keeps shortcut Shift explicit and escapes punctuation from the key-combination separator', () => {
	expect(computerKeyboardInput({ ...keyboard, key: 'r', ctrlKey: true })).toEqual({
		type: 'key',
		keys: 'CTRL+r',
	})
	expect(computerKeyboardInput({ ...keyboard, key: 'R', ctrlKey: true })).toEqual({
		type: 'key',
		keys: 'CTRL+r',
	})
	for (const [key, keys] of [
		['+', 'plus'],
		['-', 'minus'],
		['=', 'equal'],
		['/', 'slash'],
		['.', 'period'],
	])
		expect(computerKeyboardInput({ ...keyboard, key, ctrlKey: true })).toEqual({
			type: 'key',
			keys: `CTRL+${keys}`,
		})
})

it('keeps focus navigation and composing input out of remote keyboard commands', () => {
	for (const key of ['Tab', 'Shift', 'Control', 'Dead', 'Process'])
		expect(computerKeyboardInput({ ...keyboard, key })).toBeNull()
	expect(computerKeyboardInput({ ...keyboard, key: 'a', isComposing: true })).toBeNull()
})
