import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import type { ToolContext } from '../../../types/tool/index.js'
import { GrepTool } from '../grep.js'

/**
 * A pattern written to match across a line break came back as "No matches
 * found" while `multiline` was off, which reads as "this text is not here" and
 * sends the caller looking in the wrong file. The empty result now names the
 * pattern and the flag that changes the answer.
 */

function workspace(files: Record<string, string>) {
	const dir = mkdtempSync(join(tmpdir(), 'namzu-grep-line-break-'))
	for (const [name, body] of Object.entries(files)) {
		mkdirSync(join(dir, name, '..'), { recursive: true })
		writeFileSync(join(dir, name), body)
	}
	return {
		dir,
		context: { workingDirectory: dir, env: {} } as unknown as ToolContext,
	}
}

const run = (context: ToolContext, extra: Record<string, unknown> = {}, pattern = 'needle') => {
	const parsed = GrepTool.inputSchema.parse({ pattern, ...extra })
	return GrepTool.execute(parsed, context)
}

describe('a line break in the pattern explains an empty search', () => {
	it('names the pattern and the multiline flag', async () => {
		const { context } = workspace({ 'a.txt': 'alpha\nbeta\n' })
		const result = await run(context, {}, 'alpha\nbeta')
		expect(result.success).toBe(true)
		expect(result.output).toContain('No matches found')
		expect(result.output).toContain('"alpha\\nbeta"')
		expect(result.output).toContain('contains a line break')
		expect(result.output).toContain('multiline: true')
	})

	it('treats a pattern written with an escape the same way', async () => {
		const { context } = workspace({ 'a.txt': 'alpha\nbeta\n' })
		const result = await run(context, {}, 'alpha\\nbeta')
		expect(result.output).toContain('contains a line break')
		expect(result.output).toContain('multiline: true')
	})

	it('says nothing once multiline finds the match', async () => {
		const { context } = workspace({ 'a.txt': 'alpha\nbeta\n' })
		const result = await run(context, { multiline: true }, 'alpha\\nbeta')
		expect(result.output).toContain('a.txt')
		expect(result.output).not.toContain('contains a line break')
	})

	it('says nothing about a pattern that needs no line break', async () => {
		const { context } = workspace({ 'a.txt': 'x\n' })
		const result = await run(context, {}, 'needle')
		expect(result.output).toContain('No matches found')
		expect(result.output).not.toContain('contains a line break')
	})

	it('does not read an escaped backslash as a line break', async () => {
		// The file holds the two characters `\` and `n`, which `\\n` matches.
		const { context } = workspace({ 'b.txt': 'a\\nb\n' })
		const result = await run(context, {}, '\\\\n')
		expect(result.output).toContain('b.txt')
		expect(result.output).not.toContain('contains a line break')
	})

	it('says nothing on a later page of a search that did match', async () => {
		// The pattern holds a line break, but the alternative beside it matched a
		// single line, so the search found something and the pattern is not the reason.
		const { context } = workspace({ 'a.txt': 'alpha\nbeta\n' })
		const result = await run(context, { offset: 5 }, 'alpha|alpha\\nbeta')
		expect(result.output).toContain('No entries at this offset.')
		expect(result.output).not.toContain('contains a line break')
	})
})
