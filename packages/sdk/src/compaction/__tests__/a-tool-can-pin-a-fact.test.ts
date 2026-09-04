import { describe, expect, it } from 'vitest'

import { CompactionConfigSchema } from '../../config/runtime.js'
import { MAX_PINS, WorkingStateManager } from '../manager.js'
import { serializeState } from '../serializer.js'
import { restoreWorkingState, snapshotWorkingState } from '../wire.js'

const config = () => CompactionConfigSchema.parse({})

describe('a fact a tool pinned', () => {
	it('is kept by key, replaced by a later pin, and rendered into the working-memory slot', () => {
		const m = new WorkingStateManager(config())
		m.pin('controls', 'ACTION1 up, ACTION2 down', 'arc_act')
		m.pin('piece', 'at (34,47)', 'arc_act')
		m.pin('piece', 'at (34,42)', 'arc_act')
		expect(m.getState().pins.size).toBe(2)
		expect(m.getState().pins.get('piece')?.text).toBe('at (34,42)')
		const text = serializeState(m.getState())
		expect(text).toContain('## Pinned by tools')
		expect(text).toContain('**piece**: at (34,42) _(arc_act)_')
		expect(text).not.toContain('(34,47)')
		m.pin('piece', '', 'arc_act')
		expect(m.getState().pins.has('piece')).toBe(false)
	})

	it('survives the checkpoint wire format, and an old snapshot without pins still restores', () => {
		const m = new WorkingStateManager(config())
		m.pin('rule', 'a level is done when the piece covers the target', 'arc_act')
		const snap = snapshotWorkingState(m)
		expect(restoreWorkingState(snap, config()).getState().pins.get('rule')?.text).toContain(
			'target',
		)
		const { pins: _dropped, ...legacy } = snap
		expect(restoreWorkingState(legacy, config()).getState().pins.size).toBe(0)
	})

	it('drops the oldest past the pin budget and says so', () => {
		const m = new WorkingStateManager(config())
		for (let i = 0; i < MAX_PINS + 3; i++) m.pin(`k${i}`, `v${i}`, 't')
		expect(m.getState().pins.size).toBe(MAX_PINS)
		expect(m.getState().pins.has('k0')).toBe(false)
		expect(serializeState(m.getState())).toContain('3 older pins dropped')
	})
})
