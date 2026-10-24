import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import type { ToolContext } from '../../../types/tool/index.js'
import { ReadFileTool } from '../read-file.js'
import {
	MAX_READ_BYTES,
	MAX_READ_TOKENS,
	estimateReadTokens,
	renderCappedRead,
	renderNumberedRead,
} from '../read-render.js'

/**
 * A bare read of a big file used to load all of it and render a 2000-line
 * window, however many tokens those lines were. The caps below are: 256 KiB without a window, 25,000 tokens, and a first
 * page that is cut to fit and says what to call next.
 */

function dirWith(name: string, body: string): { dir: string; context: ToolContext } {
	const dir = mkdtempSync(join(tmpdir(), 'namzu-read-caps-'))
	writeFileSync(join(dir, name), body)
	return {
		dir,
		context: { workingDirectory: dir, env: {} } as unknown as ToolContext,
	}
}

const line = (n: number) => `line ${String(n).padStart(5, '0')} ${'x'.repeat(70)}`
const lines = (count: number) => Array.from({ length: count }, (_, i) => line(i + 1)).join('\n')

describe('read size cap', () => {
	it('uses the read caps', () => {
		expect(MAX_READ_BYTES).toBe(262_144)
		expect(MAX_READ_TOKENS).toBe(25_000)
	})

	it('refuses a file over 256 KiB when no window is named, and names the way out', async () => {
		const { context } = dirWith('big.txt', 'a'.repeat(MAX_READ_BYTES + 1))
		const result = await ReadFileTool.execute({ path: 'big.txt' }, context)
		expect(result.success).toBe(false)
		expect(result.error).toContain('exceeds the maximum allowed size')
		expect(result.error).toContain('offset and limit')
		expect(result.error).toContain('allow_large')
	})

	it('reads the same file when a window is named', async () => {
		const body = `${lines(4000)}\n`
		expect(Buffer.byteLength(body)).toBeGreaterThan(MAX_READ_BYTES)
		const { context } = dirWith('big.txt', body)
		const result = await ReadFileTool.execute({ path: 'big.txt', limit: 50 }, context)
		expect(result.success).toBe(true)
		expect(result.output).toContain('1\tline 00001')
		const ranged = await ReadFileTool.execute({ path: 'big.txt', readRange: [10, 12] }, context)
		expect(ranged.success).toBe(true)
	})

	it('lets allow_large lift the cap for one read', async () => {
		const { context } = dirWith('big.txt', `${lines(3400)}\n`)
		const refused = await ReadFileTool.execute({ path: 'big.txt' }, context)
		expect(refused.success).toBe(false)
		const lifted = await ReadFileTool.execute({ path: 'big.txt', allow_large: true }, context)
		expect(lifted.success).toBe(true)
	})

	it('still refuses what allow_large cannot lift, and says so', async () => {
		const { context } = dirWith('huge.txt', 'a'.repeat(MAX_READ_BYTES * 4 + 1))
		const result = await ReadFileTool.execute({ path: 'huge.txt', allow_large: true }, context)
		expect(result.success).toBe(false)
		expect(result.error).toContain('Even with allow_large')
	})
})

describe('read token cap', () => {
	// 2000 lines of 82 characters is 164,000 characters, about 41,000 tokens:
	// under the byte cap, over the token cap.
	const body = `${lines(2400)}\n`

	it('cuts the first page to fit and names the next call', async () => {
		expect(Buffer.byteLength(body)).toBeLessThan(MAX_READ_BYTES)
		const { context } = dirWith('wide.txt', body)
		const result = await ReadFileTool.execute({ path: 'wide.txt' }, context)
		expect(result.success).toBe(true)
		const output = result.output
		expect(output).toContain('[Truncated: PARTIAL view')
		const shown = Number(/showing lines 1-(\d+) of 2401 total/.exec(output)?.[1])
		expect(shown).toBeGreaterThan(1)
		expect(shown).toBeLessThan(2000)
		// 0-indexed offset, the way this tool's `offset` is.
		expect(output).toContain(`offset=${shown} limit=${shown}`)
		expect(output).toContain('Do NOT answer from this page alone')
		const page = output.slice(0, output.indexOf('\n\n[Truncated'))
		expect(estimateReadTokens(page.replace(/^\d+\t/gm, ''), '.txt')).toBeLessThanOrEqual(25_000)
		expect(result.data).toMatchObject({ truncated: true })
	})

	it('refuses, with the count, when the caller named the window', async () => {
		const { context } = dirWith('wide.txt', body)
		const result = await ReadFileTool.execute({ path: 'wide.txt', limit: 2000 }, context)
		expect(result.success).toBe(false)
		expect(result.error).toMatch(
			/File content \(\d+ tokens\) exceeds the maximum allowed tokens \(25000\)/,
		)
		const later = await ReadFileTool.execute({ path: 'wide.txt', offset: 5 }, context)
		expect(later.success).toBe(false)
	})

	it('lets allow_large lift it, at four times the cap', async () => {
		const { context } = dirWith('wide.txt', body)
		const lifted = await ReadFileTool.execute({ path: 'wide.txt', allow_large: true }, context)
		expect(lifted.success).toBe(true)
		expect(lifted.output).not.toContain('[Truncated: PARTIAL view')
	})

	it('takes the cap from the host environment', async () => {
		const { dir } = dirWith('wide.txt', body)
		const context = {
			workingDirectory: dir,
			env: { NAMZU_FILE_READ_MAX_OUTPUT_TOKENS: '5000' },
		} as unknown as ToolContext
		const result = await ReadFileTool.execute({ path: 'wide.txt' }, context)
		const shown = Number(/showing lines 1-(\d+) of/.exec(result.output)?.[1])
		expect(shown).toBeLessThan(400)
	})

	it('pages a file whose lines are too long to page by line', async () => {
		const { context } = dirWith('one.txt', 'z'.repeat(200_000))
		const result = await ReadFileTool.execute({ path: 'one.txt' }, context)
		expect(result.success).toBe(true)
		expect(result.output).toContain('very long lines and cannot be paged by line')
	})

	it('estimates JSON as denser per token', () => {
		expect(estimateReadTokens('abcdefgh', '.txt')).toBe(2)
		expect(estimateReadTokens('abcdefgh', '.json')).toBe(4)
	})
})

describe('a read under the caps is unchanged', () => {
	it('renders exactly what the uncapped renderer renders', () => {
		const content = lines(300)
		const capped = renderCappedRead(content, content.length, {}, { path: 'a.txt', ext: '.txt' })
		expect(capped.ok).toBe(true)
		if (capped.ok) expect(capped.rendered).toEqual(renderNumberedRead(content, {}))
	})

	it('declares itself self-limiting, so the generic result cap leaves it alone', () => {
		expect(ReadFileTool.selfLimitingOutput).toBe(true)
	})
})
