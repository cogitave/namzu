import { createHash, randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PinnedWslPackage, WslcSetupProgress } from '../setup/contract.js'
import { PINNED_WSL_PACKAGE, downloadWslPackage } from '../setup/wsl-package.js'

const payload = randomBytes(1_500_000)
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

let directory: string
let server: Server | undefined

beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), 'namzu-t4-dl-'))
})

afterEach(async () => {
	vi.useRealTimers()
	if (server) await new Promise<void>((resolve) => server?.close(() => resolve()))
	server = undefined
	await rm(directory, { recursive: true, force: true })
})

function pinnedFor(url: string, bytes: Uint8Array = payload): PinnedWslPackage {
	return {
		version: '3.0.1.0',
		architecture: 'x64',
		url,
		sha256: sha(bytes),
		sizeBytes: bytes.length,
	}
}

async function serve(
	handler: (request: IncomingMessage, response: ServerResponse, count: number) => void,
): Promise<{ url: string; requests: IncomingMessage[] }> {
	const requests: IncomingMessage[] = []
	server = createServer((request, response) => {
		requests.push(request)
		handler(request, response, requests.length)
	})
	await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve))
	const { port } = server.address() as AddressInfo
	return { url: `http://127.0.0.1:${port}/wsl.3.0.1.0.x64.msi`, requests }
}

/** A server that honours `Range: bytes=N-` for `bytes`. */
function rangeHandler(bytes: Uint8Array) {
	return (request: IncomingMessage, response: ServerResponse) => {
		const range = /^bytes=(\d+)-$/.exec(request.headers.range ?? '')
		if (range?.[1] !== undefined) {
			const start = Number(range[1])
			response.writeHead(206, {
				'content-length': bytes.length - start,
				'content-range': `bytes ${start}-${bytes.length - 1}/${bytes.length}`,
			})
			response.end(bytes.subarray(start))
			return
		}
		response.writeHead(200, { 'content-length': bytes.length })
		response.end(bytes)
	}
}

describe('PINNED_WSL_PACKAGE', () => {
	it('names the 3.0.1.0 x64 MSI with the digest and size the release reports', () => {
		expect(PINNED_WSL_PACKAGE).toEqual({
			version: '3.0.1.0',
			architecture: 'x64',
			url: 'https://github.com/microsoft/WSL/releases/download/3.0.1/wsl.3.0.1.0.x64.msi',
			sha256: '28b1a0d013640a2ac95898ea705fa186e5b4ff767a1c1b49257161bc106599c6',
			sizeBytes: 367669248,
		})
	})
})

