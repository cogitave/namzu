import { spawn } from 'node:child_process'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readBoundedFile } from './bounded-file-read.js'
import { screenshotTargetSize } from './computer-use-image.js'
import { describeRaster } from './view-image.js'

/**
 * What `read` hands back for the files that are not plain text: the pages of a
 * PDF as pictures and the cells of a notebook with what they printed. Each
 * function returns text and pictures for the model, or a plain failure message.
 */

/** Most pages one read may render. */
export const PDF_MAX_PAGES_PER_READ = 20
/** A PDF with more pages than this is not read whole; the model names pages. */
export const PDF_WHOLE_READ_MAX_PAGES = 10
/** The largest PDF read; larger files are refused before any tool runs. */
export const PDF_MAX_BYTES = 100 * 1024 * 1024
/** The largest notebook read in full. */
export const NOTEBOOK_MAX_BYTES = 8 * 1024 * 1024
/** Printed output of one cell above this many characters is left out. */
const CELL_OUTPUT_MAX_CHARS = 10_000
/** Encoded images plus UTF-8 text, not decoded image bytes. */
export const MEDIA_MAX_OUTPUT_BYTES = 24 * 1024 * 1024
export const NOTEBOOK_MAX_OUTPUT_BYTES = 1024 * 1024
const PAGE_MAX_BYTES = 16 * 1024 * 1024
const PDF_TOOL_TIMEOUT_MS = 120_000
const PDF_INFO_TIMEOUT_MS = 10_000
const RENDER_DPI = '100'

export interface MediaImage {
	readonly mediaType: 'image/png' | 'image/jpeg' | 'image/webp'
	/** Base64 of the image bytes. */
	readonly data: string
}

export type MediaPart =
	| { readonly type: 'text'; readonly text: string }
	| ({ readonly type: 'image' } & MediaImage)

export type MediaRead =
	| { readonly ok: true; readonly parts: readonly MediaPart[]; readonly facts: MediaFacts }
	| { readonly ok: false; readonly message: string }

export interface MediaFacts {
	readonly pages?: number
	readonly totalPages?: number
	readonly cells?: number
}

/** `"3"`, `"1-5"` and `"3-"`; anything else is not one range. */
export function parsePageRange(value: string): { first: number; last: number } | null {
	const match = /^(\d{1,9})(?:\s*(-)\s*(\d{1,9})?)?$/.exec(value.trim())
	if (!match) return null
	const first = Number(match[1])
	const last = match[3] ? Number(match[3]) : match[2] ? Number.POSITIVE_INFINITY : first
	if (first < 1 || last < first) return null
	return { first, last }
}

export function checkPageRange(
	value: string,
): { ok: true; first: number; last: number } | { ok: false; message: string } {
	const range = parsePageRange(value)
	if (!range) {
		return {
			ok: false,
			message: `Invalid pages parameter: "${value}". Give one page ("3") or one range ("1-5"), not a list. To read several pages or ranges, read each one separately. Pages are 1-indexed.`,
		}
	}
	const count =
		range.last === Number.POSITIVE_INFINITY
			? PDF_MAX_PAGES_PER_READ + 1
			: range.last - range.first + 1
	if (count > PDF_MAX_PAGES_PER_READ) {
		return {
			ok: false,
			message: `Page range "${value}" exceeds maximum of ${PDF_MAX_PAGES_PER_READ} pages per request. Please use a smaller range.`,
		}
	}
	return { ok: true, first: range.first, last: range.last }
}

interface RunResult {
	readonly code: number | null
	readonly stdout: string
	readonly stderr: string
	readonly missing: boolean
	readonly timedOut: boolean
}

function run(
	command: string,
	args: readonly string[],
	input: Buffer | undefined,
	signal: AbortSignal,
	timeoutMs: number,
): Promise<RunResult> {
	return new Promise((resolve) => {
		const child = spawn(command, [...args], { stdio: ['pipe', 'pipe', 'pipe'], signal })
		let stdout = ''
		let stderr = ''
		let missing = false
		let timedOut = false
		const timer = setTimeout(() => {
			timedOut = true
			child.kill('SIGKILL')
		}, timeoutMs)
		child.stdout.on('data', (chunk: Buffer) => {
			if (stdout.length < 1_000_000)
				stdout += chunk.subarray(0, 1_000_000 - stdout.length).toString('utf8')
		})
		child.stderr.on('data', (chunk: Buffer) => {
			if (stderr.length < 1_000_000)
				stderr += chunk.subarray(0, 1_000_000 - stderr.length).toString('utf8')
		})
		child.on('error', (error: NodeJS.ErrnoException) => {
			missing = error.code === 'ENOENT'
			clearTimeout(timer)
			resolve({ code: null, stdout, stderr: stderr || error.message, missing, timedOut })
		})
		child.on('close', (code) => {
			clearTimeout(timer)
			resolve({ code, stdout, stderr, missing, timedOut })
		})
		// A tool that exits early closes its stdin; that is its answer, not ours.
		child.stdin.on('error', () => {})
		child.stdin.end(input)
	})
}

