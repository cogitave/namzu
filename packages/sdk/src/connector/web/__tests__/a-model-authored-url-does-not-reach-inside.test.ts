import { describe, expect, it, vi } from 'vitest'

import { GuardedFetchProvider, isPrivateAddress } from '../guarded-fetch.js'
import { WebFetchRefusedError } from '../types.js'

/**
 * A URL the MODEL chose, reaching the network stack.
 *
 * The network the agent runs on is not the network the model is thinking
 * about. `http://169.254.169.254/` is a cloud metadata endpoint holding
 * credentials; `http://localhost:6379/` is whatever the host runs on 6379;
 * `file:///etc/passwd` is not even the network. None of those look unusual
 * in a URL produced while reasoning about a public site.
 *
 * The refusals happen BEFORE anything is sent, because a response already
 * fetched is a request that already happened — and against a metadata
 * endpoint the request IS the exfiltration.
 */

const reply = (
	body: string,
	init: { status?: number; headers?: Record<string, string> } = {},
): Response =>
	({
		status: init.status ?? 200,
		headers: new Headers(init.headers ?? {}),
		text: async () => body,
	}) as unknown as Response

/** A fetch that records every URL it was asked for. */
function recordingFetch(responses: Record<string, Response> | Response): {
	fn: typeof globalThis.fetch
	asked: string[]
} {
	const asked: string[] = []
	const fn = vi.fn(async (input: Parameters<typeof globalThis.fetch>[0]) => {
		const url = input.toString()
		asked.push(url)
		if (responses instanceof Object && 'status' in responses) return responses as Response
		const found = (responses as Record<string, Response>)[url]
		if (!found) throw new Error(`no scripted response for ${url}`)
		return found
	}) as unknown as typeof globalThis.fetch
	return { fn, asked }
}

/** Everything resolves publicly, unless a test says otherwise. */
const PUBLIC = async () => ['93.184.216.34']

const provider = (over: Partial<ConstructorParameters<typeof GuardedFetchProvider>[0]> = {}) =>
	new GuardedFetchProvider({ ...over })

async function settleWithin<T>(promise: Promise<T>, milliseconds = 500): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined
	return Promise.race([
		promise,
		new Promise<never>((_resolve, reject) => {
			timer = setTimeout(
				() => reject(new Error(`guarded fetch did not settle within ${milliseconds}ms`)),
				milliseconds,
			)
		}),
	]).finally(() => {
		if (timer) clearTimeout(timer)
	})
}

