import { afterEach, describe, expect, it, vi } from 'vitest'
import {
	LINK_PREVIEW_IMAGE_MAX_BYTES,
	LINK_PREVIEW_PAGE_MAX_BYTES,
} from '../shared/link-preview-protocol.js'
import {
	type LinkPreviewNetwork,
	type LinkPreviewResponse,
	createLinkPreviewService,
	isPublicAddress,
	previewTarget,
} from './link-preview.js'

afterEach(() => {
	vi.useRealTimers()
})

const bytes = (text: string, encoding: BufferEncoding = 'utf8') =>
	new Uint8Array(Buffer.from(text, encoding))

interface Script {
	status?: number
	headers?: Record<string, string>
	location?: string
	chunks?: Uint8Array[]
}

function response(script: Script) {
	const cancel = vi.fn()
	const consumed = vi.fn()
	const chunks = script.chunks ?? []
	const value: LinkPreviewResponse = {
		status: script.status ?? 200,
		header: (name) => script.headers?.[name],
		location: script.location,
		cancel,
		body: (async function* () {
			for (const chunk of chunks) {
				consumed()
				yield chunk
			}
		})(),
	}
	return { value, cancel, consumed }
}

function harness(
	respond: (url: string) => Script | undefined,
	resolve: (host: string) => readonly string[] | Promise<readonly string[]> = () => ['8.8.8.8'],
) {
	const requests: string[] = []
	const signals: AbortSignal[] = []
	const responses: ReturnType<typeof response>[] = []
	const network: LinkPreviewNetwork = {
		resolve: async (host) => resolve(host),
		request: async (url, _accept, signal) => {
			requests.push(url)
			signals.push(signal)
			const made = response(respond(url) ?? { status: 404 })
			responses.push(made)
			return made.value
		},
	}
	return { network, requests, signals, responses }
}

const html = { 'content-type': 'text/html; charset=utf-8' }
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]

describe('previewTarget', () => {
	it('accepts plain public https addresses', () => {
		expect(previewTarget('https://example.com/a?b=1')?.href).toBe('https://example.com/a?b=1')
		expect(previewTarget('https://example.com:443/')?.port).toBe('')
		expect(previewTarget('https://8.8.8.8/')).toBeDefined()
		expect(previewTarget('https://[2606:4700:4700::1111]/')).toBeDefined()
	})
	it.each([
		['http', 'http://example.com/'],
		['credentials', 'https://user:pw@example.com/'],
		['explicit port', 'https://example.com:8443/'],
		['control char', 'https://example.com/a\nb'],
		['space', 'https://example.com/a b'],
		['too long', `https://example.com/${'a'.repeat(2_048)}`],
		['single label', 'https://intranet/'],
		['localhost', 'https://localhost/'],
		['.localhost', 'https://a.localhost/'],
		['.local', 'https://printer.local/'],
		['.internal', 'https://api.internal/'],
		['.home.arpa', 'https://nas.home.arpa/'],
		['.lan', 'https://box.lan/'],
		['.intranet', 'https://wiki.intranet/'],
		['trailing dot localhost', 'https://x.local./'],
		['private v4 literal', 'https://192.168.1.1/'],
		['loopback v6 literal', 'https://[::1]/'],
		['not a string', 42],
		['garbage', 'not a url'],
	])('refuses %s', (_name, value) => {
		expect(previewTarget(value)).toBeUndefined()
	})
})

