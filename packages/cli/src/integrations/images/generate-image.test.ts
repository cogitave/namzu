import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { type Server, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'
import type { Message, ToolContext } from '@namzu/sdk'
import { afterEach, describe, expect, it } from 'vitest'
import {
	GENERATE_IMAGE_TOOL_NAME,
	createGenerateImageTool,
	generatedImagesDirectory,
	sanitizeSegment,
} from './generate-image.js'

const CRC = (() => {
	const table: number[] = []
	for (let n = 0; n < 256; n += 1) {
		let c = n
		for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
		table.push(c >>> 0)
	}
	return table
})()
function crc32(buffer: Buffer): number {
	let c = 0xffffffff
	for (const byte of buffer) c = (CRC[(c ^ byte) & 0xff] as number) ^ (c >>> 8)
	return (c ^ 0xffffffff) >>> 0
}
function chunk(type: string, data: Buffer): Buffer {
	const length = Buffer.alloc(4)
	length.writeUInt32BE(data.length)
	const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
	const crc = Buffer.alloc(4)
	crc.writeUInt32BE(crc32(body))
	return Buffer.concat([length, body, crc])
}
/** A real, decodable 4x4 RGB PNG. */
function png(): Buffer {
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
const servers: Server[] = []
afterEach(async () => {
	await Promise.all(servers.splice(0).map((s) => new Promise((resolve) => s.close(resolve))))
	for (const path of roots.splice(0)) await rm(path, { recursive: true, force: true })
})
async function scratch(): Promise<string> {
	const path = await mkdtemp(join(tmpdir(), 'namzu-imagegen-'))
	roots.push(path)
	return path
}

interface Sent {
	url: string
	body: Record<string, unknown>
}
async function fakeImages(
	respond: (n: number) => {
		status: number
		headers?: Record<string, string>
		body: unknown
	} = () => ({
		status: 200,
		body: { data: [{ b64_json: png().toString('base64') }] },
	}),
): Promise<{ base: string; sent: Sent[] }> {
	const sent: Sent[] = []
	const server = createServer((request, response) => {
		const chunks: Buffer[] = []
		request.on('data', (c: Buffer) => chunks.push(c))
		request.on('end', () => {
			sent.push({
				url: request.url ?? '',
				body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
			})
			const answer = respond(sent.length)
			response.writeHead(answer.status, {
				'content-type': 'application/json',
				...(answer.headers ?? {}),
			})
			response.end(JSON.stringify(answer.body))
		})
	})
	servers.push(server)
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
	return {
		base: `http://127.0.0.1:${(server.address() as AddressInfo).port}/backend-api/codex`,
		sent,
	}
}

function context(cwd: string, extras: Partial<ToolContext> = {}): ToolContext {
	return {
		sessionId: 'sess/1' as ToolContext['sessionId'],
		turnId: 'turn-1' as ToolContext['turnId'],
		toolUseId: 'call:1',
		workingDirectory: cwd,
		abortSignal: new AbortController().signal,
		env: {},
		log: () => {},
		...extras,
	}
}

async function setup(
	options: { base?: string; reads?: boolean; signedIn?: boolean } = {},
): Promise<{ home: string; cwd: string; tool: ReturnType<typeof createGenerateImageTool> }> {
	const home = await scratch()
	const cwd = await scratch()
	const tool = createGenerateImageTool({
		home,
		access: async () =>
			options.signedIn === false
				? undefined
				: {
						accessToken: 'tok',
						accountId: 'acct',
						...(options.base ? { baseURL: options.base } : {}),
					},
		readsImages: () => options.reads === true,
	})
	return { home, cwd, tool }
}

describe('generate_image', () => {
	it('is named like the other tools and says the request goes to OpenAI under the plan', async () => {
		const { tool } = await setup()
		expect(tool.name).toBe(GENERATE_IMAGE_TOOL_NAME)
		expect(tool.description).toMatch(/subscription plan even when another model leads/)
		expect(tool.description).not.toMatch(/codex/i)
		expect(tool.permissions).toEqual(['network_access'])
		// Like web_search: a network call that changes nothing in the project.
		expect(tool.isReadOnly?.({ prompt: 'x' })).toBe(true)
	})

	it('generates: saves under <home>/generated_images/<session>/<call>.png, tells the model, keeps base64 out of the result', async () => {
		const { base, sent } = await fakeImages()
		const { home, cwd, tool } = await setup({ base })
		const result = await tool.execute({ prompt: 'a red fox\non a hill' }, context(cwd))
		expect(result.success).toBe(true)
		expect(sent[0]?.url).toBe('/backend-api/codex/images/generations')
		const file = join(generatedImagesDirectory(home, 'sess/1'), 'call_1.png')
		expect(generatedImagesDirectory(home, 'sess/1')).toBe(join(home, 'generated_images', 'sess_1'))
		expect((await readFile(file)).equals(png())).toBe(true)
		expect(result.output).toContain(`Saved to: ${file}`)
		expect(result.output).toContain('Prompt: a red fox on a hill')
		expect(result.output).toMatch(/copy it and leave the original/)
		expect(result.output).toMatch(/already displayed/)
		// A text-only model gets text only, and no result ever holds the image's base64.
		expect(result.content).toBeUndefined()
		expect(JSON.stringify(result)).not.toContain(png().toString('base64'))
		expect(result.facts).toMatchObject({
			kind: 'shared',
			generatedImage: { prompt: 'a red fox on a hill' },
		})
		expect(result.data).toMatchObject({
			kind: 'generated_image',
			path: file,
			prompt: 'a red fox on a hill',
		})
	})

	it('gives pixels to a model that reads images, fitted, with the same text', async () => {
		const { base } = await fakeImages()
		const { cwd, tool } = await setup({ base, reads: true })
		const result = await tool.execute({ prompt: 'a fox' }, context(cwd))
		expect(Array.isArray(result.content)).toBe(true)
		const blocks = result.content as readonly { type: string; text?: string }[]
		expect(blocks.map((b) => b.type)).toEqual(['text', 'image'])
		expect(blocks[0]?.text).toBe(result.output)
		// The persisted facts and data name the file; only `content` carries the fitted copy.
		expect(JSON.stringify(result.data)).not.toMatch(/base64/)
	})

	it('edits with referenced paths read under the file tools rules, as data URLs', async () => {
		const { base, sent } = await fakeImages()
		const { cwd, tool } = await setup({ base })
		await writeFile(join(cwd, 'in.png'), png())
		const result = await tool.execute(
			{ prompt: 'add a hat', referenced_image_paths: ['in.png'], transparent_background: true },
			context(cwd),
		)
		expect(result.success).toBe(true)
		expect(sent[0]?.url).toBe('/backend-api/codex/images/edits')
		expect(sent[0]?.body.background).toBe('transparent')
		const images = sent[0]?.body.images as { image_url: string }[]
		expect(images[0]?.image_url).toBe(`data:image/png;base64,${png().toString('base64')}`)
	})

	it('refuses a reference outside the roots, a missing one and a non-image, without a request', async () => {
		const { base, sent } = await fakeImages()
		const { cwd, tool } = await setup({ base })
		await writeFile(join(cwd, 'notes.txt'), 'hello')
		for (const path of ['/etc/hostname', 'missing.png', 'notes.txt']) {
			const result = await tool.execute(
				{ prompt: 'x', referenced_image_paths: [path] },
				context(cwd),
			)
			expect(result.success).toBe(false)
			expect(result.output).toMatch(
				/^image generation failed: unable to (read|process) referenced image/,
			)
		}
		expect(sent).toHaveLength(0)
	})

	it('refuses both selectors together and more than five paths', async () => {
		const { base, sent } = await fakeImages()
		const { cwd, tool } = await setup({ base })
		const both = await tool.execute(
			{ prompt: 'x', referenced_image_paths: ['a.png'], num_last_images_to_include: 1 },
			context(cwd),
		)
		expect(both.output).toContain(
			'provide only one of referenced_image_paths or num_last_images_to_include',
		)
		const many = await tool.execute(
			{ prompt: 'x', referenced_image_paths: ['1', '2', '3', '4', '5', '6'] },
			context(cwd),
		)
		expect(many.output).toContain('at most 5 paths')
		const range = await tool.execute({ prompt: 'x', num_last_images_to_include: 9 }, context(cwd))
		expect(range.output).toContain('between 1 and 5')
		expect(sent).toHaveLength(0)
	})

	it('takes the last conversation images, newest first, and fails when fewer exist', async () => {
		const { base, sent } = await fakeImages()
		const { cwd, tool } = await setup({ base })
		const messages: Message[] = [
			{
				role: 'user',
				content: 'look',
				attachments: [{ data: 'AAAA', mediaType: 'image/png' }],
			} as Message,
			{
				role: 'tool',
				toolCallId: 't',
				content: [{ type: 'image', data: 'BBBB', mediaType: 'image/png' }],
			} as Message,
		]
		const ctx = context(cwd, {
			conversation: { messages: () => messages, systemPrompt: () => undefined },
		})
		const result = await tool.execute({ prompt: 'x', num_last_images_to_include: 2 }, ctx)
		expect(result.success).toBe(true)
		expect((sent[0]?.body.images as { image_url: string }[]).map((i) => i.image_url)).toEqual([
			'data:image/png;base64,BBBB',
			'data:image/png;base64,AAAA',
		])
		const short = await tool.execute({ prompt: 'x', num_last_images_to_include: 3 }, ctx)
		expect(short.output).toContain('only 2 were available')
	})

	it('says when the image quota comes back', async () => {
		const resetsAt = Math.floor(Date.now() / 1000) + 3600
		const { base } = await fakeImages(() => ({
			status: 429,
			headers: { 'x-codex-active-limit': 'imagegen_premium' },
			body: { error: { type: 'usage_limit_reached', resets_at: resetsAt } },
		}))
		const { cwd, tool } = await setup({ base })
		const result = await tool.execute({ prompt: 'x' }, context(cwd))
		expect(result.success).toBe(false)
		expect(result.output).toMatch(/image quota .* used up\. It resets /)
		expect(result.data).toMatchObject({
			status: 'failed',
			usageLimit: { limitId: 'imagegen_premium', resetsAt: resetsAt * 1000 },
		})
	})

	it('fails plainly when no plan sign-in is connected', async () => {
		const { cwd, tool } = await setup({ signedIn: false })
		const result = await tool.execute({ prompt: 'x' }, context(cwd))
		expect(result.success).toBe(false)
		expect(result.output).toMatch(/no plan sign-in is connected/)
	})

	it('stops with the turn', async () => {
		let reached: () => void = () => {}
		const arrived = new Promise<void>((resolve) => {
			reached = resolve
		})
		const server = createServer(() => reached())
		servers.push(server)
		await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
		const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/backend-api/codex`
		const { cwd, tool } = await setup({ base })
		const controller = new AbortController()
		const pending = tool.execute({ prompt: 'x' }, context(cwd, { abortSignal: controller.signal }))
		await arrived
		controller.abort(new Error('turn stopped'))
		const stopped = await pending
		expect(stopped.success).toBe(false)
		expect(stopped.error).toContain('turn stopped')
	})

	it('never overwrites an image: a second call under the same id leaves the first', async () => {
		const { base } = await fakeImages()
		const { home, cwd, tool } = await setup({ base })
		const first = await tool.execute({ prompt: 'one' }, context(cwd))
		expect(first.success).toBe(true)
		const again = await tool.execute({ prompt: 'two' }, context(cwd))
		expect(again.success).toBe(false)
		expect(again.output).toMatch(/already exists; the earlier image was left as it was/)
		expect(await readdir(generatedImagesDirectory(home, 'sess/1'))).toEqual(['call_1.png'])
	})

	it('refuses a session folder that is a link', async () => {
		const { base } = await fakeImages()
		const { home, cwd, tool } = await setup({ base })
		const elsewhere = await scratch()
		await mkdir(join(home, 'generated_images'), { recursive: true })
		await symlink(elsewhere, generatedImagesDirectory(home, 'sess/1'))
		const result = await tool.execute({ prompt: 'x' }, context(cwd))
		expect(result.success).toBe(false)
		expect(result.output).toMatch(/is a link or not a folder/)
		expect(await readdir(elsewhere)).toEqual([])
	})

	it('sanitizes ids to letters, digits, underscore and dash', () => {
		expect(sanitizeSegment('../../etc/x y')).toBe('______etc_x_y')
		expect(sanitizeSegment('')).toBe('_')
	})
})
