import { describe, expect, it, vi } from 'vitest'

import { withRequestTimeout } from '../request-timeout.js'

/**
 * `OllamaConfig.timeout` was declared with no doc comment and read by
 * nothing: the constructor forwarded `host` and `fetch` and never looked at
 * it, so a host that set a timeout waited forever anyway.
 *
 * The failure it exists for is specific to a local server — the process is
 * up, the socket accepts, and the model never answers because it is still
 * loading or the machine is out of memory.
 */

describe('a configured deadline reaches the request', () => {
	it('leaves fetch untouched when no timeout is set', () => {
		const base = vi.fn()

		// Absent has to stay exactly as before: adding a deadline must not
		// change what every existing host already gets.
		expect(withRequestTimeout(base as never, undefined)).toBe(base)
	})

	it('passes a signal that fires after the deadline', async () => {
		let seen: AbortSignal | undefined
		const base = vi.fn(async (_url: unknown, init?: { signal?: AbortSignal }) => {
			seen = init?.signal
			return new Response('ok')
		})

		const wrapped = withRequestTimeout(base as never, 20) as typeof fetch
		await wrapped('http://localhost:11434/api/chat')

		expect(seen).toBeDefined()
		expect(seen?.aborted).toBe(false)
		await new Promise((r) => setTimeout(r, 40))
		expect(seen?.aborted).toBe(true)
	})

	it("keeps the caller's cancellation alongside the deadline", async () => {
		let seen: AbortSignal | undefined
		const base = vi.fn(async (_url: unknown, init?: { signal?: AbortSignal }) => {
			seen = init?.signal
			return new Response('ok')
		})
		const caller = new AbortController()

		const wrapped = withRequestTimeout(base as never, 60_000) as typeof fetch
		await wrapped('http://localhost:11434/api/chat', { signal: caller.signal })
		caller.abort()

		// Composed, never replaced. The caller's signal is how a run cancels
		// mid-stream, and dropping it for the deadline would leave a local
		// model generating after the run that asked for it has stopped.
		expect(seen?.aborted).toBe(true)
	})

	it('still calls through to the fetch it was given', async () => {
		const base = vi.fn(async () => new Response('ok'))

		const wrapped = withRequestTimeout(base as never, 1_000) as typeof fetch
		await wrapped('http://localhost:11434/api/chat')

		expect(base).toHaveBeenCalledOnce()
	})

	it('refuses a deadline that would abort every request', () => {
		// Zero reads as "no time at all", which would break every request
		// rather than bound it — a config error worth naming at construction
		// instead of as a mysterious abort on the first call.
		expect(() => withRequestTimeout(undefined, 0)).toThrow(/positive/)
		expect(() => withRequestTimeout(undefined, -5)).toThrow(/positive/)
		expect(() => withRequestTimeout(undefined, Number.NaN)).toThrow(/positive/)
	})
})
