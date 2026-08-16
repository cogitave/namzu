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
			provider({ fetch: fn }).fetch({ url: 'http://169.254.169.254/latest/meta-data/' }),
		).rejects.toThrow(/inside this host/)
	})

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
			provider({ fetch: fn, resolve: async () => ['93.184.216.34', '127.0.0.1'] }).fetch({
				url: 'http://mixed.example/',
			}),
		).rejects.toThrow(WebFetchRefusedError)
	})

	it('allows a name that resolves entirely outside', async () => {
		// The other direction: a guard that refused everything would pass every
		// test above and be useless.
		const { fn } = recordingFetch(reply('page'))

		const result = await provider({ fetch: fn, resolve: async () => ['93.184.216.34'] }).fetch({
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

		const result = await provider({ fetch: fn, allowPrivateAddresses: true }).fetch({
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

	it('covers IPv6, including the mapped spelling of an IPv4 address', () => {
		// A guard that checked only IPv4 is bypassed by a name with a AAAA
		// record, and `::ffff:127.0.0.1` is loopback wearing an IPv6 spelling.
		for (const address of ['::1', 'fe80::1', 'fc00::1', 'fd12::3', '::ffff:127.0.0.1']) {
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
			provider({ fetch: fn, resolve: PUBLIC }).fetch({ url: 'https://example.com/' }),
		).rejects.toThrow(/redirect/i)
		// The first hop was fetched; the second was never sent.
		expect(asked).toEqual(['https://example.com/'])
	})

	it('resolves a RELATIVE Location against the current URL', async () => {
		// An unresolved relative target would be checked as a different URL
		// than the one actually followed.
		const { fn, asked } = recordingFetch({
			'https://example.com/a': reply('', { status: 302, headers: { location: '/b' } }),
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
			reply('', { status: 302, headers: { location: 'https://example.com/next' } }),
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

		const result = await provider({ fetch: fn, maxBytes: 100, resolve: PUBLIC }).fetch({
			url: 'https://example.com/',
		})

		expect(result.truncated).toBe(true)
		expect(result.body).toHaveLength(100)
	})

	it('does not claim truncation for a page that fit', async () => {
		const { fn } = recordingFetch(reply('short'))

		const result = await provider({ fetch: fn, maxBytes: 100, resolve: PUBLIC }).fetch({
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
			provider({ fetch: fn, blockedHosts: ['intranet.example'], resolve: PUBLIC }).fetch({
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

		await provider({ fetch: fn, resolve: PUBLIC }).fetch({ url: 'https://example.com/' })

		expect(seen?.redirect).toBe('manual')
	})

	it('refuses a name that resolves to nothing at all', async () => {
		// The other fail-open shape: an empty list satisfies the "no private
		// addresses" loop, so a name with no records would pass a check that
		// only looked for a bad answer rather than for an answer.
		const { fn, asked } = recordingFetch(reply('x'))

		await expect(
			provider({ fetch: fn, resolve: async () => [] }).fetch({ url: 'http://nowhere.example/' }),
		).rejects.toThrow(/no addresses/)
		expect(asked).toEqual([])
	})
})