describe('isPublicAddress', () => {
	it.each([
		'0.1.2.3',
		'10.1.2.3',
		'100.64.0.1',
		'127.0.0.1',
		'169.254.169.254',
		'172.16.0.1',
		'172.31.255.255',
		'192.0.0.8',
		'192.0.2.1',
		'192.31.196.1',
		'192.52.193.1',
		'192.88.99.1',
		'192.168.0.1',
		'192.175.48.1',
		'198.18.0.1',
		'198.19.255.255',
		'198.51.100.1',
		'203.0.113.1',
		'224.0.0.1',
		'240.0.0.1',
		'255.255.255.255',
		'::',
		'::1',
		'::ffff:127.0.0.1',
		'::ffff:7f00:1',
		'::ffff:10.0.0.1',
		'64:ff9b::1',
		'64:ff9b:1::1',
		'100::1',
		'2001::1',
		'2001:db8::1',
		'2002::1',
		'3fff::1',
		'fc00::1',
		'fd12::1',
		'fe80::1',
		'fe80::1%eth0',
		'[fe80::1]',
		'fec0::1',
		'ff02::1',
		'garbage',
		'',
		'999.1.1.1',
	])('refuses %s', (address) => {
		expect(isPublicAddress(address)).toBe(false)
	})
	it.each(['8.8.8.8', '1.1.1.1', '172.32.0.1', '2606:4700:4700::1111', '::ffff:8.8.8.8'])(
		'allows %s',
		(address) => {
			expect(isPublicAddress(address)).toBe(true)
		},
	)
})

describe('resolution', () => {
	it('refuses a mix of public and private answers without requesting', async () => {
		const h = harness(
			() => ({ headers: html }),
			() => ['8.8.8.8', '10.0.0.1'],
		)
		expect(await createLinkPreviewService({ network: h.network }).page('https://a.com/')).toBeNull()
		expect(h.requests).toEqual([])
	})
	it('refuses an empty answer', async () => {
		const h = harness(
			() => ({ headers: html }),
			() => [],
		)
		expect(await createLinkPreviewService({ network: h.network }).page('https://a.com/')).toBeNull()
		expect(h.requests).toEqual([])
	})
	it('refuses when the resolver throws', async () => {
		const h = harness(
			() => ({ headers: html }),
			() => Promise.reject(new Error('dns')),
		)
		expect(await createLinkPreviewService({ network: h.network }).page('https://a.com/')).toBeNull()
		expect(h.requests).toEqual([])
	})
	it('does not resolve IP literals', async () => {
		const resolve = vi.fn(async () => ['10.0.0.1'])
		const h = harness(() => ({ headers: html, chunks: [bytes('</head>')] }))
		h.network.resolve = resolve
		expect(
			await createLinkPreviewService({ network: h.network }).page('https://8.8.8.8/'),
		).not.toBeNull()
		expect(resolve).not.toHaveBeenCalled()
	})
})

describe('redirects', () => {
	const ok = { headers: html, chunks: [bytes('<head></head>')] }
	it('follows a relative location', async () => {
		const h = harness((url) =>
			url === 'https://a.com/x/y' ? { status: 302, location: '../z' } : ok,
		)
		const page = await createLinkPreviewService({ network: h.network }).page('https://a.com/x/y')
		expect(page?.url).toBe('https://a.com/z')
		expect(h.requests).toEqual(['https://a.com/x/y', 'https://a.com/z'])
	})
	it('refuses a redirect to a private host without requesting it', async () => {
		const h = harness(
			(url) => (url === 'https://a.com/' ? { status: 301, location: 'https://b.com/' } : ok),
			(host) => (host === 'b.com' ? ['192.168.0.9'] : ['8.8.8.8']),
		)
		expect(await createLinkPreviewService({ network: h.network }).page('https://a.com/')).toBeNull()
		expect(h.requests).toEqual(['https://a.com/'])
	})
	it('refuses a redirect to http', async () => {
		const h = harness(() => ({ status: 302, location: 'http://a.com/' }))
		expect(await createLinkPreviewService({ network: h.network }).page('https://a.com/')).toBeNull()
		expect(h.requests).toHaveLength(1)
	})
	it('allows four redirects and refuses the fifth', async () => {
		const chain = (limit: number) =>
			harness((url) => {
				const n = Number(new URL(url).pathname.slice(1) || 0)
				return n < limit ? { status: 302, location: `/${n + 1}` } : ok
			})
		const four = chain(4)
		expect(
			await createLinkPreviewService({ network: four.network }).page('https://a.com/'),
		).not.toBeNull()
		const five = chain(5)
		expect(
			await createLinkPreviewService({ network: five.network }).page('https://a.com/'),
		).toBeNull()
		expect(five.requests).toHaveLength(5)
	})
	it('refuses a redirect without a location', async () => {
		const h = harness(() => ({ status: 302 }))
		expect(await createLinkPreviewService({ network: h.network }).page('https://a.com/')).toBeNull()
	})
})

