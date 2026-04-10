import { randomUUID } from 'node:crypto'

import {
	DEFAULT_LOCK_ACQUIRE_TIMEOUT_MS,
	DEFAULT_LOCK_TIMEOUT_MS,
	DEFAULT_MAX_LOCKS_PER_AGENT,
	LOCK_ACQUIRE_POLL_INTERVAL_MS,
} from '../constants/bus/index.js'
import type { AgentBusEvent, FileLock, LockAcquireResult, LockId } from '../types/bus/index.js'
import type { RunId } from '../types/ids/index.js'
import type { Logger } from '../utils/logger.js'

export interface FileLockManagerConfig {
	readonly lockTimeoutMs: number
	readonly acquireTimeoutMs: number
	readonly maxLocksPerAgent: number
}

const DEFAULT_CONFIG: FileLockManagerConfig = {
	lockTimeoutMs: DEFAULT_LOCK_TIMEOUT_MS,
	acquireTimeoutMs: DEFAULT_LOCK_ACQUIRE_TIMEOUT_MS,
	maxLocksPerAgent: DEFAULT_MAX_LOCKS_PER_AGENT,
}

export class FileLockManager {
	private readonly locks = new Map<string, FileLock>()
	private readonly agentLocks = new Map<string, Set<string>>()
	private readonly config: FileLockManagerConfig
	private readonly log: Logger
	private readonly emit: (event: AgentBusEvent) => void

	constructor(
		log: Logger,
		emit: (event: AgentBusEvent) => void,
		config: Partial<FileLockManagerConfig> = {},
	) {
		this.config = { ...DEFAULT_CONFIG, ...config }
		this.log = log.child({ component: 'FileLockManager' })
		this.emit = emit
	}

	private generateLockId(): LockId {
		return `lock_${randomUUID()}`
	}

	private getAgentLockSet(owner: RunId): Set<string> {
		let lockSet = this.agentLocks.get(owner)
		if (!lockSet) {
			lockSet = new Set()
			this.agentLocks.set(owner, lockSet)
		}
		return lockSet
	}

	private tryAcquire(filePath: string, owner: RunId): LockAcquireResult {
		const existing = this.locks.get(filePath)
		if (existing) {
			if (existing.owner === owner) {
				return { acquired: true, lock: existing }
			}
			this.log.debug('lock denied', {
				filePath,
				requester: owner,
				holder: existing.owner,
			})
			this.emit({
				type: 'lock_denied',
				filePath,
				requester: owner,
				holder: existing.owner,
			})
			return { acquired: false, holder: existing.owner, filePath }
		}

		const agentLockSet = this.getAgentLockSet(owner)
		if (agentLockSet.size >= this.config.maxLocksPerAgent) {
			this.log.warn('max locks per agent reached', {
				owner,
				currentCount: agentLockSet.size,
				max: this.config.maxLocksPerAgent,
			})
			return { acquired: false, holder: owner, filePath }
		}

		const lockId = this.generateLockId()
		const now = Date.now()
		const lock: FileLock = {
			lockId,
			filePath,
			owner,
			acquiredAt: now,
			expiresAt: now + this.config.lockTimeoutMs,
		}

		this.locks.set(filePath, lock)
		agentLockSet.add(filePath)

		this.log.debug('lock acquired', { lockId, filePath, owner })
		this.emit({ type: 'lock_acquired', lockId, filePath, owner })
		return { acquired: true, lock }
	}

	async acquire(filePath: string, owner: RunId): Promise<LockAcquireResult> {
		this.expireStale()

		const immediate = this.tryAcquire(filePath, owner)
		if (immediate.acquired) return immediate

		const deadline = Date.now() + this.config.acquireTimeoutMs
		while (Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, LOCK_ACQUIRE_POLL_INTERVAL_MS))
			this.expireStale()

			const retry = this.tryAcquire(filePath, owner)
			if (retry.acquired) return retry
		}

		const holder = this.locks.get(filePath)
		return {
			acquired: false,
			holder: holder?.owner ?? ('' as RunId),
			filePath,
		}
	}

	release(filePath: string, owner: RunId): boolean {
		const existing = this.locks.get(filePath)
		if (!existing || existing.owner !== owner) {
			return false
		}

		this.locks.delete(filePath)
		const agentLockSet = this.agentLocks.get(owner)
		agentLockSet?.delete(filePath)
		if (agentLockSet?.size === 0) {
			this.agentLocks.delete(owner)
		}

		this.log.debug('lock released', {
			lockId: existing.lockId,
			filePath,
			owner,
		})
		this.emit({
			type: 'lock_released',
			lockId: existing.lockId,
			filePath,
			owner,
		})
		return true
	}

	releaseAll(owner: RunId): number {
		const agentLockSet = this.agentLocks.get(owner)
		if (!agentLockSet) return 0

		let released = 0
		for (const filePath of agentLockSet) {
			const lock = this.locks.get(filePath)
			if (lock && lock.owner === owner) {
				this.locks.delete(filePath)
				this.log.debug('lock released (cleanup)', {
					lockId: lock.lockId,
					filePath,
					owner,
				})
				this.emit({
					type: 'lock_released',
					lockId: lock.lockId,
					filePath,
					owner,
				})
				released += 1
			}
		}

		this.agentLocks.delete(owner)
		return released
	}

	isLocked(filePath: string): boolean {
		const lock = this.locks.get(filePath)
		if (!lock) return false
		if (lock.expiresAt !== undefined && Date.now() > lock.expiresAt) {
			this.expireLock(filePath, lock)
			return false
		}
		return true
	}

	getHolder(filePath: string): RunId | undefined {
		const lock = this.locks.get(filePath)
		if (!lock) return undefined
		if (lock.expiresAt !== undefined && Date.now() > lock.expiresAt) {
			this.expireLock(filePath, lock)
			return undefined
		}
		return lock.owner
	}

	expireStale(): number {
		const now = Date.now()
		let expired = 0
		for (const [filePath, lock] of this.locks) {
			if (lock.expiresAt !== undefined && now > lock.expiresAt) {
				this.expireLock(filePath, lock)
				expired += 1
			}
		}
		return expired
	}

	private expireLock(filePath: string, lock: FileLock): void {
		this.locks.delete(filePath)
		const agentLockSet = this.agentLocks.get(lock.owner)
		agentLockSet?.delete(filePath)
		if (agentLockSet?.size === 0) {
			this.agentLocks.delete(lock.owner)
		}

		this.log.info('lock expired', {
			lockId: lock.lockId,
			filePath,
			owner: lock.owner,
		})
		this.emit({
			type: 'lock_expired',
			lockId: lock.lockId,
			filePath,
			owner: lock.owner,
		})
	}
}
