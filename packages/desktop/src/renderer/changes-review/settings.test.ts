import { describe, expect, it } from 'vitest'
import {
	DISPLAY_DEFAULTS,
	LIST_FIT_WIDTH,
	LIST_WIDTH,
	clampListWidth,
	listSide,
	parseDisplay,
} from './settings.js'

describe('display settings', () => {
	it('defaults to wrap and changed words on, and everything else off', () => {
		expect(parseDisplay(null)).toEqual(DISPLAY_DEFAULTS)
		expect(DISPLAY_DEFAULTS).toMatchObject({
			wordWrap: true,
			highlightWords: true,
			showFiles: false,
			groupByFolder: false,
			separateKinds: false,
			hideWhitespace: false,
			sideBySide: false,
			listPosition: 'auto',
		})
	})

	it('keeps stored values of the right type and ignores the rest', () => {
		const stored = JSON.stringify({
			wordWrap: false,
			listPosition: 'left',
			listWidth: 9999,
			groupByFolder: 'yes',
		})
		expect(parseDisplay(stored)).toMatchObject({
			wordWrap: false,
			listPosition: 'left',
			listWidth: LIST_WIDTH.max,
			groupByFolder: false,
		})
		expect(parseDisplay('not json')).toEqual(DISPLAY_DEFAULTS)
	})

	it('clamps the list width and fits the list from 400 px', () => {
		expect(clampListWidth(10)).toBe(LIST_WIDTH.min)
		expect(clampListWidth(300.4)).toBe(300)
		expect(LIST_FIT_WIDTH).toBe(400)
	})

	it('puts Automatic on the side away from the conversation', () => {
		expect(listSide('auto')).toBe('right')
		expect(listSide('right')).toBe('right')
		expect(listSide('left')).toBe('left')
	})
})
