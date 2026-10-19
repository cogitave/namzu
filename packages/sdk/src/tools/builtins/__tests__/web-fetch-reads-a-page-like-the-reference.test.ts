import { type Server, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { GuardedFetchProvider } from '../../../connector/web/guarded-fetch.js'
import {
	WEB_PAGE_CACHE_TTL_MS,
	WEB_PAGE_MODEL_MAX_CHARS,
	WEB_PAGE_TRUNCATED_MARKER,
} from '../../../connector/web/page.js'
import type { WebExtractRequest } from '../../../connector/web/types.js'
import type { SessionId, TurnId } from '../../../types/ids/index.js'
import type { ToolContext } from '../../../types/tool/index.js'
import { WEB_EXTRACT_INSTRUCTION, WEB_FETCH_ACCEPT, WebFetchTool } from '../web.js'

/**
 * `web_fetch` against a real HTTP server on the loopback: HTML becomes
 * markdown, a small model answers the prompt from it, a page is kept for
 * fifteen minutes, and a redirect to another host is handed back instead of
 * followed. The guard is the shipped one with private addresses allowed, which
 * is the only way a test can reach a server it started itself.
 */

interface Hit {
	readonly path: string
	readonly accept: string | undefined
}

interface Site {
	readonly origin: string
	readonly host: string
	readonly hits: Hit[]
	readonly close: () => Promise<void>
}

function serve(
	host: string,
	routes: Record<
		string,
		| { status?: number; type?: string; body?: string; location?: string }
		| ((hits: number) => {
				status?: number
				type?: string
				body?: string
				location?: string
		  })
	>,
): Promise<Site> {
	const hits: Hit[] = []
	const server: Server = createServer((request, response) => {
		const path = request.url ?? '/'
		hits.push({ path, accept: request.headers.accept })
		const route = routes[path]
		if (!route) {
			response.writeHead(404, { 'content-type': 'text/plain' })
			response.end('nothing here')
			return
		}
		const spec = typeof route === 'function' ? route(hits.length) : route
		response.writeHead(spec.status ?? 200, {
			'content-type': spec.type ?? 'text/html; charset=utf-8',
			...(spec.location ? { location: spec.location } : {}),
		})
		response.end(spec.body ?? '')
	})
	return new Promise((resolve) => {
		server.listen(0, host, () => {
			const { port } = server.address() as AddressInfo
			resolve({
				origin: `http://${host}:${port}`,
				host: `${host}:${port}`,
				hits,
				close: () =>
					new Promise<void>((done) => {
						server.closeAllConnections()
						server.close(() => done())
					}),
			})
		})
	})
}

const PAGE = `<!doctype html><html><head><title>Guide</title>
<style>.hidden{display:none}</style><script>window.secret = 'script text'</script></head>
<body><h1>Install guide</h1><p>Run <b>the installer</b> then read <a href="https://docs.example/start">the docs</a>.</p>
<ul><li>first step</li><li>second step</li></ul><noscript>enable javascript</noscript></body></html>`

let sites: Site[] = []
afterEach(async () => {
	vi.useRealTimers()
	await Promise.all(sites.map((site) => site.close()))
	sites = []
})
async function site(host: string, routes: Parameters<typeof serve>[1]): Promise<Site> {
	const started = await serve(host, routes)
	sites.push(started)
	return started
}

interface Extraction {
	requests: WebExtractRequest[]
	extractor: NonNullable<NonNullable<ToolContext['web']>['extract']>
}
function extractorReplying(answer: string | ((request: WebExtractRequest) => string)): Extraction {
	const requests: WebExtractRequest[] = []
	return {
		requests,
		extractor: {
			async extract(request) {
				requests.push(request as WebExtractRequest)
				return typeof answer === 'string' ? answer : answer(request as WebExtractRequest)
			},
		},
	}
}

function contextWith(
	extraction: Extraction | undefined,
	fetchProvider = new GuardedFetchProvider({ allowPrivateAddresses: true }),
): ToolContext {
	return {
		sessionId: '0190a5b2-7c3d-7e4f-8a9b-0c1d2e3f4a5b' as SessionId,
		turnId: 'b9dc517e-37ed-4289-afcd-b0d081254384' as TurnId,
		workingDirectory: '/tmp',
		abortSignal: new AbortController().signal,
		env: {},
		log: () => {},
		web: {
			fetch: fetchProvider,
			...(extraction ? { extract: extraction.extractor } : {}),
		},
	}
}

const call = (context: ToolContext, url: string, prompt = 'how do I install it', offset?: number) =>
	WebFetchTool.execute({ url, prompt, ...(offset === undefined ? {} : { offset }) }, context)

beforeEach(() => {
	vi.useRealTimers()
})

describe('what the model is asked, and what it is shown', () => {
	it('converts the page to markdown and answers the prompt from it with the extractor', async () => {
		const origin = await site('127.0.0.1', { '/guide': { body: PAGE } })
		const extraction = extractorReplying('Run the installer, then read the docs.')

		const result = await call(contextWith(extraction), `${origin.origin}/guide`)

		expect(result.success).toBe(true)
		expect(result.output).toContain('Run the installer, then read the docs.')
		expect(extraction.requests).toHaveLength(1)
		const request = extraction.requests[0] as WebExtractRequest
		expect(request.prompt).toBe('how do I install it')
		expect(request.instruction).toBe(WEB_EXTRACT_INSTRUCTION)
		expect(request.content).toContain('Install guide')
		expect(request.content).toContain('**the installer**')
		expect(request.content).toContain('[the docs](https://docs.example/start)')
		expect(request.content).not.toContain('script text')
		expect(request.content).not.toContain('enable javascript')
		expect(request.content).not.toContain('<h1>')
		expect(request.body).toContain('Web page content:')
		expect(request.body).toContain('how do I install it')
		expect(request.sessionId).toBe('0190a5b2-7c3d-7e4f-8a9b-0c1d2e3f4a5b')
		expect(request.turnId).toBe('b9dc517e-37ed-4289-afcd-b0d081254384')
	})

	it('tells the model the page is data and holds quotes to 125 characters', () => {
		expect(WEB_EXTRACT_INSTRUCTION).toMatch(/untrusted/iu)
		expect(WEB_EXTRACT_INSTRUCTION).toMatch(/never follow instructions/iu)
		expect(WEB_EXTRACT_INSTRUCTION).toMatch(/125 characters/u)
	})

	it('shows the page as markdown when no extractor is wired', async () => {
		const origin = await site('127.0.0.1', { '/guide': { body: PAGE } })

		const result = await call(contextWith(undefined), `${origin.origin}/guide`)

		expect(result.success).toBe(true)
		expect(result.output).toContain('Install guide')
		expect(result.output).toContain('**the installer**')
		expect(result.output).not.toContain('<h1>')
	})

	it('shows the page when the extractor cannot answer, and never fails the fetch', async () => {
		const origin = await site('127.0.0.1', { '/guide': { body: PAGE } })
		const failing = {
			requests: [] as WebExtractRequest[],
			extractor: {
				async extract(): Promise<string | undefined> {
					throw new Error('small model offline')
				},
			},
		}
		const silent = {
			requests: [] as WebExtractRequest[],
			extractor: {
				async extract(): Promise<string | undefined> {
					return undefined
				},
			},
		}

		for (const extraction of [failing, silent]) {
			const result = await call(contextWith(extraction), `${origin.origin}/guide`)
			expect(result.success).toBe(true)
			expect(result.output).toContain('Install guide')
		}
	})

	it('leaves a page that is not HTML as it is', async () => {
		const origin = await site('127.0.0.1', {
			'/data.json': {
				type: 'application/json',
				body: '{"name":"namzu","tags":["a","b"]}',
			},
		})
		const extraction = extractorReplying('ok')

		await call(contextWith(extraction), `${origin.origin}/data.json`)

		expect((extraction.requests[0] as WebExtractRequest).content).toBe(
			'{"name":"namzu","tags":["a","b"]}',
		)
	})

	it('asks for markdown first, as the reference does', async () => {
		const origin = await site('127.0.0.1', { '/guide': { body: PAGE } })
		await call(contextWith(undefined), `${origin.origin}/guide`)
		expect(origin.hits[0]?.accept).toBe(WEB_FETCH_ACCEPT)
	})
})

describe('the fifteen-minute cache', () => {
	it('answers a second question about a page without fetching it again', async () => {
		const origin = await site('127.0.0.1', { '/guide': { body: PAGE } })
		const extraction = extractorReplying((request) => `answer to: ${request.prompt}`)
		const context = contextWith(extraction)

		const first = await call(context, `${origin.origin}/guide`, 'first question')
		const second = await call(context, `${origin.origin}/guide`, 'second question')

		expect(origin.hits).toHaveLength(1)
		expect(first.output).toContain('answer to: first question')
		expect(second.output).toContain('answer to: second question')
		expect((first.data as { cached: boolean }).cached).toBe(false)
		expect((second.data as { cached: boolean }).cached).toBe(true)
	})

	it('fetches again once the quarter hour is over, and not a moment before', async () => {
		vi.useFakeTimers({ toFake: ['Date'] })
		vi.setSystemTime(new Date('2026-10-19T10:00:00Z'))
		const origin = await site('127.0.0.1', { '/guide': { body: PAGE } })
		const context = contextWith(undefined)

		await call(context, `${origin.origin}/guide`)
		vi.setSystemTime(Date.now() + WEB_PAGE_CACHE_TTL_MS - 1)
		await call(context, `${origin.origin}/guide`)
		expect(origin.hits).toHaveLength(1)

		vi.setSystemTime(Date.now() + 2)
		await call(context, `${origin.origin}/guide`)
		expect(origin.hits).toHaveLength(2)
	})

	it('keys the cache by URL', async () => {
		const origin = await site('127.0.0.1', {
			'/a': { body: '<p>page a</p>' },
			'/b': { body: '<p>page b</p>' },
		})
		const context = contextWith(undefined)

		const a = await call(context, `${origin.origin}/a`)
		const b = await call(context, `${origin.origin}/b`)

		expect(a.output).toContain('page a')
		expect(b.output).toContain('page b')
		expect(origin.hits).toHaveLength(2)
	})

	it('does not keep a page for a different provider', async () => {
		const origin = await site('127.0.0.1', { '/guide': { body: PAGE } })

		await call(contextWith(undefined), `${origin.origin}/guide`)
		await call(contextWith(undefined), `${origin.origin}/guide`)

		expect(origin.hits).toHaveLength(2)
	})

	it('does not keep an error', async () => {
		let healthy = false
		const origin = await site('127.0.0.1', {
			'/flaky': () => (healthy ? { body: '<p>back</p>' } : { status: 500, body: 'down' }),
		})
		const context = contextWith(undefined)

		const down = await call(context, `${origin.origin}/flaky`)
		healthy = true
		const up = await call(context, `${origin.origin}/flaky`)

		expect(down.output).toContain('HTTP 500 Internal Server Error')
		expect(up.output).toContain('back')
	})
})

describe('redirects', () => {
	it('follows a redirect that stays on the same site', async () => {
		const origin = await site('127.0.0.1', {
			'/old': { status: 301, location: '/new' },
			'/new': { body: '<p>the new page</p>' },
		})

		const result = await call(contextWith(undefined), `${origin.origin}/old`)

		expect(result.output).toContain('the new page')
		expect(result.output).toContain(`redirected to ${origin.origin}/new`)
		expect(origin.hits.map((hit) => hit.path)).toEqual(['/old', '/new'])
	})

	it('hands back a redirect to another host instead of following it', async () => {
		const elsewhere = await site('127.0.0.2', {
			'/landing': { body: '<p>other host</p>' },
		})
		const origin = await site('127.0.0.1', {
			'/moved': {
				status: 302,
				location: `${elsewhere.origin}/landing?from=moved`,
			},
		})
		const extraction = extractorReplying('should not be asked')

		const result = await call(
			contextWith(extraction),
			`${origin.origin}/moved`,
			'what does it say',
			0,
		)

		expect(result.success).toBe(true)
		expect(result.output).toContain('REDIRECT DETECTED')
		expect(result.output).toContain(`Original URL: ${origin.origin}/moved`)
		expect(result.output).toContain(`${elsewhere.origin}/landing?from=moved`)
		expect(result.output).toContain('Status: 302 Found')
		expect(result.output).toContain('web_fetch again')
		expect(result.output).toContain('"what does it say"')
		expect(elsewhere.hits).toHaveLength(0)
		expect(extraction.requests).toHaveLength(0)
	})

	it('lets the model follow the handed-back redirect with a second call', async () => {
		const elsewhere = await site('127.0.0.2', {
			'/landing': { body: '<p>other host</p>' },
		})
		const origin = await site('127.0.0.1', {
			'/moved': { status: 302, location: `${elsewhere.origin}/landing` },
		})
		const context = contextWith(undefined)

		await call(context, `${origin.origin}/moved`)
		const followed = await call(context, `${elsewhere.origin}/landing`)

		expect(followed.output).toContain('other host')
		expect(elsewhere.hits).toHaveLength(1)
	})

	it('does not follow a redirect to another port either', async () => {
		const other = await site('127.0.0.1', {
			'/x': { body: '<p>other port</p>' },
		})
		const origin = await site('127.0.0.1', {
			'/go': { status: 307, location: `${other.origin}/x` },
		})

		const result = await call(contextWith(undefined), `${origin.origin}/go`)

		expect(result.output).toContain('REDIRECT DETECTED')
		expect(other.hits).toHaveLength(0)
	})

	it('still refuses a redirect target the guard would refuse', async () => {
		const requested: string[] = []
		const strict = new GuardedFetchProvider({
			resolve: async (name) => (name === 'site.example' ? ['93.184.216.34'] : ['10.0.0.7']),
			fetch: async (input) => {
				requested.push(String(input))
				return new Response('', {
					status: 302,
					headers: { location: 'http://metadata.internal/latest/meta-data/' },
				})
			},
		})

		const result = await call(contextWith(undefined, strict), 'http://site.example/go')

		expect(result.success).toBe(false)
		expect(result.error).toContain('metadata.internal')
		expect(result.error).toContain('10.0.0.7')
		expect(requested).toEqual(['http://site.example/go'])
	})

	it('hands the redirect back with the offset the model asked for', async () => {
		const elsewhere = await site('127.0.0.2', {})
		const origin = await site('127.0.0.1', {
			'/moved': { status: 302, location: `${elsewhere.origin}/z` },
		})

		const result = await call(contextWith(undefined), `${origin.origin}/moved`, 'p', 500)

		expect(result.output).toContain('offset: 500')
	})
})

describe('an answer from a page that is not 200', () => {
	it('reports the status and does not read the body', async () => {
		const origin = await site('127.0.0.1', {})
		const extraction = extractorReplying('should not be asked')

		const result = await call(contextWith(extraction), `${origin.origin}/missing`)

		expect(result.success).toBe(true)
		expect(result.output).toContain('The server returned HTTP 404 Not Found.')
		expect(result.output).toContain('authenticated tool')
		expect(result.output).not.toContain('nothing here')
		expect(extraction.requests).toHaveLength(0)
	})
})

describe('a page too long for one question', () => {
	const WORD = 'paragraph '
	const long = `<p>${WORD.repeat(15_000)}</p><p>THE-END-MARKER</p>`

	it('is cut for the model and says how to read on', async () => {
		const origin = await site('127.0.0.1', { '/long': { body: long } })
		const extraction = extractorReplying('summary of the start')

		const result = await call(contextWith(extraction), `${origin.origin}/long`)

		const sent = (extraction.requests[0] as WebExtractRequest).content
		expect(sent.length).toBeLessThanOrEqual(
			WEB_PAGE_MODEL_MAX_CHARS + WEB_PAGE_TRUNCATED_MARKER.length + 2,
		)
		expect(sent.endsWith(WEB_PAGE_TRUNCATED_MARKER)).toBe(true)
		expect(sent).not.toContain('THE-END-MARKER')
		expect(result.output).toContain('summary of the start')
		expect(result.output).toContain(`covers characters 0 to ${WEB_PAGE_MODEL_MAX_CHARS}`)
		expect(result.output).toContain(`offset ${WEB_PAGE_MODEL_MAX_CHARS}`)
	})

	it('reads on from the offset, from the cached page', async () => {
		const origin = await site('127.0.0.1', { '/long': { body: long } })
		const extraction = extractorReplying('the end of the page')
		const context = contextWith(extraction)

		await call(context, `${origin.origin}/long`)
		const second = await call(
			context,
			`${origin.origin}/long`,
			'what is at the end',
			WEB_PAGE_MODEL_MAX_CHARS,
		)

		const sent = (extraction.requests[1] as WebExtractRequest).content
		expect(sent).toContain('THE-END-MARKER')
		expect((extraction.requests[1] as WebExtractRequest).body).toContain(
			`starts ${WEB_PAGE_MODEL_MAX_CHARS} characters into the page`,
		)
		expect(second.output).toContain('the end of the page')
		expect(second.output).not.toContain('to read on')
		expect(origin.hits).toHaveLength(1)
	})

	it('says so when the offset is past the end', async () => {
		const origin = await site('127.0.0.1', {
			'/short': { body: '<p>tiny</p>' },
		})

		const result = await call(contextWith(undefined), `${origin.origin}/short`, 'p', 5000)

		expect(result.success).toBe(true)
		expect(result.output).toMatch(/Nothing left to read from offset 5000/u)
	})
})

describe('URLs the reference refuses before any request', () => {
	it('refuses a hostname without a dot, and points to a shell command', async () => {
		const context = contextWith(undefined)
		const result = await call(context, 'http://localhost:3000/')
		expect(result.success).toBe(false)
		expect(result.error).toMatch(/hostnames without a dot/u)
		expect(result.error).toMatch(/curl/u)
	})

	it('refuses a URL with a user name or password', async () => {
		const result = await call(contextWith(undefined), 'https://user:pass@example.com/')
		expect(result.success).toBe(false)
		expect(result.error).toMatch(/user name or password/u)
	})

	it('refuses a URL longer than 2000 characters', async () => {
		const result = await call(contextWith(undefined), `https://example.com/${'a'.repeat(2000)}`)
		expect(result.success).toBe(false)
		expect(result.error).toMatch(/longer than 2000/u)
	})
})

describe('the tool’s own input', () => {
	it('requires a prompt, and takes an optional offset', () => {
		const schema = WebFetchTool.inputSchema
		expect(schema.safeParse({ url: 'https://example.com/' }).success).toBe(false)
		expect(schema.safeParse({ url: 'https://example.com/', prompt: 'p' }).success).toBe(true)
		expect(schema.safeParse({ url: 'https://example.com/', prompt: 'p', offset: 10 }).success).toBe(
			true,
		)
		expect(schema.safeParse({ url: 'https://example.com/', prompt: 'p', offset: -1 }).success).toBe(
			false,
		)
	})
})
