import { describe, expect, it } from 'vitest'

import { assertThinkingUnsupported } from '../thinking-support.js'

/**
 * `thinking` sits on `ChatCompletionParams`, so every driver accepts it. Six
 * of the seven in this repo did not implement it, and five of those six simply
 * dropped the field: the caller got an ordinary completion with an empty
 * `reasoning` array, indistinguishable from a model that chose not to reason.
 *
 * One driver already refused instead, with the reasoning written out. The rule
 * was decided once and applied once — so it moved here, where a new driver
 * inherits it rather than re-deciding it.
 */
describe('a driver that cannot think says so', () => {
	it('refuses a manual thinking request', () => {
		expect(() =>
			assertThinkingUnsupported('TestProvider', { thinking: { type: 'enabled' } }),
		).toThrow(/TestProvider does not implement thinking/)
	})

	it('refuses an adaptive one too', () => {
		// Both are a request to think. Refusing one and dropping the other
		// would leave exactly the silence this exists to remove.
		expect(() =>
			assertThinkingUnsupported('TestProvider', { thinking: { type: 'adaptive' } }),
		).toThrow(/does not implement thinking/)
	})

	it('names the driver, not just the problem', () => {
		// In a multi-provider setup this is the difference between a bug
		// report about the model and a one-line config fix.
		expect(() =>
			assertThinkingUnsupported('BedrockProvider', { thinking: { type: 'adaptive' } }),
		).toThrow(/BedrockProvider/)
	})

	it('says what silence would have looked like', () => {
		let message = ''
		try {
			assertThinkingUnsupported('TestProvider', { thinking: { type: 'enabled' } })
		} catch (err) {
			message = (err as Error).message
		}
		expect(message).toContain('empty reasoning list')
		expect(message).toContain('Drop `thinking`')
	})

	it('honours an explicit disable as a no-op', () => {
		// A config shared across providers that says "do not think" should not
		// fail on the ones that were never going to.
		expect(() =>
			assertThinkingUnsupported('TestProvider', { thinking: { type: 'disabled' } }),
		).not.toThrow()
	})

	it('does nothing when the caller said nothing', () => {
		expect(() => assertThinkingUnsupported('TestProvider', {})).not.toThrow()
	})
})
