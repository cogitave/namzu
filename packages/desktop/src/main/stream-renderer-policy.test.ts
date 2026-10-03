import { readFile } from 'node:fs/promises'
import { expect, it, vi } from 'vitest'
import {
	installStreamRendererPolicy,
	readStreamRendererPort,
	withStreamRendererPort,
} from './stream-renderer-policy.js'

const page = 'file:///application/dist/renderer/index.html'
const port = 23456
async function fixture(html?: string) {
	const original = html ?? (await readFile(new URL('../../index.html', import.meta.url), 'utf8'))
	const handle = vi.fn()
	const unhandle = vi.fn()
	const fetch = vi.fn(
		async () =>
			new Response(original, {
				headers: { 'content-type': 'text/html', 'content-length': String(original.length) },
			}),
	)
	const dispose = installStreamRendererPolicy({
		protocol: { handle, unhandle },
		fetch,
		productionPage: page,
		port,
	})
	const handler = handle.mock.calls[0]?.[1] as (request: Request) => Promise<Response>
	return { original, handler, fetch, handle, unhandle, dispose }
}

it('adds only a port to the exact selected development page and leaves production file URLs unchanged', () => {
	expect(withStreamRendererPort('http://127.0.0.1:5173/', port)).toBe(
		`http://127.0.0.1:5173/?namzuStreamPort=${port}`,
	)
	expect(withStreamRendererPort('http://localhost:5173/', port)).toBe(
		`http://localhost:5173/?namzuStreamPort=${port}`,
	)
	expect(withStreamRendererPort(page, port)).toBe(page)
	for (const value of [
		'https://127.0.0.1:5173/',
		'http://remote.invalid/',
		'http://credential:private@127.0.0.1:5173/',
		'http://127.0.0.1:5173/preview',
		'http://127.0.0.1:5173/?token=private',
		'http://127.0.0.1:5173/#private',
	])
		expect(() => withStreamRendererPort(value, port)).toThrow('selected local root page')
	for (const invalid of [0, -1, 1.5, 65536, Number.NaN])
		expect(() => withStreamRendererPort(page, invalid)).toThrow('stream port')
})

it('rejects malformed, duplicate or nonlocal port sources without widening development policy', () => {
	expect(readStreamRendererPort(`/?namzuStreamPort=${port}`)).toBe(port)
	expect(readStreamRendererPort('http://[::1]:5173/?namzuStreamPort=65535')).toBe(65535)
	for (const value of [
		undefined,
		'/',
		'/?namzuStreamPort=0',
		'/?namzuStreamPort=01',
		'/?namzuStreamPort=%2B1',
		'/?namzuStreamPort=1.5',
		'/?namzuStreamPort=65536',
		'/?namzuStreamPort=23456&namzuStreamPort=23456',
		'/?namzuStreamPort=1%3Bconnect-src%20*',
		'http://remote.invalid/?namzuStreamPort=23456',
		'ws://127.0.0.1:5173/?namzuStreamPort=23456',
	])
		expect(readStreamRendererPort(value)).toBeUndefined()
})

it('rewrites only the exact bundled renderer policy and forwards to built-in file handling without recursion', async () => {
	const f = await fixture()
	const request = new Request(page)
	const response = await f.handler(request)
	const actual = await response.text()
	expect(actual).toBe(
		f.original.replace("connect-src 'none'", `connect-src ws://127.0.0.1:${port}`),
	)
	expect(actual).not.toContain('ws://127.0.0.1:*')
	expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8')
	expect(response.headers.has('content-length')).toBe(false)
	expect(f.fetch).toHaveBeenCalledWith(request, { bypassCustomProtocolHandlers: true })
	expect(f.handle).toHaveBeenCalledWith('file', expect.any(Function))
	f.dispose()
	f.dispose()
	expect(f.unhandle).toHaveBeenCalledExactlyOnceWith('file')
})

it('preserves other assets and file documents even if they contain the same CSP text', async () => {
	const f = await fixture()
	for (const url of [
		'file:///application/dist/renderer/assets/index.js',
		'file:///application/dist/renderer/other.html',
		'file:///other/dist/renderer/index.html',
		`${page}?namzuStreamPort=34567`,
	]) {
		const response = await f.handler(new Request(url))
		expect(await response.text()).toBe(f.original)
		expect(response.headers.get('content-length')).toBe(String(f.original.length))
	}
	f.dispose()
})

it('fails closed when production CSP is missing, duplicated or already widened', async () => {
	const original = await readFile(new URL('../../index.html', import.meta.url), 'utf8')
	const policyMeta = original.match(/<meta[^>]+http-equiv="Content-Security-Policy"[^>]+>/u)?.[0]
	if (!policyMeta) throw new Error('Missing fixture document policy')
	for (const html of [
		original.replace(policyMeta, ''),
		original.replace(policyMeta, `${policyMeta}${policyMeta}`),
		original.replace("connect-src 'none'", 'connect-src *'),
		original.replace("connect-src 'none'", "connect-src 'none'; connect-src *"),
	]) {
		const f = await fixture(html)
		await expect(f.handler(new Request(page))).rejects.toThrow(/policy/u)
		f.dispose()
	}
})

it('preserves failed file responses and rejects invalid registration before handling files', async () => {
	const f = await fixture()
	const failed = new Response('owned-fixture-not-found', { status: 404 })
	f.fetch.mockResolvedValueOnce(failed)
	expect(await f.handler(new Request(page))).toBe(failed)
	f.dispose()
	for (const productionPage of [
		'http://127.0.0.1:5173/',
		'file:///application/other.html',
		`${page}?stream=private`,
	]) {
		const handle = vi.fn()
		expect(() =>
			installStreamRendererPolicy({
				protocol: { handle, unhandle: vi.fn() },
				fetch: f.fetch,
				productionPage,
				port,
			}),
		).toThrow('exact bundled renderer file')
		expect(handle).not.toHaveBeenCalled()
	}
})
