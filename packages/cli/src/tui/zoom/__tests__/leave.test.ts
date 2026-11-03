import { afterEach, describe, expect, it, vi } from 'vitest'
import { leaveWorkspacesBounded } from '../leave.js'

afterEach(() => vi.useRealTimers())

describe('leaveWorkspacesBounded', () => {
	it('flushes after a release that handed the terminal back', async () => {
		const flush = vi.fn(async () => undefined)
		await leaveWorkspacesBounded({ release: async () => true, flush, limitMs: 2000 })
		expect(flush).toHaveBeenCalledTimes(1)
	})

	it('does not flush when nothing was released', async () => {
		const flush = vi.fn(async () => undefined)
		await leaveWorkspacesBounded({ release: async () => false, flush, limitMs: 2000 })
		expect(flush).not.toHaveBeenCalled()
	})

	it('moves on at the limit and tells a late release it is no longer wanted', async () => {
		vi.useFakeTimers()
		let finish: (() => void) | undefined
		let wantedAtResume: boolean | undefined
		const flush = vi.fn(async () => undefined)
		const done = leaveWorkspacesBounded({
			release: (stillWanted) =>
				new Promise<boolean>((resolve) => {
					finish = () => {
						wantedAtResume = stillWanted()
						resolve(wantedAtResume)
					}
				}),
			flush,
			limitMs: 2000,
		})
		await vi.advanceTimersByTimeAsync(2000)
		await done
		finish?.()
		await vi.advanceTimersByTimeAsync(0)
		expect(wantedAtResume).toBe(false)
		expect(flush).not.toHaveBeenCalled()
	})

	it('does not throw when the release fails', async () => {
		const flush = vi.fn(async () => undefined)
		await expect(
			leaveWorkspacesBounded({
				release: async () => {
					throw new Error('x')
				},
				flush,
				limitMs: 2000,
			}),
		).resolves.toBeUndefined()
		expect(flush).not.toHaveBeenCalled()
	})
})
