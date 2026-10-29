import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { encode } from 'fast-png'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ToolResultBlock } from '../../../types/message/index.js'
import type { ToolContext, ToolResult } from '../../../types/tool/index.js'
import { ReadFileTool } from '../read-file.js'
import { checkPageRange, parsePageRange } from '../read-media.js'

function makeContext(workingDirectory: string): ToolContext {
	return {
		sessionId: '0190a5b2-7c3d-7e4f-8a9b-0c1d2e3f4a5b' as ToolContext['sessionId'],
		turnId: '4adf3fdd-2823-4640-be0a-5d21fe28b6d2' as ToolContext['turnId'],
		workingDirectory,
		abortSignal: new AbortController().signal,
		env: {},
		log: () => {},
	}
}

function dirWith(files: Record<string, string | Buffer>): string {
	const dir = mkdtempSync(join(tmpdir(), 'namzu-read-media-'))
	for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body)
	return dir
}

const PNG = Buffer.from(
	encode({ width: 4, height: 4, channels: 3, depth: 8, data: new Uint8Array(48).fill(80) }),
)
// An 8x6 grey JPEG.
const JPEG = Buffer.from(
	'/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/wAALCAAGAAgBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAAA//EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AJ//Z',
	'base64',
)

function blocks(result: ToolResult): readonly ToolResultBlock[] {
	return result.content as readonly ToolResultBlock[]
}

/**
 * Stand-ins for the two poppler programs, written to a directory placed first
 * on PATH. `pdfinfo` reports FAKE_PDF_PAGES pages; `pdftoppm` writes one tiny
 * JPEG per requested page, named the way the real one pads them, and fails the
 * way the real one does for a first page past the end.
 */
function fakePoppler(pages: number): string {
	const bin = mkdtempSync(join(tmpdir(), 'namzu-fake-poppler-'))
	mkdirSync(bin, { recursive: true })
	const jpegFile = join(bin, 'page.jpg')
	writeFileSync(jpegFile, JPEG)
	writeFileSync(
		join(bin, 'pdfinfo'),
		`#!/bin/sh\ncat >/dev/null\necho "Pages:          ${pages}"\n`,
	)
	writeFileSync(
		join(bin, 'pdftoppm'),
		`#!/bin/sh
first=1; last=${pages}; prev=""
for a in "$@"; do
  case "$prev" in -f) first=$a;; -l) last=$a;; esac
  prev=$a; prefix=$a
done
cat >/dev/null
if [ "$first" -gt ${pages} ]; then
  echo "Wrong page range given: the first page ($first) can not be after the last page (${pages})." >&2
  exit 99
fi
[ "$last" -gt ${pages} ] && last=${pages}
n=$first
while [ "$n" -le "$last" ]; do
  if [ ${pages} -ge 10 ]; then name=$(printf '%02d' "$n"); else name=$n; fi
  cp "${jpegFile}" "$prefix-$name.jpg"
  n=$((n+1))
done
`,
	)
	chmodSync(join(bin, 'pdfinfo'), 0o755)
	chmodSync(join(bin, 'pdftoppm'), 0o755)
	return bin
}

function withPoppler(pages: number): void {
	vi.stubEnv('PATH', `${fakePoppler(pages)}${delimiter}${process.env.PATH ?? ''}`)
}

afterEach(() => {
	vi.unstubAllEnvs()
})

describe('read of a picture', () => {
	it('returns the pixels of a PNG and of a JPEG', async () => {
		const dir = dirWith({ 'shot.png': PNG, 'photo.jpg': JPEG })
		const png = await ReadFileTool.execute({ path: 'shot.png' }, makeContext(dir))
		expect(png.success).toBe(true)
		expect(blocks(png).some((b) => b.type === 'image' && b.mediaType === 'image/png')).toBe(true)
		const jpeg = await ReadFileTool.execute({ path: 'photo.jpg' }, makeContext(dir))
		expect(jpeg.success).toBe(true)
		expect(blocks(jpeg).some((b) => b.type === 'image' && b.mediaType === 'image/jpeg')).toBe(true)
	})

	it('treats a text file with a picture name as text', async () => {
		const dir = dirWith({ 'notes.png': 'just words' })
		const result = await ReadFileTool.execute({ path: 'notes.png' }, makeContext(dir))
		expect(result.success).toBe(true)
		expect(result.output).toBe('1\tjust words')
	})

	it('says plainly when the picture is damaged', async () => {
		const dir = dirWith({ 'bad.png': PNG.subarray(0, 30) })
		const result = await ReadFileTool.execute({ path: 'bad.png' }, makeContext(dir))
		expect(result.success).toBe(false)
		expect(result.error).toMatch(/malformed|truncated/i)
	})
})

