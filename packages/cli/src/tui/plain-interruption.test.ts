import { describe, expect, it } from 'vitest'

import {
	classifyInterruption,
	cleanVendorMessage,
	debugRequested,
	describePlainInterruption,
	describeProviderWait,
	describeProviderWaitClock,
	isSelfMending,
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

describe('a refused copy of the conversation', () => {
	it('reads in plain words, with no id and no raw message', () => {
		const text = describePlainInterruption(
			failed({
				message:
					"A cached message carries id 01a1, which this session's log never recorded. A host must not mint its own id.",
				failure: { code: 'stale_cached_history', message: 'x', retryable: false },
			}),
		)
		expect(text).toBe(
			'This screen was out of step with the saved conversation. Send your message again.',
		)
		expectPlain(text)
	})
})

describe('a conversation the model cannot hold', () => {
	it('keeps the conversation: no /new, no /clear, no start over', () => {
		const text = describePlainInterruption(
			failed({
				explanation: { id: 'provider.context_overflow', message: 'x', hint: 'y' },
				providerError: { kind: 'context_overflow', providerId: 'openai' },
			}),
		)
		expect(text).toBe(
			'This conversation is too long for the model, and Namzu could not shorten it enough. Try again, or pick a model with more room with /model.',
		)
		expect(text).not.toMatch(/\/new|\/clear|start (?:a )?new|start fresh|start over/i)
	})

	it('adds the compaction cause on the debug line only', () => {
		const event = failed({
			message: 'prompt is too long · automatic compaction failed: reducer backend down',
			explanation: {
				id: 'provider.context_overflow',
				message: 'The prompt is larger than the model can accept.',
				hint: 'Compaction ran and could not make enough room.',
			},
			providerError: { kind: 'context_overflow', providerId: 'openai' },
		})
		expect(describePlainInterruption(event)).not.toContain('automatic compaction failed')
		expect(describePlainInterruption(event, { debug: true })).toContain(
			'automatic compaction failed: reducer backend down',
		)
	})
})

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
			'OpenAI could not process this message. Change the message and send it again, or pick another model with /model.',
			'OpenAI said: messages.0.content: Input should be a valid string',
		])
		expectPlain(text)
	})

	it('points an image refusal at /model and never at starting over', () => {
		const text = describePlainInterruption(
			failed({
				message: 'zen (HTTP 400)',
				providerError: {
					kind: 'bad_request',
					providerId: 'zen',
					detail:
						'Upstream request failed: [invalid_value] Beam supports text input only. This conversation contains an image.',
				},
			}),
		)
		expect(text.split('\n')[0]).toBe(
			'Zen could not read an image in this conversation. Pick a model that can read images with /model.',
		)
		expect(text).not.toMatch(/\/new|send it again|new conversation/i)
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
		const notice = describeProviderWait(
			{ delayMs: 2_000, attempt: 1, maxRetries: 10, code: 'network' },
			'lmstudio',
			undefined,
			1_000,
		)
		expect(notice).toEqual({
			what: 'Namzu could not reach LM Studio at localhost:1234.',
			retryAt: 3_000,
			attempt: 1,
			maxRetries: 10,
		})
		expect(describeProviderWaitClock(notice, 1_000)).toBe('Retrying in 2s · attempt 1/10')
	})
})

describe('a connection failure that is not a dropped connection', () => {
	it('names a certificate that does not check out, with something to check', () => {
		const text = describePlainInterruption(
			paused({
				explanation: { id: 'provider.network', message: 'x', hint: 'y' },
				providerError: {
					kind: 'network',
					providerId: 'openai',
					providerCode: 'SELF_SIGNED_CERT_IN_CHAIN',
				},
			}),
		)
		expect(text).toContain('could not verify the security certificate of OpenAI')
		expect(text).not.toContain('tries again on its own')
		expectPlain(text)
	})

	it('does not try a refused certificate again by itself, whatever the code', () => {
		for (const providerCode of [
			'SELF_SIGNED_CERT_IN_CHAIN',
			'CERT_HAS_EXPIRED',
			'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
			'ERR_TLS_CERT_ALTNAME_INVALID',
		]) {
			expect(
				isSelfMending(
					paused({
						explanation: { id: 'provider.network', message: 'x', hint: 'y' },
						providerError: { kind: 'network', providerId: 'openai', providerCode },
					}),
				),
			).toBe(false)
		}
	})

	it('tries a dropped connection and a provider fault again by itself', () => {
		expect(
			isSelfMending(
				paused({
					explanation: { id: 'provider.network', message: 'x', hint: 'y' },
					providerError: { kind: 'network', providerId: 'openai', providerCode: 'ECONNRESET' },
				}),
			),
		).toBe(true)
		expect(
			isSelfMending(
				paused({
					explanation: { id: 'provider.unavailable', message: 'x', hint: 'y' },
					providerError: { kind: 'server', providerId: 'openai' },
				}),
			),
		).toBe(true)
		expect(
			isSelfMending(
				paused({
					explanation: { id: 'provider.auth', message: 'x', hint: 'y' },
					providerError: { kind: 'auth', providerId: 'openai' },
				}),
			),
		).toBe(false)
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
			'Paused. OpenAI is having problems on its side. Namzu tries again on its own. Press Enter to try now, or Esc to stop.',
		],
		[
			'offline',
			offline,
			'Paused. Namzu could not reach OpenAI. Namzu tries again on its own. Press Enter to try now, or Esc to stop.',
		],
		[
			'rate limited',
			limited,
			'Paused. OpenAI is limiting requests right now. Wait about 1m 05s. Press Enter to continue, or Esc to stop.',
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
		expect(text).toBe(
			'Paused. Sign in to the site. Press Enter to continue, or Esc to stop.\nPage: login',
		)
	})

	it('labels a tool’s attached facts instead of printing their raw keys', () => {
		const text = describePlainInterruption(
			paused({
				handoff: {
					kind: 'human-required',
					reason: 'Sign in',
					detail: { login_url: 'https://x.test', siteName: 'x' },
				},
			}),
		)
		expect(text).toContain('Login url: https://x.test')
		expect(text).toContain('Site name: x')
		expect(text).not.toContain('login_url')
	})
})

