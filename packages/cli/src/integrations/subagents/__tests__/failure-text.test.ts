import { describe, expect, it } from 'vitest'

import { plainAgentFailure } from '../failure-text.js'

const RAW =
	'openai (HTTP 400) — the provider rejected the request as invalid: {"error":{"message":"bad","type":"invalid_request_error"}}'

describe('plainAgentFailure', () => {
	it('turns a provider failure into one sentence with a next step, no wire name or body', () => {
		const plain = plainAgentFailure(RAW, false)
		expect(plain).toBe(
			'The provider could not use this request. Start the task again, or choose another model.',
		)
		expect(plain).not.toMatch(/openai|HTTP|\{/u)
	})

	it('maps each known cause to its own sentence', () => {
		expect(plainAgentFailure('x (HTTP 429) — rate limited by the provider', false)).toMatch(
			/too busy/u,
		)
		expect(plainAgentFailure('x — could not reach the provider: ECONNRESET', false)).toMatch(
			/could not reach/u,
		)
		expect(
			plainAgentFailure('x (HTTP 401) — the provider rejected the request credentials', false),
		).toMatch(/sign-in/u)
		expect(plainAgentFailure('x — the request exceeded the model context window', false)).toMatch(
			/too large/u,
		)
		expect(
			plainAgentFailure('x (HTTP 500) — the provider failed to complete the request', false),
		).toMatch(/ran into a problem/u)
	})

	it('keeps a message that is already a sentence for a person', () => {
		expect(plainAgentFailure('Sub-agent runtime is closed.', false)).toBe(
			'Sub-agent runtime is closed.',
		)
	})

	it('hides machine output behind --debug', () => {
		const plain = plainAgentFailure('ECONNRESET at foo.js:12', false)
		expect(plain).toBe(
			'This agent stopped because something went wrong. Message the agent to try again, or start the task again.',
		)
		expect(plain).not.toMatch(/--debug|error|ECONNRESET/u)
	})

	it('adds the raw text on the next line only when detail was asked for', () => {
		const detailed = plainAgentFailure(RAW, true)
		expect(detailed.split('\n')).toEqual([
			'The provider could not use this request. Start the task again, or choose another model.',
			RAW,
		])
	})
})
