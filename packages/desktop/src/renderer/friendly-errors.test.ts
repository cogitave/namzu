import { describe, expect, it } from 'vitest'
import {
	describeBlockedRetry,
	describeFailure,
	providerName,
	sanitizeDetails,
	unknownUsageDetail,
} from './friendly-errors.js'

const JARGON = /HTTP|\b[45]\d\d\b|receipt|retained|token|unresolved|<|JSON/i

describe('provider replies', () => {
	const cases: [string, string, string][] = [
		[
			'openai (HTTP 403) — the provider rejected the request credentials: Project proj_abc123 does not have access to model gpt-5',
			'model-access',
			'Your OpenAI account can’t use gpt-5. Choose another model.',
		],
		[
			'openai (HTTP 429) — rate limited by the provider: You exceeded your current quota, please check your plan and billing details.',
			'out-of-credit',
			'Your OpenAI account is out of credit. Add credit in your OpenAI billing page, then send again.',
		],
		[
			'openai (HTTP 408) — could not reach the provider: Request timed out.',
			'timeout',
			'OpenAI took too long to answer. Try again.',
		],
		[
			'openai (HTTP 404) — the provider rejected the request as invalid: The model gpt-9 does not exist',
			'model-missing',
			'OpenAI doesn’t offer that model to your account. Choose another model.',
		],
		[
			'openai (HTTP 413) — the provider rejected the request as invalid: 413 Request Entity Too Large',
			'too-large',
			'This message is too large for OpenAI. Shorten it or remove an attachment, then send again.',
		],
	]
	it.each(cases)('%j', (raw, kind, text) => {
		const failure = describeFailure(raw)
		expect(failure.kind).toBe(kind)
		expect(failure.text).toBe(text)
	})

	it('does not blame the key for a model the account cannot use', () => {
		const failure = describeFailure(cases[0]?.[0] ?? '')
		expect(failure.text).not.toMatch(/key/i)
	})

	it('says a usage-less reply could not be read and offers Try again, with no accounting words', () => {
		const failure = describeFailure(
			'Provider ended without token usage; the budget reservation remains unresolved.',
			'OpenAI',
		)
		expect(failure.kind).toBe('bad-reply')
		expect(failure.text).toBe('OpenAI sent a reply Namzu couldn’t read. Try again.')
		expect(failure.actions).toEqual(['try-again'])
		expect(failure.details).not.toMatch(/budget|reservation|unresolved/i)
	})

	it('cleans Details: status once, labelled request ID, no repeated title, grouped counts', () => {
		const html = describeFailure(
			'openai (HTTP 502) — the provider failed to complete the request: 502 Bad Gateway Bad Gateway cloudflare Ray ID: 8f2a1b3c4d5e6f70',
		)
		expect(html.details).toBe(
			'OpenAI: the provider failed to complete the request\nStatus: 502 · Provider said: “Bad Gateway”\nRequest ID: 8f2a1b3c4d5e6f70',
		)
		const empty = describeFailure(
			'openai (HTTP 500) — the provider failed to complete the request: 500 status code (no body)',
		)
		expect(empty.details).toBe('OpenAI: the provider failed to complete the request\nStatus: 500')
		const context = describeFailure(
			'openai (HTTP 400) — the request exceeded the model context window: maximum context length is 128000 tokens, you sent 131452 tokens',
		)
		expect(context.details).toContain('131,452')
		expect(html.details).not.toMatch(/usage/i)
	})
})

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
		expect(html.details).toContain('Status: 502 · Provider said: “Bad Gateway”')
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
		expect(blocked.details).toBeUndefined()
	})

	it('offers to continue when the allowance is used up, and never shows the runtime wording', () => {
		const used = describeBlockedRetry(
			'This turn’s original token allowance is exhausted. Retry cannot change that allowance.',
		)
		expect(used.actions).toEqual(['continue'])
		expect(used.details).toBeUndefined()
		expect(used.text).not.toMatch(JARGON)
	})

	it.each([
		[
			'openai (HTTP 500) — the provider failed to complete the request: 500 Internal Server Error',
			'OpenAI: the provider failed to complete the request\nStatus: 500 · Provider said: “Internal Server Error”',
		],
		[
			'openai (HTTP 502) — the provider failed to complete the request: 502 502 Bad Gateway',
			'OpenAI: the provider failed to complete the request\nStatus: 502 · Provider said: “Bad Gateway”',
		],
		[
			'openai (HTTP 503) — the provider failed to complete the request: <html><head><title>503 Service Unavailable</title></head><body><h1>503 Service Unavailable</h1></body></html>',
			'OpenAI: the provider failed to complete the request\nStatus: 503 · Provider said: “Service Unavailable”',
		],
	])('a 5xx before any reply carries labelled details and no usage line: %s', (raw, details) => {
		const failure = describeFailure(raw)
		expect(failure.details).toBe(details)
		expect(failure.details).not.toMatch(/usage|[{}<]/i)
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

describe('provider reply edge cases', () => {
	const failure = (status: number, sentence: string, body: string) =>
		describeFailure(`openai (HTTP ${status}) — the provider ${sentence}: ${body}`, 'OpenAI')

	it('names the model without a trailing full stop', () => {
		expect(failure(403, 'rejected the request credentials', 'No access to model gpt-5.').text).toBe(
			'Your OpenAI account can’t use gpt-5. Choose another model.',
		)
	})
	it('still blames the key when a 403 is about the key', () => {
		expect(
			failure(403, 'rejected the request credentials', 'Incorrect API key provided for this model')
				.kind,
		).toBe('rejected-key')
	})
	it('keeps a free-tier rate limit that suggests a payment method as a rate limit', () => {
		expect(
			failure(
				429,
				'was rate limited',
				'Rate limit reached. Please add a payment method to your account to increase your rate limit.',
			).kind,
		).toBe('rate-limit')
	})
	it('leaves no JSON residue where a request ID was', () => {
		const details = failure(
			500,
			'failed to complete the request',
			'{"error":{"message":"The server had an error","request_id":"req_abcdef123456"}}',
		).details
		expect(details).toContain('Request ID: req_abcdef123456')
		expect(details).not.toMatch(/request_id|""|" "/)
	})
})

describe('Details wording', () => {
	it('words a refused 403 without the runtime sentence and labels the vendor project', () => {
		const failure = describeFailure(
			'openai (HTTP 403) — the provider rejected the request credentials: Project proj_abc123 does not have access to model gpt-5',
		)
		expect(failure.details).toBe(
			'OpenAI: access was refused\nStatus: 403 · Provider said: “Your project does not have access to model gpt-5”\nProject: proj_abc123',
		)
		expect(failure.details).not.toMatch(/rejected the request credentials/)
	})
	it('shows the OpenAI type, code and request ID the driver carries, with the project on its own line', () => {
		const failure = describeFailure(
			'openai (HTTP 403) — the provider rejected the request credentials: {"error":{"message":"Project proj_abc123 does not have access to model gpt-6-luna","type":"invalid_request_error","code":"model_not_found"},"request_id":"req_9f8e7d"}',
		)
		expect(failure.details).toBe(
			'OpenAI: access was refused\nStatus: 403 · Provider said: “Your project does not have access to model gpt-6-luna” · Type: invalid_request_error · Code: model_not_found\nProject: proj_abc123\nRequest ID: req_9f8e7d',
		)
	})
	it('shows the type and code of a 429 the same way', () => {
		const failure = describeFailure(
			'openai (HTTP 429) — rate limited by the provider: {"error":{"message":"Rate limit reached for gpt-6-luna","type":"rate_limit_error","code":"rate_limit_exceeded"},"request_id":"req_429aa11"}',
		)
		expect(failure.details).toBe(
			'OpenAI: rate limited by the provider\nStatus: 429 · Provider said: “Rate limit reached for gpt-6-luna” · Type: rate_limit_error · Code: rate_limit_exceeded\nRequest ID: req_429aa11',
		)
	})
	it('does not say a reply went unreported when none arrived', () => {
		expect(unknownUsageDetail()).not.toMatch(/\breply\b/)
	})
})

describe('Details read the vendor body into labelled fields', () => {
	const details = (line: string) => describeFailure(line, 'OpenAI').details ?? ''
	it('reads the Anthropic shape', () => {
		const text = details(
			'anthropic (HTTP 403) — the provider rejected the request credentials: {"type":"error","error":{"type":"permission_error","message":"Your account cannot use this model."},"request_id":"req_011CabcdEFGH1234"}',
		)
		expect(text).toBe(
			'Anthropic: access was refused\nStatus: 403 · Provider said: “Your account cannot use this model” · Type: permission_error\nRequest ID: req_011CabcdEFGH1234',
		)
		expect(text).not.toMatch(/[{}]/)
	})
	it('reads the OpenAI shape with its code', () => {
		const text = details(
			'openai (HTTP 429) — the provider was rate limited: {"error":{"message":"Rate limit reached for gpt-5","type":"requests","code":"rate_limit_exceeded","param":null}}',
		)
		expect(text).toContain('Status: 429 · Provider said: “Rate limit reached for gpt-5”')
		expect(text).toContain('Type: requests · Code: rate_limit_exceeded')
		expect(text).not.toMatch(/[{}"]|null/)
	})
	it('reads the Google shape', () => {
		const text = details(
			'google (HTTP 500) — the provider failed to complete the request: {"error":{"code":500,"message":"Internal error encountered.","status":"INTERNAL"}}',
		)
		expect(text).toContain(
			'Status: 500 · Provider said: “Internal error encountered” · Type: INTERNAL',
		)
		expect(text).not.toMatch(/[{}]/)
	})
	it('reads a plain JSON string', () => {
		expect(
			details('openai (HTTP 429) — the provider was rate limited: "Slow down, please."'),
		).toContain('Status: 429 · Provider said: “Slow down, please”')
	})
	it('falls back to one capped line without braces for an unknown shape', () => {
		const text = details(
			`openai (HTTP 500) — the provider failed to complete the request: {"detail":{"info":[1,2]},"note":"${'x '.repeat(300)}"}`,
		)
		expect(text).not.toMatch(/[{}[\]"]/)
		expect(text.split('\n').every((line) => line.length <= 520)).toBe(true)
	})
})

describe('Details tidy leftovers', () => {
	it('leaves no empty brackets after a request id is lifted out', () => {
		const text =
			describeFailure(
				'openai (HTTP 429) — the provider was rate limited: You exceeded your current quota. (request id: req_abcdef123456)',
				'OpenAI',
			).details ?? ''
		expect(text).not.toContain('()')
		expect(text).toContain('Request ID: req_abcdef123456')
	})
	it('spaces a colon in an unknown-shape excerpt like prose', () => {
		const text =
			describeFailure(
				'anthropic (HTTP 500) — the provider failed to complete the request: {"unexpected":{"a":1}}',
				'Anthropic',
			).details ?? ''
		expect(text).toContain('unexpected: a: 1')
	})
})

/**
 * The exact messages the real drivers of three vendors throw, captured by pointing each driver at a
 * local server that answers with that vendor's own body (one SDK words its error "<status>
 * <message>", another appends the body as JSON, the third driver keeps no body). Every wire reads as
 * the same labelled fields.
 */
describe('Details are the same labelled fields on every wire', () => {
	const driver: Record<string, string> = {
		'openai.403':
			'openai (HTTP 403) — the provider rejected the request credentials: 403 Project `proj_abc123` does not have access to model `gpt-6-luna`',
		'openai.429':
			'openai (HTTP 429) — rate limited by the provider: 429 Rate limit reached for gpt-6-luna in organization org-x on requests per min. Limit: 3, Used: 3.',
		'openai.quota':
			'openai (HTTP 429) — rate limited by the provider: 429 You exceeded your current quota, please check your plan and billing details.',
		'openai.500':
			'openai (HTTP 500) — the provider failed to complete the request: 500 The server had an error while processing your request.',
		'anthropic.403':
			'anthropic (HTTP 403) — the provider rejected the request credentials: 403 {"type":"error","error":{"type":"permission_error","message":"Your account cannot use this model."},"request_id":"req_011CXabcdef12345"}',
		'anthropic.429':
			'anthropic (HTTP 429) — rate limited by the provider: 429 {"type":"error","error":{"type":"rate_limit_error","message":"Number of request tokens has exceeded your per-minute rate limit."},"request_id":"req_011CXabcdef12346"}',
		'anthropic.quota':
			'anthropic (HTTP 429) — rate limited by the provider: 429 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API."},"request_id":"req_011CXabcdef12347"}',
		'anthropic.500':
			'anthropic (HTTP 500) — the provider failed to complete the request: 500 {"type":"error","error":{"type":"api_error","message":"Internal server error"},"request_id":"req_011CXabcdef12348"}',
		'google.403': 'google (HTTP 403) — the provider rejected the request credentials',
		'google.429': 'google (HTTP 429) — rate limited by the provider',
		'google.quota': 'google (HTTP 429) — rate limited by the provider',
		'google.500': 'google (HTTP 500) — the provider failed to complete the request',
	}
	const expected: Record<string, string> = {
		'openai.403':
			'OpenAI: access was refused\nStatus: 403 · Provider said: “Your project does not have access to model gpt-6-luna”\nProject: proj_abc123',
		'openai.429':
			'OpenAI: rate limited by the provider\nStatus: 429 · Provider said: “Rate limit reached for gpt-6-luna in organization org-x on requests per min. Limit: 3, Used: 3”',
		'openai.quota':
			'OpenAI: rate limited by the provider\nStatus: 429 · Provider said: “You exceeded your current quota, please check your plan and billing details”',
		'openai.500':
			'OpenAI: the provider failed to complete the request\nStatus: 500 · Provider said: “The server had an error while processing your request”',
		'anthropic.403':
			'Anthropic: access was refused\nStatus: 403 · Provider said: “Your account cannot use this model” · Type: permission_error\nRequest ID: req_011CXabcdef12345',
		'anthropic.429':
			'Anthropic: rate limited by the provider\nStatus: 429 · Provider said: “Number of request tokens has exceeded your per-minute rate limit” · Type: rate_limit_error\nRequest ID: req_011CXabcdef12346',
		'anthropic.quota':
			'Anthropic: rate limited by the provider\nStatus: 429 · Provider said: “Your credit balance is too low to access the Anthropic API” · Type: invalid_request_error\nRequest ID: req_011CXabcdef12347',
		'anthropic.500':
			'Anthropic: the provider failed to complete the request\nStatus: 500 · Provider said: “Internal server error” · Type: api_error\nRequest ID: req_011CXabcdef12348',
		'google.403': 'Google: access was refused\nStatus: 403',
		'google.429': 'Google: rate limited by the provider\nStatus: 429',
		'google.quota': 'Google: rate limited by the provider\nStatus: 429',
		'google.500': 'Google: the provider failed to complete the request\nStatus: 500',
	}
	it.each(Object.keys(driver))('%s', (key) => {
		const details = describeFailure(driver[key] ?? '').details ?? ''
		expect(details).toBe(expected[key])
		expect(details).not.toMatch(/[{}"`]|rejected the request credentials|usage/)
	})
	it('keeps the OpenAI headline the same as before', () => {
		expect(describeFailure(driver['openai.403'] ?? '').text).toBe(
			'Your OpenAI account can’t use gpt-6-luna. Choose another model.',
		)
		expect(describeFailure(driver['openai.quota'] ?? '').kind).toBe('out-of-credit')
	})
})

describe('Zen declining a free model that carried no key', () => {
	const refused = describeFailure(
		'zen (HTTP 403) — the provider rejected the request credentials: {"type":"error","error":{"type":"FreeTierError","message":"This free tier is not available to this client"}}',
	)

	it('says a true sentence and never blames a key', () => {
		expect(refused.kind).toBe('free-refused')
		expect(refused.text).toBe(
			'Zen didn’t accept the free model right now. Try again in a while, or choose another provider. A Zen API key also works.',
		)
		expect(refused.text).not.toMatch(/your key|OpenCode|imitat|impersonat|policy/i)
		expect(refused.actions).toEqual(['try-again', 'settings'])
	})

	it('keeps the technical detail under Details', () => {
		expect(refused.details).toContain('Status: 403')
		expect(refused.details).toContain('free tier is not available')
		expect(refused.details).toContain('FreeTierError')
	})

	it('leaves a 403 about a key, and other providers, on their own copy', () => {
		expect(
			describeFailure(
				'zen (HTTP 403) — the provider rejected the request credentials: Invalid API key',
			).kind,
		).toBe('rejected-key')
		expect(
			describeFailure(
				'openai (HTTP 403) — the provider rejected the request credentials: free tier not available',
			).kind,
		).toBe('rejected-key')
	})
})
