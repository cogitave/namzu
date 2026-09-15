import { readFile } from 'node:fs/promises'
import { extname } from 'node:path'
import { z } from 'zod'
import { defineTool } from '../defineTool.js'
import { resolveWithinAnyReal, toolRoots } from '../paths.js'
import { renderNumberedRead } from './read-render.js'

const inputSchema = z.object({
	path: z.string().describe('Path to the file to read (absolute or relative)'),
	readRange: z
		.tuple([z.coerce.number().int().min(1), z.coerce.number().int().min(1)])
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

			// The WHOLE body, not the selected window: a later edit is checked
			// against the file, and a partial read must not fingerprint a
			// fragment as if it were the file.
			context.fileReadTracker?.recordRead(input.path, content)

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

		context.fileReadTracker?.recordRead(filePath, content)

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
