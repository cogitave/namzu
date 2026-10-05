import type { PalComputerInput } from '../shared/protocol.js'
import { ComputerInputRetiredError } from './computer-input-focus.js'
import { type ComputerInputOwner, computerInputOwnerMatches } from './computer-input-queue.js'

/** Cleanup authority comes only from a keyboard lifetime admitted for this exact allocation. */
export class ComputerKeyboardOwners {
	private readonly owners = new Map<string, Readonly<ComputerInputOwner>>()

	capture(action: PalComputerInput, owner: ComputerInputOwner): void {
		if (action.type !== 'key_down' && action.type !== 'key_up') return
		const existing = this.owners.get(action.keyboardId)
		if (existing && !computerInputOwnerMatches(existing, owner))
			throw new ComputerInputRetiredError()
		if (!existing) {
			if (action.type === 'key_up' || this.owners.size >= 32) throw new ComputerInputRetiredError()
			this.owners.set(action.keyboardId, Object.freeze({ ...owner }))
		}
	}

	owner(keyboardId: string): Readonly<ComputerInputOwner> | undefined {
		return this.owners.get(keyboardId)
	}

	assertRelease(keyboardId: string, captured: ComputerInputOwner): void {
		const owner = this.owners.get(keyboardId)
		if (!owner || !computerInputOwnerMatches(owner, captured)) throw new ComputerInputRetiredError()
	}

	retire(keyboardId: string, captured: ComputerInputOwner): void {
		const owner = this.owners.get(keyboardId)
		if (owner && computerInputOwnerMatches(owner, captured)) this.owners.delete(keyboardId)
	}
}