describe('an address inside the host is refused before the request', () => {
	it('refuses loopback by literal', async () => {
		const { fn, asked } = recordingFetch(reply('secret'))

		await expect(provider({ fetch: fn }).fetch({ url: 'http://127.0.0.1:6379/' })).rejects.toThrow(
			WebFetchRefusedError,
		)
		// Nothing was sent. A refusal that fetched first and discarded the
		// body is a request that happened.
		expect(asked).toEqual([])
	})

	it('refuses the cloud metadata address', async () => {
		const { fn } = recordingFetch(reply('creds'))

		await expect(
			provider({ fetch: fn }).fetch({
				url: 'http://169.254.169.254/latest/meta-data/',
			}),
		).rejects.toThrow(/inside this host/)
	})

	it.each(['http://[::ffff:127.0.0.1]/', 'http://[::ffff:a9fe:a9fe]/'])(
		'refuses canonical IPv4-mapped IPv6 before fetch: %s',
		async (url) => {
			const { fn, asked } = recordingFetch(reply('secret'))

			await expect(provider({ fetch: fn }).fetch({ url })).rejects.toThrow(WebFetchRefusedError)
			expect(asked).toEqual([])
		},
	)

	it('refuses a public NAME that resolves inside', async () => {
		// A hostname check alone is bypassed by any name whose A record points
		// inside — a thing anyone can set up on a domain they own, and it
		// costs nothing to try.
		const { fn, asked } = recordingFetch(reply('x'))

		await expect(
			provider({ fetch: fn, resolve: async () => ['10.0.0.5'] }).fetch({
				url: 'http://sneaky.example/',
			}),
		).rejects.toThrow(/resolves to 10\.0\.0\.5/)
		expect(asked).toEqual([])
	})

	it('refuses when ANY resolved address is inside', async () => {
		// A name with one public and one private record is still a way in, and
		// taking the first answer would depend on resolver ordering.
		const { fn } = recordingFetch(reply('x'))

		await expect(
			provider({
				fetch: fn,
				resolve: async () => ['93.184.216.34', '127.0.0.1'],
			}).fetch({
				url: 'http://mixed.example/',
			}),
		).rejects.toThrow(WebFetchRefusedError)
	})

	it('allows a name that resolves entirely outside', async () => {
		// The other direction: a guard that refused everything would pass every
		// test above and be useless.
		const { fn } = recordingFetch(reply('page'))

		const result = await provider({
			fetch: fn,
			resolve: async () => ['93.184.216.34'],
		}).fetch({
			url: 'http://example.com/',
		})

		expect(result.body).toBe('page')
	})

	it('refuses rather than allowing when resolution fails', async () => {
		// A name nobody can resolve is not a name that is safe. Treating a
		// lookup failure as "no private addresses found" is fail-open, and the
		// fetch that follows would resolve it again for real.
		const { fn, asked } = recordingFetch(reply('x'))

		await expect(
			provider({
				fetch: fn,
				resolve: async () => {
					throw new Error('SERVFAIL')
				},
			}).fetch({ url: 'http://unresolvable.example/' }),
		).rejects.toThrow(WebFetchRefusedError)
		expect(asked).toEqual([])
	})

	it('lets a host opt in deliberately', async () => {
		// A test fixture on 127.0.0.1 is the one legitimate case, and it is a
		// decision a host makes explicitly rather than inherits.
		const { fn, asked } = recordingFetch(reply('ok'))

		const result = await provider({
			fetch: fn,
			allowPrivateAddresses: true,
		}).fetch({
			url: 'http://127.0.0.1:8080/health',
		})

		expect(result.body).toBe('ok')
		expect(asked).toHaveLength(1)
	})
})

describe('the address rules, written out', () => {
	it('covers the IPv4 ranges that matter', () => {
		for (const address of [
			'127.0.0.1',
			'10.1.2.3',
			'172.16.0.1',
			'172.31.255.255',
			'192.168.1.1',
			'169.254.169.254',
			'0.0.0.0',
			'224.0.0.1',
		]) {
			expect(isPrivateAddress(address)).toBe(true)
		}
	})

	it('does not over-refuse the neighbours of those ranges', () => {
		// `172.15` and `172.32` are public, and a range check written from
		// memory gets exactly these wrong.
		for (const address of ['8.8.8.8', '93.184.216.34', '172.15.0.1', '172.32.0.1', '11.0.0.1']) {
			expect(isPrivateAddress(address)).toBe(false)
		}
	})

	it('covers IPv6, including canonical mapped and full link-local spellings', () => {
		// A guard that checked only IPv4 is bypassed by a name with a AAAA
		// record, and `::ffff:127.0.0.1` is loopback wearing an IPv6 spelling.
		for (const address of [
			'::1',
			'fe80::1',
			'fe80::1%lo0',
			'fe90::1',
			'febf::1',
			'fc00::1',
			'fd12::3',
			'ff02::1',
			'::ffff:127.0.0.1',
			'::ffff:7f00:1',
			'::ffff:a9fe:a9fe',
		]) {
			expect(isPrivateAddress(address)).toBe(true)
		}
		expect(isPrivateAddress('2606:4700:4700::1111')).toBe(false)
		expect(isPrivateAddress('::ffff:93.184.216.34')).toBe(false)
	})
})

describe('a scheme that is not the web is refused by name', () => {
	it('refuses file: and says which scheme', async () => {
		// Naming it is what lets a model correct itself.
		const { fn, asked } = recordingFetch(reply('x'))

		await expect(provider({ fetch: fn }).fetch({ url: 'file:///etc/passwd' })).rejects.toThrow(
			/file:/,
		)
		expect(asked).toEqual([])
	})

	it('refuses data: and anything else', async () => {
		const { fn } = recordingFetch(reply('x'))
		for (const url of ['data:text/plain,hi', 'ftp://example.com/x', 'gopher://example.com']) {
			await expect(provider({ fetch: fn }).fetch({ url })).rejects.toThrow(WebFetchRefusedError)
		}
	})

	it('refuses something that is not a URL at all', async () => {
		const { fn } = recordingFetch(reply('x'))

		await expect(provider({ fetch: fn }).fetch({ url: 'not a url' })).rejects.toThrow(/not a URL/)
	})
})

