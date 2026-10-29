import { stat } from 'node:fs/promises'
import { extname } from 'node:path'
import { z } from 'zod'
import type { ToolContext, ToolResult } from '../../types/tool/index.js'
import type { ToolFacts } from '../../types/tool/presentation.js'
import { defineTool } from '../defineTool.js'
import { resolveWithinAnyReal, toolRoots } from '../paths.js'
import { resolveRetainedOutput } from '../retained-output.js'
import { looksBinary } from '../text-window.js'
import { TEXT_MAX_INPUT_BYTES, readBoundedChunks, readBoundedFile } from './bounded-file-read.js'
import { fingerprintContent } from './content-fingerprint.js'
import {
	type MediaRead,
	NOTEBOOK_MAX_BYTES,
	PDF_MAX_BYTES,
	readNotebook,
	readPdfPages,
} from './read-media.js'
import { type RenderedRead, humanBytes, renderCappedRead } from './read-render.js'
import { MAX_BYTES as IMAGE_MAX_BYTES, inspectImageBytes } from './view-image.js'

const inputSchema = z.object({
	path: z.string().describe('Path to the file to read (absolute or relative)'),
	// A two-element ARRAY, not a `z.tuple`, and the distinction is the whole
	// reason this comment exists. Both members carry the identical constraint,
	// so the tuple bought nothing — and it rendered as the draft-07 tuple
	// `items: [a, b]`, which a wire that validates against JSON Schema 2020-12
	// refuses outright. It was the only tuple in the first-party tool surface,
	// and it took down every other tool in the same request with it. The
	// spelling below means the same thing to the model (`[10, 40]` either way)
	// and to the parser, and reads identically in both dialects. See
	// `registry/tool/portable.ts`.
	readRange: z
		.array(z.coerce.number().int().min(1))
		.length(2)
		.optional()
		.describe(
			'Optional 1-indexed inclusive line range, e.g. [10, 40]. When provided it takes precedence over offset/limit.',
		),
	offset: z.coerce
		.number()
		.int()
		.min(0)
		.optional()
		.describe('Starting line number (0-indexed). Defaults to 0 (beginning of file).'),
	limit: z.coerce.number().optional().describe('Maximum number of lines to read'),
	pages: z
		.string()
		.optional()
		.describe(
			'For a PDF: the pages to render as images, one page ("3") or one range ("1-5"), at most 20 pages per request. Required for a PDF of more than 10 pages.',
		),
	allow_large: z
		.boolean()
		.optional()
		.describe(
			'Raise the size and token caps for this one read. Set it only after a read was refused as too large and you genuinely need all of the file.',
		),
})

