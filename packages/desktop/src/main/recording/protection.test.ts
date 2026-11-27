import { describe, expect, it } from 'vitest'
import { ContentProtection, type ProtectableWindow } from './protection.js'

class FakeWindow implements ProtectableWindow {
	protected = false
	destroyed = false
	calls: boolean[] = []
	setContentProtection(enabled: boolean) {
		this.protected = enabled
		this.calls.push(enabled)
	}
	isDestroyed() {
		return this.destroyed
	}
}

describe('content protection during a recording', () => {
	it('protects every window it knows, and puts each back to what it was', () => {
		const registry = new ContentProtection()
		const main = new FakeWindow()
		const chooser = new FakeWindow()
		const pill = new FakeWindow()
		pill.protected = true
		registry.add(main)
		registry.add(chooser)
		registry.add(pill, true)
		registry.engage()
		expect([main, chooser, pill].map((w) => w.protected)).toEqual([true, true, true])
		registry.release()
		expect([main, chooser, pill].map((w) => w.protected)).toEqual([false, false, true])
	})

	it('protects a window that opens during the recording as soon as it is added', () => {
		const registry = new ContentProtection()
		registry.engage()
		const later = new FakeWindow()
		registry.add(later)
		expect(later.protected).toBe(true)
		registry.release()
		expect(later.protected).toBe(false)
	})

	it('forgets a destroyed window and does not touch it', () => {
		const registry = new ContentProtection()
		const gone = new FakeWindow()
		registry.add(gone)
		gone.destroyed = true
		registry.engage()
		expect(gone.calls).toEqual([])
	})

	it('refuses to go on when a window cannot be hidden', () => {
		const registry = new ContentProtection()
		const bad: ProtectableWindow = {
			setContentProtection: () => {
				throw new Error('no')
			},
			isDestroyed: () => false,
		}
		registry.add(bad)
		expect(() => registry.engage()).toThrow('could not be hidden')
	})

	it('puts every other window back when one fails to, and says how many failed', () => {
		const registry = new ContentProtection()
		const bad: ProtectableWindow = {
			setContentProtection: (enabled) => {
				if (!enabled) throw new Error('no')
			},
			isDestroyed: () => false,
		}
		const good = new FakeWindow()
		registry.add(bad)
		registry.add(good)
		registry.engage()
		expect(registry.release()).toBe(1)
		expect(good.protected).toBe(false)
		expect(registry.active).toBe(false)
	})
})