describe('a redirect is re-checked, every hop', () => {
	it('refuses a public URL that redirects inside', async () => {
		// The classic version of this bug: check the URL the caller typed,
		// then let the platform follow redirects. A permitted page answers
		// 302 -> the metadata endpoint, and the guard never sees it.
		const { fn, asked } = recordingFetch({
			'https://example.com/': reply('', {
				status: 302,
				headers: { location: 'http://169.254.169.254/' },
			}),
		})

		await expect(
			provider({ fetch: fn, resolve: PUBLIC }).fetch({
				url: 'https://example.com/',
			}),
		).rejects.toThrow(/redirect/i)
		// The first hop was fetched; the second was never sent.
		expect(asked).toEqual(['https://example.com/'])
	})

	it('resolves a RELATIVE Location against the current URL', async () => {
		// An unresolved relative target would be checked as a different URL
		// than the one actually followed.
		const { fn, asked } = recordingFetch({
			'https://example.com/a': reply('', {
				status: 302,
				headers: { location: '/b' },
			}),
			'https://example.com/b': reply('arrived'),
		})

		const result = await provider({ fetch: fn, resolve: PUBLIC }).fetch({
			url: 'https://example.com/a',
		})

		expect(asked).toEqual(['https://example.com/a', 'https://example.com/b'])
		expect(result.body).toBe('arrived')
		expect(result.redirects).toEqual(['https://example.com/a', 'https://example.com/b'])
	})

	it('stops at the redirect limit rather than looping', async () => {
		const { fn } = recordingFetch(
			reply('', {
				status: 302,
				headers: { location: 'https://example.com/next' },
			}),
		)

		await expect(
			provider({ fetch: fn, maxRedirects: 2, resolve: PUBLIC }).fetch({
				url: 'https://example.com/',
			}),
		).rejects.toThrow(/2 redirects/)
	})

	it('reports the whole chain on success', async () => {
		// So a citation names where the content actually came from, not where
		// the model asked.
		const { fn } = recordingFetch({
			'https://example.com/': reply('', {
				status: 301,
				headers: { location: 'https://example.com/final' },
			}),
			'https://example.com/final': reply('content'),
		})

		const result = await provider({ fetch: fn, resolve: PUBLIC }).fetch({
			url: 'https://example.com/',
		})

		expect(result.redirects).toEqual(['https://example.com/', 'https://example.com/final'])
		expect(result.url).toBe('https://example.com/final')
	})
})

describe('model-authored headers cannot make the request "as me"', () => {
	it('strips authorization and cookie', async () => {
		// `headers` is a channel from the model into an outbound request, and
		// these two turn "fetch this page" into "fetch this page as me".
		let seen: Headers | Record<string, string> | undefined
		const fn = vi.fn(async (_input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
			seen = init?.headers as Record<string, string>
			return reply('ok')
		}) as unknown as typeof globalThis.fetch

		await provider({ fetch: fn, resolve: PUBLIC }).fetch({
			url: 'https://example.com/',
			headers: {
				Authorization: 'Bearer secret',
				Cookie: 'session=1',
				Host: 'internal.example',
				accept: 'text/html',
			},
		})

		expect(seen).toEqual({ accept: 'text/html' })
	})

	it('strips regardless of header case', async () => {
		let seen: Record<string, string> | undefined
		const fn = vi.fn(async (_i: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
			seen = init?.headers as Record<string, string>
			return reply('ok')
		}) as unknown as typeof globalThis.fetch

		await provider({ fetch: fn, resolve: PUBLIC }).fetch({
			url: 'https://example.com/',
			headers: { AUTHORIZATION: 'Bearer x', 'PROXY-AUTHORIZATION': 'Basic y' },
		})

		expect(seen).toEqual({})
	})
})

