import { describe, expect, it } from 'vitest'
import { buildSafeEnv } from '../provider/local.js'

describe('the environment a command in the local sandbox is handed', () => {
	it('says a session started it, and neither the sandbox config nor the call can take that back', () => {
		expect(buildSafeEnv().NAMZU_STARTED_BY_SESSION).toBe('1')
		expect(
			buildSafeEnv({ NAMZU_STARTED_BY_SESSION: '0' }, { NAMZU_STARTED_BY_SESSION: '' })
				.NAMZU_STARTED_BY_SESSION,
		).toBe('1')
	})
})
