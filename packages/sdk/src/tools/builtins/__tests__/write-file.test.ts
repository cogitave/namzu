import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { FileReadTracker, ToolContext } from '../../../types/tool/index.js'
import { WriteFileTool } from '../write-file.js'

function makeTracker(): FileReadTracker & { keys(): string[] } {
	const set = new Set<string>()
	return {
		recordRead: (key) => {
			set.add(key)
		},
		hasRead: (key) => set.has(key),
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

describe('WriteFileTool — canonical contract and read-before-overwrite invariant', () => {
	it('publishes one closed path + content contract', () => {
		expect(WriteFileTool.modelInputSchema).toEqual({
			type: 'object',
			properties: {
				path: {
					type: 'string',
					description: 'Non-empty path to the file to write.',
				},
				content: {
					type: 'string',
					description:
						'Complete bounded file body. May be empty only for an intentionally empty file.',
				},
			},
			required: ['path', 'content'],
			additionalProperties: false,
		})
		expect(WriteFileTool.inputSchema.safeParse({ path: 'doc.md', content: '' }).success).toBe(true)
		expect(WriteFileTool.inputSchema.safeParse({ path: 'doc.md', newStr: 'legacy' }).success).toBe(
			false,
		)
		expect(WriteFileTool.inputSchema.safeParse({ path: '   ', content: 'body' }).success).toBe(
			false,
		)
	})

	it('writes a new file without requiring a prior read', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'namzu-write-'))
		const tracker = makeTracker()
		const ctx = makeContext(dir, tracker)

		const result = await WriteFileTool.execute({ path: 'fresh.txt', content: 'hello' }, ctx)

		expect(result.success).toBe(true)
		expect(readFileSync(join(dir, 'fresh.txt'), 'utf-8')).toBe('hello')
		expect(tracker.hasRead(join(dir, 'fresh.txt'))).toBe(true)
	})

	it('preserves edge whitespace in a valid path', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'namzu-write-'))

		const result = await WriteFileTool.execute(
			{ path: ' fresh.txt ', content: 'hello' },
			makeContext(dir),
		)

		expect(result.success).toBe(true)
		expect(readFileSync(join(dir, ' fresh.txt '), 'utf-8')).toBe('hello')
	})

	it('rejects legacy content aliases even when execute is called directly', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'namzu-write-'))

		const result = await WriteFileTool.execute(
			{ path: 'fresh.txt', newStr: 'legacy' } as never,
			makeContext(dir),
		)

		expect(result.success).toBe(false)
		expect(result.error).toContain('Invalid write input')
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

	it('preserves existing hosts without a file read tracker', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'namzu-write-'))
		writeFileSync(join(dir, 'existing.txt'), 'before')
		const ctx = makeContext(dir)

		const result = await WriteFileTool.execute({ path: 'existing.txt', content: 'after' }, ctx)

		expect(result.success).toBe(true)
		expect(readFileSync(join(dir, 'existing.txt'), 'utf-8')).toBe('after')
	})
})
