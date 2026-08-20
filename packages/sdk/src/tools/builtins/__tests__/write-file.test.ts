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

/**
 * The published contract, pinned exactly.
 *
 * This was dropped when the tool gained `newStr`, and dropping it is what let
 * the two contracts drift apart silently. They are deliberately NOT the same
 * contract, and that is the thing worth recording: a host driving `execute`
 * directly may pass `newStr`, and a model may not — because a model given two
 * names for the body has to choose, and choosing is what produces the
 * half-filled calls the closed model schema exists to prevent. Nothing said
 * that out loud once the test asserting it was rewritten to assert the
 * opposite.
 */
describe('WriteFileTool — the published contract', () => {
	it('publishes one closed path + content shape to the model', () => {
		expect(WriteFileTool.modelInputSchema).toEqual({
			type: 'object',
			properties: {
				path: {
					type: 'string',
					description: 'Relative path to the file to write. Must not be empty.',
				},
				content: {
					type: 'string',
					description:
						'Complete file body. Use "" only for an intentionally empty file. Keep under 12000 characters.',
				},
			},
			required: ['path', 'content'],
			additionalProperties: false,
		})
		expect(WriteFileTool.enforceModelInput).toBe(true)
	})

	it('keeps newStr off the model surface while accepting it from a host', () => {
		const modelProperties = WriteFileTool.modelInputSchema?.properties as Record<string, unknown>
		expect(Object.keys(modelProperties)).not.toContain('newStr')

		// The execution schema is the wider one, on purpose.
		expect(WriteFileTool.inputSchema.safeParse({ path: 'doc.md', newStr: 'body' }).success).toBe(
			true,
		)
	})

	it('requires a body under one name or the other', () => {
		expect(WriteFileTool.inputSchema.safeParse({ path: 'doc.md' }).success).toBe(false)
		// An empty string is a body — an intentionally empty file is legal.
		expect(WriteFileTool.inputSchema.safeParse({ path: 'doc.md', content: '' }).success).toBe(true)
	})

	it('refuses a whitespace-only path but not a path with edge whitespace', async () => {
		expect(WriteFileTool.inputSchema.safeParse({ path: '   ', content: 'body' }).success).toBe(
			false,
		)

		// The refusal above must not over-reach: ' fresh.txt ' is a legal name
		// on every filesystem this runs on, and trimming it would write to a
		// different file than the caller asked for.
		const dir = mkdtempSync(join(tmpdir(), 'namzu-write-'))
		const result = await WriteFileTool.execute(
			{ path: ' fresh.txt ', content: 'hello' },
			makeContext(dir),
		)

		expect(result.success).toBe(true)
		expect(readFileSync(join(dir, ' fresh.txt '), 'utf-8')).toBe('hello')
	})

	it('rejects an undeclared field even when execute is called directly', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'namzu-write-'))

		const result = await WriteFileTool.execute(
			{ path: 'fresh.txt', content: 'hello', append: true } as never,
			makeContext(dir),
		)

		expect(result.success).toBe(false)
		expect(result.error).toContain('Invalid write input')
	})
})

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

	it('accepts newStr as the canonical create/write content alias', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'namzu-write-'))
		const tracker = makeTracker()
		const ctx = makeContext(dir, tracker)

		const result = await WriteFileTool.execute({ path: 'fresh.txt', newStr: 'hello' }, ctx)

		expect(result.success).toBe(true)
		expect(readFileSync(join(dir, 'fresh.txt'), 'utf-8')).toBe('hello')
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

	it('does not invent freshness for an older boolean-only tracker', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'namzu-write-'))
		const filePath = join(dir, 'legacy-tracker.txt')
		writeFileSync(filePath, 'the agent read this')
		const tracker = makeTracker()
		tracker.recordRead(filePath)
		// The host never supplied a fingerprint. A later body cannot be
		// compared to evidence that does not exist, so the old behavior stays.
		writeFileSync(filePath, 'changed after the boolean observation')

		const result = await WriteFileTool.execute(
			{ path: 'legacy-tracker.txt', content: 'replacement' },
			makeContext(dir, tracker),
		)

		expect(result.success).toBe(true)
		expect(readFileSync(filePath, 'utf-8')).toBe('replacement')
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
