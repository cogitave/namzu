import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { removeTempDir } from '../../../__fixtures__/temp-dir.js'
import { downloadArchive } from './archive.js'
import { FetchError } from './git.js'
import {
	CATALOG_DOWNLOAD_MAX_BYTES,
	MAX_REDIRECTS,
	download,
	fetchCatalogText,
	isArchiveType,
	isCatalogType,
} from './url.js'

type Handler = (request: IncomingMessage, response: ServerResponse) => void
let server: Server
let base: string
let handler: Handler
let root: string

beforeEach(async () => {
	root = mkdtempSync(join(tmpdir(), 'namzu-url-fetch-'))
	handler = (_request, response) => response.writeHead(404).end()
	server = createServer((request, response) => handler(request, response))
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
	base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterEach(async () => {
	server.closeAllConnections()
	await new Promise<void>((resolve) => server.close(() => resolve()))
	removeTempDir(root)
})

// The fake server is plain http on 127.0.0.1, which only the test option allows.
const loopback = { allowLoopbackHttp: true } as const

async function failure(promise: Promise<unknown>): Promise<FetchError> {
	try {
		await promise
	} catch (error) {
		expect(error).toBeInstanceOf(FetchError)
		return error as FetchError
	}
	throw new Error('expected a FetchError')
}

describe('catalog download', () => {
	it('reads a JSON catalog and a text/plain one, and sends no cookies or sign-in', async () => {
		let seen: IncomingMessage | undefined
		handler = (request, response) => {
			seen = request
			response
				.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
				.end('{"name":"x"}')
		}
		expect(await fetchCatalogText(`${base}/marketplace.json`, loopback)).toBe('{"name":"x"}')
		expect(seen?.headers.cookie).toBeUndefined()
		expect(seen?.headers.authorization).toBeUndefined()
		handler = (_request, response) =>
			response.writeHead(200, { 'content-type': 'text/plain' }).end('{}')
		expect(await fetchCatalogText(`${base}/raw`, loopback)).toBe('{}')
		expect(isCatalogType('application/vnd.api+json')).toBe(true)
		expect(isCatalogType('text/html')).toBe(false)
		expect(isArchiveType('application/zip')).toBe(true)
		expect(isArchiveType('text/html')).toBe(false)
	})

	it('refuses plain http outside the test option, an address with sign-in details, and a page that is not a catalog', async () => {
		expect((await failure(fetchCatalogText(`${base}/m.json`))).code).toBe(64)
		expect((await failure(fetchCatalogText('http://example.com/m.json', loopback))).code).toBe(64)
		expect((await failure(fetchCatalogText('https://u:p@example.com/m.json'))).code).toBe(64)
		handler = (_request, response) =>
			response.writeHead(200, { 'content-type': 'text/html' }).end('<html>')
		const html = await failure(fetchCatalogText(`${base}/m.json`, loopback))
		expect(html).toMatchObject({ code: 65, kind: 'type' })
	})

	it('stops at the size cap, by the declared length and by what arrives', async () => {
		handler = (_request, response) => {
			response.writeHead(200, {
				'content-type': 'application/json',
				'content-length': String(CATALOG_DOWNLOAD_MAX_BYTES + 1),
			})
			response.end()
		}
		expect(await failure(fetchCatalogText(`${base}/big`, loopback))).toMatchObject({
			code: 65,
			kind: 'size',
		})
		handler = (_request, response) => {
			response.writeHead(200, { 'content-type': 'application/json' })
			const chunk = Buffer.alloc(1024 * 1024, 0x20)
			for (let i = 0; i <= 10; i++) response.write(chunk)
			response.end()
		}
		const streamed = await failure(fetchCatalogText(`${base}/stream`, loopback))
		expect(streamed).toMatchObject({ code: 65, kind: 'size' })
		expect(streamed.message).toContain('10 MiB')
	})

	it('follows redirects up to five and never to an address that is not https', async () => {
		let hops = 0
		handler = (request, response) => {
			if (request.url === '/final')
				return void response
					.writeHead(200, { 'content-type': 'application/json' })
					.end('{"ok":true}')
			hops++
			response.writeHead(302, { location: `/r${hops}` }).end()
		}
		// Each hop redirects again: more than five stops.
		const tooMany = await failure(fetchCatalogText(`${base}/r0`, loopback))
		expect(tooMany).toMatchObject({ code: 69, kind: 'redirect' })
		expect(hops).toBe(MAX_REDIRECTS + 1)
		// Exactly five redirects then the answer works.
		let count = 0
		handler = (_request, response) => {
			if (count < MAX_REDIRECTS) {
				count++
				return void response.writeHead(301, { location: '/again' }).end()
			}
			response.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}')
		}
		expect(await fetchCatalogText(`${base}/start`, loopback)).toBe('{"ok":true}')
		// A redirect to http that is not the loopback is refused, as is one to a file or ftp address.
		for (const location of [
			'http://example.com/m.json',
			'ftp://example.com/m.json',
			'file:///etc/passwd',
		]) {
			handler = (_request, response) => response.writeHead(302, { location }).end()
			const refused = await failure(fetchCatalogText(`${base}/hop`, loopback))
			expect(refused, location).toMatchObject({ code: 65, kind: 'redirect' })
		}
	})

	it('names a missing page, a sign-in wall and a server error in plain words', async () => {
		handler = (_request, response) => response.writeHead(404).end()
		expect(await failure(fetchCatalogText(`${base}/a`, loopback))).toMatchObject({
			code: 66,
			kind: 'not-found',
		})
		handler = (_request, response) => response.writeHead(403).end()
		const walled = await failure(fetchCatalogText(`${base}/a`, loopback))
		expect(walled).toMatchObject({ code: 66, kind: 'auth' })
		expect(walled.message).toContain('does not send')
		handler = (_request, response) => response.writeHead(503).end()
		expect(await failure(fetchCatalogText(`${base}/a`, loopback))).toMatchObject({
			code: 69,
			kind: 'status',
		})
	})

	it('says it could not reach a host that is not listening', async () => {
		await new Promise<void>((resolve) => server.close(() => resolve()))
		const error = await failure(fetchCatalogText(`${base}/m.json`, loopback))
		expect(error).toMatchObject({ code: 69, kind: 'network' })
		// Reopen so the afterEach close has something to close.
		server = createServer()
		await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
	})
})

describe('the time limit, on a fake clock', () => {
	it('aborts a download that never finishes after the limit and says so', async () => {
		vi.useFakeTimers()
		try {
			const fetchImpl = ((_url: string, init: { signal: AbortSignal }) =>
				new Promise((_resolve, reject) => {
					init.signal.addEventListener('abort', () => reject(new Error('aborted')))
				})) as unknown as typeof fetch
			const pending = failure(fetchCatalogText('https://example.com/m.json', { fetchImpl }))
			await vi.advanceTimersByTimeAsync(29_999)
			let settled = false
			void pending.then(() => {
				settled = true
			})
			await vi.advanceTimersByTimeAsync(0)
			expect(settled).toBe(false)
			await vi.advanceTimersByTimeAsync(1)
			const error = await pending
			expect(error).toMatchObject({ code: 69, kind: 'timeout' })
			expect(error.message).toContain('30 seconds')
		} finally {
			vi.useRealTimers()
		}
	})
})

describe('archive download', () => {
	const zipBytes = Buffer.from('PK\u0003\u0004 not really a zip but bytes')
	const sha = createHash('sha256').update(zipBytes).digest('hex')

	it('writes the file under staging and reports its digest; a given digest is verified', async () => {
		handler = (_request, response) =>
			response.writeHead(200, { 'content-type': 'application/zip' }).end(zipBytes)
		const dest = join(root, 'staging', 'plugin.zip')
		const ok = await downloadArchive(`${base}/p.zip`, dest, sha.toUpperCase(), loopback)
		expect(ok).toEqual({ file: dest, sha256: sha, bytes: zipBytes.length })
		expect(readFileSync(dest)).toEqual(zipBytes)
		const unpinned = await downloadArchive(
			`${base}/p.zip`,
			join(root, 'u.zip'),
			undefined,
			loopback,
		)
		expect(unpinned.sha256).toBe(sha)
	})

	it('refuses a download whose digest differs and writes nothing', async () => {
		handler = (_request, response) =>
			response.writeHead(200, { 'content-type': 'application/zip' }).end(zipBytes)
		const dest = join(root, 'bad.zip')
		const error = await failure(downloadArchive(`${base}/p.zip`, dest, 'a'.repeat(64), loopback))
		expect(error).toMatchObject({ code: 65, kind: 'digest' })
		expect(error.message).toContain('does not match the digest')
		expect(existsSync(dest)).toBe(false)
	})

	it('does not take a web page for an archive', async () => {
		handler = (_request, response) =>
			response.writeHead(200, { 'content-type': 'text/html' }).end('<html>')
		expect(
			(await failure(downloadArchive(`${base}/p.zip`, join(root, 'h.zip'), undefined, loopback)))
				.kind,
		).toBe('type')
	})
})

describe('download', () => {
	it('uses a rewritten address when a test gives one', async () => {
		handler = (_request, response) =>
			response.writeHead(200, { 'content-type': 'application/json' }).end('{"a":1}')
		const bytes = await download(
			{
				url: 'https://example.test/m.json',
				maxBytes: 100,
				timeoutMs: 1000,
				acceptType: isCatalogType,
				subject: 'catalog',
			},
			{ ...loopback, rewriteUrl: () => `${base}/m.json` },
		)
		expect(bytes.toString()).toBe('{"a":1}')
	})

	it('stops a download whose signal aborted, with the sentence for a cancel and not a network error', async () => {
		const controller = new AbortController()
		let reached!: () => void
		const waiting = new Promise<void>((resolve) => {
			reached = resolve
		})
		// A server that sends the headers and then nothing: the download ends only through the signal.
		handler = (_request, response) => {
			response.writeHead(200, { 'content-type': 'application/json' })
			response.write('{')
			reached()
		}
		const request = {
			url: 'https://example.test/m.json',
			maxBytes: 100,
			timeoutMs: 600_000,
			acceptType: isCatalogType,
			subject: 'catalog',
		}
		const pending = download(request, {
			...loopback,
			rewriteUrl: () => `${base}/m.json`,
			signal: controller.signal,
		})
		const settled = expect(pending).rejects.toMatchObject({
			kind: 'cancelled',
			message: 'Cancelled.',
		})
		await waiting
		controller.abort()
		await settled
		// Already aborted: nothing is requested.
		await expect(
			download(request, {
				...loopback,
				rewriteUrl: () => `${base}/m.json`,
				signal: controller.signal,
			}),
		).rejects.toMatchObject({ kind: 'cancelled' })
	})
})
