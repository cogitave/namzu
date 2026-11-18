import { describe, expect, it, vi } from 'vitest'
import {
	bindTrustedProjectContext,
	refreshCachedContext,
	refreshTrustedProjectContext,
	resolveTrustedProjectContext,
} from './trusted-project-context.js'

describe('refreshTrustedProjectContext', () => {
	it('asks the refresher, not the cache, when one is bound', () => {
		const boot = {}
		const cached = { n: 1 }
		const fresh = { n: 2 }
		bindTrustedProjectContext(
			boot,
			() => cached,
			() => fresh,
		)
		expect(resolveTrustedProjectContext(boot, '/p')).toBe(cached)
		expect(refreshTrustedProjectContext(boot, '/p')).toBe(fresh)
	})
	it('falls back to resolving when no refresher is bound, and to identity when nothing is', () => {
		const boot = {}
		const cached = { n: 1 }
		bindTrustedProjectContext(boot, () => cached)
		expect(refreshTrustedProjectContext(boot, '/p')).toBe(cached)
		const loose = {}
		expect(refreshTrustedProjectContext(loose, '/p')).toBe(loose)
	})
})

describe('refreshCachedContext', () => {
	it('stores and returns the fresh context when the files load', () => {
		const cache = new Map([['/p', { n: 1 }]])
		const onError = vi.fn()
		const out = refreshCachedContext(
			cache,
			'/p',
			() => ({ n: 0 }),
			() => ({ n: 2 }),
			onError,
		)
		expect(out).toEqual({ n: 2 })
		expect(cache.get('/p')).toBe(out)
		expect(onError).not.toHaveBeenCalled()
	})
	it('keeps the last good context, leaves the cache alone and reports a load that throws', () => {
		const good = { n: 1 }
		const cache = new Map([['/p', good]])
		const boom = new Error('bad yaml')
		const onError = vi.fn()
		const out = refreshCachedContext(
			cache,
			'/p',
			() => ({ n: 0 }),
			() => {
				throw boom
			},
			onError,
		)
		expect(out).toBe(good)
		expect(cache.get('/p')).toBe(good)
		expect(onError).toHaveBeenCalledWith(boom)
	})
	it('loads through first when nothing is cached', () => {
		const first = { n: 0 }
		const load = vi.fn()
		expect(refreshCachedContext(new Map(), '/p', () => first, load, vi.fn())).toBe(first)
		expect(load).not.toHaveBeenCalled()
	})
})
