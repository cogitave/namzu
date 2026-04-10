import path from 'node:path'

import type { AgentBusEvent, FileOwnership, OwnershipClaimResult } from '../types/bus/index.js'
import type { RunId } from '../types/ids/index.js'
import type { Logger } from '../utils/logger.js'

export class EditOwnershipTracker {
	private readonly ownerships = new Map<string, FileOwnership>()
	private readonly log: Logger
	private readonly emit: (event: AgentBusEvent) => void

	constructor(log: Logger, emit: (event: AgentBusEvent) => void) {
		this.log = log.child({ component: 'EditOwnershipTracker' })
		this.emit = emit
	}

	private normalizePath(filePath: string): string {
		return path.resolve(filePath)
	}

	claim(filePath: string, owner: RunId): OwnershipClaimResult {
		const normalized = this.normalizePath(filePath)
		const existing = this.ownerships.get(normalized)

		if (existing && existing.owner !== owner) {
			this.log.debug('ownership claim denied', {
				filePath: normalized,
				requester: owner,
				currentOwner: existing.owner,
			})
			this.emit({
				type: 'ownership_denied',
				filePath: normalized,
				requester: owner,
				currentOwner: existing.owner,
			})
			return { claimed: false, currentOwner: existing.owner, filePath: normalized }
		}

		if (existing && existing.owner === owner) {
			return { claimed: true, ownership: existing }
		}

		const ownership: FileOwnership = {
			filePath: normalized,
			owner,
			claimedAt: Date.now(),
		}
		this.ownerships.set(normalized, ownership)

		this.log.debug('ownership claimed', { filePath: normalized, owner })
		this.emit({ type: 'ownership_claimed', filePath: normalized, owner })
		return { claimed: true, ownership }
	}

	release(filePath: string, owner: RunId): boolean {
		const normalized = this.normalizePath(filePath)
		const existing = this.ownerships.get(normalized)

		if (!existing || existing.owner !== owner) {
			return false
		}

		this.ownerships.delete(normalized)
		this.log.debug('ownership released', { filePath: normalized, previousOwner: owner })
		this.emit({ type: 'ownership_released', filePath: normalized, previousOwner: owner })
		return true
	}

	transfer(filePath: string, from: RunId, to: RunId): boolean {
		const normalized = this.normalizePath(filePath)
		const existing = this.ownerships.get(normalized)

		if (!existing || existing.owner !== from) {
			return false
		}

		const transferred: FileOwnership = {
			filePath: normalized,
			owner: to,
			claimedAt: Date.now(),
		}
		this.ownerships.set(normalized, transferred)

		this.log.info('ownership transferred', { filePath: normalized, from, to })
		this.emit({ type: 'ownership_transferred', filePath: normalized, from, to })
		return true
	}

	releaseAll(owner: RunId): number {
		let released = 0
		for (const [normalized, ownership] of this.ownerships) {
			if (ownership.owner === owner) {
				this.ownerships.delete(normalized)
				this.log.debug('ownership released (cleanup)', {
					filePath: normalized,
					previousOwner: owner,
				})
				this.emit({
					type: 'ownership_released',
					filePath: normalized,
					previousOwner: owner,
				})
				released += 1
			}
		}
		return released
	}

	getOwner(filePath: string): RunId | undefined {
		const normalized = this.normalizePath(filePath)
		return this.ownerships.get(normalized)?.owner
	}

	listByOwner(owner: RunId): FileOwnership[] {
		const result: FileOwnership[] = []
		for (const ownership of this.ownerships.values()) {
			if (ownership.owner === owner) {
				result.push(ownership)
			}
		}
		return result
	}

	checkConflict(filePath: string, requester: RunId): RunId | undefined {
		const normalized = this.normalizePath(filePath)
		const existing = this.ownerships.get(normalized)
		if (existing && existing.owner !== requester) {
			return existing.owner
		}
		return undefined
	}
}
