import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ToolContext } from '../../../types/tool/index.js'
import { ReadFileTool } from '../read-file.js'

function makeContext(workingDirectory: string): ToolContext {
	return {
		runId: 'run_test' as ToolContext['runId'],
		workingDirectory,
		abortSignal: new AbortController().signal,
		env: {},
		log: () => {},
	}
}

describe('ReadFileTool', () => {
	it('accepts readRange as a 1-indexed inclusive line range', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'namzu-read-'))
		writeFileSync(join(dir, 'doc.md'), ['one', 'two', 'three', 'four'].join('\n'))

		const result = await ReadFileTool.execute(
			{ path: 'doc.md', readRange: [2, 3] },
			makeContext(dir),
		)

		expect(result.success).toBe(true)
		expect(result.output).toContain('2\ttwo\n3\tthree')
		// A window over a longer file now says so: the model must be able to
		// tell "these are all the lines" from "these are the lines I asked
		// for", or it reasons about a fragment as if it were the file.
		expect(result.output).toContain('PARTIAL view — lines 2-3 of 4')
		expect(result.data).toMatchObject({ truncated: true, returnedLines: 2, totalLines: 4 })
	})

	it('adds no partial-view notice when the whole file was returned', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'namzu-read-'))
		writeFileSync(join(dir, 'doc.md'), ['one', 'two'].join('\n'))

		const result = await ReadFileTool.execute({ path: 'doc.md' }, makeContext(dir))

		expect(result.output).toBe('1\tone\n2\ttwo')
		expect(result.data).toMatchObject({ truncated: false })
	})

	it('defaults to a bounded window instead of returning an entire large file', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'namzu-read-'))
		const lines = Array.from({ length: 5000 }, (_, i) => `line ${i + 1}`)
		writeFileSync(join(dir, 'big.txt'), lines.join('\n'))

		const result = await ReadFileTool.execute({ path: 'big.txt' }, makeContext(dir))

		expect(result.data).toMatchObject({ returnedLines: 2000, totalLines: 5000, truncated: true })
		expect(result.output).toContain('PARTIAL view — lines 1-2000 of 5000')
		// The notice names the exact next call rather than describing it.
		expect(result.output).toContain('offset: 2000')
	})

	it('guides binary Office documents through extractor tooling', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'namzu-read-'))
		writeFileSync(join(dir, 'transcript.docx'), Buffer.from('PK\x03\x04binary-docx'))

		const result = await ReadFileTool.execute({ path: 'transcript.docx' }, makeContext(dir))

		expect(result.success).toBe(false)
		expect(result.output).toContain('DOCX document package')
		expect(result.output).toContain('python-docx')
		expect(result.data).toMatchObject({ binary: true })
	})
})
