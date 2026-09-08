import { EventType } from '@ag-ui/core'
import { describe, expect, it, vi } from 'vitest'
import { AGUIRunUI } from '../ui.js'

describe('request-scoped application events', () => {
	it('publishes detached initial history and seals it before native streaming', () => {
		const ui = new AGUIRunUI({})
		const messages = [{ id: 'user-1', role: 'user' as const, content: 'Authorized history' }]
		ui.setInitialMessages(messages)
		messages[0]!.content = 'Changed after admission'
		expect(ui.drain()).toEqual([
			{
				type: EventType.MESSAGES_SNAPSHOT,
				messages: [{ id: 'user-1', role: 'user', content: 'Authorized history' }],
			},
		])
		ui.sealInitialMessages()
		expect(() => ui.setInitialMessages([])).toThrow('before it returns')
		expect(ui.drain()).toEqual([])
		ui.setState({ ready: true })
		expect(ui.drain()).toHaveLength(1)
	})
	it('validates snapshot identity and shape before publishing anything', () => {
		const ui = new AGUIRunUI({})
		for (const messages of [
			[{ id: 'x', role: 'bad', content: 'no' }],
			[{ id: '', role: 'user', content: 'no' }],
			[
				{ id: 'x', role: 'user', content: 'first' },
				{ id: 'x', role: 'user', content: 'second' },
			],
		]) {
			expect(() => ui.setInitialMessages(messages as never)).toThrow()
			expect(ui.drain()).toEqual([])
		}
		ui.setInitialMessages([])
		expect(ui.drain()).toEqual([{ type: EventType.MESSAGES_SNAPSHOT, messages: [] }])
	})
	it('applies event byte, queue and request lifetime limits to initial history', () => {
		const ui = new AGUIRunUI({}, { maxPendingEvents: 1, maxEventBytes: 120 })
		expect(() =>
			ui.setInitialMessages([{ id: 'x', role: 'user', content: 'x'.repeat(120) }]),
		).toThrow('maxEventBytes')
		ui.custom('ready', null)
		expect(() => ui.setInitialMessages([])).toThrow('queue is full')
		expect(ui.drain()).toHaveLength(1)
		ui.close()
		expect(() => ui.setInitialMessages([])).toThrow('ended')
	})

	it('owns detached JSON state and snapshots', () => {
		const initial = { nested: { value: 1 } }
		const ui = new AGUIRunUI(initial)
		initial.nested.value = 9
		expect(ui.state).toEqual({ nested: { value: 1 } })
		const replacement = { nested: { value: 2 } }
		ui.setState(replacement)
		replacement.nested.value = 3
		const snapshot = ui.state as typeof replacement
		snapshot.nested.value = 4
		expect(ui.drain()).toEqual([
			{ type: EventType.STATE_SNAPSHOT, snapshot: { nested: { value: 2 } } },
		])
		expect(ui.state).toEqual({ nested: { value: 2 } })
	})

	it('applies valid patches atomically and refuses invalid or prototype-mutating patches', () => {
		const ui = new AGUIRunUI({ count: 1, items: [] })
		ui.patchState([
			{ op: 'replace', path: '/count', value: 2 },
			{ op: 'add', path: '/items/-', value: 'x' },
		])
		expect(ui.state).toEqual({ count: 2, items: ['x'] })
		expect(ui.drain()).toHaveLength(1)
		expect(() =>
			ui.patchState([
				{ op: 'replace', path: '/count', value: 3 },
				{ op: 'remove', path: '/absent' },
			]),
		).toThrow()
		expect(ui.state).toEqual({ count: 2, items: ['x'] })
		expect(() => ui.patchState([{ op: 'add', path: '/__proto__/polluted', value: true }])).toThrow()
		expect(Object.prototype).not.toHaveProperty('polluted')
		expect(ui.drain()).toEqual([])
	})

	it('bounds events and state without partial mutation, and wakes only its owning adapter', () => {
		const ui = new AGUIRunUI({}, { maxPendingEvents: 1, maxEventBytes: 120 })
		const observer = vi.fn()
		const detach = ui.onEvent(observer)
		ui.custom('progress', { step: 1 })
		expect(observer).toHaveBeenCalledTimes(1)
		expect(() => ui.setState({ changed: true })).toThrow('queue is full')
		expect(ui.state).toEqual({})
		ui.drain()
		expect(() => ui.setState('x'.repeat(121))).toThrow('maxEventBytes')
		expect(ui.state).toEqual({})
		expect(() => ui.onEvent(vi.fn())).toThrow('already have an owner')
		detach()
		ui.custom('ready', null)
		expect(observer).toHaveBeenCalledTimes(1)
		ui.close()
		expect(ui.drain()).toEqual([])
		expect(() => ui.custom('late', {})).toThrow('ended')
	})

	it.each([Number.NaN, Number.POSITIVE_INFINITY, undefined, () => {}, { missing: undefined }])(
		'refuses non-JSON state: %s',
		(value) => {
			const ui = new AGUIRunUI({})
			expect(() => ui.setState(value)).toThrow()
			expect(ui.drain()).toEqual([])
		},
	)
})
