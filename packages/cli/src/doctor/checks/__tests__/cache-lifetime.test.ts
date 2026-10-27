import { describe, expect, it } from 'vitest'

import { describeCacheLifetimeStatus } from '../cache-lifetime.js'

const offered = async () => true
const notOffered = async () => false

describe('providers.cache-lifetime', () => {
	it('is skipped where no provider lets the lifetime be chosen', async () => {
		const result = await describeCacheLifetimeStatus({}, notOffered, {})
		expect(result.status).toBe('skipped')
	})

	it('reports the default and suggests the longer one, as a pass', async () => {
		const result = await describeCacheLifetimeStatus({}, offered, {})

		expect(result.status).toBe('pass')
		expect(result.message).toContain('5 minutes')
		expect(result.message).toContain('long sessions')
		expect(result.remediation).toContain('compaction.promptCacheTtl')
	})

	it('reports the longer lifetime without suggesting anything', async () => {
		const result = await describeCacheLifetimeStatus(
			{ compaction: { promptCacheTtl: '1h' } },
			offered,
			{},
		)

		expect(result).toEqual({ status: 'pass', message: 'Prompt cache lifetime is 1 hour.' })
	})
})
