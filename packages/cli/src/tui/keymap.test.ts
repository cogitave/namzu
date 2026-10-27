import { describe, expect, it } from 'vitest'

import {
	ACTIONS,
	type ActionId,
	isAction,
	isChordAction,
	isChordLead,
	keyLabel,
	keysHelpText,
	primaryKeyLabel,
} from './keymap.js'

describe('the action registry', () => {
	it('gives no two actions in one context the same key', () => {
		const seen = new Map<string, string>()
		for (const spec of ACTIONS) {
			for (const chord of spec.keys) {
				const slot = `${spec.context}:${chord}`
				expect(seen.get(slot), `${chord} is bound twice in ${spec.context}`).toBeUndefined()
				seen.set(slot, spec.id)
			}
		}
	})

	it('matches the keys the chat screen has always answered', () => {
		const cases: [ActionId, string, Record<string, boolean>][] = [
			['app:interrupt', 'c', { ctrl: true }],
			['app:exit', 'd', { ctrl: true }],
			['app:toggleTranscript', 'o', { ctrl: true }],
			['app:openAgents', 't', { ctrl: true }],
			['chat:clearScreen', 'l', { ctrl: true }],
			['task:background', 'b', { ctrl: true }],
			['history:search', 'r', { ctrl: true }],
			['chat:cycleMode', '', { tab: true, shift: true }],
			['chat:newline', '', { return: true, shift: true }],
			['chat:newline', '', { return: true, meta: true }],
			['chat:effortLower', '', { downArrow: true, shift: true }],
			['chat:effortRaise', '.', { meta: true }],
			['chat:recallQueued', '', { upArrow: true, meta: true }],
			['chat:triggerToggle', 'w', { meta: true }],
			['edit:wordLeft', 'b', { meta: true }],
			['edit:wordLeft', '', { leftArrow: true, ctrl: true }],
			['edit:deleteWordBack', '', { backspace: true, meta: true }],
			['chat:imagePaste', 'v', { meta: true }],
			['chat:externalEditor', 'g', { ctrl: true }],
		]
		for (const [id, input, key] of cases) {
			expect(isAction(id, input, key), `${id} on ${JSON.stringify(key)} ${input}`).toBe(true)
		}
	})

	it('does not read a plain letter or an unrelated modifier as an action', () => {
		expect(isAction('chat:modelPicker', 'p', {})).toBe(false)
		expect(isAction('chat:modelPicker', 'p', { ctrl: true })).toBe(false)
		expect(isAction('chat:stash', 's', {})).toBe(false)
		expect(isAction('app:toggleTranscript', 'o', { meta: true })).toBe(false)
	})

	it('knows the new chat shortcuts', () => {
		expect(isAction('chat:stash', 's', { ctrl: true })).toBe(true)
		expect(isAction('chat:modelPicker', 'p', { meta: true })).toBe(true)
		expect(isAction('chat:effortPicker', 't', { meta: true })).toBe(true)
		expect(isAction('chat:undo', '-', { ctrl: true })).toBe(true)
		// A terminal sends Ctrl+_ as the unit separator with no modifier flag.
		expect(isAction('chat:undo', '\x1f', {})).toBe(true)
	})

	it('treats Ctrl+X as the lead of the chords and their second strokes as actions', () => {
		expect(isChordLead('x', { ctrl: true })).toBe(true)
		expect(isChordLead('s', { ctrl: true })).toBe(false)
		expect(isChordAction('chat:sendNow', 's', { ctrl: true })).toBe(true)
		expect(isChordAction('chat:killAgents', 'k', { ctrl: true })).toBe(true)
		expect(isChordAction('chat:externalEditor', 'e', { ctrl: true })).toBe(true)
		expect(isChordAction('chat:sendNow', 'k', { ctrl: true })).toBe(false)
		// A chord is not a single stroke.
		expect(isAction('chat:sendNow', 's', { ctrl: true })).toBe(false)
	})
})

describe('key labels and the help list', () => {
	it('writes keys the way a person reads them', () => {
		expect(keyLabel('ctrl+x ctrl+s')).toBe('Ctrl+X Ctrl+S')
		expect(keyLabel('meta+p')).toBe('Alt+P')
		expect(keyLabel('shift+tab')).toBe('Shift+Tab')
		expect(keyLabel('escape')).toBe('Esc')
		expect(primaryKeyLabel('chat:stash')).toBe('Ctrl+S')
	})

	it('lists every action that has a description, grouped, with its keys', () => {
		const text = keysHelpText()
		for (const spec of ACTIONS) {
			if (spec.help === '') continue
			expect(text, spec.id).toContain(spec.help)
			expect(text, spec.id).toContain(keyLabel(spec.keys[0] ?? ''))
		}
		expect(text).toContain('Alt+P')
		expect(text).toContain('Ctrl+S')
		expect(text.split('\n')[0]).toBe('Keyboard shortcuts')
	})
})