describe('a body too large is cut, and says so', () => {
	it('reports truncation rather than returning a short page as whole', async () => {
		// A truncated page reading as complete is a model concluding something
		// from a document whose second half it never saw.
		const { fn } = recordingFetch(reply('x'.repeat(5000)))

		const result = await provider({
			fetch: fn,
			maxBytes: 100,
			resolve: PUBLIC,
		}).fetch({
			url: 'https://example.com/',
		})

		expect(result.truncated).toBe(true)
		expect(result.body).toHaveLength(100)
	})

	it('does not claim truncation for a page that fit', async () => {
		const { fn } = recordingFetch(reply('short'))

		const result = await provider({
			fetch: fn,
			maxBytes: 100,
			resolve: PUBLIC,
		}).fetch({
			url: 'https://example.com/',
		})

		expect(result.truncated).toBe(false)
		expect(result.body).toBe('short')
	})
})

describe('a host can block names of its own', () => {
	it('refuses a blocked host whatever it resolves to', async () => {
		// An internal name that resolves publicly is not caught by an
		// IP-range rule, and only the host knows its own names.
		const { fn, asked } = recordingFetch(reply('x'))

		await expect(
			provider({
				fetch: fn,
				blockedHosts: ['intranet.example'],
				resolve: PUBLIC,
			}).fetch({
				url: 'https://intranet.example/wiki',
			}),
		).rejects.toThrow(/blocks this name/)
		expect(asked).toEqual([])
	})
})

describe('the two properties a fake fetch can only observe directly', () => {
	it('never lets the platform follow a redirect for it', async () => {
		// `redirect: 'follow'` would have the platform land on the final URL
		// having never asked whether that URL was allowed — the guard would
		// see one hop and the socket would see three. Asserting the option is
		// asserting the guarantee here, because with `follow` there is nothing
		// else to observe: the refusal simply never happens.
		let seen: RequestInit | undefined
		const fn = vi.fn(async (_i: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
			seen = init
			return reply('ok')
		}) as unknown as typeof globalThis.fetch

		await provider({ fetch: fn, resolve: PUBLIC }).fetch({
			url: 'https://example.com/',
		})

		expect(seen?.redirect).toBe('manual')
	})

	it('refuses a name that resolves to nothing at all', async () => {
		// The other fail-open shape: an empty list satisfies the "no private
		// addresses" loop, so a name with no records would pass a check that
		// only looked for a bad answer rather than for an answer.
		const { fn, asked } = recordingFetch(reply('x'))

		await expect(
			provider({ fetch: fn, resolve: async () => [] }).fetch({
				url: 'http://nowhere.example/',
			}),
		).rejects.toThrow(/no addresses/)
		expect(asked).toEqual([])
	})
})