describe('read of a PDF', () => {
	const pdf = Buffer.from('%PDF-1.4\n%fake\n')

	it('renders a small PDF whole, one picture per page', async () => {
		withPoppler(3)
		const dir = dirWith({ 'doc.pdf': pdf })
		const result = await ReadFileTool.execute({ path: 'doc.pdf' }, makeContext(dir))
		expect(result.success).toBe(true)
		expect(result.output).toContain('PDF pages extracted: 3 pages')
		expect(blocks(result).filter((b) => b.type === 'image')).toHaveLength(3)
		expect(result.data).toMatchObject({ pages: 3, totalPages: 3 })
	})

	it('refuses a long PDF without pages and names the parameter', async () => {
		withPoppler(40)
		const dir = dirWith({ 'long.pdf': pdf })
		const result = await ReadFileTool.execute({ path: 'long.pdf' }, makeContext(dir))
		expect(result.success).toBe(false)
		expect(result.output).toContain('This PDF has 40 pages')
		expect(result.output).toContain('pages: "1-5"')
		expect(result.output).toContain('Maximum 20 pages per request')
	})

	it('renders the requested range and says where to continue', async () => {
		withPoppler(40)
		const dir = dirWith({ 'long.pdf': pdf })
		const result = await ReadFileTool.execute({ path: 'long.pdf', pages: '4-6' }, makeContext(dir))
		expect(result.success).toBe(true)
		expect(blocks(result).filter((b) => b.type === 'image')).toHaveLength(3)
		expect(result.output).toContain('This PDF has 40 pages. These are pages 4-6.')
		expect(result.output).toContain('pages: "7-9"')
	})

	it('refuses a range of more than 20 pages and a list of ranges', async () => {
		withPoppler(40)
		const dir = dirWith({ 'long.pdf': pdf })
		const wide = await ReadFileTool.execute({ path: 'long.pdf', pages: '1-30' }, makeContext(dir))
		expect(wide.success).toBe(false)
		expect(wide.output).toContain('exceeds maximum of 20 pages per request')
		const list = await ReadFileTool.execute({ path: 'long.pdf', pages: '1,3' }, makeContext(dir))
		expect(list.success).toBe(false)
		expect(list.output).toContain('Invalid pages parameter')
	})

	it('names the length of the document when the range starts past its end', async () => {
		withPoppler(5)
		const dir = dirWith({ 'short.pdf': pdf })
		const result = await ReadFileTool.execute(
			{ path: 'short.pdf', pages: '9-10' },
			makeContext(dir),
		)
		expect(result.success).toBe(false)
		expect(result.output).toContain('the PDF has 5 pages')
		expect(result.output).toContain('within 1-5')
	})

	it('says what to install when the renderer is missing', async () => {
		vi.stubEnv('PATH', mkdtempSync(join(tmpdir(), 'namzu-empty-path-')))
		const dir = dirWith({ 'doc.pdf': pdf })
		const result = await ReadFileTool.execute({ path: 'doc.pdf', pages: '1' }, makeContext(dir))
		expect(result.success).toBe(false)
		expect(result.output).toContain('poppler-utils')
	})
})

describe('page ranges', () => {
	it('parses a page, a range and an open range', () => {
		expect(parsePageRange('3')).toEqual({ first: 3, last: 3 })
		expect(parsePageRange(' 2 - 5 ')).toEqual({ first: 2, last: 5 })
		expect(parsePageRange('7-')).toEqual({ first: 7, last: Number.POSITIVE_INFINITY })
		expect(parsePageRange('5-2')).toBeNull()
		expect(parsePageRange('0')).toBeNull()
		expect(parsePageRange('a')).toBeNull()
	})

	it('allows exactly 20 pages and no more', () => {
		expect(checkPageRange('1-20').ok).toBe(true)
		expect(checkPageRange('1-21').ok).toBe(false)
		expect(checkPageRange('5-').ok).toBe(false)
	})
})