describe('downloadWslPackage against a local server', () => {
	it('downloads, verifies, renames and reports bytes', async () => {
		const { url } = await serve(rangeHandler(payload))
		const events: WslcSetupProgress[] = []
		const result = await downloadWslPackage({
			pinned: pinnedFor(url),
			directory: join(directory, 'nested', 'setup'),
			onProgress: (progress) => events.push(progress),
		})
		expect(result).toEqual({
			outcome: 'ok',
			path: join(directory, 'nested', 'setup', 'wsl.3.0.1.0.x64.msi'),
		})
		expect(sha(await readFile((result as { path: string }).path))).toBe(sha(payload))
		expect(existsSync(`${(result as { path: string }).path}.part`)).toBe(false)
		const done = events.map((event) => (event.phase === 'progress' ? event.done : -1))
		expect(done.length).toBeGreaterThan(1)
		expect([...done].sort((a, b) => a - b)).toEqual(done)
		expect(done.at(-1)).toBe(payload.length)
		expect(
			events.every((event) => event.step === 'download-wsl' && event.phase === 'progress'),
		).toBe(true)
	})

	it('resumes a partial file with a Range request', async () => {
		const { url, requests } = await serve(rangeHandler(payload))
		await writeFile(join(directory, 'wsl.3.0.1.0.x64.msi.part'), payload.subarray(0, 700_000))
		const events: WslcSetupProgress[] = []
		const result = await downloadWslPackage({
			pinned: pinnedFor(url),
			directory,
			onProgress: (progress) => events.push(progress),
		})
		expect(result.outcome).toBe('ok')
		expect(requests).toHaveLength(1)
		expect(requests[0]?.headers.range).toBe('bytes=700000-')
		expect(sha(await readFile(join(directory, 'wsl.3.0.1.0.x64.msi')))).toBe(sha(payload))
		const first = events[0]
		expect(first?.phase === 'progress' && first.done).toBeGreaterThanOrEqual(700_000)
	})

	it('discards a partial file longer than the package and asks for the whole file', async () => {
		const { url, requests } = await serve(rangeHandler(payload))
		await writeFile(
			join(directory, 'wsl.3.0.1.0.x64.msi.part'),
			Buffer.concat([payload, randomBytes(50)]),
		)
		const result = await downloadWslPackage({ pinned: pinnedFor(url), directory })
		expect(result.outcome).toBe('ok')
		expect(requests).toHaveLength(1)
		expect(requests[0]?.headers.range).toBeUndefined()
		expect(sha(await readFile(join(directory, 'wsl.3.0.1.0.x64.msi')))).toBe(sha(payload))
	})

	it('overwrites the partial file from a 200 answer, in the one request it made', async () => {
		const { url, requests } = await serve((_request, response) => {
			response.writeHead(200, { 'content-length': payload.length })
			response.end(payload)
		})
		await writeFile(join(directory, 'wsl.3.0.1.0.x64.msi.part'), payload.subarray(0, 300_000))
		const result = await downloadWslPackage({ pinned: pinnedFor(url), directory })
		expect(result.outcome).toBe('ok')
		// It asked to resume once, was answered with the whole file, and used it:
		// no second request was needed to start over.
		expect(requests).toHaveLength(1)
		expect(requests[0]?.headers.range).toBe('bytes=300000-')
		expect(sha(await readFile(join(directory, 'wsl.3.0.1.0.x64.msi')))).toBe(sha(payload))
	})

	it('deletes a file whose digest is wrong and says it is corrupt', async () => {
		const other = randomBytes(payload.length)
		const { url } = await serve(rangeHandler(other))
		const result = await downloadWslPackage({ pinned: pinnedFor(url, payload), directory })
		expect(result).toMatchObject({ outcome: 'failed', code: 'download-corrupt' })
		expect(await readdir(directory)).toEqual([])
	})

	it('deletes a longer file than expected and says it is corrupt', async () => {
		const longer = Buffer.concat([payload, randomBytes(10)])
		const { url } = await serve(rangeHandler(longer))
		const result = await downloadWslPackage({ pinned: pinnedFor(url, payload), directory })
		expect(result).toMatchObject({ outcome: 'failed', code: 'download-corrupt' })
		expect(await readdir(directory)).toEqual([])
	})

	it('does not fetch when a verified file is already there', async () => {
		const { url, requests } = await serve(rangeHandler(payload))
		await writeFile(join(directory, 'wsl.3.0.1.0.x64.msi'), payload)
		const result = await downloadWslPackage({ pinned: pinnedFor(url), directory })
		expect(result.outcome).toBe('ok')
		expect(requests).toEqual([])
	})

	it('replaces a finished file that no longer matches', async () => {
		const { url } = await serve(rangeHandler(payload))
		await writeFile(join(directory, 'wsl.3.0.1.0.x64.msi'), randomBytes(payload.length))
		const result = await downloadWslPackage({ pinned: pinnedFor(url), directory })
		expect(result.outcome).toBe('ok')
		expect(sha(await readFile(join(directory, 'wsl.3.0.1.0.x64.msi')))).toBe(sha(payload))
	})

	it('fails at once on a 404 without retrying', async () => {
		const { url, requests } = await serve((_request, response) => {
			response.writeHead(404)
			response.end()
		})
		const result = await downloadWslPackage({ pinned: pinnedFor(url), directory })
		expect(result).toMatchObject({ outcome: 'failed', code: 'download-failed' })
		expect(requests).toHaveLength(1)
	})
})

