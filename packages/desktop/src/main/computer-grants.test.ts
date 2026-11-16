import { describe, expect, it } from 'vitest'
import type { PermissionView } from '../shared/protocol.js'
import { ComputerGrants } from './computer-grants.js'

type Call = PermissionView['calls'][number]
const act = (app: string | undefined, extra: Partial<Call> = {}): Call => ({
	id: 'c1',
	name: 'computer_use',
	input: { type: 'mouse_click', at: { x: 1, y: 1 } },
	isDestructive: true,
	...(app ? { computer: { app } } : {}),
	...extra,
})
const grants = () => new ComputerGrants(() => ['Namzu', 'Electron'])

describe('computer grants', () => {
	it('asks once about an application nobody allowed', () => {
		expect(grants().decide([act('Notepad')])).toEqual({ kind: 'ask-app', apps: ['Notepad'] })
	})

	it('names a lowercase process the way a person reads it', () => {
		expect(grants().decide([act('notepad')])).toEqual({ kind: 'ask-app', apps: ['Notepad'] })
		const held = grants()
		held.grant(['notepad.exe'])
		expect(held.view().granted).toEqual(['Notepad'])
	})

	it('answers by itself in an allowed application, whatever the case or the .exe', () => {
		const held = grants()
		held.grant(['Notepad'])
		expect(held.decide([act('notepad.exe')])).toEqual({ kind: 'allow' })
		expect(held.decide([act('NOTEPAD'), act('Notepad')])).toEqual({ kind: 'allow' })
	})

	it('asks about every application of a batch that is not allowed', () => {
		const held = grants()
		held.grant(['Notepad'])
		expect(held.decide([act('Notepad'), act('Edge')])).toEqual({ kind: 'ask-app', apps: ['Edge'] })
	})

	it('keeps the ordinary card for what the agent asks about every time', () => {
		const held = grants()
		held.grant(['Notepad'])
		expect(held.decide([act('Notepad', { alwaysAsk: true })])).toEqual({ kind: 'ask' })
	})

	it('keeps the ordinary card for an action that closes, deletes, sends or submits', () => {
		const held = grants()
		held.grant(['Notepad'])
		expect(
			held.decide([
				act(undefined, { computer: { app: 'Notepad', consequence: 'presses ALT+F4' } }),
			]),
		).toEqual({ kind: 'ask' })
	})

	it('never allows the agent into Namzu itself, even if someone granted it', () => {
		const held = grants()
		held.grant(['Namzu'])
		expect(held.decide([act('Namzu')])).toEqual({ kind: 'ask' })
		expect(held.decide([act('namzu.exe')])).toEqual({ kind: 'ask' })
	})

	it('treats an unnamed application as the whole screen', () => {
		const held = grants()
		expect(held.decide([act(undefined)])).toEqual({ kind: 'ask-app', apps: ['the screen'] })
		held.grant(['the screen'])
		expect(held.decide([act(undefined)])).toEqual({ kind: 'allow' })
	})

	it('answers the screen question for an allowed application and asks for another', () => {
		const held = grants()
		held.grant(['Notepad'])
		const moment = (app: string): Call => ({
			id: 's',
			name: 'screen_moment',
			input: { app },
			isDestructive: false,
			alwaysAsk: true,
		})
		expect(held.decide([moment('Notepad')])).toEqual({ kind: 'allow' })
		expect(held.decide([moment('Edge')])).toEqual({ kind: 'ask' })
	})

	it('hands any other tool to the ordinary card', () => {
		const held = grants()
		held.grant(['Notepad'])
		expect(
			held.decide([act('Notepad'), { id: 'b', name: 'bash', input: {}, isDestructive: true }]),
		).toEqual({ kind: 'ask' })
		expect(held.decide([])).toEqual({ kind: 'ask' })
	})

	it('takes an application back and lists what was used', () => {
		const held = grants()
		held.grant(['Notepad'])
		expect(held.markUsed('Edge')).toBe(true)
		expect(held.markUsed('edge')).toBe(false)
		expect(held.markUsed('Namzu')).toBe(false)
		expect(held.view()).toEqual({ granted: ['Notepad'], used: ['Notepad', 'Edge'] })
		expect(held.revoke('NOTEPAD')).toBe(true)
		expect(held.view().granted).toEqual([])
		expect(held.decide([act('Notepad')])).toEqual({ kind: 'ask-app', apps: ['Notepad'] })
	})
})