describe('read of a notebook', () => {
	function notebook(cells: unknown[], language?: string): string {
		return JSON.stringify({
			cells,
			metadata: language ? { language_info: { name: language } } : {},
			nbformat: 4,
		})
	}

	it('returns cells in order with their ids, types and printed output', async () => {
		const dir = dirWith({
			'a.ipynb': notebook([
				{ id: 'intro', cell_type: 'markdown', source: ['# Title\n', 'text'] },
				{
					id: 'calc',
					cell_type: 'code',
					execution_count: 1,
					source: 'print(1)',
					outputs: [{ output_type: 'stream', name: 'stdout', text: ['1\n'] }],
				},
				{ cell_type: 'code', source: 'x', outputs: [] },
			]),
		})
		const result = await ReadFileTool.execute({ path: 'a.ipynb' }, makeContext(dir))
		expect(result.success).toBe(true)
		const lines = result.output.split('\n')
		expect(result.output).toContain(
			'<cell id="intro"><cell_type>markdown</cell_type># Title\ntext</cell id="intro">',
		)
		expect(result.output).toContain('<cell id="calc">print(1)</cell id="calc">')
		expect(result.output).toContain('<cell id="cell-2">x</cell id="cell-2">')
		expect(lines.indexOf('1')).toBeGreaterThan(lines.findIndex((l) => l.includes('id="calc"')))
		expect(result.data).toMatchObject({ cells: 3 })
	})

	it('names the language of a code cell that is not Python', async () => {
		const dir = dirWith({
			'r.ipynb': notebook([{ id: 'r1', cell_type: 'code', source: 'x <- 1' }], 'R'),
		})
		const result = await ReadFileTool.execute({ path: 'r.ipynb' }, makeContext(dir))
		expect(result.output).toContain('<cell id="r1"><language>R</language>x <- 1</cell id="r1">')
	})

	it('shows a small picture a cell produced', async () => {
		const dir = dirWith({
			'p.ipynb': notebook([
				{
					id: 'plot',
					cell_type: 'code',
					source: 'plot()',
					outputs: [
						{
							output_type: 'display_data',
							data: { 'text/plain': ['<Figure>'], 'image/png': PNG.toString('base64') },
						},
					],
				},
			]),
		})
		const result = await ReadFileTool.execute({ path: 'p.ipynb' }, makeContext(dir))
		expect(result.success).toBe(true)
		expect(result.output).toContain('<Figure>')
		expect(blocks(result).some((b) => b.type === 'image')).toBe(true)
	})

	it('leaves out the output of a cell that printed too much and says how to get it', async () => {
		const dir = dirWith({
			'big.ipynb': notebook([
				{
					id: 'noisy',
					cell_type: 'code',
					source: 'spam()',
					outputs: [{ output_type: 'stream', text: 'x'.repeat(12_000) }],
				},
			]),
		})
		const result = await ReadFileTool.execute({ path: 'big.ipynb' }, makeContext(dir))
		expect(result.success).toBe(true)
		expect(result.output).not.toContain('xxxxxxxxxx')
		expect(result.output).toContain('Outputs are too large to include')
		expect(result.output).toContain('.cells[0].outputs')
	})

	it('reports an error cell with its name and message', async () => {
		const dir = dirWith({
			'e.ipynb': notebook([
				{
					id: 'boom',
					cell_type: 'code',
					source: '1/0',
					outputs: [
						{
							output_type: 'error',
							ename: 'ZeroDivisionError',
							evalue: 'division by zero',
							traceback: ['Traceback'],
						},
					],
				},
			]),
		})
		const result = await ReadFileTool.execute({ path: 'e.ipynb' }, makeContext(dir))
		expect(result.output).toContain('ZeroDivisionError: division by zero')
	})

	it('refuses a file that is not a notebook, plainly', async () => {
		const dir = dirWith({ 'bad.ipynb': '{not json', 'odd.ipynb': '{"cells": 3}' })
		const broken = await ReadFileTool.execute({ path: 'bad.ipynb' }, makeContext(dir))
		expect(broken.success).toBe(false)
		expect(broken.output).toContain('not valid JSON')
		const odd = await ReadFileTool.execute({ path: 'odd.ipynb' }, makeContext(dir))
		expect(odd.success).toBe(false)
		expect(odd.output).toContain('not a valid Jupyter notebook')
	})
})

describe('PDF encoded output budget', () => {
	it('refuses aggregate base64 expansion before encoding another oversized batch of pages', async () => {
		const bin = fakePoppler(2)
		// A JPEG with harmless trailing bytes keeps small dimensions but has a
		// 12 MiB base64 representation. Two pages exceed the budget with headers.
		writeFileSync(
			join(bin, 'page.jpg'),
			Buffer.concat([JPEG, Buffer.alloc(9 * 1024 * 1024 - JPEG.length)]),
		)
		vi.stubEnv('PATH', `${bin}${delimiter}${process.env.PATH ?? ''}`)
		const dir = dirWith({ 'large-pages.pdf': '%PDF-1.4\nfixture' })
		const result = await ReadFileTool.execute({ path: 'large-pages.pdf' }, makeContext(dir))
		expect(result.success).toBe(false)
		expect(result.error).toContain('24 MiB encoded output budget')
	})
})
