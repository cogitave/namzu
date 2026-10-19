/**
 * While the provider is asked again, the Working row carries one line: what
 * failed, and `Retrying in 5s · attempt 2/10` counting down on its own clock.
 */

import { render } from 'ink-testing-library'
import { afterEach, expect, it, vi } from 'vitest'

import { LiveActivity } from '../LiveActivity.js'
import { describeProviderWait } from '../plain-interruption.js'

afterEach(() => {
	vi.useRealTimers()
})

it('counts down once a second and names the attempt out of ten', async () => {
	vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
	vi.setSystemTime(new Date('2026-10-19T09:00:00Z'))
	const notice = describeProviderWait(
		{
			delayMs: 5_000,
			attempt: 2,
			maxRetries: 10,
			code: 'server_error',
			status: 503,
		},
		'openai',
	)
	const view = render(
		<LiveActivity activeTools={[]} working interruptible animate={false} waitNotice={notice} />,
	)
	try {
		const first = view.lastFrame() ?? ''
		expect(first).toContain('The request failed.')
		expect(first).toContain('Retrying in 5s · attempt 2/10')
		await vi.advanceTimersByTimeAsync(3_000)
		expect(view.lastFrame() ?? '').toContain('Retrying in 2s · attempt 2/10')
	} finally {
		view.unmount()
	}
})

it('says what is wrong in plain words from the third try, or at once for no connection or a limit', () => {
	const at = (code: string, attempt: number, status?: number) =>
		describeProviderWait(
			{
				delayMs: 1_000,
				attempt,
				maxRetries: 10,
				code,
				...(status ? { status } : {}),
			},
			'openai',
		).what
	expect(at('server_error', 1, 500)).toBe('The request failed.')
	expect(at('server_error', 3, 500)).toBe('OpenAI is having problems on its side.')
	expect(at('network', 1)).toBe('Namzu could not reach OpenAI.')
	expect(at('rate_limit', 1, 429)).toBe('OpenAI is limiting requests.')
})