describe('one run-owned operation bounds resolution, fetch, and body reads', () => {
	type ByteReadResult =
		| { readonly done: false; readonly value: Uint8Array }
		| { readonly done: true; readonly value?: undefined }

	it('refuses a pre-aborted caller before DNS or fetch', async () => {
		const resolve = vi.fn(PUBLIC)
		const fetch = vi.fn(async () => reply('must not run')) as unknown as typeof globalThis.fetch
		const caller = new AbortController()
		const reason = new Error('operator already stopped the web fetch')
		caller.abort(reason)

		await expect(
			provider({ fetch, resolve }).fetch({
				url: 'https://example.com/',
				signal: caller.signal,
			}),
		).rejects.toBe(reason)
		expect(resolve).not.toHaveBeenCalled()
		expect(fetch).not.toHaveBeenCalled()
	})

	it('passes a private signal to a resolver and preserves the caller cause', async () => {
		let markStarted: (() => void) | undefined
		const started = new Promise<void>((resolve) => {
			markStarted = resolve
		})
		let resolverSignal: AbortSignal | undefined
		const resolve = vi.fn((_hostname: string, signal?: AbortSignal) => {
			resolverSignal = signal
			markStarted?.()
			return new Promise<readonly string[]>(() => {})
		})
		const fetch = vi.fn(async () => reply('must not run')) as unknown as typeof globalThis.fetch
		const caller = new AbortController()
		const pending = provider({ fetch, resolve, timeoutMs: 1_000 }).fetch({
			url: 'https://example.com/',
			signal: caller.signal,
		})

		await started
		const reason = new Error('operator stopped DNS admission')
		caller.abort(reason)

		await expect(settleWithin(pending)).rejects.toBe(reason)
		expect(resolverSignal).toBeDefined()
		expect(resolverSignal).not.toBe(caller.signal)
		expect(resolverSignal?.aborted).toBe(true)
		expect(resolverSignal?.reason).toBe(reason)
		expect(fetch).not.toHaveBeenCalled()
	})

	it('settles a fetch that ignores its deadline signal', async () => {
		let transportSignal: AbortSignal | undefined
		const fetch = vi.fn((_input: unknown, init?: RequestInit) => {
			transportSignal = init?.signal as AbortSignal
			return new Promise<Response>(() => {})
		}) as unknown as typeof globalThis.fetch

		await expect(
			settleWithin(
				provider({ fetch, allowPrivateAddresses: true, timeoutMs: 10 }).fetch({
					url: 'https://example.com/',
				}),
			),
		).rejects.toMatchObject({
			name: 'TimeoutError',
			message: expect.stringContaining('10ms'),
		})
		expect(transportSignal?.aborted).toBe(true)
		expect(transportSignal?.reason).toMatchObject({ name: 'TimeoutError' })
	})

	it('settles and cancels a body reader that ignores the transport signal', async () => {
		const cancel = vi.fn(async () => {})
		const releaseLock = vi.fn()
		const response = {
			status: 200,
			headers: new Headers({ 'content-type': 'text/plain' }),
			body: {
				getReader: () => ({
					read: () => new Promise<ByteReadResult>(() => {}),
					cancel,
					releaseLock,
				}),
			},
		} as unknown as Response
		const fetch = vi.fn(async () => response) as unknown as typeof globalThis.fetch

		await expect(
			settleWithin(
				provider({ fetch, allowPrivateAddresses: true, timeoutMs: 10 }).fetch({
					url: 'https://example.com/',
				}),
			),
		).rejects.toMatchObject({ name: 'TimeoutError' })
		expect(cancel).toHaveBeenCalledTimes(1)
		expect(releaseLock).toHaveBeenCalledTimes(1)
	})

	it('lets an abort beat an oversized chunk fulfilled in the same turn', async () => {
		const caller = new AbortController()
		const reason = new Error('operator stopped during the body read')
		const cancel = vi.fn(async () => {})
		const response = {
			status: 200,
			headers: new Headers({ 'content-type': 'text/plain' }),
			body: {
				getReader: () => ({
					read: () => {
						caller.abort(reason)
						return Promise.resolve({
							done: false as const,
							value: new TextEncoder().encode('overflow'),
						})
					},
					cancel,
					releaseLock: vi.fn(),
				}),
			},
		} as unknown as Response
		const fetch = vi.fn(async () => response) as unknown as typeof globalThis.fetch

		await expect(
			provider({ fetch, allowPrivateAddresses: true, maxBytes: 4 }).fetch({
				url: 'https://example.com/',
				signal: caller.signal,
			}),
		).rejects.toBe(reason)
		expect(cancel).toHaveBeenCalledTimes(1)
	})
})

describe('the byte limit is enforced while the response is streaming', () => {
	type ByteReadResult =
		| { readonly done: false; readonly value: Uint8Array }
		| { readonly done: true; readonly value?: undefined }

	function responseFromReads(
		reads: ByteReadResult[],
		headers: Record<string, string> = {},
	): {
		response: Response
		cancel: ReturnType<typeof vi.fn>
		text: ReturnType<typeof vi.fn>
	} {
		const cancel = vi.fn(async () => {})
		const text = vi.fn(async () => 'the full body path must not run')
		const pending = [...reads]
		const response = {
			status: 200,
			headers: new Headers({ 'content-type': 'text/plain', ...headers }),
			body: {
				getReader: () => ({
					read: async () => pending.shift() ?? { done: true as const, value: undefined },
					cancel,
					releaseLock: vi.fn(),
				}),
			},
			text,
		} as unknown as Response
		return { response, cancel, text }
	}

	it('counts actual chunks, retains only the prefix, and cancels on overflow', async () => {
		const { response, cancel, text } = responseFromReads(
			[{ done: false, value: new TextEncoder().encode('abcdefghij') }],
			{ 'content-length': '1' },
		)
		const fetch = vi.fn(async () => response) as unknown as typeof globalThis.fetch

		const result = await provider({
			fetch,
			allowPrivateAddresses: true,
			maxBytes: 4,
		}).fetch({
			url: 'https://example.com/',
		})

		expect(result).toMatchObject({ body: 'abcd', truncated: true })
		expect(cancel).toHaveBeenCalledTimes(1)
		expect(text).not.toHaveBeenCalled()
	})

	it('does not call an exact-limit body truncated after observing EOF', async () => {
		const { response, cancel } = responseFromReads([
			{ done: false, value: new TextEncoder().encode('abcd') },
			{ done: true, value: undefined },
		])
		const fetch = vi.fn(async () => response) as unknown as typeof globalThis.fetch

		const result = await provider({
			fetch,
			allowPrivateAddresses: true,
			maxBytes: 4,
		}).fetch({
			url: 'https://example.com/',
		})

		expect(result).toMatchObject({ body: 'abcd', truncated: false })
		expect(cancel).not.toHaveBeenCalled()
	})

	it('returns a valid UTF-8 prefix when the cap cuts a code point', async () => {
		const { response } = responseFromReads([{ done: false, value: new TextEncoder().encode('éé') }])
		const fetch = vi.fn(async () => response) as unknown as typeof globalThis.fetch

		const result = await provider({
			fetch,
			allowPrivateAddresses: true,
			maxBytes: 3,
		}).fetch({
			url: 'https://example.com/',
		})

		expect(result.body).toBe('é')
		expect(result.body).not.toContain('�')
		expect(result.truncated).toBe(true)
	})
})