describe('the quiet stretch while a request is retried', () => {
	it('counts down to the next try and names the attempt', () => {
		const notice = describeProviderWait(
			{
				delayMs: 20_000,
				attempt: 2,
				maxRetries: 10,
				code: 'rate_limit',
				status: 429,
			},
			'openai',
			undefined,
			0,
		)
		expect(notice.what).toBe('OpenAI is limiting requests.')
		expect(describeProviderWaitClock(notice, 0)).toBe('Retrying in 20s · attempt 2/10')
		expect(describeProviderWaitClock(notice, 15_500)).toBe('Retrying in 5s · attempt 2/10')
		expect(describeProviderWaitClock(notice, 65_000)).toBe('Retrying in 1s · attempt 2/10')
	})
	it('keeps a long wait readable', () => {
		const notice = describeProviderWait(
			{
				delayMs: 65_000,
				attempt: 3,
				maxRetries: 10,
				code: 'server_error',
				status: 502,
			},
			undefined,
			undefined,
			0,
		)
		expect(notice.what).toBe('The provider is having problems on its side.')
		expect(describeProviderWaitClock(notice, 0)).toBe('Retrying in 1m 05s · attempt 3/10')
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

describe('a free Zen model with no allowance left', () => {
	const limited = {
		providerError: {
			kind: 'throttle',
			providerId: 'zen',
			status: 429,
			retryAfterMs: 15 * 3_600_000,
			detail: 'FreeUsageLimitError: Rate limit exceeded. Please try again later.',
		},
		explanation: {
			id: 'provider.rate_limit',
			message: 'The provider is rate limiting this turn.',
			hint: 'wait',
		},
	}

	it('says the allowance is used up, when it resets, and offers /model or another provider', () => {
		const text = describePlainInterruption(failed(limited), { model: 'space-bunny-free' })
		expect(text).toBe(
			'The free allowance for this model is used up for now. It should reset in about 15h 00m. Pick another model with /model, or choose another provider. A Zen API key also works.',
		)
		expectPlain(text)
		expect(text).not.toMatch(/concurrency|Wait a moment|limiting requests/i)
	})

	it('keeps the provider’s own words for debug only', () => {
		const plain = describePlainInterruption(failed(limited), { model: 'space-bunny-free' })
		expect(plain).not.toContain('FreeUsageLimitError')
		const debug = describePlainInterruption(failed(limited), {
			model: 'space-bunny-free',
			debug: true,
		})
		expect(debug).toContain('Provider detail: FreeUsageLimitError')
	})

	it('leads a pause with the ways on rather than with waiting', () => {
		const text = describePlainInterruption(paused({ ...limited, reason: 'rate limited' }), {
			model: 'space-bunny-free',
		})
		expect(text).toBe(
			'Paused. The free allowance for this model is used up for now. It should reset in about 15h 00m. Pick another model with /model, or choose another provider. A Zen API key also works. Press Enter to continue, or Esc to stop.',
		)
	})

	it('names no reset time when the provider gave none', () => {
		const { retryAfterMs: _omit, ...providerError } = limited.providerError
		const text = describePlainInterruption(failed({ ...limited, providerError }), {
			model: 'space-bunny-free',
		})
		expect(text).toBe(
			'The free allowance for this model is used up for now. Pick another model with /model, or choose another provider. A Zen API key also works.',
		)
	})

	it('leaves a paid model and other providers on the ordinary wording', () => {
		const paid = describePlainInterruption(failed(limited), { model: 'claude-sonnet-4-5' })
		expect(paid).toContain('Zen is limiting requests right now.')
		const other = describePlainInterruption(
			failed({ ...limited, providerError: { ...limited.providerError, providerId: 'openai' } }),
			{ model: 'space-bunny-free' },
		)
		expect(other).toContain('OpenAI is limiting requests right now.')
		expect(describePlainInterruption(failed(limited))).toContain('Zen is limiting requests')
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

describe('a conversation another window is still answering', () => {
	const elsewhere = (freeInMinutes: number): Interruption =>
		failed({
			message: 'This conversation already has a running reply.',
			turnInProgress: { sessionId: 's', activeTurnId: '', state: 'running', freeInMinutes },
		})

	it('says whose it is and when it is free, instead of telling this window to stop it', () => {
		const text = describePlainInterruption(elsewhere(5))
		expect(text).toBe(
			'This conversation is in use by another window. It is available again in about 5 minutes.',
		)
		expect(text).not.toMatch(/Esc/)
		expectPlain(text)
	})

	it('counts one minute in the singular', () => {
		expect(describePlainInterruption(elsewhere(1))).toContain('about 1 minute.')
	})
})
