import { describe, expect, it } from 'vitest'
import { ConcurrentInvocationError, InvocationLock } from '../lock.js'

describe('InvocationLock', () => {
	describe('acquire', () => {
		it('should acquire lock when not locked', () => {
			const lock = new InvocationLock()
			const agentId = 'agent-123'

			const disposable = lock.acquire(agentId)

			expect(disposable).toBeDefined()
			expect(disposable[Symbol.dispose]).toBeDefined()
			expect(lock.isActive()).toBe(true)
		})

		it('should throw ConcurrentInvocationError when already locked', () => {
			const lock = new InvocationLock()
			const agentId = 'agent-123'

			lock.acquire(agentId)

			expect(() => lock.acquire(agentId)).toThrow(ConcurrentInvocationError)
		})

		it('should throw with correct agent ID in error', () => {
			const lock = new InvocationLock()
			const agentId = 'agent-456'

			lock.acquire(agentId)

			try {
				lock.acquire(agentId)
				expect.fail('Should have thrown ConcurrentInvocationError')
			} catch (err) {
				if (err instanceof ConcurrentInvocationError) {
					expect(err.agentId).toBe(agentId)
					expect(err.message).toContain(agentId)
				} else {
					throw err
				}
			}
		})
	})

	describe('dispose', () => {
		it('should release lock when disposed', () => {
			const lock = new InvocationLock()
			const agentId = 'agent-123'

			const disposable = lock.acquire(agentId)
			expect(lock.isActive()).toBe(true)

			disposable[Symbol.dispose]()
			expect(lock.isActive()).toBe(false)
		})

		it('should allow re-acquisition after disposal', () => {
			const lock = new InvocationLock()
			const agentId = 'agent-123'

			const disposable1 = lock.acquire(agentId)
			disposable1[Symbol.dispose]()

			// Should not throw
			const disposable2 = lock.acquire(agentId)
			expect(disposable2).toBeDefined()
			expect(lock.isActive()).toBe(true)

			disposable2[Symbol.dispose]()
		})
	})

	describe('isActive', () => {
		it('should return false when not locked', () => {
			const lock = new InvocationLock()
			expect(lock.isActive()).toBe(false)
		})

		it('should return true when locked', () => {
			const lock = new InvocationLock()
			lock.acquire('agent-123')
			expect(lock.isActive()).toBe(true)
		})

		it('should return false after disposal', () => {
			const lock = new InvocationLock()
			const disposable = lock.acquire('agent-123')
			expect(lock.isActive()).toBe(true)

			disposable[Symbol.dispose]()
			expect(lock.isActive()).toBe(false)
		})
	})

	describe('try/finally pattern', () => {
		it('should release lock in finally block', () => {
			const lock = new InvocationLock()
			const agentId = 'agent-123'

			const disposable = lock.acquire(agentId)
			try {
				expect(lock.isActive()).toBe(true)
			} finally {
				disposable[Symbol.dispose]()
			}

			expect(lock.isActive()).toBe(false)
		})

		it('should release lock even if error thrown', () => {
			const lock = new InvocationLock()
			const agentId = 'agent-123'

			const disposable = lock.acquire(agentId)
			try {
				throw new Error('Test error')
			} catch {
				disposable[Symbol.dispose]()
			}

			expect(lock.isActive()).toBe(false)

			// Should be able to acquire again
			const disposable2 = lock.acquire(agentId)
			expect(disposable2).toBeDefined()
		})
	})
})

describe('ConcurrentInvocationError', () => {
	it('should be an instance of Error', () => {
		const error = new ConcurrentInvocationError('agent-123')
		expect(error).toBeInstanceOf(Error)
	})

	it('should have correct name', () => {
		const error = new ConcurrentInvocationError('agent-123')
		expect(error.name).toBe('ConcurrentInvocationError')
	})

	it('should store agentId', () => {
		const agentId = 'agent-abc'
		const error = new ConcurrentInvocationError(agentId)
		expect(error.agentId).toBe(agentId)
	})

	it('should include agent ID in message', () => {
		const agentId = 'agent-xyz'
		const error = new ConcurrentInvocationError(agentId)
		expect(error.message).toContain(agentId)
	})

	it('should mention concurrent invocations in message', () => {
		const error = new ConcurrentInvocationError('agent-123')
		expect(error.message.toLowerCase()).toContain('concurrent')
	})
})