describe('redirect admission spends no work after the hop budget', () => {
	it('cancels the redirect body and never resolves its forbidden next target', async () => {
		const cancel = vi.fn(async () => {})
		const response = {
			status: 302,
			headers: new Headers({ location: 'https://must-not-resolve.example/' }),
			body: { cancel },
		} as unknown as Response
		const fetch = vi.fn(async () => response) as unknown as typeof globalThis.fetch
		const resolve = vi.fn(PUBLIC)

		await expect(
			provider({ fetch, resolve, maxRedirects: 0 }).fetch({
				url: 'https://example.com/',
			}),
		).rejects.toMatchObject({ details: { reason: 'redirect-limit' } })
		expect(resolve).toHaveBeenCalledTimes(1)
		expect(resolve).toHaveBeenCalledWith('example.com', expect.any(AbortSignal))
		expect(cancel).toHaveBeenCalledTimes(1)
	})

	it('uses the same operation signal across redirect DNS and fetch phases', async () => {
		const signals: AbortSignal[] = []
		const resolve = vi.fn((_hostname: string, signal?: AbortSignal) => {
			if (signal) signals.push(signal)
			return signals.length === 1
				? Promise.resolve(PUBLIC())
				: new Promise<readonly string[]>(() => {})
		})
		const fetch = vi.fn(async (_input: unknown, init?: RequestInit) => {
			if (init?.signal) signals.push(init.signal)
			return {
				status: 302,
				headers: new Headers({ location: '/next' }),
				body: { cancel: async () => {} },
			} as unknown as Response
		}) as unknown as typeof globalThis.fetch

		await expect(
			settleWithin(
				provider({ fetch, resolve, timeoutMs: 10 }).fetch({
					url: 'https://example.com/',
				}),
			),
		).rejects.toMatchObject({ name: 'TimeoutError' })
		expect(signals).toHaveLength(3)
		expect(signals.every((signal) => signal === signals[0])).toBe(true)
		expect(signals[0]?.aborted).toBe(true)
	})
})

describe('resource limits are admitted when the provider is built', () => {
	it.each([
		[{ timeoutMs: 0 }, /timeoutMs must be an integer from 1/],
		[{ timeoutMs: 1.5 }, /timeoutMs must be an integer from 1/],
		[{ maxBytes: 0 }, /maxBytes must be an integer from 1/],
		[{ maxBytes: Number.NaN }, /maxBytes must be an integer from 1/],
		[{ maxRedirects: -1 }, /maxRedirects must be a non-negative safe integer/],
		[{ maxRedirects: 1.5 }, /maxRedirects must be a non-negative safe integer/],
	] as const)('refuses %j', (config, message) => {
		expect(() => new GuardedFetchProvider(config)).toThrow(message)
	})

	it('allows zero redirects while retaining direct fetches', async () => {
		const { fn } = recordingFetch(reply('direct'))
		const result = await provider({
			fetch: fn,
			resolve: PUBLIC,
			maxRedirects: 0,
		}).fetch({
			url: 'https://example.com/',
		})

		expect(result.body).toBe('direct')
	})
})
