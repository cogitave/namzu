import { describe, expect, it } from 'vitest'
import {
	bindTrustedProjectContext,
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
