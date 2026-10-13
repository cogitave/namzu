import { describe, expect, it } from 'vitest'

import { PERMISSION_MODE_NAMES } from '../mode-names.js'
import { PERMISSION_MODES } from '../mode.js'

describe('the permission modes the root command lists', () => {
	it('are the SDK’s review modes, in the same order', () => {
		expect([...PERMISSION_MODE_NAMES]).toEqual([...PERMISSION_MODES])
	})
})
