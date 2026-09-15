import { readFile } from 'node:fs/promises'
import { extname } from 'node:path'
import { z } from 'zod'
import type { ToolContext } from '../../types/tool/index.js'
import { defineTool } from '../defineTool.js'
import { resolveWithinAnyReal, toolRoots } from '../paths.js'
import { fingerprintContent } from './content-fingerprint.js'
import { type RenderedRead, renderNumberedRead } from './read-render.js'

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
})

export const ReadFileTool = defineTool({
	name: 'read',
	description:
		'Reads a file and returns its contents with line numbers. Supports readRange ([start,end], 1-indexed inclusive) or offset/limit for large files. Without a window it returns the first 2000 lines and says so — pass offset/limit to continue.',
	inputSchema,
	category: 'filesystem',
	permissions: ['file_read'],
	readOnly: true,
	destructive: false,
	concurrencySafe: true,

	presentCall(input) {
		if (typeof input.path !== 'string') return undefined
		return {
			kind: 'generic',
			label: `Read ${input.path}`,
			presentation: 'activity',
			activity: 'exploration',
		}
	},

	async execute(input, context) {
		// Sandbox-aware: route through sandbox.readFile() when available
		if (context.sandbox) {
			const buffer = await context.sandbox.readFile(input.path)
			const binaryGuidance = describeStructuredBinaryRead(input.path, buffer)
			if (binaryGuidance) {
				return {
					success: false,
					output: binaryGuidance,
					data: {
						path: input.path,
						sandboxed: true,
						binary: true,
					},
				}
			}
			const content = buffer.toString('utf-8')
			const rendered = renderNumberedRead(content, input)
			recordObservedRead(context, input.path, content, rendered)

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
			}
		}

		const filePath = await resolveWithinAnyReal(toolRoots(context), input.path)
		const buffer = await readFile(filePath)
		const binaryGuidance = describeStructuredBinaryRead(filePath, buffer)
		if (binaryGuidance) {
			return {
				success: false,
				output: binaryGuidance,
				data: {
					path: filePath,
					binary: true,
				},
			}
		}
		const content = buffer.toString('utf-8')
		const rendered = renderNumberedRead(content, input)
		recordObservedRead(context, filePath, content, rendered)

		return {
			success: true,
			output: rendered.output,
			data: {
				totalLines: rendered.totalLines,
				returnedLines: rendered.returnedLines,
				truncated: rendered.partial,
				path: filePath,
			},
		}
	},
})

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
): void {
	const tracker = context.fileReadTracker
	if (!tracker) return
	if (!rendered.partial && tracker.recordFullRead && context.toolUseId) {
		tracker.recordFullRead(key, content, context.toolUseId, fingerprintContent(rendered.output))
		return
	}
	tracker.recordRead(key, content)
}

function describeStructuredBinaryRead(path: string, buffer: Buffer): string | null {
	const ext = extname(path).toLowerCase()
	if (ext === '.docx') return buildStructuredBinaryGuidance(path, 'DOCX', 'python-docx')
	if (ext === '.pptx') return buildStructuredBinaryGuidance(path, 'PPTX', 'python-pptx')
	if (ext === '.xlsx') return buildStructuredBinaryGuidance(path, 'XLSX', 'openpyxl')
	if (ext === '.pdf' || startsWithPdfHeader(buffer)) {
		return buildStructuredBinaryGuidance(path, 'PDF', 'pdftotext or PyMuPDF')
	}
	return null
}

function startsWithPdfHeader(buffer: Buffer): boolean {
	return buffer.length >= 4 && buffer.subarray(0, 4).toString('utf8') === '%PDF'
}

function buildStructuredBinaryGuidance(path: string, format: string, extractor: string): string {
	return [
		`The file "${path}" is a ${format} document package, not UTF-8 text.`,
		'Do not use the read/cat tools as evidence for this raw file.',
		`Extract its text with shell/Python tooling already available in the sandbox (${extractor}), write the extracted text or summary under scratch, then read that text file.`,
		'If extraction fails, report the exact filename and extraction error instead of claiming the attachment is unavailable.',
	].join('\n')
}
