import { defineProviderDriverConformance } from '@namzu/sdk/testing'
import { describe, expect, it } from 'vitest'

import { AnthropicProvider } from '../client.js'

/**
 * The driver contract, run against this driver.
 *
 * The rules live in `@namzu/sdk` rather than here, which is the point:
 * seven packages implemented `LLMProvider` and there was nowhere to write
 * a rule binding all of them, so every provider finding in the audit was a
 * behaviour present in exactly one driver and absent from the other six.
 *
 * A new rule added to the suite arrives here without this file changing.
 * Nothing is asserted locally — a local assertion is how the seven
 * hand-written error-taxonomy tests came to cover the same ground
 * differently.
 */

defineProviderDriverConformance({
	describe,
	it,
	expect,
	label: 'anthropic',
	registryType: 'anthropic',
	// Constructed with credentials that are syntactically valid and reach
	// nothing. The contract asserts declared shape, not behaviour against a
	// live endpoint — a suite that needed a real key could not run in CI.
	makeProvider: () => new AnthropicProvider({ apiKey: 'sk-conformance' }),
})
