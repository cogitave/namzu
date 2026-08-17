import { defineProviderDriverConformance } from '@namzu/sdk/testing'
import { describe, expect, it } from 'vitest'

import { DeepSeekProvider } from '../client.js'

/**
 * The driver contract, run against this driver.
 *
 * The rules live in `@namzu/sdk` rather than here, so a rule added to the
 * suite arrives without this file changing. Nothing is asserted locally.
 */

defineProviderDriverConformance({
	describe,
	it,
	expect,
	label: 'deepseek',
	registryType: 'deepseek',
	retryDefaults: undefined,
	attribution: { kind: 'header' },
	makeProvider: () => new DeepSeekProvider({ apiKey: 'sk-conformance' }),
})