const PDF_TOOLS_MISSING =
	'Page rendering needs pdftoppm, which is not installed. Install poppler-utils (for example `brew install poppler` or `apt-get install poppler-utils`), or extract the text with another tool.'

/** The page count, or null when it cannot be read (no pdfinfo, damaged file). */
async function pdfPageCount(bytes: Buffer, signal: AbortSignal): Promise<number | null> {
	const result = await run('pdfinfo', ['-'], bytes, signal, PDF_INFO_TIMEOUT_MS)
	if (result.code !== 0) return null
	const match = /^Pages:\s+(\d+)/m.exec(result.stdout)
	return match ? Number(match[1]) : null
}

function pdfFailure(stderr: string): string {
	if (/password/i.test(stderr))
		return 'PDF is password-protected. Please provide an unprotected version.'
	if (/damaged|corrupt|invalid|Couldn't (?:find trailer dictionary|read xref table)/i.test(stderr))
		return 'PDF file is corrupted or invalid.'
	const first = stderr.split(/\r?\n/).find((line) => line.trim() !== '')
	return `Could not render PDF${first ? `: ${first.trim()}` : '.'}`
}

async function renderPages(
	bytes: Buffer,
	first: number,
	last: number | undefined,
	directory: string,
	signal: AbortSignal,
): Promise<{ ok: true; names: string[] } | { ok: false; message: string; pageCount?: number }> {
	const args = ['-jpeg', '-r', RENDER_DPI, '-scale-to', '4096', '-f', String(first)]
	if (last !== undefined && Number.isFinite(last)) args.push('-l', String(last))
	args.push('-', join(directory, 'page'))
	const result = await run('pdftoppm', args, bytes, signal, PDF_TOOL_TIMEOUT_MS)
	if (result.missing) return { ok: false, message: PDF_TOOLS_MISSING }
	if (result.timedOut)
		return { ok: false, message: 'Rendering the PDF took too long and was stopped.' }
	if (result.code !== 0) {
		const outside = /Wrong page range given.*last page \((\d+)\)/i.exec(result.stderr)
		if (outside) {
			const total = Number(outside[1])
			if (total === 0)
				return {
					ok: false,
					message: 'PDF reports 0 pages (empty page tree). The PDF may be invalid.',
				}
			return {
				ok: false,
				pageCount: total,
				message: `The pages requested are outside the document (the PDF has ${total} ${total === 1 ? 'page' : 'pages'}). Use a range within 1-${total}, at most ${PDF_MAX_PAGES_PER_READ} pages per request (for example pages: "1-${Math.min(total, PDF_MAX_PAGES_PER_READ)}").`,
			}
		}
		return { ok: false, message: pdfFailure(result.stderr) }
	}
	const names = (await readdir(directory)).filter((name) => name.endsWith('.jpg')).sort()
	if (names.length === 0)
		return { ok: false, message: 'No pages were rendered. The PDF may be invalid.' }
	return { ok: true, names }
}

/** Re-render one page at the size the image budget allows. */
async function renderPageFitted(
	bytes: Buffer,
	page: number,
	width: number,
	height: number,
	directory: string,
	signal: AbortSignal,
): Promise<Buffer | null> {
	const base = join(directory, `fit-${page}`)
	const result = await run(
		'pdftoppm',
		[
			'-jpeg',
			'-f',
			String(page),
			'-l',
			String(page),
			'-scale-to-x',
			String(width),
			'-scale-to-y',
			String(height),
			'-singlefile',
			'-',
			base,
		],
		bytes,
		signal,
		PDF_TOOL_TIMEOUT_MS,
	)
	if (result.code !== 0) return null
	return readBoundedFile(`${base}.jpg`, PAGE_MAX_BYTES, signal).catch(() => null)
}

/**
 * Render pages of a PDF as pictures. With `pages` it is exactly that range
 * (at most 20); without it the whole file when it has at most 10 pages, and a
 * message naming the `pages` parameter when it has more.
 */
export async function readPdfPages(
	bytes: Buffer,
	pagesArgument: string | undefined,
	label: string,
	signal: AbortSignal,
): Promise<MediaRead> {
	if (bytes.length > PDF_MAX_BYTES)
		return { ok: false, message: 'PDF exceeds the 100 MiB input limit.' }
	let first = 1
	let last: number | undefined
	let total: number | null = null
	if (pagesArgument !== undefined) {
		const checked = checkPageRange(pagesArgument)
		if (!checked.ok) return { ok: false, message: checked.message }
		first = checked.first
		last = checked.last
		total = await pdfPageCount(bytes, signal)
	} else {
		total = await pdfPageCount(bytes, signal)
		if (total !== null && total > PDF_WHOLE_READ_MAX_PAGES) {
			return {
				ok: false,
				message: `This PDF has ${total} pages, which is too many to read at once. Use the pages parameter to read specific page ranges (e.g., pages: "1-5"). Maximum ${PDF_MAX_PAGES_PER_READ} pages per request.`,
			}
		}
		last = total === null ? PDF_WHOLE_READ_MAX_PAGES : total
	}
	const directory = await mkdtemp(join(tmpdir(), 'namzu-pdf-'))
	try {
		const rendered = await renderPages(bytes, first, last, directory, signal)
		if (!rendered.ok) return { ok: false, message: rendered.message }
		const parts: MediaPart[] = []
		let encodedBytes = 0
		const firstName = rendered.names[0] as string
		const firstShown = Number(/-(\d+)\.jpg$/.exec(firstName)?.[1] ?? first)
		const header = `PDF pages extracted: ${rendered.names.length} ${rendered.names.length === 1 ? 'page' : 'pages'} from ${label} (${formatSize(bytes.length)})`
		const lastShown = firstShown + rendered.names.length - 1
		const more =
			total !== null && lastShown < total
				? `. This PDF has ${total} pages. These are pages ${firstShown}-${lastShown}. Use the pages parameter to read other pages (e.g., pages: "${lastShown + 1}-${Math.min(lastShown + rendered.names.length, total)}").`
				: total === null
					? `. The page count could not be read; these are pages ${firstShown}-${lastShown}.`
					: ''
		if (Buffer.byteLength(header + more, 'utf8') > 64 * 1024)
			return { ok: false, message: 'PDF label exceeds the output budget.' }
		parts.push({ type: 'text', text: `${header}${more}` })
		for (const [index, name] of rendered.names.entries()) {
			const page = firstShown + index
			const unusable = `[Page ${page} could not be processed as an image.]`
			try {
				let image = await readBoundedFile(join(directory, name), PAGE_MAX_BYTES, signal)
				const raster = describeRaster(image)
				const target = screenshotTargetSize(raster.width, raster.height)
				if (target.width !== raster.width || target.height !== raster.height) {
					const fitted = await renderPageFitted(
						bytes,
						page,
						target.width,
						target.height,
						directory,
						signal,
					)
					if (!fitted) {
						parts.push({ type: 'text', text: unusable })
						continue
					}
					image = fitted
				}
				const size = 4 * Math.ceil(image.length / 3)
				if (encodedBytes + size > MEDIA_MAX_OUTPUT_BYTES - 128 * 1024)
					return {
						ok: false,
						message: 'PDF pictures exceed the 24 MiB encoded output budget. Request fewer pages.',
					}
				encodedBytes += size
				parts.push({ type: 'image', mediaType: 'image/jpeg', data: image.toString('base64') })
			} catch {
				parts.push({ type: 'text', text: unusable })
			}
		}
		return {
			ok: true,
			parts,
			facts: { pages: rendered.names.length, ...(total !== null ? { totalPages: total } : {}) },
		}
	} finally {
		await rm(directory, { recursive: true, force: true }).catch(() => {})
	}
}

function formatSize(n: number): string {
	if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MiB`
	if (n >= 1024) return `${Math.round(n / 1024)} KiB`
	return `${n} B`
}

const NOTEBOOK_INVALID =
	'Notebook file is not a valid Jupyter notebook (top-level "cells" must be an array of cell objects, each with a string or string-array "source").'

interface NotebookCell {
	readonly id?: unknown
	readonly cell_type?: unknown
	readonly source?: unknown
	readonly execution_count?: unknown
	readonly outputs?: unknown
}

function joined(value: unknown): string | null {
	if (typeof value === 'string') return value
	if (Array.isArray(value) && value.every((line) => typeof line === 'string')) return value.join('')
	return null
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function outputParts(output: unknown):
	| {
			text: string
			image: MediaImage | undefined
			imageSize?: number
	  }
	| undefined {
	if (!isRecord(output)) return undefined
	switch (output.output_type) {
		case 'stream':
			return { text: joined(output.text) ?? '', image: undefined }
		case 'execute_result':
		case 'display_data': {
			const data = isRecord(output.data) ? output.data : {}
			const rawImage = data['image/png'] ?? data['image/jpeg']
			if (typeof rawImage === 'string' && rawImage.length > CELL_OUTPUT_MAX_CHARS)
				return {
					text: joined(data['text/plain']) ?? '',
					image: undefined,
					imageSize: rawImage.length,
				}
			return { text: joined(data['text/plain']) ?? '', image: notebookImage(data) }
		}
		case 'error': {
			const trace = Array.isArray(output.traceback) ? output.traceback.join('\n') : ''
			return {
				text: `${String(output.ename ?? '')}: ${String(output.evalue ?? '')}\n${trace}`,
				image: undefined,
			}
		}
		default:
			return undefined
	}
}

function notebookImage(data: Record<string, unknown>): MediaImage | undefined {
	for (const mediaType of ['image/png', 'image/jpeg'] as const) {
		const value = data[mediaType]
		if (typeof value !== 'string') continue
		const base64 = value.replace(/\s/g, '')
		if (base64.length > NOTEBOOK_MAX_OUTPUT_BYTES || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64))
			return undefined
		try {
			const decoded = Buffer.from(base64, 'base64')
			if (decoded.toString('base64') !== base64) return undefined
			describeRaster(decoded)
		} catch {
			return undefined
		}
		return { mediaType, data: base64 }
	}
	return undefined
}

/**
 * A notebook as text the model can work from: every cell as
 * `<cell id="...">source</cell id="...">` (a non-code cell names its type, a
 * code cell in a language other than Python names the language), each followed
 * by what it printed. A cell whose output is over 10,000 characters keeps only a
 * note on how to read it.
 */
export function readNotebook(bytes: Buffer, label: string): MediaRead {
	if (bytes.length > NOTEBOOK_MAX_BYTES) {
		return {
			ok: false,
			message: `Notebook file (${formatSize(bytes.length)}) exceeds the maximum size this tool can read (${formatSize(NOTEBOOK_MAX_BYTES)}). Use a shell command with jq to read specific portions, for example: jq '.cells[:20]' ${label}`,
		}
	}
	let parsed: unknown
	try {
		parsed = JSON.parse(bytes.toString('utf-8'))
	} catch (error) {
		return {
			ok: false,
			message: `Notebook file is not valid JSON (it may be truncated, corrupted, or still being written): ${error instanceof Error ? error.message : String(error)}`,
		}
	}
	if (!isRecord(parsed) || !Array.isArray(parsed.cells))
		return { ok: false, message: NOTEBOOK_INVALID }
	const cells = parsed.cells as unknown[]
	if (!cells.every((cell) => isRecord(cell) && joined((cell as NotebookCell).source) !== null)) {
		return { ok: false, message: NOTEBOOK_INVALID }
	}
	const metadata = isRecord(parsed.metadata) ? parsed.metadata : {}
	const info = isRecord(metadata.language_info) ? metadata.language_info : {}
	const language = typeof info.name === 'string' ? info.name : 'python'
	const parts: MediaPart[] = []
	let outputBytes = 0
	let exceeded = false
	const pushText = (text: string): void => {
		outputBytes += Buffer.byteLength(text, 'utf8') + (parts.length > 0 ? 1 : 0)
		if (outputBytes > NOTEBOOK_MAX_OUTPUT_BYTES) {
			exceeded = true
			return
		}
		parts.push({ type: 'text', text })
	}
	for (const [index, raw] of (cells as NotebookCell[]).entries()) {
		const id = typeof raw.id === 'string' ? raw.id : `cell-${index}`
		const type = typeof raw.cell_type === 'string' ? raw.cell_type : 'code'
		const tags =
			(type !== 'code' ? `<cell_type>${type}</cell_type>` : '') +
			(type === 'code' && language !== 'python' ? `<language>${language}</language>` : '')
		pushText(`<cell id="${id}">${tags}${joined(raw.source)}</cell id="${id}">`)
		if (exceeded) break
		if (type !== 'code' || !Array.isArray(raw.outputs) || raw.outputs.length === 0) continue
		const outputs = raw.outputs.map(outputParts).filter((o) => o !== undefined)
		const size = outputs.reduce(
			(sum, o) => sum + o.text.length + (o.imageSize ?? o.image?.data.length ?? 0),
			0,
		)
		if (size > CELL_OUTPUT_MAX_CHARS) {
			pushText(
				`Outputs are too large to include. Use a shell command with: jq '.cells[${index}].outputs' ${label}`,
			)
			continue
		}
		for (const output of outputs) {
			if (output.text) pushText(`\n${output.text}`)
			if (output.image) {
				outputBytes += output.image.data.length
				if (outputBytes > NOTEBOOK_MAX_OUTPUT_BYTES) {
					exceeded = true
					break
				}
				parts.push({ type: 'image', ...output.image })
			}
		}
	}
	if (exceeded)
		return {
			ok: false,
			message:
				'Notebook exceeds the 1 MiB encoded output budget. Extract selected cells with jq and read the extracted file.',
		}
	return { ok: true, parts, facts: { cells: cells.length } }
}
