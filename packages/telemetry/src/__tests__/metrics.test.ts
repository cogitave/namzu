import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * `createPlatformMetrics` is four delegating methods and one unit conversion,
 * and the conversion is the whole reason this file needs a test.
 *
 * Two of the four take SECONDS and the recorders they call take
 * MILLISECONDS. `metrics.ts` says so, in a comment: "The conversion has to
 * happen on exactly one side of the boundary; it lives on the recorder's, so
 * this undoes it rather than letting both sides divide." Nothing checked it.
 * A unit error here does not throw, does not warn and does not show up in a
 * type — it reports every duration a thousand times too small or too large,
 * on the same series the runtime writes its own, and the dashboard reads
 * plausible either way.
 *
 * The SDK's recorders are mocked because what is under test is the boundary,
 * not the instrument. What reaches the recorder IS the assertion.
 */

const recordTokenUsage = vi.fn()
const recordToolCall = vi.fn()
const recordRunDuration = vi.fn()
const recordModelDuration = vi.fn()

vi.mock('@namzu/sdk', () => ({
	recordTokenUsage: (...args: unknown[]) => recordTokenUsage(...args),
	recordToolCall: (...args: unknown[]) => recordToolCall(...args),
	recordRunDuration: (...args: unknown[]) => recordRunDuration(...args),
	recordModelDuration: (...args: unknown[]) => recordModelDuration(...args),
}))

const { createPlatformMetrics } = await import('../metrics.js')

beforeEach(() => {
	recordTokenUsage.mockClear()
	recordToolCall.mockClear()
	recordRunDuration.mockClear()
	recordModelDuration.mockClear()
})

describe('the seconds-to-milliseconds boundary', () => {
	it('multiplies a run duration by 1000 before it reaches the recorder', () => {
		createPlatformMetrics().recordRunDuration('completed', 1.5)

		// 1500, not 1.5 and not 0.0015. Dividing instead of multiplying, or
		// dropping the conversion, both leave a number the recorder accepts.
		expect(recordRunDuration).toHaveBeenCalledWith('completed', 1500)
	})

	it('multiplies a model latency by 1000 too', () => {
		createPlatformMetrics().recordLLMLatency('a-model', 0.25)

		expect(recordModelDuration).toHaveBeenCalledWith('a-model', 250)
	})

	it('converts a sub-millisecond duration rather than rounding it away', () => {
		// 0.0004s is 0.4ms. A conversion that floored to whole milliseconds
		// would report zero for every fast run, and a histogram of zeroes
		// looks like a working instrument.
		createPlatformMetrics().recordRunDuration('completed', 0.0004)

		expect(recordRunDuration).toHaveBeenCalledWith('completed', 0.4)
	})
})

describe('the delegating half', () => {
	it('reshapes token counts into the recorder’s named fields', () => {
		// Positional in, named out. Swapping the two at this boundary is
		// invisible to the type checker — both are `number`.
		createPlatformMetrics().recordTokenUsage('a-model', 11, 22)

		expect(recordTokenUsage).toHaveBeenCalledWith('a-model', {
			promptTokens: 11,
			completionTokens: 22,
		})
	})

	it('passes a tool outcome through unchanged, including the failing case', () => {
		const metrics = createPlatformMetrics()
		metrics.recordToolCall('bash', true)
		metrics.recordToolCall('bash', false)

		// Both directions, because a delegate that hard-coded `true` would
		// satisfy a single-call assertion and lose every failure.
		expect(recordToolCall).toHaveBeenNthCalledWith(1, 'bash', true)
		expect(recordToolCall).toHaveBeenNthCalledWith(2, 'bash', false)
	})
})

describe('resolution is deferred, which is why this returns a bag of closures', () => {
	it('touches no recorder until a method is called', () => {
		// The defect this file's docstring records: instruments used to be
		// bound EAGERLY, so a bag built before `registerTelemetry()` captured
		// the no-op meter and discarded every write for the rest of its life.
		// Construction reaching a recorder is that shape returning.
		createPlatformMetrics()

		expect(recordTokenUsage).not.toHaveBeenCalled()
		expect(recordToolCall).not.toHaveBeenCalled()
		expect(recordRunDuration).not.toHaveBeenCalled()
		expect(recordModelDuration).not.toHaveBeenCalled()
	})

	it('gives every bag the same recorders, so two hosts aggregate instead of diverging', () => {
		createPlatformMetrics().recordToolCall('read', true)
		createPlatformMetrics().recordToolCall('read', true)

		expect(recordToolCall).toHaveBeenCalledTimes(2)
	})
})
