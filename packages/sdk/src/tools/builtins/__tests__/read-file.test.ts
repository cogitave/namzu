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
		expect(result.output).toBe('2\ttwo\n3\tthree')
	})
})
