import { expect, it, vi } from 'vitest'
import { closeAcpResources } from '../acp.js'
it('attempts Pal cleanup after conversation cleanup fails and retains both errors', async () => {
	const sessionError = new Error('conversation cleanup failed')
	const computerError = new Error('computer stop failed')
	const order: string[] = []
	const session = vi.fn(async () => {
		order.push('session')
		throw sessionError
	})
	const pals = vi.fn(async () => {
		order.push('pals')
		throw computerError
	})
	const failure = await closeAcpResources({ close: session }, pals).catch((error) => error)
	expect(order).toEqual(['session', 'pals'])
	expect(failure).toBeInstanceOf(AggregateError)
	expect(failure.errors).toEqual([sessionError, computerError])
})
it('closes the Pal owner even for ordinary ACP and when session cleanup succeeds', async () => {
	const pals = vi.fn(async () => {})
	await closeAcpResources({ close: async () => {} }, pals)
	expect(pals).toHaveBeenCalledOnce()
})