describe('page', () => {
	const run = (script: Script) => {
		const h = harness(() => script)
		return { h, result: createLinkPreviewService({ network: h.network }).page('https://a.com/') }
	}
	it('refuses non-2xx', async () => {
		expect(await run({ status: 404, headers: html, chunks: [bytes('x')] }).result).toBeNull()
	})
	it.each([undefined, 'application/json', 'text/plain'])(
		'refuses content type %s',
		async (type) => {
			const { h, result } = run({
				headers: type ? { 'content-type': type } : {},
				chunks: [bytes('<head>')],
			})
			expect(await result).toBeNull()
			expect(h.responses[0]?.cancel).toHaveBeenCalled()
		},
	)
	it('accepts xhtml', async () => {
		const { result } = run({
			headers: { 'content-type': 'Application/XHTML+xml' },
			chunks: [bytes('<head></head>')],
		})
		expect((await result)?.head).toBe('<head></head>')
	})
	it('cuts right after </head>, across a chunk boundary', async () => {
		const { h, result } = run({
			headers: html,
			chunks: [bytes('<html><head><title>T</title></he'), bytes('ad><body>secret</body>')],
		})
		expect(await result).toEqual({
			url: 'https://a.com/',
			head: '<html><head><title>T</title></head>',
		})
		expect(h.responses[0]?.cancel).toHaveBeenCalled()
	})
	it('matches the closing tag case-insensitively and ignores </header>', async () => {
		const { result } = run({
			headers: html,
			chunks: [bytes('<head></header>x</HEAD >tail')],
		})
		expect((await result)?.head).toBe('<head></header>x</HEAD >')
	})
	it('keeps exactly the byte cap when no head ends', async () => {
		const piece = new Uint8Array(100 * 1024).fill(0x61)
		const { h, result } = run({ headers: html, chunks: Array.from({ length: 8 }, () => piece) })
		expect((await result)?.head).toHaveLength(LINK_PREVIEW_PAGE_MAX_BYTES)
		expect(h.responses[0]?.cancel).toHaveBeenCalled()
	})
	it('sniffs a meta charset', async () => {
		const body = Buffer.concat([
			Buffer.from('<head><meta charset="windows-1254"><title>'),
			Buffer.from([0xfe]),
			Buffer.from('</title></head>'),
		])
		const { result } = run({
			headers: { 'content-type': 'text/html' },
			chunks: [new Uint8Array(body)],
		})
		expect((await result)?.head).toContain('<title>ş</title>')
	})
	it('sniffs an http-equiv charset', async () => {
		const body = Buffer.concat([
			Buffer.from(
				'<head><meta http-equiv="Content-Type" content="text/html; charset=iso-8859-9"><title>',
			),
			Buffer.from([0xfd]),
			Buffer.from('</title></head>'),
		])
		const { result } = run({
			headers: { 'content-type': 'text/html' },
			chunks: [new Uint8Array(body)],
		})
		expect((await result)?.head).toContain('<title>ı</title>')
	})
	it('prefers the header charset over the meta tag', async () => {
		const body = Buffer.concat([
			Buffer.from('<head><meta charset="utf-8"><title>'),
			Buffer.from([0xfe]),
			Buffer.from('</title></head>'),
		])
		const { result } = run({
			headers: { 'content-type': 'text/html; charset=windows-1254' },
			chunks: [new Uint8Array(body)],
		})
		expect((await result)?.head).toContain('<title>ş</title>')
	})
	it('falls back to utf-8 for an unknown label', async () => {
		const { result } = run({
			headers: { 'content-type': 'text/html; charset=bogus-9' },
			chunks: [bytes('<head>é</head>')],
		})
		expect((await result)?.head).toBe('<head>é</head>')
	})
	it('refuses invalid input without a request', async () => {
		const h = harness(() => ({ headers: html }))
		const service = createLinkPreviewService({ network: h.network })
		expect(await service.page('http://a.com/')).toBeNull()
		expect(await service.page(undefined)).toBeNull()
		expect(h.requests).toEqual([])
	})
})