export const ReadFileTool = defineTool({
	name: 'read',
	description:
		'Reads a file and returns its contents with line numbers. Also reads images (PNG, JPEG, WebP), which come back as pictures; PDFs, whose pages come back as images (pass pages, for example "1-5", at most 20 pages per request; a PDF of more than 10 pages needs it); and Jupyter notebooks (.ipynb), which come back as cells with their outputs. Supports readRange ([start,end], 1-indexed inclusive) or offset/limit for large files. Without a window it returns the first 2000 lines and says so — pass offset/limit to continue. A file over 256 KiB is refused unless a window is named, and a result over about 25,000 tokens is cut to a first page that names the next call; pass allow_large only when you need all of it.',
	inputSchema,
	category: 'filesystem',
	// Declared so a path outside the turn's roots can be reviewed before the
	// call runs, rather than refused after. See `ToolDefinition.pathArgument`.
	pathArgument: 'path',
	permissions: ['file_read'],
	readOnly: true,
	destructive: false,
	concurrencySafe: true,
	// Bounded by the size and token caps in `renderCappedRead`, so the turn's
	// default per-result cap and the per-message budget leave it alone.
	selfLimitingOutput: true,

	presentCall(input) {
		if (typeof input.path !== 'string') return undefined
		return {
			kind: 'generic',
			label: `Read ${input.path}`,
			presentation: 'activity',
			activity: 'exploration',
			facts: { kind: 'read', path: input.path },
		}
	},

	async execute(input, context) {
		// This session's own retained tool output lives on the host, outside the
		// roots and outside any sandbox. It is read here, as a plain window of text,
		// because the result that named it told the model to.
		const retained = await resolveRetainedOutput(context.retainedOutputDirectory, input.path)
		// Sandbox-aware: route through sandbox.readFile() when available
		if (context.sandbox && retained === undefined) {
			const sandbox = context.sandbox
			const buffer = await readBoundedChunks(
				(offset, length) =>
					sandbox.readFile(input.path, { offset, length, signal: context.abortSignal }),
				PDF_MAX_BYTES,
				context.abortSignal,
				(prefix) => inputLimit(input.path, prefix),
			)
			const media = await readMediaFile(buffer, input.path, input, context, true)
			if (media) return media
			const binaryGuidance = describeStructuredBinaryRead(input.path)
			if (binaryGuidance) {
				return {
					success: false,
					output: binaryGuidance,
					data: {
						path: input.path,
						sandboxed: true,
						binary: true,
					},
					facts: {
						kind: 'read',
						path: input.path,
						binary: true,
						bytes: buffer.length,
					},
				}
			}
			const content = buffer.toString('utf-8')
			if (looksBinary(content)) return unreadableAsText(input.path, buffer.length, true)
			const capped = renderCappedRead(content, buffer.length, input, capOptions(input, context))
			if (!capped.ok) return refusedRead(input.path, buffer.length, capped.message, true)
			const rendered = capped.rendered
			const unchanged = unchangedRead(context, input.path, input, content, buffer.length)
			if (unchanged) return unchanged
			recordObservedRead(context, input.path, content, rendered, input)

			return {
				success: true,
				output: rendered.output,
				data: {
					totalLines: rendered.totalLines,
					returnedLines: rendered.returnedLines,
					truncated: rendered.partial,
					path: input.path,
					sandboxed: true,
				},
				facts: readFacts(input.path, buffer, content, rendered),
			}
		}

		const filePath = retained ?? (await resolveWithinAnyReal(toolRoots(context), input.path))
		// Pictures, PDFs and notebooks are not text: they have their own size
		// limits and are never numbered, so the text cap below does not apply.
		const namesMediaFile = namesMedia(filePath)
		// Refused on the size alone, before the file is in memory, when no window
		// was named: the cap exists so a huge file is never loaded to be refused.
		if (!namesMediaFile && input.readRange === undefined && input.limit === undefined) {
			const { size } = await stat(filePath)
			const early = renderCappedRead('', size, input, capOptions(input, context))
			if (!early.ok) return refusedRead(filePath, size, early.message, false)
		}
		const buffer = await readBoundedFile(filePath, PDF_MAX_BYTES, context.abortSignal, (prefix) =>
			inputLimit(filePath, prefix),
		)
		const media = await readMediaFile(buffer, filePath, input, context, false)
		if (media) return media
		const binaryGuidance = describeStructuredBinaryRead(filePath)
		if (binaryGuidance) {
			return {
				success: false,
				output: binaryGuidance,
				data: {
					path: filePath,
					binary: true,
				},
				facts: {
					kind: 'read',
					path: filePath,
					binary: true,
					bytes: buffer.length,
				},
			}
		}
		const content = buffer.toString('utf-8')
		if (looksBinary(content)) return unreadableAsText(filePath, buffer.length, false)
		const capped = renderCappedRead(content, buffer.length, input, capOptions(input, context))
		if (!capped.ok) return refusedRead(filePath, buffer.length, capped.message, false)
		const rendered = capped.rendered
		const unchanged =
			retained === undefined
				? unchangedRead(context, filePath, input, content, buffer.length)
				: undefined
		if (unchanged) return unchanged
		recordObservedRead(context, filePath, content, rendered, input)

		return {
			success: true,
			output: rendered.output,
			data: {
				totalLines: rendered.totalLines,
				returnedLines: rendered.returnedLines,
				truncated: rendered.partial,
				path: filePath,
			},
			facts: readFacts(filePath, buffer, content, rendered),
		}
	},
})

type MediaKind = 'image' | 'pdf' | 'notebook'

/**
 * What a file is by its bytes, never by its name: a text file called `.png` is
 * still text. A notebook is JSON, so only its extension can name it.
 */
