import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ToolContext } from '../../../types/tool/index.js'
import { EditTool } from '../edit.js'

function makeContext(workingDirectory: string): ToolContext {
	return {
		runId: 'run_test' as ToolContext['runId'],
		workingDirectory,
		abortSignal: new AbortController().signal,
		env: {},
		log: () => {},
	}
}

describe('EditTool', () => {
	it('accepts oldStr/newStr aliases for string replacement', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'namzu-edit-'))
		writeFileSync(join(dir, 'doc.md'), 'alpha\nbeta\n')

		const result = await EditTool.execute(
			{ path: 'doc.md', oldStr: 'beta', newStr: 'gamma', replace_all: false },
			makeContext(dir),
		)

		expect(result.success).toBe(true)
		expect(readFileSync(join(dir, 'doc.md'), 'utf-8')).toBe('alpha\ngamma\n')
	})

	it('inserts content after a 1-indexed line number', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'namzu-edit-'))
		writeFileSync(join(dir, 'doc.md'), 'alpha\nbeta\n')

		const result = await EditTool.execute(
			{ path: 'doc.md', insertLine: 1, newStr: 'inserted', replace_all: false },
			makeContext(dir),
		)

		expect(result.success).toBe(true)
		expect(readFileSync(join(dir, 'doc.md'), 'utf-8')).toBe('alpha\ninserted\nbeta\n')
	})

	it('inserts content at the end with insertLine=end', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'namzu-edit-'))
		writeFileSync(join(dir, 'doc.md'), 'alpha\n')

		const result = await EditTool.execute(
			{ path: 'doc.md', insertLine: 'end', newStr: 'omega', replace_all: false },
			makeContext(dir),
		)

		expect(result.success).toBe(true)
		expect(readFileSync(join(dir, 'doc.md'), 'utf-8')).toBe('alpha\nomega\n')
	})
})
