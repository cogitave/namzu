import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { DownloadError, downloadVerifiedTarball, parseSha512 } from './download.js'

let dir: string
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'namzu-download-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const REGISTRY = 'https://registry.example.test'
const URL_OK = `${REGISTRY}/@namzu/cli/-/cli-2.0.0.tgz`
const body = Buffer.from('the release bytes')
const digest = (bytes: Buffer) => `sha512-${createHash('sha512').update(bytes).digest('base64')}`

const answer =
	(response: () => Response): typeof fetch =>
	async () =>
		response()

function options(over: Partial<Parameters<typeof downloadVerifiedTarball>[0]> = {}) {
	return {
		url: URL_OK,
		integrity: digest(body),
		registry: REGISTRY,
		destination: join(dir, 'download', 'cli.tgz'),
		fetch: answer(() => new Response(body)),
		...over,
	}
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
	try {
		await promise
	} catch (error) {
		if (error instanceof DownloadError) return error.code
		throw error
	}
	return 'none'
}

describe('downloading the release tarball', () => {
	it('keeps the file when its sha512 is the registry’s digest', async () => {
		const o = options()
		await downloadVerifiedTarball(o)
		expect(readFileSync(o.destination)).toEqual(body)
		expect(readdirSync(join(dir, 'download'))).toEqual(['cli.tgz'])
	})

	it('leaves nothing behind when the bytes are not the ones the registry vouched for', async () => {
		const o = options({ fetch: answer(() => new Response('other bytes')) })
		expect(await codeOf(downloadVerifiedTarball(o))).toBe('integrity')
		expect(existsSync(o.destination)).toBe(false)
		expect(readdirSync(join(dir, 'download'))).toEqual([])
	})

	it('refuses an address that is not on the registry’s own origin without asking for it', async () => {
		let asked = false
		const o = options({
			url: 'https://mirror.example.test/cli-2.0.0.tgz',
			fetch: async () => {
				asked = true
				return new Response(body)
			},
		})
		expect(await codeOf(downloadVerifiedTarball(o))).toBe('unverifiable')
		expect(asked).toBe(false)
	})

	it('refuses a digest that is not a sha512', async () => {
		expect(await codeOf(downloadVerifiedTarball(options({ integrity: 'sha1-abc=' })))).toBe(
			'unverifiable',
		)
		expect(parseSha512('sha512-AAAA')).toBeNull()
		expect(parseSha512(digest(body))).toHaveLength(64)
	})

	it('reports a registry that answers with an error as a network failure', async () => {
		const o = options({ fetch: answer(() => new Response('nope', { status: 503 })) })
		expect(await codeOf(downloadVerifiedTarball(o))).toBe('network')
		expect(existsSync(o.destination)).toBe(false)
	})

	it('reports a connection that fails as a network failure', async () => {
		const o = options({
			fetch: async () => {
				throw new TypeError('fetch failed')
			},
		})
		expect(await codeOf(downloadVerifiedTarball(o))).toBe('network')
	})

	it('stops a download bigger than the limit and keeps nothing', async () => {
		const o = options({ maxBytes: 4 })
		expect(await codeOf(downloadVerifiedTarball(o))).toBe('network')
		expect(readdirSync(join(dir, 'download'))).toEqual([])
	})

	it('gives up on a download that stops arriving when its time is up', async () => {
		vi.useFakeTimers()
		try {
			const o = options({
				timeoutMs: 5_000,
				fetch: async (_url, init) => {
					const signal = init?.signal
					return new Response(
						new ReadableStream<Uint8Array>({
							start(controller) {
								signal?.addEventListener('abort', () => controller.error(signal.reason))
							},
						}),
					)
				},
			})
			const outcome = codeOf(downloadVerifiedTarball(o))
			await vi.advanceTimersByTimeAsync(5_000)
			expect(await outcome).toBe('network')
			expect(existsSync(o.destination)).toBe(false)
		} finally {
			vi.useRealTimers()
		}
	})
})
