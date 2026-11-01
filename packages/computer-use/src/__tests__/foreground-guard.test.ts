import type { ComputerUseAction, ComputerUseResult } from '@namzu/sdk'
import { describe, expect, it, vi } from 'vitest'
import type { Adapter } from '../adapters/types.js'
import { guardForeground } from '../foreground/guard.js'
import { FakeMonitor, baseState, makeLadder } from './foreground-fakes.js'

function inner(over: Partial<Adapter> = {}) {
	const executed: ComputerUseAction['type'][] = []
	const adapter: Adapter = {
		capabilities: {
			displayServer: 'win32',
			screenshot: true,
			mouse: true,
			keyboard: true,
			cursorPosition: true,
			clipboard: false,
		},
		backend: 'inner',
		getDisplayGeometry: async () => ({ width: 1, height: 1, scaleFactor: 1 }),
		execute: async (action) => {
			executed.push(action.type)
			return action.type === 'screenshot'
				? ({ type: 'ok' } as ComputerUseResult)
				: {
						type: 'ok',
						delivery: 'delivered_unverified',
						retrySafety: 'unsafe',
					}
		},
		listWindows: async () => [
			{
				id: '0x5',
				title: 't',
				app: 'Editor',
				pid: 5,
				bounds: { x: 0, y: 0, width: 1, height: 1 },
				focused: false,
				minimized: false,
			},
		],
		focusWindow: vi.fn(async () => ({ ok: true, focusedId: '0x5' })),
		...over,
	}
	return { adapter, executed }
}

describe('guardForeground', () => {
	it('sends display input through the ladder and reads like the adapter when nothing interfered', async () => {
		const { ladder } = makeLadder()
		const { adapter, executed } = inner()
		const guarded = guardForeground(adapter, ladder)
		await expect(guarded.execute({ type: 'key', keys: 'ENTER' })).resolves.toMatchObject({
			delivery: 'delivered_unverified',
		})
		expect(executed).toEqual(['key'])
		expect(guarded.backend).toBe('inner')
	})

	it('does not gate reads', async () => {
		const monitor = new FakeMonitor()
		monitor.state_ = () => ({ ...baseState, desktop: 'Winlogon' })
		const { ladder } = makeLadder({ monitor })
		const { adapter, executed } = inner()
		await guardForeground(adapter, ladder).execute({ type: 'screenshot' })
		expect(executed).toEqual(['screenshot'])
		expect(monitor.calls).toEqual([])
	})

	it('turns a blocked burst into a not-delivered result that names the blocker, with nothing sent', async () => {
		const monitor = new FakeMonitor()
		monitor.state_ = () => ({ ...baseState, desktop: 'Winlogon' })
		const { ladder } = makeLadder({ monitor })
		const { adapter, executed } = inner()
		const result = await guardForeground(adapter, ladder).execute({
			type: 'type_text',
			text: 'x',
		})
		expect(result).toMatchObject({
			type: 'ok',
			delivery: 'not_delivered',
			retrySafety: 'safe',
		})
		expect(result.type === 'ok' && result.detail).toMatch(/Ask the user/)
		expect(executed).toEqual([])
	})

	it('downgrades a result to unverified, unsafe when the user touched input during the burst', async () => {
		const monitor = new FakeMonitor()
		monitor.during = { inputs: 2, escapes: 0 }
		const { ladder } = makeLadder({ monitor })
		const { adapter } = inner({
			execute: async () => ({
				type: 'ok',
				delivery: 'delivered_verified',
				retrySafety: 'safe',
			}),
		})
		const result = await guardForeground(adapter, ladder).execute({
			type: 'mouse_click',
			at: { x: 1, y: 1 },
			button: 'left',
		})
		expect(result).toMatchObject({
			delivery: 'delivered_unverified',
			retrySafety: 'unsafe',
		})
	})

	it('gates focus_window with the app of the window, and refuses typed when blocked', async () => {
		const monitor = new FakeMonitor()
		monitor.state_ = () => ({ ...baseState, userIdleMs: 0 })
		const approve = vi.fn(async () => 'deny' as const)
		const { ladder } = makeLadder({ monitor, approve })
		const { adapter } = inner()
		const guarded = guardForeground(adapter, ladder)
		const result = await guarded.focusWindow?.('0x5')
		expect(result).toMatchObject({
			ok: false,
			focusedId: null,
			delivery: 'not_delivered',
			retrySafety: 'safe',
		})
		expect(approve).toHaveBeenCalledWith(
			expect.objectContaining({ app: 'Editor', pid: 5 }),
			undefined,
		)
		expect(adapter.focusWindow).not.toHaveBeenCalled()
	})

	it('focuses when the screen is free', async () => {
		const { ladder } = makeLadder()
		const { adapter } = inner()
		await expect(guardForeground(adapter, ladder).focusWindow?.('0x5')).resolves.toEqual({
			ok: true,
			focusedId: '0x5',
		})
	})
})
