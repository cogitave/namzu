import { describe, expect, it, vi } from 'vitest'
import {
	type EngineDeliveryView,
	UNAVAILABLE_ENGINE_VIEW,
} from '../shared/engine-delivery-protocol.js'
import { connectEngineDelivery, deliveryControls } from './use-engine-delivery.js'

const view: EngineDeliveryView = {
	available: true,
	enabled: true,
	runs: { source: 'bundled', commandLine: '51.1.0', engine: '62.13.0' },
	bundled: { commandLine: '51.1.0', engine: '62.13.0' },
	status: { kind: 'unknown' },
	canUseOwn: false,
}

describe('following the engine view', () => {
	it('reads the view once and follows each push, until stopped', async () => {
		let push: (view: EngineDeliveryView) => void = () => undefined
		const stop = vi.fn()
		const seen: EngineDeliveryView[] = []
		const disconnect = connectEngineDelivery(
			{
				engineDelivery: async () => view,
				onEngineDelivery: (listener) => {
					push = listener
					return stop
				},
			},
			(next) => seen.push(next),
		)
		await Promise.resolve()
		expect(seen).toEqual([view])
		push({ ...view, enabled: false })
		expect(seen.at(-1)?.enabled).toBe(false)
		disconnect()
		expect(stop).toHaveBeenCalled()
		push(view)
		expect(seen).toHaveLength(2)
	})

	it('does nothing in a window whose host has no such view', () => {
		const set = vi.fn()
		connectEngineDelivery({}, set)()
		expect(set).not.toHaveBeenCalled()
	})

	it('survives a read that fails', async () => {
		const set = vi.fn()
		connectEngineDelivery(
			{
				engineDelivery: async () => {
					throw new Error('no')
				},
				onEngineDelivery: () => () => undefined,
			},
			set,
		)
		await Promise.resolve()
		expect(set).not.toHaveBeenCalled()
	})
})

describe('the controls a window gets', () => {
	it('are none where this build cannot fetch engines, so nothing is drawn', () => {
		expect(deliveryControls(undefined, async () => undefined)).toBeUndefined()
		expect(deliveryControls(UNAVAILABLE_ENGINE_VIEW, async () => undefined)).toBeUndefined()
		expect(deliveryControls(view, async () => undefined)?.view).toBe(view)
	})
})