describe('image', () => {
	const run = (script: Script, kind: unknown = 'image') => {
		const h = harness(() => script)
		return {
			h,
			result: createLinkPreviewService({ network: h.network }).image('https://a.com/i', kind),
		}
	}
	const b64 = (data: number[]) => Buffer.from(data).toString('base64')
	const pad = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
	it.each([
		['image/png', PNG],
		['image/jpeg', [0xff, 0xd8, 0xff, 0xe0, 1]],
		['image/gif', [...Buffer.from('GIF89a'), 1, 2]],
		['image/gif', [...Buffer.from('GIF87a'), 1, 2]],
		['image/webp', [...Buffer.from('RIFF'), 1, 2, 3, 4, ...Buffer.from('WEBPVP8 ')]],
		['image/avif', [0, 0, 0, 0x1c, ...Buffer.from('ftypavif'), ...pad]],
		['image/avif', [0, 0, 0, 0x1c, ...Buffer.from('ftypavis'), ...pad]],
	])('sniffs %s ignoring the declared type', async (mime, data) => {
		const { result } = run({
			headers: { 'content-type': 'text/plain' },
			chunks: [new Uint8Array(data)],
		})
		expect(await result).toBe(`data:${mime};base64,${b64(data)}`)
	})
	it('refuses svg and html', async () => {
		expect(
			await run({
				headers: { 'content-type': 'image/svg+xml' },
				chunks: [bytes('<svg xmlns="x"/>')],
			}).result,
		).toBeNull()
		expect(await run({ chunks: [bytes('<!doctype html><p>')] }).result).toBeNull()
	})
	it('accepts ico only as an icon', async () => {
		const ico = new Uint8Array([0, 0, 1, 0, 1, 0])
		expect(await run({ chunks: [ico] }, 'icon').result).toBe(
			`data:image/x-icon;base64,${b64([...ico])}`,
		)
		expect(await run({ chunks: [ico] }, 'image').result).toBeNull()
	})
	it('refuses a bad kind without a request', async () => {
		const { h, result } = run({ chunks: [new Uint8Array(PNG)] }, 'banner')
		expect(await result).toBeNull()
		expect(h.requests).toEqual([])
	})
	it('refuses an oversized content-length without reading the body', async () => {
		const { h, result } = run({
			headers: { 'content-length': String(LINK_PREVIEW_IMAGE_MAX_BYTES.image + 1) },
			chunks: [new Uint8Array(PNG)],
		})
		expect(await result).toBeNull()
		expect(h.responses[0]?.consumed).not.toHaveBeenCalled()
		expect(h.responses[0]?.cancel).toHaveBeenCalled()
	})
	it('uses the smaller cap for icons', async () => {
		const { result } = run(
			{ headers: { 'content-length': String(LINK_PREVIEW_IMAGE_MAX_BYTES.icon + 1) } },
			'icon',
		)
		expect(await result).toBeNull()
	})
	it('stops a stream that outgrows the cap', async () => {
		const piece = new Uint8Array(LINK_PREVIEW_IMAGE_MAX_BYTES.icon)
		piece.set(PNG)
		const { h, result } = run({ chunks: [piece, new Uint8Array(1), piece] }, 'icon')
		expect(await result).toBeNull()
		expect(h.responses[0]?.cancel).toHaveBeenCalled()
		expect(h.responses[0]?.consumed).toHaveBeenCalledTimes(2)
	})
})

