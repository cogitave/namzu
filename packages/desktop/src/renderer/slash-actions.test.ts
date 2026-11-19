import { describe, expect, it } from 'vitest'
import {
	SLASH_DEFINITIONS,
	type SlashHandlers,
	slashRows,
	slashRowsHeldBack,
} from './slash-actions.js'

const noop = () => undefined

describe('slashRows', () => {
	it('lists only rows with a handler, in the table order, never greyed', () => {
		const handlers: SlashHandlers = { new: noop, fork: noop, model: noop }
		expect(slashRows(handlers, { newConversation: false }).map((row) => row.name)).toEqual([
			'fork',
			'model',
			'new',
		])
	})

	it('keeps rows that need a conversation off the new-conversation screen', () => {
		const handlers: SlashHandlers = { new: noop, fork: noop, model: noop }
		expect(slashRows(handlers, { newConversation: true }).map((row) => row.name)).toEqual([
			'model',
			'new',
		])
		expect(slashRowsHeldBack(handlers, true)).toBe(true)
		expect(slashRowsHeldBack({ model: noop }, true)).toBe(false)
		expect(slashRowsHeldBack(handlers, false)).toBe(false)
	})

	it('has one row per name and a tooltip for each', () => {
		const names = SLASH_DEFINITIONS.map((row) => row.name)
		expect(new Set(names).size).toBe(names.length)
		expect(SLASH_DEFINITIONS.every((row) => row.tooltip.length > 0)).toBe(true)
	})
})
