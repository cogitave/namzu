/**
 * The kernel's outcome record for a turn that only searched for and called `generate_image`.
 * The tool is the real one, mounted the way a session mounts it (a toolset that is ready while
 * the plan sign-in is connected, deferred behind `search_tools`), driven through the real
 * `query` loop with a scripted model. A picture is written only into Namzu's own folder, so the
 * turn changed nothing in the workspace and must not read as "a command ran that may have
 * changed files".
 */

import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'
import {
	MockLLMProvider,
	type QueryParams,
	deferred,
	drainQuery,
	generateProjectId,
	generateSessionId,
	generateTenantId,
	generateTopicId,
	readyWhen,
	toolset,
} from '@namzu/sdk'
import { afterEach, describe, expect, it } from 'vitest'
import { createGenerateImageTool } from './generate-image.js'

function png(): Buffer {
	const table: number[] = []
	for (let n = 0; n < 256; n += 1) {
		let c = n
		for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
		table.push(c >>> 0)
	}
	const chunk = (type: string, data: Buffer): Buffer => {
		const length = Buffer.alloc(4)
		length.writeUInt32BE(data.length)
		const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
		let c = 0xffffffff
		for (const byte of body) c = (table[(c ^ byte) & 0xff] as number) ^ (c >>> 8)
		const crc = Buffer.alloc(4)
		crc.writeUInt32BE((c ^ 0xffffffff) >>> 0)
		return Buffer.concat([length, body, crc])
	}
	const header = Buffer.alloc(13)
	header.writeUInt32BE(4, 0)
	header.writeUInt32BE(4, 4)
	header[8] = 8
	header[9] = 2
	const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(12, 120)])
	return Buffer.concat([
		Buffer.from('89504e470d0a1a0a', 'hex'),
		chunk('IHDR', header),
		chunk('IDAT', deflateSync(Buffer.concat([row, row, row, row]))),
		chunk('IEND', Buffer.alloc(0)),
	])
}

const roots: string[] = []
const closers: Array<() => Promise<void>> = []
afterEach(async () => {
	for (const close of closers.splice(0)) await close()
	for (const path of roots.splice(0)) await rm(path, { recursive: true, force: true })
})

async function turnThatGeneratesAnImage(options: { signOutAfterTheCall?: boolean } = {}) {
	const home = await mkdtemp(join(tmpdir(), 'namzu-imagegen-home-'))
	const workingDirectory = await mkdtemp(join(tmpdir(), 'namzu-imagegen-work-'))
	roots.push(home, workingDirectory)
	const server = createServer((request, response) => {
		request.on('data', () => {})
		request.on('end', () => {
			response.writeHead(200, { 'content-type': 'application/json' })
			response.end(JSON.stringify({ data: [{ b64_json: png().toString('base64') }] }))
		})
	})
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
	closers.push(() => new Promise((resolve) => server.close(() => resolve())))
	const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/backend-api/codex`
	let signedIn = true
	const tool = createGenerateImageTool({
		home,
		access: async () => {
			// The sign-in is read once, as the call starts; from here on the offer is withdrawn.
			if (options.signOutAfterTheCall)
				queueMicrotask(() => {
					signedIn = false
				})
			return { accessToken: 'tok', accountId: 'acct', baseURL: base }
		},
		readsImages: () => false,
	})
	const mounted = deferred(readyWhen(toolset('image-generation', [tool]), () => signedIn))
	const turn = await drainQuery(
		{
			provider: new MockLLMProvider({
				turns: [
					{
						toolCalls: [{ name: 'search_tools', args: { query: 'generate_image' } }],
					},
					{
						toolCalls: [{ name: 'generate_image', args: { prompt: 'a red fox' } }],
					},
					{ text: 'Here is your fox.' },
				],
			}),
			toolsets: [mounted],
			turnConfig: {
				model: 'mock-model',
				timeoutMs: 30_000,
				tokenBudget: 100_000,
				maxIterations: 8,
				maxResponseTokens: 256,
			},
			agentId: 'agent_image',
			agentName: 'Image',
			messages: [{ role: 'user', content: 'draw me a red fox' }],
			workingDirectory,
			sessionId: generateSessionId(),
			topicId: generateTopicId(),
			projectId: generateProjectId(),
			tenantId: generateTenantId(),
			retry: false,
		} as unknown as QueryParams,
		() => {},
	)
	// The call really ran and saved its picture in Namzu's own folder.
	const saved = await readdir(join(home, 'generated_images'), {
		recursive: true,
	})
	expect(saved.some((name) => name.endsWith('.png'))).toBe(true)
	return turn
}

describe('a turn that generated an image', () => {
	it('changed nothing in the workspace, so the record is not "cannot tell"', async () => {
		const turn = await turnThatGeneratesAnImage()
		expect(turn.outcome).toMatchObject({
			verdict: 'unchanged',
			changes: { total: 0, paths: [] },
		})
	})

	it('still changed nothing when the plan sign-in goes away right after the call', async () => {
		const turn = await turnThatGeneratesAnImage({ signOutAfterTheCall: true })
		expect(turn.outcome?.verdict).toBe('unchanged')
	})
})
