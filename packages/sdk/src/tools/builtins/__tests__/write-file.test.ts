import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { FileReadTracker, ToolContext } from '../../../types/tool/index.js'
import { WriteFileTool } from '../write-file.js'

function makeTracker(): FileReadTracker & { keys(): string[] } {
	const set = new Set<string>()
	return {
		recordRead: (k) => {
			set.add(k)
		},
		hasRead: (k) => set.has(k),
		keys: () => Array.from(set),
	}
}

function makeContext(workingDirectory: string, tracker?: FileReadTracker): ToolContext {
	return {
		runId: 'run_test' as ToolContext['runId'],
		workingDirectory,
		abortSignal: new AbortController().signal,
		env: {},
		log: () => {},
		fileReadTracker: tracker,
	}
}

describe('WriteFileTool — read-before-overwrite invariant', () => {
	it('writes a new file without requiring a prior read', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'namzu-write-'))
		const tracker = makeTracker()
		const ctx = makeContext(dir, tracker)

		const result = await WriteFileTool.execute({ path: 'fresh.txt', content: 'hello' }, ctx)

		expect(result.success).toBe(true)
		expect(readFileSync(join(dir, 'fresh.txt'), 'utf-8')).toBe('hello')
		expect(tracker.hasRead(join(dir, 'fresh.txt'))).toBe(true)
	})

	it('refuses to overwrite an existing file the agent has not read', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'namzu-write-'))
		writeFileSync(join(dir, 'pre-existing.txt'), 'original')
		const tracker = makeTracker()
		const ctx = makeContext(dir, tracker)

		const result = await WriteFileTool.execute(
			{ path: 'pre-existing.txt', content: 'replaced' },
			ctx,
		)

		expect(result.success).toBe(false)
		expect(result.error).toMatch(/already exists.*read/i)
		expect(readFileSync(join(dir, 'pre-existing.txt'), 'utf-8')).toBe('original')
	})

	it('allows overwrite once the file has been read in the same context', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'namzu-write-'))
		const filePath = join(dir, 'pre-existing.txt')
		writeFileSync(filePath, 'original')
		const tracker = makeTracker()
		tracker.recordRead(filePath)
		const ctx = makeContext(dir, tracker)

		const result = await WriteFileTool.execute(
			{ path: 'pre-existing.txt', content: 'replaced' },
			ctx,
		)

		expect(result.success).toBe(true)
		expect(readFileSync(filePath, 'utf-8')).toBe('replaced')
	})

	it('falls back to legacy behaviour when no fileReadTracker is provided (back-compat)', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'namzu-write-'))
		writeFileSync(join(dir, 'legacy.txt'), 'before')
		const ctx = makeContext(dir)

		const result = await WriteFileTool.execute({ path: 'legacy.txt', content: 'after' }, ctx)

		expect(result.success).toBe(true)
		expect(readFileSync(join(dir, 'legacy.txt'), 'utf-8')).toBe('after')
	})
})
