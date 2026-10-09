import { describe, expect, it } from 'vitest'
import {
	describeBlockedRetry,
	describeFailure,
	providerName,
	sanitizeDetails,
	withUnknownUsage,
} from './friendly-errors.js'

const JARGON = /HTTP|\b[45]\d\d\b|receipt|retained|token|unresolved|<|JSON/i

describe('describeFailure', () => {
	it.each([
		[
			'anthropic — could not reach the provider: Connection error.',
			'connection',
			'Namzu couldn’t reach Anthropic. Check your internet connection.',
			['try-again'],
		],
		[
			'openai (HTTP 401) — the provider rejected the request credentials: 401 Incorrect API key provided: sk-e2e***. You can find your API key at https://platform.openai.com/account/api-keys.',
			'rejected-key',
			'OpenAI didn’t accept your key. Check it in Settings, then send again.',
			['settings'],
		],
		[
			'anthropic (HTTP 429) — rate limited by the provider',
			'rate-limit',
			'Anthropic asked Namzu to slow down. Give it a minute.',
			['try-again'],
		],
		[
			'openai (HTTP 502) — the provider failed to complete the request: 502 <html><body>502 Bad Gateway</body></html>',
			'server',
			'OpenAI had a problem on its side. Your message is saved.',
			['try-again'],
		],
		[
			'google (HTTP 400) — the request exceeded the model context window',
			'too-long',
			'This conversation is too long for the model. Start a new conversation, or choose a model with more room.',
			['new-conversation'],
		],
	])('puts %j in plain words', (raw, kind, text, actions) => {
		const failure = describeFailure(raw)
		expect(failure.kind).toBe(kind)
		expect(failure.text).toBe(text)
		expect(failure.actions).toEqual(actions)
		expect(failure.text).not.toMatch(JARGON)
	})

	it('keeps the original behind details with markup and key-shaped text removed', () => {
		const failure = describeFailure(
			'openai (HTTP 401) — the provider rejected the request credentials: Incorrect API key provided: sk-proj-abcdef123456.',
		)
		expect(failure.details).toContain('Incorrect API key provided')
		expect(failure.details).not.toContain('sk-proj-abcdef123456')
		const html = describeFailure(
			'openai (HTTP 502) — the provider failed to complete the request: <html><body>502 Bad Gateway</body></html>',
		)
		expect(html.details).not.toContain('<')
		expect(html.details).toContain('502 Bad Gateway')
	})

	it('names a missing key and points at Settings', () => {
		const failure = describeFailure(
			'No credential found for Anthropic (Claude), your saved provider. Enter one below with "k".',
			'Anthropic (Claude)',
		)
		expect(failure.kind).toBe('missing-key')
		expect(failure.text).toBe(
			'There is no API key for Anthropic. Add one in Settings, then send again.',
		)
		expect(failure.actions).toEqual(['settings'])
	})

	it('describes a lost connection without naming a folder', () => {
		const failure = describeFailure('The Namzu connection closed.')
		expect(failure.kind).toBe('lost-connection')
		expect(failure.text).not.toMatch(/folder|project/i)
	})

	it('never leaves a raw message in the main text', () => {
		const failure = describeFailure('ENOENT: weird internal failure {"error":{"code":9}}')
		expect(failure.kind).toBe('other')
		expect(failure.text).not.toContain('ENOENT')
		expect(failure.details).toContain('ENOENT')
	})
})

describe('describeBlockedRetry', () => {
	it('explains the unresolved-usage refusal without receipts and offers to continue here', () => {
		const blocked = describeBlockedRetry(
			'This provider request has unresolved token usage. Retry requires its actual provider usage receipt; the original turn is retained.',
		)
		expect(blocked.kind).toBe('cannot-repeat')
		expect(blocked.text).not.toMatch(JARGON)
		expect(blocked.actions).toEqual(['continue'])
		expect(blocked.text).toContain('Continue without this reply')
		expect(blocked.details).toBe('Usage for one request is unknown.')
	})

	it('offers to continue when the allowance is used up, and never shows the runtime wording', () => {
		const used = describeBlockedRetry(
			'This turn’s original token allowance is exhausted. Retry cannot change that allowance.',
		)
		expect(used.actions).toEqual(['continue'])
		expect(used.details).toBeUndefined()
		expect(used.text).not.toMatch(JARGON)
	})

	it('adds what is unknown about usage to the details of a repeatable failure', () => {
		const failure = describeFailure(
			'openai (HTTP 502) — the provider failed to complete the request: 502 502 Bad Gateway',
		)
		expect(failure.details).toBe(
			'OpenAI: the provider failed to complete the request (502 Bad Gateway)',
		)
		expect(failure.details).not.toMatch(/502 502/)
		expect(withUnknownUsage([failure])[0]?.details).toBe(
			'OpenAI: the provider failed to complete the request (502 Bad Gateway)\nUsage for one request is unknown.',
		)
		expect(withUnknownUsage([failure], 4)[0]?.details).toMatch(/Usage for 4 requests is unknown\.$/)
		expect(withUnknownUsage([])).toEqual([])
	})

	it.each([
		'This turn’s original token accounting is unavailable. Its checkpoint is retained.',
		'The paused turn’s checkpoint is unavailable. Its conversation is retained.',
	])('treats %j the same way', (notice) => {
		expect(describeBlockedRetry(notice).kind).toBe('cannot-repeat')
	})

	it('does not tell a person to start over while a reply is merely still settling', () => {
		const busy = describeBlockedRetry('Wait for this conversation’s active turn to settle.')
		expect(busy.kind).toBe('busy')
		expect(busy.actions).toEqual([])
	})
})

describe('names and details', () => {
	it('shows a provider by the name a person knows', () => {
		expect(providerName('anthropic')).toBe('Anthropic')
		expect(providerName('mystery')).toBe('Mystery')
		expect(providerName(undefined, 'Anthropic (Claude)')).toBe('Anthropic')
		expect(providerName(undefined)).toBe('the provider')
	})
	it('bounds and cleans details', () => {
		expect(sanitizeDetails(`${'a '.repeat(600)}`).length).toBeLessThanOrEqual(500)
		expect(sanitizeDetails('token abcdefghijklmnopqrstuvwxyz0123456789ABCD here')).toContain(
			'[hidden]',
		)
	})
})