/** Wait, event by event and without a clock, until the code under test has set a timer. */
async function untilTimerExists(): Promise<void> {
	while (vi.getTimerCount() === 0) await new Promise((resolve) => setImmediate(resolve))
}

/** The delays of the backoff waits (the only timers over 100 ms this code sets). */
function waits(spy: { mock: { calls: unknown[][] } }): number[] {
	return spy.mock.calls
		.map((call) => call[1])
		.filter((delay): delay is number => typeof delay === 'number' && delay >= 1000)
}

function fakeFetch(answers: (number | Error | 'ok')[], bytes: Uint8Array = payload) {
	const calls: RequestInit['headers'][] = []
	const waiters: (() => void)[] = []
	const impl = (async (_url: string | URL | Request, init?: RequestInit) => {
		calls.push(init?.headers)
		for (const waiter of waiters.splice(0)) waiter()
		const answer = answers[Math.min(calls.length - 1, answers.length - 1)]
		if (answer instanceof Error) throw answer
		if (answer === 'ok') return new Response(bytes, { status: 200 })
		return new Response(null, { status: answer })
	}) as typeof fetch
	return {
		impl,
		calls,
		/** Resolves once the stub has been called `count` times. */
		async called(count: number) {
			while (calls.length < count) await new Promise<void>((resolve) => waiters.push(resolve))
		},
	}
}

