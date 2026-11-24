import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import {
	CODEX_IMAGE_MODEL,
	CodexImagesError,
	requestCodexImage,
	sniffImageType,
} from '../images.js'

interface Seen {
	method: string
	url: string
	headers: IncomingMessage['headers']
	body: Record<string, unknown>
}

const servers: Server[] = []
afterEach(async () => {
	await Promise.all(servers.splice(0).map((s) => new Promise((resolve) => s.close(resolve))))
})

async function serve(
	answer: (request: Seen, response: ServerResponse) => void,
): Promise<{ base: string; seen: Seen[] }> {
	const seen: Seen[] = []
	const server = createServer((request, response) => {
		const chunks: Buffer[] = []
		request.on('data', (chunk: Buffer) => chunks.push(chunk))
		request.on('end', () => {
			const item: Seen = {
				method: request.method ?? '',
				url: request.url ?? '',
				headers: request.headers,
				body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'),
			}
			seen.push(item)
			answer(item, response)
		})
	})
	servers.push(server)
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
	return {
		base: `http://127.0.0.1:${(server.address() as AddressInfo).port}/backend-api/codex`,
		seen,
	}
}

const PNG = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from('payload')])
const auth = { accessToken: 'tok', accountId: 'acct-1' }

function ok(response: ServerResponse, bytes: Buffer = PNG): void {
	response.writeHead(200, {
		'content-type': 'application/json',
		'x-codex-imagegen-request-id': 'r1',
	})
	response.end(JSON.stringify({ created: 1, data: [{ b64_json: bytes.toString('base64') }] }))
}

describe('requestCodexImage', () => {
	it('generates: posts the reference body to images/generations with the plan headers', async () => {
		const { base, seen } = await serve((_, response) => ok(response))
		const result = await requestCodexImage(
			{ ...auth, baseURL: base },
			{ prompt: 'a red fox', turnId: 'turn-9' },
		)
		expect(result.bytes.equals(PNG)).toBe(true)
		expect(result.mediaType).toBe('image/png')
		expect(result.requestId).toBe('r1')
		const [call] = seen
		expect(call?.method).toBe('POST')
		expect(call?.url).toBe('/backend-api/codex/images/generations')
		expect(call?.body).toEqual({
			prompt: 'a red fox',
			model: CODEX_IMAGE_MODEL,
			quality: 'auto',
			size: 'auto',
			background: 'opaque',
		})
		expect(call?.headers.authorization).toBe('Bearer tok')
		expect(call?.headers['chatgpt-account-id']).toBe('acct-1')
		expect(call?.headers.originator).toBe('Codex Namzu')
		expect(call?.headers['user-agent']).toBe('Codex Namzu/1.0')
		expect(call?.headers['x-codex-image-turn-id']).toBe('turn-9')
	})

	it('edits: posts images as data URLs to images/edits, with a transparent background on request', async () => {
		const { base, seen } = await serve((_, response) => ok(response))
		await requestCodexImage(
			{ ...auth, baseURL: base },
			{ prompt: 'add a hat', transparentBackground: true, images: ['data:image/png;base64,AAAA'] },
		)
		expect(seen[0]?.url).toBe('/backend-api/codex/images/edits')
		expect(seen[0]?.body.background).toBe('transparent')
		expect(seen[0]?.body.images).toEqual([{ image_url: 'data:image/png;base64,AAAA' }])
	})

	it('keeps a GIF as a GIF and anything else as a PNG', () => {
		expect(sniffImageType(Buffer.from('GIF89a....'))).toBe('image/gif')
		expect(sniffImageType(Buffer.from('GIF87a....'))).toBe('image/gif')
		expect(sniffImageType(PNG)).toBe('image/png')
	})

	it('reads a spent image quota with when it resets', async () => {
		const { base } = await serve((_, response) => {
			response.writeHead(429, {
				'content-type': 'application/json',
				'x-codex-active-limit': 'image_gen',
			})
			response.end(
				JSON.stringify({ error: { type: 'usage_limit_reached', resets_at: 1_900_000_000 } }),
			)
		})
		const error = await requestCodexImage({ ...auth, baseURL: base }, { prompt: 'x' }).catch(
			(e) => e,
		)
		expect(error).toBeInstanceOf(CodexImagesError)
		expect(error.usageLimit).toEqual({ limitId: 'image_gen', resetsAt: 1_900_000_000_000 })
	})

	it('reports other failures with the status and the service text', async () => {
		const { base } = await serve((_, response) => {
			response.writeHead(400, { 'content-type': 'application/json' })
			response.end(JSON.stringify({ error: { message: 'bad prompt' } }))
		})
		const error = await requestCodexImage({ ...auth, baseURL: base }, { prompt: 'x' }).catch(
			(e) => e,
		)
		expect(error.status).toBe(400)
		expect(error.message).toContain('bad prompt')
		expect(error.usageLimit).toBeUndefined()
	})

	it('refuses an empty answer', async () => {
		const { base } = await serve((_, response) => {
			response.writeHead(200, { 'content-type': 'application/json' })
			response.end(JSON.stringify({ data: [] }))
		})
		await expect(requestCodexImage({ ...auth, baseURL: base }, { prompt: 'x' })).rejects.toThrow(
			/no image data/,
		)
	})

	it('refuses an image over 32 MiB without keeping it', async () => {
		const { base } = await serve((_, response) => ok(response, Buffer.alloc(33 * 1024 * 1024, 1)))
		await expect(requestCodexImage({ ...auth, baseURL: base }, { prompt: 'x' })).rejects.toThrow(
			/32 MiB/,
		)
	})

	it('stops with the caller: an abort ends a request the server never answers', async () => {
		let arrived: () => void = () => {}
		const reached = new Promise<void>((resolve) => {
			arrived = resolve
		})
		const { base } = await serve(() => arrived())
		const controller = new AbortController()
		const pending = requestCodexImage(
			{ ...auth, baseURL: base },
			{ prompt: 'x', signal: controller.signal },
		)
		await reached
		controller.abort(new Error('stopped'))
		await expect(pending).rejects.toThrow('stopped')
	})
})