function mediaKindOf(path: string, buffer: Buffer): MediaKind | undefined {
	if (buffer.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'image'
	if (buffer[0] === 0xff && buffer[1] === 0xd8) return 'image'
	if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP')
		return 'image'
	if (buffer.subarray(0, 4).toString('utf8') === '%PDF') return 'pdf'
	if (extname(path).toLowerCase() === '.ipynb') return 'notebook'
	return undefined
}

/** A name that suggests a file the text cap should not judge. */
function namesMedia(path: string): boolean {
	return ['.png', '.jpg', '.jpeg', '.webp', '.pdf', '.ipynb'].includes(extname(path).toLowerCase())
}

function inputLimit(path: string, prefix: Buffer): number {
	const kind = mediaKindOf(path, prefix)
	return kind ? mediaLimit(kind) : TEXT_MAX_INPUT_BYTES
}

function mediaLimit(kind: MediaKind): number {
	return kind === 'image' ? IMAGE_MAX_BYTES : kind === 'pdf' ? PDF_MAX_BYTES : NOTEBOOK_MAX_BYTES
}

function mediaFailure(path: string, bytes: number, message: string, sandboxed: boolean) {
	return {
		success: false as const,
		output: message,
		error: message,
		data: { path, ...(sandboxed ? { sandboxed: true } : {}) },
		facts: { kind: 'read' as const, path, bytes },
	}
}

function tooLargeMedia(path: string, bytes: number, kind: MediaKind) {
	const what = kind === 'image' ? 'Image' : kind === 'pdf' ? 'PDF' : 'Notebook'
	return mediaFailure(
		path,
		bytes,
		`${what} file (${humanBytes(bytes)}) exceeds the maximum size this tool can read (${humanBytes(mediaLimit(kind))}).`,
		false,
	)
}

/**
 * An image, a PDF or a notebook, as what the model can use: the picture itself,
 * the pages of the PDF as pictures, or the notebook's cells with their output.
 * Undefined for any other file, which is read as text.
 */
async function readMediaFile(
	buffer: Buffer,
	path: string,
	input: { readonly pages?: string | undefined },
	context: ToolContext,
	sandboxed: boolean,
): Promise<ToolResult | undefined> {
	const kind = mediaKindOf(path, buffer)
	if (!kind) return undefined
	if (buffer.length > mediaLimit(kind)) return tooLargeMedia(path, buffer.length, kind)
	if (kind === 'image') {
		try {
			const result = await inspectImageBytes(
				{ path, bytes: buffer, sandboxed },
				context.abortSignal,
			)
			return {
				...result,
				facts: { kind: 'read' as const, path, bytes: buffer.length },
			}
		} catch (error) {
			return mediaFailure(
				path,
				buffer.length,
				error instanceof Error ? error.message : String(error),
				sandboxed,
			)
		}
	}
	const media: MediaRead =
		kind === 'pdf'
			? await readPdfPages(buffer, input.pages, path, context.abortSignal)
			: readNotebook(buffer, path)
	if (!media.ok) return mediaFailure(path, buffer.length, media.message, sandboxed)
	const text = media.parts
		.filter((part) => part.type === 'text')
		.map((part) => part.text)
		.join('\n')
	const hasImage = media.parts.some((part) => part.type === 'image')
	return {
		success: true as const,
		output: text,
		...(hasImage
			? {
					content: media.parts.map((part) =>
						part.type === 'text'
							? { type: 'text' as const, text: part.text }
							: { type: 'image' as const, mediaType: part.mediaType, data: part.data },
					),
				}
			: {}),
		data: { path, ...(sandboxed ? { sandboxed: true } : {}), ...media.facts },
		facts: { kind: 'read' as const, path, bytes: buffer.length },
	}
}

function capOptions(
	input: { path: string; allow_large?: boolean | undefined },
	context: ToolContext,
): Parameters<typeof renderCappedRead>[3] {
	const tokens = Number(context.env?.NAMZU_FILE_READ_MAX_OUTPUT_TOKENS)
	return {
		path: input.path,
		ext: extname(input.path).toLowerCase(),
		...(input.allow_large === true ? { allowLarge: true } : {}),
		...(Number.isFinite(tokens) && tokens > 0 ? { caps: { maxTokens: tokens } } : {}),
	}
}

/**
 * A file whose bytes are not text. The model gets a short note with the size
 * and the next step, never the numbered garbage a decode would produce.
 */
function unreadableAsText(path: string, bytes: number, sandboxed: boolean) {
	return {
		success: false as const,
		output: `This file is not readable as text (${humanBytes(bytes)} of binary or non-UTF-8 data). Inspect it with a shell command such as file or xxd, or use a tool made for its format.`,
		data: { path, binary: true, ...(sandboxed ? { sandboxed: true } : {}) },
		facts: { kind: 'read' as const, path, binary: true, bytes },
	}
}

function refusedRead(path: string, bytes: number, message: string, sandboxed: boolean) {
	return {
		success: false as const,
		output: '',
		error: message,
		data: { path, tooLarge: true, ...(sandboxed ? { sandboxed: true } : {}) },
		facts: { kind: 'read' as const, path, bytes },
	}
}

/**
 * What a read returned, as fields. A file that is not text is named as such,
 * so a host says "Binary file, 4 KB" instead of drawing the bytes the model's
 * numbered rendering contains.
 */
function readFacts(
	path: string,
	buffer: Buffer,
	content: string,
	rendered: RenderedRead,
): ToolFacts {
	return {
		kind: 'read',
		path,
		bytes: buffer.length,
		...(looksBinary(content) ? { binary: true } : {}),
		totalLines: rendered.totalLines,
		returnedLines: rendered.returnedLines,
		...(rendered.partial ? { partial: true } : {}),
	}
}

/**
 * Put this read on the observation ledger.
 *
 * Always the WHOLE body, not the selected window: a later edit is checked
 * against the file, and a partial read must not fingerprint a fragment as if it
 * were the file.
 *
 * A read that returned the file whole additionally witnesses itself, so the
 * derived work context can reference the body without the model reading it
 * again. The witness is the fingerprint of the RENDERING — this call's own
 * `output`, byte for byte — because the rendering is what the receipt carries,
 * and the body is in front of the model only while the receipt is still exactly
 * that. A read whose window left any of the file out witnesses nothing: it
 * shows a fragment, and the fingerprint of the file cannot say which one.
 */
function recordObservedRead(
	context: ToolContext,
	key: string,
	content: string,
	rendered: RenderedRead,
	input: ReadWindowInput,
): void {
	const tracker = context.fileReadTracker
	if (!tracker) return
	if (!rendered.partial && tracker.recordFullRead && context.toolUseId) {
		tracker.recordFullRead(key, content, context.toolUseId, fingerprintContent(rendered.output))
	} else {
		tracker.recordRead(key, content)
	}
	if (tracker.recordReadWindow && context.toolUseId) {
		tracker.recordReadWindow(key, windowKey(input), {
			callId: context.toolUseId,
			renderedFingerprint: fingerprintContent(rendered.output),
			contentFingerprint: fingerprintContent(content),
		})
	}
}

type ReadWindowInput = {
	readonly readRange?: readonly number[] | undefined
	readonly offset?: number | undefined
	readonly limit?: number | undefined
	readonly allow_large?: boolean | undefined
}

/** The lines a read asked for, as one comparable string. */
function windowKey(input: ReadWindowInput): string {
	const range = input.readRange
	const lines = range
		? `r${range[0]}-${range[1]}`
		: `o${input.offset ?? 0}l${input.limit === undefined ? 'all' : input.limit}`
	return input.allow_large === true ? `${lines}+large` : lines
}

/**
 * The answer to a repeat read of the same lines of a file that has not changed.
 *
 * The earlier result is still in front of the model, so returning the lines a
 * second time only spends the window. It is given ONLY while that is true:
 * the body must fingerprint the same as at the earlier read, and the earlier
 * receipt must still be in the conversation exactly as the tool returned it
 * (the host says so through `receiptVisible`). A receipt that was cleared,
 * summarised away or annotated is no answer, and the lines are returned again.
 */
function unchangedRead(
	context: ToolContext,
	key: string,
	input: ReadWindowInput,
	content: string,
	bytes: number,
) {
	const tracker = context.fileReadTracker
	if (!tracker?.readWindow || !context.receiptVisible) return undefined
	const earlier = tracker.readWindow(key, windowKey(input))
	if (!earlier || earlier.contentFingerprint !== fingerprintContent(content)) return undefined
	if (!context.receiptVisible(earlier.callId, earlier.renderedFingerprint)) return undefined
	return {
		success: true as const,
		output:
			'Unchanged since your earlier read of the same lines. That result is still current; use it instead of reading again.',
		data: { path: key, unchanged: true },
		facts: { kind: 'read' as const, path: key, bytes, unchanged: true },
	}
}

function describeStructuredBinaryRead(path: string): string | null {
	const ext = extname(path).toLowerCase()
	if (ext === '.docx') return buildStructuredBinaryGuidance(path, 'DOCX', 'python-docx')
	if (ext === '.pptx') return buildStructuredBinaryGuidance(path, 'PPTX', 'python-pptx')
	if (ext === '.xlsx') return buildStructuredBinaryGuidance(path, 'XLSX', 'openpyxl')
	return null
}

function buildStructuredBinaryGuidance(path: string, format: string, extractor: string): string {
	return [
		`The file "${path}" is a ${format} document package, not UTF-8 text.`,
		'Do not use the read/cat tools as evidence for this raw file.',
		`Extract its text with shell/Python tooling already available in the sandbox (${extractor}), write the extracted text or summary under scratch, then read that text file.`,
		'If extraction fails, report the exact filename and extraction error instead of claiming the attachment is unavailable.',
	].join('\n')
}