describe('downloadWslPackage retries', () => {
	it('starts over when the server rejects the resume range', async () => {
		await writeFile(join(directory, 'wsl.3.0.1.0.x64.msi.part'), payload.subarray(0, 1000))
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
		const stub = fakeFetch([416, 'ok'])
		const pending = downloadWslPackage({
			pinned: pinnedFor('https://example.invalid/wsl.3.0.1.0.x64.msi'),
			directory,
			fetch: stub.impl,
		})
		await stub.called(1)
		await untilTimerExists()
		await vi.advanceTimersByTimeAsync(1000)
		expect((await pending).outcome).toBe('ok')
		expect(stub.calls).toEqual([{ Range: 'bytes=1000-' }, {}])
	})

	it('backs off 1 s, 2 s, 4 s and then succeeds', async () => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
		const spy = vi.spyOn(globalThis, 'setTimeout')
		const stub = fakeFetch([503, new Error('connection reset'), 429, 'ok'])
		const pending = downloadWslPackage({
			pinned: pinnedFor('https://example.invalid/wsl.3.0.1.0.x64.msi'),
			directory,
			fetch: stub.impl,
		})
		await stub.called(1)
		for (const [delay, calls] of [
			[1000, 2],
			[2000, 3],
			[4000, 4],
		] as const) {
			await untilTimerExists()
			await vi.advanceTimersByTimeAsync(delay - 1)
			for (let i = 0; i < 20; i++) await Promise.resolve()
			expect(stub.calls).toHaveLength(calls - 1)
			await vi.advanceTimersByTimeAsync(1)
			await stub.called(calls)
		}
		expect((await pending).outcome).toBe('ok')
		expect(waits(spy)).toEqual([1000, 2000, 4000])
	})

	it('gives up after five attempts with download-failed', async () => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
		const spy = vi.spyOn(globalThis, 'setTimeout')
		const stub = fakeFetch([new Error('offline')])
		const pending = downloadWslPackage({
			pinned: pinnedFor('https://example.invalid/wsl.3.0.1.0.x64.msi'),
			directory,
			fetch: stub.impl,
		})
		for (const [delay, calls] of [
			[1000, 2],
			[2000, 3],
			[4000, 4],
			[8000, 5],
		] as const) {
			await stub.called(calls - 1)
			await untilTimerExists()
			await vi.advanceTimersByTimeAsync(delay)
			await stub.called(calls)
		}
		const result = await pending
		expect(result).toMatchObject({ outcome: 'failed', code: 'download-failed' })
		expect(stub.calls).toHaveLength(5)
		expect(waits(spy)).toEqual([1000, 2000, 4000, 8000])
	})

	it('starts over when a 206 answers for another offset', async () => {
		await writeFile(join(directory, 'wsl.3.0.1.0.x64.msi.part'), payload.subarray(0, 1000))
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
		const calls: RequestInit['headers'][] = []
		const waiters: (() => void)[] = []
		const impl = (async (_url: string | URL | Request, init?: RequestInit) => {
			calls.push(init?.headers)
			for (const waiter of waiters.splice(0)) waiter()
			if (calls.length === 1) {
				return new Response(payload.subarray(0, payload.length - 1000), {
					status: 206,
					headers: { 'content-range': `bytes 0-${payload.length - 1001}/${payload.length}` },
				})
			}
			return new Response(payload, { status: 200 })
		}) as typeof fetch
		const pending = downloadWslPackage({
			pinned: pinnedFor('https://example.invalid/wsl.3.0.1.0.x64.msi'),
			directory,
			fetch: impl,
		})
		while (calls.length < 1) await new Promise<void>((resolve) => waiters.push(resolve))
		await untilTimerExists()
		await vi.advanceTimersByTimeAsync(1000)
		expect((await pending).outcome).toBe('ok')
		expect(calls).toEqual([{ Range: 'bytes=1000-' }, {}])
	})

	it('stops waiting when the signal aborts during a backoff', async () => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
		const stub = fakeFetch([503])
		const controller = new AbortController()
		const pending = downloadWslPackage({
			pinned: pinnedFor('https://example.invalid/wsl.3.0.1.0.x64.msi'),
			directory,
			fetch: stub.impl,
			signal: controller.signal,
		})
		const settled = pending.then(
			() => 'resolved',
			(error: unknown) => error,
		)
		await stub.called(1)
		await untilTimerExists()
		controller.abort(new Error('stopped'))
		expect(await settled).toEqual(new Error('stopped'))
		expect(stub.calls).toHaveLength(1)
	})

	it('rejects with the signal reason when aborted while hashing an existing file', async () => {
		const url = 'https://example.invalid/wsl.3.0.1.0.x64.msi'
		await mkdir(directory, { recursive: true })
		await writeFile(join(directory, 'wsl.3.0.1.0.x64.msi'), payload)
		const controller = new AbortController()
		const stub = fakeFetch([200])
		const pending = downloadWslPackage({
			pinned: pinnedFor(url),
			directory,
			fetch: stub.impl,
			signal: controller.signal,
		})
		// The abort lands synchronously after the call started: the first awaited step is the size check.
		controller.abort(new Error('stopped'))
		await expect(pending).rejects.toEqual(new Error('stopped'))
		expect(stub.calls).toHaveLength(0)
	})

	it('keeps the partial file when it is interrupted', async () => {
		await mkdir(directory, { recursive: true })
		const controller = new AbortController()
		controller.abort(new Error('stopped'))
		await writeFile(join(directory, 'wsl.3.0.1.0.x64.msi.part'), payload.subarray(0, 10))
		await expect(
			downloadWslPackage({
				pinned: pinnedFor('https://example.invalid/wsl.3.0.1.0.x64.msi'),
				directory,
				fetch: fakeFetch([503]).impl,
				signal: controller.signal,
			}),
		).rejects.toThrow('stopped')
		expect(existsSync(join(directory, 'wsl.3.0.1.0.x64.msi.part'))).toBe(true)
	})

	it('refuses a package address without a usable file name', async () => {
		const result = await downloadWslPackage({
			pinned: { ...pinnedFor('https://example.invalid/'), url: 'https://example.invalid/' },
			directory,
			fetch: fakeFetch([200]).impl,
		})
		expect(result).toMatchObject({ outcome: 'failed', code: 'download-failed' })
	})
})
