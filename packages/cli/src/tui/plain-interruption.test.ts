import { describe, expect, it } from 'vitest'

import {
	classifyInterruption,
	cleanVendorMessage,
	debugRequested,
	describePlainInterruption,
	describeProviderWait,
} from './plain-interruption.js'
import type { Interruption } from './turn-interruption.js'

const failed = (extra: Record<string, unknown>): Interruption =>
	({ kind: 'error', message: 'boom', ...extra }) as unknown as Interruption
const paused = (extra: Record<string, unknown>): Interruption =>
	({
		kind: 'paused',
		turnId: 'turn-1',
		checkpointId: '01a12552-fe6b-733f-bdfd-ee9abb0b6021',
		reason: 'boom',
		...extra,
	}) as unknown as Interruption

const MACHINE = [
	/\[provider\./,
	/Provider:/,
	/Reason:/,
	/Provider detail:/,
	/Checkpoint/i,
	/turnConfig/,
	/[0-9a-f]{8}-[0-9a-f]{4}-/,
	/\{"/,
	/HTTP \d{3}/,
	/\bturn\b/i,
]

function expectPlain(text: string): void {
	for (const pattern of MACHINE) expect(text).not.toMatch(pattern)
}

describe('an error in the terminal app', () => {
	it('names the product and a next step for a rejected key, with no ids or labels', () => {
		const text = describePlainInterruption(
			failed({
				explanation: {
					id: 'provider.auth',
					message: 'The provider rejected the credentials for this turn.',
					hint: 'Check the key.',
				},
				providerError: { kind: 'auth', providerId: 'openai' },
			}),
		)
		expect(text).toBe(
			'OpenAI did not accept your API key. Check it in /setup, or pick another provider with /model.',
		)
		expectPlain(text)
	})

	it('does not echo the provider’s own text when the headline already says it', () => {
		const text = describePlainInterruption(
			failed({
				explanation: { id: 'provider.auth', message: 'x', hint: 'y' },
				providerError: {
					kind: 'auth',
					providerId: 'openai',
					detail: '401 {"error":{"message":"Incorrect API key provided: sk-e2e-***."}}',
				},
			}),
		)
		expect(text).not.toContain('OpenAI said')
	})

	it('says a model is missing in the person’s words, not by its config key', () => {
		const text = describePlainInterruption(
			failed({
				explanation: {
					id: 'provider.model_not_found',
					message: 'x',
					hint: 'Check `turnConfig.model`',
				},
				providerError: { kind: 'bad_request', providerId: 'openai' },
			}),
			{ model: 'gpt-e2e-1' },
		)
		expect(text).toBe('OpenAI has no model called gpt-e2e-1. Run /model to pick another.')
		expectPlain(text)
	})

	it('turns a 400 with a JSON body into a headline and one cleaned vendor line', () => {
		const text = describePlainInterruption(
			failed({
				message:
					'openai (HTTP 400) — the provider rejected the request as invalid: 400 {"error":{"message":"messages.0.content: Input should be a valid string","request_id":"req_011CTxAbCdEf"}}',
				providerError: {
					kind: 'bad_request',
					providerId: 'openai',
					detail: '400 {"error":{"message":"messages.0.content: Input should be a valid string"}}',
				},
			}),
		)
		expect(text.split('\n')).toEqual([
			'OpenAI could not process this message. Send it again, or start a new conversation with /new.',
			'OpenAI said: messages.0.content: Input should be a valid string',
		])
		expectPlain(text)
	})

	it('drops a vendor line that only repeats the headline or carries ids', () => {
		expect(cleanVendorMessage('429 {"type":"error"}')).toBeUndefined()
		// The status code is not repeated: the headline already carries the meaning.
		expect(cleanVendorMessage('<html><body><h1>502 Bad Gateway</h1></body></html>')).toBe(
			'Bad Gateway',
		)
		expect(
			cleanVendorMessage(
				'failed for req_011CTxAbCdEf and 01a12552-fe6b-733f-bdfd-ee9abb0b6021 today',
			),
		).toBe('failed for and today')
	})

	it('humanises the rate-limit wait and never shows milliseconds', () => {
		const text = describePlainInterruption(
			failed({
				explanation: { id: 'provider.rate_limit', message: 'x', hint: 'y' },
				providerError: {
					kind: 'throttle',
					providerId: 'anthropic',
					retryAfterMs: 20_000,
				},
			}),
		)
		expect(text).toBe('Anthropic is limiting requests right now. Try again in about 20s.')
	})

	it('falls back to a sentence with a next step when nothing classified the failure', () => {
		const text = describePlainInterruption(failed({ message: 'Error: kaboom happened inside' }))
		expect(text).toMatch(/--debug/)
		expectPlain(text)
	})

	it('keeps the structured form only when detail was asked for', () => {
		const event = failed({
			explanation: {
				id: 'provider.auth',
				message: 'The provider rejected the credentials for this turn.',
				hint: 'h',
			},
			providerError: { kind: 'auth', providerId: 'openai' },
		})
		expect(describePlainInterruption(event, { debug: true })).toContain('[provider.auth]')
		expect(debugRequested({ NAMZU_DEBUG: '1' }, [])).toBe(true)
		expect(debugRequested({}, ['node', 'namzu', '--debug'])).toBe(true)
		expect(debugRequested({ NAMZU_DEBUG: '0' }, [])).toBe(false)
	})
})

describe('a local server that cannot be reached', () => {
	it('is not blamed on the internet connection', () => {
		const text = describePlainInterruption(
			failed({
				explanation: { id: 'provider.network', message: 'x', hint: 'y' },
				providerError: { kind: 'network', providerId: 'ollama' },
			}),
		)
		expect(text).toBe('Namzu could not reach Ollama at localhost:11434. Start it, then try again.')
	})
	it('uses the configured address when one is given', () => {
		const text = describePlainInterruption(
			failed({ providerError: { kind: 'network', providerId: 'openai' } }),
			{ baseUrl: 'http://127.0.0.1:8080/v1' },
		)
		expect(text).toBe('Namzu could not reach OpenAI at 127.0.0.1:8080. Start it, then try again.')
	})
	it('says so while it retries', () => {
		expect(
			describeProviderWait(
				{ delayMs: 2_000, attempt: 0, maxRetries: 2, code: 'network' },
				'lmstudio',
			),
		).toBe('Namzu could not reach LM Studio at localhost:1234. Retrying in about 2s (try 1 of 3).')
	})
})

describe('a paused reply in the terminal app', () => {
	const unavailable = {
		explanation: { id: 'provider.unavailable', message: 'x', hint: 'y' },
		providerError: { kind: 'server', providerId: 'openai' },
	}
	const offline = {
		explanation: { id: 'provider.network', message: 'x', hint: 'y' },
		providerError: { kind: 'network', providerId: 'openai' },
	}
	const limited = {
		explanation: { id: 'provider.rate_limit', message: 'x', hint: 'y' },
		providerError: {
			kind: 'throttle',
			providerId: 'openai',
			retryAfterMs: 65_000,
		},
	}
	it.each([
		[
			'server error',
			unavailable,
			'Paused: OpenAI is having problems on its side. Press Enter to try again, or type a new message.',
		],
		[
			'offline',
			offline,
			'Paused: Namzu could not reach OpenAI. Press Enter to try again, or type a new message.',
		],
		[
			'rate limited',
			limited,
			'Paused: OpenAI is limiting requests right now. Wait about 1m 05s, then press Enter to try again, or type a new message.',
		],
	])('reads plainly when %s, with no checkpoint id', (_name, extra, expected) => {
		const text = describePlainInterruption(paused(extra))
		expect(text).toBe(expected)
		expectPlain(text)
	})

	it('classifies from the provider kind when the catalog did not claim it', () => {
		expect(
			classifyInterruption(paused({ providerError: { kind: 'server', providerId: 'x' } })),
		).toBe('server')
		expect(classifyInterruption(paused({}))).toBe('unknown')
	})

	it('words a tool’s request for a person without a checkpoint', () => {
		const text = describePlainInterruption(
			paused({
				handoff: {
					kind: 'human-required',
					reason: 'Sign in to the site',
					detail: { page: 'login' },
				},
			}),
		)
		expect(text).toBe('Paused, and needs you: Sign in to the site\npage: login')
	})
})

describe('the quiet stretch while a request is retried', () => {
	it('says why, once, with the wait the provider asked for', () => {
		expect(
			describeProviderWait(
				{ delayMs: 20_000, attempt: 1, maxRetries: 4, code: 'rate_limit', status: 429 },
				'openai',
			),
		).toBe('OpenAI is limiting requests. Retrying in about 20s (try 2 of 5).')
		expect(
			describeProviderWait(
				{ delayMs: 2_000, attempt: 2, maxRetries: 4, code: 'network' },
				'anthropic',
			),
		).toBe('Namzu could not reach Anthropic. Retrying in about 2s (try 3 of 5).')
		expect(
			describeProviderWait({
				delayMs: 65_000,
				attempt: 1,
				maxRetries: 2,
				code: 'server_error',
				status: 502,
			}),
		).toBe('The provider is having problems on its side. Retrying in about 1m 05s (try 2 of 3).')
	})
})

describe('Zen declining a free model that carried no key', () => {
	const refusal = {
		providerError: {
			kind: 'auth',
			providerId: 'zen',
			status: 403,
			detail: 'FreeTierError: free tier is not available to this client',
		},
		explanation: { id: 'provider.permission', message: 'm', hint: 'h' },
	}

	it('says a true plain sentence, with the ways on and no claim about a key', () => {
		const text = describePlainInterruption(failed(refusal))
		expect(text).toBe(
			'Zen didn’t accept the free model right now. Try again in a while, or choose another provider with /model. A Zen API key also works.',
		)
		expect(text).not.toMatch(/authenticated|OpenCode|imitat|impersonat|policy|free tier/i)
		expectPlain(text)
	})

	it('keeps the service’s own words for debug only', () => {
		const text = describePlainInterruption(failed(refusal), { debug: true })
		expect(text).toContain('Provider detail: FreeTierError')
	})

	it('leaves other 403s and other providers on their own copy', () => {
		const other = describePlainInterruption(
			failed({
				providerError: { ...refusal.providerError, detail: 'Forbidden for this account' },
				explanation: refusal.explanation,
			}),
		)
		expect(other).toContain('does not allow this account to use that model')
		const goKey = describePlainInterruption(
			failed({ providerError: { ...refusal.providerError, providerId: 'zen-go' } }),
		)
		expect(goKey).not.toContain('free model')
	})
})

describe('a message refused because the conversation still holds a turn', () => {
	const refused = (state: 'running' | 'paused' | 'interrupted'): Interruption =>
		failed({
			message: 'This conversation already has a turn.',
			turnInProgress: { sessionId: 's', activeTurnId: '', state },
		})

	it.each(['running', 'paused', 'interrupted'] as const)(
		'says what to do about a %s turn in one sentence, with no id and no generic advice',
		(state) => {
			const text = describePlainInterruption(refused(state))
			expectPlain(text)
			expect(text).not.toContain('()')
			expect(text).not.toContain('--debug')
			expect(text).not.toContain('Send your message again')
			expect(text.split('\n')).toHaveLength(1)
		},
	)

	it('tells a paused one to be continued or closed', () => {
		expect(describePlainInterruption(refused('paused'))).toMatch(/Enter.*\/abandon/)
	})
})
