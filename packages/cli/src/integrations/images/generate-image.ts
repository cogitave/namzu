import { constants } from 'node:fs'
import { lstat, mkdir, open, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import {
	CODEX_IMAGE_LIMIT_IDS,
	CODEX_IMAGE_MAX_BYTES,
	CodexImagesError,
	requestCodexImage,
} from '@namzu/openai'
import {
	type ToolContext,
	type ToolDefinition,
	type ToolFacts,
	type ToolResult,
	defineTool,
	inspectImageBytes,
	mcpJsonSchemaToZod,
	resolveWithinAnyReal,
	toolRoots,
} from '@namzu/sdk'

/** Reference images: how many one call may carry. */
export const MAX_REFERENCED_IMAGES = 5
/** One reference image may be this large before it is encoded. */
const MAX_REFERENCE_BYTES = 20 * 1024 * 1024
export const GENERATED_IMAGES_DIRECTORY = 'generated_images'
export const GENERATE_IMAGE_TOOL_NAME = 'generate_image'

const inputSchema = {
	type: 'object' as const,
	properties: {
		prompt: {
			type: 'string',
			minLength: 1,
			description: 'What the image should show, or how to change the images given.',
		},
		transparent_background: {
			type: 'boolean',
			description: 'Ask for a transparent background. Default false.',
		},
		referenced_image_paths: {
			type: 'array',
			items: { type: 'string', minLength: 1 },
			maxItems: MAX_REFERENCED_IMAGES,
			description:
				'Paths of up to 5 existing images to edit or use as references. Omit when making a new image.',
		},
		num_last_images_to_include: {
			type: 'integer',
			minimum: 1,
			maximum: MAX_REFERENCED_IMAGES,
			description:
				'Use the last N images of this conversation (1 to 5) as the images to edit. Never together with referenced_image_paths.',
		},
	},
	required: ['prompt'],
	additionalProperties: false,
}

export interface GenerateImageInput {
	readonly prompt: string
	readonly transparent_background?: boolean
	readonly referenced_image_paths?: readonly string[]
	readonly num_last_images_to_include?: number
}

/** What the subscription plan sign-in gives the tool at call time. */
export interface ImageGenerationAccess {
	readonly accessToken: string
	readonly accountId: string
	readonly baseURL?: string
}

export interface GenerateImageToolOptions {
	/** The sign-in to use, renewed when due; `undefined` when there is none. */
	readonly access: (signal: AbortSignal) => Promise<ImageGenerationAccess | undefined>
	/** The Namzu home: images go under `<home>/generated_images/<session>/`. */
	readonly home: string
	/** Whether the model leading the conversation reads images. Read per call. */
	readonly readsImages: () => boolean
	readonly fetch?: typeof fetch
	/** Timeout of one request in milliseconds. */
	readonly timeoutMs?: number
	readonly now?: () => number
}

/** Letters, digits, `_` and `-` only: the id names a file and cannot climb out of its folder. */
export function sanitizeSegment(value: string): string {
	const clean = value.replace(/[^A-Za-z0-9_-]/g, '_')
	return clean.length > 0 ? clean : '_'
}

/** The folder one session's generated images live in. */
export function generatedImagesDirectory(home: string, sessionId: string): string {
	return join(home, GENERATED_IMAGES_DIRECTORY, sanitizeSegment(sessionId))
}

/** What the tool offers when the plan route is unavailable; never an error for the model to read. */
const DESCRIPTION =
	'Create a new image from a description, or edit images with instructions. Use it when the person asks for a picture, illustration, logo, icon, mockup or edit of an existing image. ' +
	'Generation takes a few minutes. Omit referenced_image_paths and num_last_images_to_include for a brand new image; pass referenced_image_paths when every image to edit has a file path, or num_last_images_to_include for the latest images of this conversation, never both. ' +
	'Use view_image first to look at a file you plan to edit. Make the image without asking again unless required images must be attached again. ' +
	"The image is shown to the person and saved to a file; the result gives the path. The request goes to OpenAI under the person's subscription plan even when another model leads the conversation."

function sniffMediaType(bytes: Buffer): string | undefined {
	if (bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'image/png'
	if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg'
	if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP')
		return 'image/webp'
	return undefined
}

function dataUrl(bytes: Buffer, mediaType: string): string {
	return `data:${mediaType};base64,${bytes.toString('base64')}`
}

function oneLine(text: string, max = 300): string {
	const flat = text.replace(/\s+/g, ' ').trim()
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

class Refused extends Error {}

async function readReference(path: string, context: ToolContext): Promise<string> {
	context.abortSignal.throwIfAborted()
	let bytes: Buffer
	try {
		if (context.sandbox) {
			bytes = await context.sandbox.readFile(path, {
				offset: 0,
				length: MAX_REFERENCE_BYTES + 1,
				signal: context.abortSignal,
			})
		} else {
			const resolved = await resolveWithinAnyReal(toolRoots(context), path)
			if (context.readDenied?.(resolved)) throw new Error('reading this file is not allowed')
			const info = await stat(resolved)
			if (!info.isFile()) throw new Error('not a regular file')
			if (info.size > MAX_REFERENCE_BYTES) throw new Error('larger than 20 MiB')
			bytes = await readFile(resolved)
		}
	} catch (error) {
		context.abortSignal.throwIfAborted()
		throw new Refused(
			`unable to read referenced image at \`${path}\`: ${error instanceof Error ? error.message : String(error)}`,
		)
	}
	if (bytes.length > MAX_REFERENCE_BYTES)
		throw new Refused(`unable to read referenced image at \`${path}\`: larger than 20 MiB`)
	const mediaType = sniffMediaType(bytes)
	if (!mediaType)
		throw new Refused(
			`unable to process referenced image at \`${path}\`: not a PNG, JPEG or WebP image`,
		)
	return dataUrl(bytes, mediaType)
}

/** The newest images of the conversation, newest first, as `data:` URLs. */
function lastImages(context: ToolContext, count: number): string[] {
	const messages = context.conversation?.messages() ?? []
	const found: string[] = []
	for (let index = messages.length - 1; index >= 0 && found.length < count; index -= 1) {
		const message = messages[index]
		if (!message) continue
		const blocks: { data: string; mediaType: string }[] = []
		if (message.role === 'tool' && Array.isArray(message.content)) {
			for (const block of message.content)
				if (block.type === 'image') blocks.push({ data: block.data, mediaType: block.mediaType })
		}
		if (message.role === 'user' && Array.isArray(message.attachments)) {
			for (const item of message.attachments) {
				if (item.type === 'stored' || item.type === 'document') continue
				if ('data' in item && typeof item.data === 'string')
					blocks.push({ data: item.data, mediaType: item.mediaType })
			}
		}
		// Within one message the last block is the newest.
		for (const block of blocks.reverse()) {
			if (found.length >= count) break
			found.push(`data:${block.mediaType};base64,${block.data}`)
		}
	}
	return found
}

/**
 * Save the bytes under the session's folder. The folder is never a link, an
 * existing file is never replaced, and nothing larger than 32 MiB is kept.
 */
export async function saveGeneratedImage(
	home: string,
	sessionId: string,
	callId: string,
	bytes: Buffer,
	mediaType: 'image/png' | 'image/gif',
): Promise<string> {
	if (bytes.length > CODEX_IMAGE_MAX_BYTES) throw new Error('The image is larger than 32 MiB.')
	const root = join(home, GENERATED_IMAGES_DIRECTORY)
	const directory = generatedImagesDirectory(home, sessionId)
	await mkdir(root, { recursive: true, mode: 0o700 })
	for (const folder of [root]) {
		const info = await lstat(folder)
		if (info.isSymbolicLink() || !info.isDirectory())
			throw new Error(`${folder} is a link or not a folder, so no image was saved there.`)
	}
	await mkdir(directory, { recursive: true, mode: 0o700 })
	const info = await lstat(directory)
	if (info.isSymbolicLink() || !info.isDirectory())
		throw new Error(`${directory} is a link or not a folder, so no image was saved there.`)
	const file = join(
		directory,
		`${sanitizeSegment(callId)}.${mediaType === 'image/gif' ? 'gif' : 'png'}`,
	)
	let handle: Awaited<ReturnType<typeof open>>
	try {
		// `wx` fails on an existing name; NOFOLLOW refuses a link planted at the name.
		handle = await open(
			file,
			constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
			0o600,
		)
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'EEXIST')
			throw new Error(`${file} already exists; the earlier image was left as it was.`)
		throw error
	}
	try {
		await handle.writeFile(bytes)
	} finally {
		await handle.close()
	}
	return file
}

function resetText(resetsAt: number | undefined, now: number): string {
	if (resetsAt === undefined) return ''
	const date = new Date(resetsAt)
	if (Number.isNaN(date.getTime())) return ''
	if (resetsAt <= now) return ' It resets soon.'
	return ` It resets ${date.toLocaleString()}.`
}

function failure(
	reason: string,
	extra: { readonly usageLimit?: { readonly resetsAt?: number; readonly limitId?: string } } = {},
): ToolResult {
	const output = `image generation failed: ${reason}`
	return {
		success: false,
		output,
		error: output,
		data: { kind: 'generated_image', status: 'failed', reason, ...extra },
	}
}

/**
 * `generate_image`: make or edit an image on the person's subscription plan. The
 * tool is offered whenever that sign-in is connected, whatever model leads the
 * conversation. Its result holds the saved path and the prompt, never the
 * image's base64; a model that reads images also gets a fitted copy of the
 * pixels (the same size bound as `view_image`).
 */
export function createGenerateImageTool(options: GenerateImageToolOptions): ToolDefinition {
	const clock = options.now ?? Date.now
	return defineTool({
		name: GENERATE_IMAGE_TOOL_NAME,
		description: DESCRIPTION,
		inputSchema: mcpJsonSchemaToZod(inputSchema),
		category: 'network',
		permissions: ['network_access'],
		timeoutMs: 12 * 60 * 1000,
		// Asked about and moded like `web_search`: it sends a prompt out and changes nothing in the
		// project. The one file it makes is its own, in the Namzu home.
		readOnly: true,
		destructive: false,
		concurrencySafe: true,
		presentCall: (raw) => ({
			kind: 'generic',
			label: `Generate image: ${oneLine(String((raw as { prompt?: unknown }).prompt ?? ''), 80)}`,
			presentation: 'activity',
		}),
		async execute(raw, context): Promise<ToolResult> {
			const input = raw as unknown as GenerateImageInput
			const paths = input.referenced_image_paths ?? []
			const last = input.num_last_images_to_include
			if (paths.length > 0 && last !== undefined)
				return failure('provide only one of referenced_image_paths or num_last_images_to_include')
			if (paths.length > MAX_REFERENCED_IMAGES)
				return failure(
					`\`referenced_image_paths\` must contain at most ${MAX_REFERENCED_IMAGES} paths`,
				)
			if (last !== undefined && (last < 1 || last > MAX_REFERENCED_IMAGES))
				return failure(
					`\`num_last_images_to_include\` must be between 1 and ${MAX_REFERENCED_IMAGES}`,
				)
			let images: string[] = []
			try {
				if (paths.length > 0) {
					for (const path of paths) images.push(await readReference(path, context))
				} else if (last !== undefined) {
					images = lastImages(context, last)
					if (images.length < last)
						return failure(
							`requested the last ${last} conversation images, but only ${images.length} were available`,
						)
				}
			} catch (error) {
				if (error instanceof Refused) return failure(error.message)
				throw error
			}
			context.abortSignal.throwIfAborted()
			const access = await options.access(context.abortSignal)
			if (!access)
				return failure('no plan sign-in is connected. Sign in with the OpenAI subscription first.')
			let result: Awaited<ReturnType<typeof requestCodexImage>>
			try {
				result = await requestCodexImage(
					{
						accessToken: access.accessToken,
						accountId: access.accountId,
						...(access.baseURL ? { baseURL: access.baseURL } : {}),
						...(options.fetch ? { fetch: options.fetch } : {}),
						...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
					},
					{
						prompt: input.prompt,
						transparentBackground: input.transparent_background === true,
						...(images.length > 0 ? { images } : {}),
						turnId: String(context.turnId),
						signal: context.abortSignal,
					},
				)
			} catch (error) {
				context.abortSignal.throwIfAborted()
				if (error instanceof CodexImagesError) {
					const limit = error.usageLimit
					if (
						limit &&
						(limit.limitId === undefined || CODEX_IMAGE_LIMIT_IDS.includes(limit.limitId))
					) {
						return failure(`${error.message}${resetText(limit.resetsAt, clock())}`, {
							usageLimit: {
								...(limit.limitId ? { limitId: limit.limitId } : {}),
								...(limit.resetsAt !== undefined ? { resetsAt: limit.resetsAt } : {}),
							},
						})
					}
					return failure(error.message)
				}
				throw error
			}
			const prompt = oneLine(input.prompt)
			let saved: string
			try {
				saved = await saveGeneratedImage(
					options.home,
					String(context.sessionId),
					context.toolUseId ?? `${clock()}`,
					result.bytes,
					result.mediaType,
				)
			} catch (error) {
				return failure(
					`the image was made but could not be saved: ${error instanceof Error ? error.message : String(error)}`,
				)
			}
			const directory = generatedImagesDirectory(options.home, String(context.sessionId))
			const lines = [
				'Image generated and already shown to the person.',
				`Prompt: ${prompt}`,
				`Saved to: ${saved}`,
				`Generated images are saved to ${directory} as ${saved} by default.`,
				'If you need to use a generated image at another path, copy it and leave the original in place unless the person explicitly asks you to delete it.',
				'The generated image is already displayed to the person. There is no need to render it in the final response as a Markdown image or file link.',
			]
			const output = lines.join('\n')
			const facts: ToolFacts = {
				kind: 'shared',
				files: [{ path: saved, real: saved, bytes: result.bytes.length }],
				caption: prompt,
				generatedImage: { prompt },
			}
			const data = {
				kind: 'generated_image',
				status: 'completed',
				path: saved,
				prompt,
				mediaType: result.mediaType,
				bytes: result.bytes.length,
				transparentBackground: input.transparent_background === true,
				...(images.length > 0 ? { edited: images.length } : {}),
				...(paths.length > 0 ? { referencedImagePaths: paths } : {}),
			}
			// Pixels for a model that reads images; a GIF or a failed fit gives text only.
			if (options.readsImages() && result.mediaType === 'image/png') {
				try {
					const seen = await inspectImageBytes(
						{ path: saved, bytes: result.bytes, sandboxed: false },
						context.abortSignal,
					)
					const image = Array.isArray(seen.content)
						? seen.content.find((block) => block.type === 'image')
						: undefined
					if (image)
						return {
							success: true,
							output,
							facts,
							data,
							content: [{ type: 'text', text: output }, image],
						}
				} catch {
					// Text only: the file is saved and shown either way.
				}
			}
			return { success: true, output, facts, data }
		},
	})
}
