import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ToolContext } from '../../../types/tool/index.js'
import { VerifyOutputsTool } from '../verify-outputs.js'

function makeContext(workingDirectory: string): ToolContext {
	return {
		runId: 'run_test' as ToolContext['runId'],
		workingDirectory,
		abortSignal: new AbortController().signal,
		env: {},
		log: () => {},
	}
}

describe('VerifyOutputsTool', () => {
	it('reports OK for every existing non-empty file', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'namzu-verify-'))
		writeFileSync(join(dir, 'a.md'), 'hello world')
		writeFileSync(join(dir, 'b.txt'), 'x'.repeat(500))

		const result = await VerifyOutputsTool.execute(
			{ paths: ['a.md', 'b.txt'] },
			makeContext(dir),
		)

		expect(result.success).toBe(true)
		expect(result.output).toMatch(/2\/2 passed/)
		expect(result.output).toMatch(/OK   a\.md/)
		expect(result.output).toMatch(/OK   b\.txt/)
	})

	it('flags missing files as FAIL with summary', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'namzu-verify-'))
		writeFileSync(join(dir, 'present.md'), 'data')

		const result = await VerifyOutputsTool.execute(
			{ paths: ['present.md', 'missing.md', 'also-missing.md'] },
			makeContext(dir),
		)

		expect(result.success).toBe(false)
		expect(result.error).toMatch(/2 of 3 expected outputs failed/)
		expect(result.output).toMatch(/1\/3 passed/)
		expect(result.output).toMatch(/FAIL missing\.md — missing/)
	})

	it('treats files smaller than min_bytes as FAIL', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'namzu-verify-'))
		writeFileSync(join(dir, 'tiny.md'), 'x') // 1 byte
		writeFileSync(join(dir, 'big.md'), 'y'.repeat(2000))

		const result = await VerifyOutputsTool.execute(
			{ paths: ['tiny.md', 'big.md'], min_bytes: 1000 },
			makeContext(dir),
		)

		expect(result.success).toBe(false)
		expect(result.output).toMatch(/FAIL tiny\.md — size 1B < min 1000B/)
		expect(result.output).toMatch(/OK   big\.md/)
	})

	it('rejects directories that match a path', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'namzu-verify-'))
		const result = await VerifyOutputsTool.execute(
			{ paths: ['.'] }, // working directory itself
			makeContext(dir),
		)
		expect(result.success).toBe(false)
		expect(result.output).toMatch(/FAIL \. — not a regular file/)
	})
})