describe('cache', () => {
	it('serves a repeat from memory', async () => {
		const h = harness(() => ({ headers: html, chunks: [bytes('<head></head>')] }))
		const service = createLinkPreviewService({ network: h.network })
		const first = await service.page('https://a.com/')
		expect(await service.page('https://a.com/')).toEqual(first)
		expect(h.requests).toHaveLength(1)
	})
	it('keeps failures for two minutes and successes for fifteen', async () => {
		let clock = 0
		let ok = false
		const h = harness(() =>
			ok ? { headers: html, chunks: [bytes('<head></head>')] } : { status: 500 },
		)
		const service = createLinkPreviewService({ network: h.network, now: () => clock })
		expect(await service.page('https://a.com/')).toBeNull()
		ok = true
		clock = 2 * 60_000 - 1
		expect(await service.page('https://a.com/')).toBeNull()
		expect(h.requests).toHaveLength(1)
		clock = 2 * 60_000
		expect(await service.page('https://a.com/')).not.toBeNull()
		expect(h.requests).toHaveLength(2)
		clock += 15 * 60_000 - 1
		await service.page('https://a.com/')
		expect(h.requests).toHaveLength(2)
		clock += 1
		await service.page('https://a.com/')
		expect(h.requests).toHaveLength(3)
	})
	it('caches images per kind', async () => {
		const h = harness(() => ({ chunks: [new Uint8Array(PNG)] }))
		const service = createLinkPreviewService({ network: h.network })
		await service.image('https://a.com/i', 'image')
		await service.image('https://a.com/i', 'image')
		await service.image('https://a.com/i', 'icon')
		expect(h.requests).toHaveLength(2)
	})
	it('evicts the least recent page beyond 128 entries', async () => {
		const h = harness(() => ({ headers: html, chunks: [bytes('<head></head>')] }))
		const service = createLinkPreviewService({ network: h.network })
		for (let i = 0; i < 129; i++) await service.page(`https://a.com/${i}`)
		await service.page('https://a.com/0')
		expect(h.requests).toHaveLength(130)
		await service.page('https://a.com/128')
		expect(h.requests).toHaveLength(130)
	})
	it('shares one request between concurrent identical calls', async () => {
		let release: (() => void) | undefined
		const gate = new Promise<void>((resolve) => {
			release = resolve
		})
		const h = harness(
			() => ({ headers: html, chunks: [bytes('<head></head>')] }),
			async () => {
				await gate
				return ['8.8.8.8']
			},
		)
		const service = createLinkPreviewService({ network: h.network })
		const a = service.page('https://a.com/')
		const b = service.page('https://a.com/')
		release?.()
		expect(await a).toEqual(await b)
		expect(h.requests).toHaveLength(1)
	})
})

describe('concurrency', () => {
	it('starts a third operation only when one of two finishes', async () => {
		const releases: Array<() => void> = []
		const started: string[] = []
		const network: LinkPreviewNetwork = {
			resolve: async () => ['8.8.8.8'],
			request: (url) => {
				started.push(url)
				return new Promise((resolve) => {
					releases.push(() =>
						resolve(response({ headers: html, chunks: [bytes('<head></head>')] }).value),
					)
				})
			},
		}
		const service = createLinkPreviewService({ network, maxConcurrent: 2 })
		const all = ['1', '2', '3'].map((n) => service.page(`https://a.com/${n}`))
		await vi.waitFor(() => expect(started).toHaveLength(2))
		releases[0]?.()
		await vi.waitFor(() => expect(started).toHaveLength(3))
		releases[1]?.()
		releases[2]?.()
		expect((await Promise.all(all)).every((page) => page !== null)).toBe(true)
	})
})

describe('deadline', () => {
	it('gives up after 8 seconds and aborts the request', async () => {
		vi.useFakeTimers()
		const signals: AbortSignal[] = []
		const network: LinkPreviewNetwork = {
			resolve: async () => ['8.8.8.8'],
			request: (_url, _accept, signal) => {
				signals.push(signal)
				return new Promise(() => {})
			},
		}
		const pending = createLinkPreviewService({ network }).page('https://a.com/')
		await vi.advanceTimersByTimeAsync(7_999)
		expect(signals[0]?.aborted).toBe(false)
		await vi.advanceTimersByTimeAsync(1)
		expect(await pending).toBeNull()
		expect(signals[0]?.aborted).toBe(true)
	})
})
