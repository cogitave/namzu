import type { ShortcutState } from '../shared/os-state.js'
import { isAccelerator } from '../shared/shortcuts.js'

/** The two global shortcuts Namzu can hold. */
export type ShortcutSlot = 'quickEntry' | 'voice'

/** What the system offers for global keys. A fake stands in for it in tests. */
export interface ShortcutSystem {
	/** `false` when another program already holds the keys; may throw for keys it cannot read. */
	register(accelerator: string, run: () => void): boolean
	unregister(accelerator: string): void
}

const SLOTS: readonly ShortcutSlot[] = ['quickEntry', 'voice']

/**
 * Holds the global shortcuts the person chose and says, for each, whether the system really gave
 * them to Namzu. A shortcut another program owns is reported plainly, never retried silently.
 */
export class ShortcutController {
	private readonly held = new Map<ShortcutSlot, string>()
	private readonly states = new Map<ShortcutSlot, ShortcutState>()

	constructor(
		private readonly system: ShortcutSystem,
		private readonly actions: Record<ShortcutSlot, () => void>,
	) {}

	/** Bring the held shortcuts to `wanted`. An empty string removes that slot's shortcut at once. */
	sync(wanted: Record<ShortcutSlot, string>): void {
		// Release every slot that changes first, so keys one slot gives up can be claimed by the other.
		const changing = SLOTS.filter(
			(slot) => this.held.get(slot) !== wanted[slot] || !this.states.get(slot)?.registered,
		)
		for (const slot of changing) {
			const current = this.held.get(slot)
			if (current !== undefined) {
				this.system.unregister(current)
				this.held.delete(slot)
			}
			this.states.delete(slot)
		}
		for (const slot of changing) {
			const next = wanted[slot]
			if (next) this.states.set(slot, this.claim(slot, next))
		}
	}

	private claim(slot: ShortcutSlot, accelerator: string): ShortcutState {
		if (!isAccelerator(accelerator))
			return { registered: false, problem: 'These keys are not a shortcut Namzu can use.' }
		for (const [other, held] of this.held)
			if (other !== slot && held === accelerator)
				return {
					registered: false,
					problem: `${accelerator} is already the other Namzu shortcut, so this one is not registered.`,
				}
		let ok = false
		try {
			ok = this.system.register(accelerator, this.actions[slot])
		} catch {
			ok = false
		}
		if (!ok)
			return {
				registered: false,
				problem: `${accelerator} is taken by another app or by the system, so it is not registered. Choose other keys.`,
			}
		this.held.set(slot, accelerator)
		return { registered: true }
	}

	state(slot: ShortcutSlot): ShortcutState {
		return this.states.get(slot) ?? { registered: false }
	}

	dispose(): void {
		for (const accelerator of this.held.values()) this.system.unregister(accelerator)
		this.held.clear()
		this.states.clear()
	}
}
