import { describe, expect, it, vi } from 'vitest'

import { ConnectorHttpOperation } from '../http-operation.js'

describe('ConnectorHttpOperation authority checks', () => {
	it('does not start foreign work after authority is withdrawn', async () => {
		const caller = new AbortController()
		const operation = new ConnectorHttpOperation(caller.signal, 1_000, 'test operation')
		const start = vi.fn(async () => 'must not run')
		const reason = new Error('cancelled before foreign work')

		caller.abort(reason)
		try {
			await expect(operation.run(start)).rejects.toBe(reason)
			expect(start).not.toHaveBeenCalled()
		} finally {
			operation.close()
		}
	})

	it('does not publish a value that won the promise race after cancellation', async () => {
		const caller = new AbortController()
		const operation = new ConnectorHttpOperation(caller.signal, 1_000, 'test operation')
		const pending = operation.wait(Promise.resolve('late success'))
		const reason = new Error('cancelled beside foreign fulfillment')

		caller.abort(reason)
		try {
			await expect(pending).rejects.toBe(reason)
		} finally {
			operation.close()
		}
	})
})
