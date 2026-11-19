import { describe, expect, it, vi } from 'vitest'
import { closePageAfter } from './extension-page-close.js'

describe('the page of an extension that is turned off', () => {
	it('closes after a turn off that went through', async () => {
		const close = vi.fn()
		const r = await closePageAfter(
			'namzu/extensions/disable',
			'a.b',
			Promise.resolve({ view: {} }),
			close,
		)
		expect(r).toEqual({ view: {} })
		expect(close).toHaveBeenCalledWith('a.b')
	})
	it('closes after a removal that went through', async () => {
		const close = vi.fn()
		await closePageAfter('namzu/extensions/remove', 'a.b', Promise.resolve({ ok: true }), close)
		expect(close).toHaveBeenCalledWith('a.b')
	})
	it('stays open on a wrong password, a wait or a lock', async () => {
		for (const code of ['admin-wrong', 'admin-wait', 'admin-locked']) {
			const close = vi.fn()
			const r = await closePageAfter(
				'namzu/extensions/disable',
				'a.b',
				Promise.resolve({ error: { code, check: 'lock', message: 'no' } }),
				close,
			)
			expect(r).toEqual({ error: { code, check: 'lock', message: 'no' } })
			expect(close).not.toHaveBeenCalled()
		}
	})
	it('stays open when the call itself fails', async () => {
		const close = vi.fn()
		await expect(
			closePageAfter('namzu/extensions/remove', 'a.b', Promise.reject(new Error('x')), close),
		).rejects.toThrow('x')
		expect(close).not.toHaveBeenCalled()
	})
	it('leaves other methods alone', async () => {
		const close = vi.fn()
		await closePageAfter('namzu/extensions/list', 'a.b', Promise.resolve({}), close)
		expect(close).not.toHaveBeenCalled()
	})
})
