import { describe, expect, it } from 'vitest'
import { createLimiter } from './limiter.js'

describe('the read limiter', () => {
	it('runs no more than the limit at once and the rest in order', async () => {
		const limit = createLimiter(2)
		const started: number[] = []
		const gates: (() => void)[] = []
		const task = (n: number) => () =>
			new Promise<number>((resolve) => {
				started.push(n)
				gates.push(() => resolve(n))
			})
		const all = [1, 2, 3, 4].map((n) => limit(task(n)))
		expect(started).toEqual([1, 2])
		gates[0]?.()
		await all[0]
		await Promise.resolve()
		expect(started).toEqual([1, 2, 3])
		gates[1]?.()
		gates[2]?.()
		await Promise.all([all[1], all[2]])
		await Promise.resolve()
		expect(started).toEqual([1, 2, 3, 4])
		gates[3]?.()
		expect(await Promise.all(all)).toEqual([1, 2, 3, 4])
	})

	it('goes on after a task fails', async () => {
		const limit = createLimiter(1)
		const failed = limit(() => Promise.reject(new Error('no')))
		const after = limit(() => Promise.resolve('ok'))
		await expect(failed).rejects.toThrow('no')
		await expect(after).resolves.toBe('ok')
	})
})
