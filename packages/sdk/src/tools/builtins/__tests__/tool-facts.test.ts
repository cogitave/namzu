import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { ToolContext } from '../../../types/tool/index.js'
import { admitToolFacts } from '../../admit-facts.js'
import { defineTool } from '../../defineTool.js'
import { failureFactsFromError } from '../../failure-facts.js'
import { createFileReadTracker } from '../../file-read-tracker.js'
import { looksBinary, windowText } from '../../text-window.js'
import { EditTool } from '../edit.js'
import { GlobTool } from '../glob.js'
import { GrepTool } from '../grep.js'
import { ReadFileTool } from '../read-file.js'
import { WriteFileTool } from '../write-file.js'

/**
 * What a tool tells a host about a call as fields, so the person's view never
 * reads the model's prose. The model's own `output` is asserted unchanged
 * elsewhere; these assert the fields beside it.
 */

function project(): { dir: string; ctx: ToolContext } {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), 'namzu-facts-')))
	const ctx = {
		sessionId: '0190a5b2-7c3d-7e4f-8a9b-0c1d2e3f4a5b',
		turnId: '4adf3fdd-2823-4640-be0a-5d21fe28b6d2',
		workingDirectory: dir,
		abortSignal: new AbortController().signal,
		env: {},
		log: () => {},
	} as unknown as ToolContext
	return { dir, ctx }
}

describe('windowText', () => {
	it('keeps short text whole', () => {
		expect(windowText('a\nb\nc\n')).toEqual({
			head: 'a\nb\nc',
			totalLines: 3,
			totalBytes: 6,
		})
	})

	it('keeps the head and the tail of a long text and counts what lay between', () => {
		const text = `${Array.from({ length: 600 }, (_, i) => String(i + 1)).join('\n')}\n`
		const window = windowText(text)
		expect(window.totalLines).toBe(600)
		expect(window.head.split('\n')[0]).toBe('1')
		expect(window.tail?.split('\n').at(-1)).toBe('600')
		const shown = window.head.split('\n').length + (window.tail?.split('\n').length ?? 0)
		expect(window.omittedLines).toBe(600 - shown)
	})

	it('never cuts a surrogate pair when it clips a long line', () => {
		const window = windowText('😀'.repeat(20_000))
		expect(window.head.endsWith('…')).toBe(true)
		expect(window.head).not.toMatch(/[\ud800-\udbff]…$/)
	})

	it('has no lines for empty text', () => {
		expect(windowText('')).toEqual({ head: '', totalLines: 0, totalBytes: 0 })
	})
})

describe('looksBinary', () => {
	it('calls text with colour codes and Turkish letters text', () => {
		expect(looksBinary('\u001b[31mkırmızı\u001b[0m şğüöçı\n\tdone')).toBe(false)
	})

	it('calls a NUL byte binary', () => {
		expect(looksBinary('abc\u0000def')).toBe(true)
	})

	it('calls a stream of replacement characters binary', () => {
		expect(looksBinary('�'.repeat(50) + 'x'.repeat(50))).toBe(true)
	})
})

describe('failureFactsFromError', () => {
	it('reads the kind from the error code and the subject from its path', () => {
		expect(failureFactsFromError({ code: 'ENOENT', path: '/p/missing.txt' })).toEqual({
			kind: 'failure',
			reason: 'not_found',
			subject: '/p/missing.txt',
		})
		expect(failureFactsFromError({ code: 'EACCES' })).toEqual({
			kind: 'failure',
			reason: 'permission_denied',
		})
		expect(failureFactsFromError({ code: 'EISDIR' })).toMatchObject({
			reason: 'not_a_file',
		})
	})

	it('has no opinion on an error it does not know', () => {
		expect(failureFactsFromError(new Error('ENOENT: in the message only'))).toBeUndefined()
	})
})

describe('defineTool', () => {
	it('carries the failure kind of a thrown filesystem error and keeps the model text', async () => {
		const tool = defineTool({
			name: 'probe',
			description: 'probe',
			inputSchema: z.object({}),
			category: 'filesystem',
			permissions: [],
			readOnly: true,
			destructive: false,
			concurrencySafe: true,
			async execute() {
				throw Object.assign(new Error("ENOENT: no such file or directory, open '/p/x'"), {
					code: 'ENOENT',
					path: '/p/x',
				})
			},
		})
		const result = await tool.execute({}, project().ctx)
		expect(result.success).toBe(false)
		expect(result.error).toBe("probe failed: ENOENT: no such file or directory, open '/p/x'")
		expect(result.facts).toEqual({
			kind: 'failure',
			reason: 'not_found',
			subject: '/p/x',
		})
	})
})

describe('read', () => {
	it('names the file on the call', () => {
		expect(ReadFileTool.presentCall?.({ path: 'a.ts' } as never)).toMatchObject({
			facts: { kind: 'read', path: 'a.ts' },
		})
	})

	it('reports size and lines of a text file', async () => {
		const { dir, ctx } = project()
		writeFileSync(join(dir, 'a.ts'), 'export const a = 1\nexport const b = 2\n')
		const result = await ReadFileTool.execute({ path: 'a.ts' } as never, ctx)
		expect(result.facts).toEqual({
			kind: 'read',
			path: join(dir, 'a.ts'),
			bytes: 38,
			totalLines: 2,
			returnedLines: 2,
		})
		expect(result.output).toContain('1\t')
	})

	it('marks a file that is not text and still gives the model its rendering', async () => {
		const { dir, ctx } = project()
		writeFileSync(join(dir, 'blob.bin'), Buffer.from(Array.from({ length: 4096 }, (_, i) => i % 7)))
		const result = await ReadFileTool.execute({ path: 'blob.bin' } as never, ctx)
		expect(result.facts).toMatchObject({
			kind: 'read',
			binary: true,
			bytes: 4096,
		})
	})
})

describe('grep and glob', () => {
	it('report what they searched for and what they found, as numbers', async () => {
		const { dir, ctx } = project()
		writeFileSync(join(dir, 'a.ts'), 'export const a = 1\n')
		writeFileSync(join(dir, 'b.ts'), 'export const b = 2\n')
		const grep = await GrepTool.execute(
			GrepTool.inputSchema.parse({ pattern: 'export', path: '.' }) as never,
			ctx,
		)
		expect(grep.facts).toMatchObject({
			kind: 'search',
			pattern: 'export',
			matches: 2,
			filesMatched: 2,
			truncated: false,
		})
		const glob = await GlobTool.execute(
			GlobTool.inputSchema.parse({ pattern: '**/*.ts' }) as never,
			ctx,
		)
		expect(glob.facts).toMatchObject({
			kind: 'list',
			pattern: '**/*.ts',
			count: 2,
			truncated: false,
		})
	})

	it('name what was asked on the call', () => {
		expect(GrepTool.presentCall?.({ pattern: 'export', path: 'src' } as never)).toMatchObject({
			facts: { kind: 'search', pattern: 'export', path: 'src' },
		})
		expect(GlobTool.presentCall?.({ pattern: '**/*.ts' } as never)).toMatchObject({
			facts: { kind: 'list', pattern: '**/*.ts' },
		})
	})
})

describe('edit and write', () => {
	it('edit reports the file and how many replacements', async () => {
		const { dir, ctx } = project()
		writeFileSync(join(dir, 'a.ts'), 'export const a = 1\n')
		const result = await EditTool.execute(
			{ path: 'a.ts', old_string: 'a = 1', new_string: 'a = 2' } as never,
			ctx,
		)
		expect(result.success).toBe(true)
		expect(result.facts).toEqual({
			kind: 'edit',
			path: join(dir, 'a.ts'),
			replacements: 1,
			added: 1,
			removed: 1,
			hunks: [
				{
					oldStart: 1,
					oldLines: 1,
					newStart: 1,
					newLines: 1,
					lines: ['-export const a = 1', '+export const a = 2'],
				},
			],
		})
		expect(result.output).toContain('1 replacement(s) (+1 -1)')
	})

	it('write says created for a new file and updated for a replaced one', async () => {
		const { dir, ctx } = project()
		mkdirSync(join(dir, 'new'))
		const created = await WriteFileTool.execute({ path: 'new/n.txt', content: 'one\n' }, ctx)
		expect(created.facts).toMatchObject({
			kind: 'write',
			operation: 'created',
			bytes: 4,
		})
		const tracker = createFileReadTracker()
		tracker.recordRead(join(dir, 'new', 'n.txt'), 'one\n')
		const updated = await WriteFileTool.execute({ path: 'new/n.txt', content: 'two\nthree\n' }, {
			...ctx,
			fileReadTracker: tracker,
		} as never)
		expect(updated.error).toBeUndefined()
		expect(updated.facts).toMatchObject({
			kind: 'write',
			operation: 'updated',
			added: 2,
			removed: 1,
		})
	})

	it('write over a file nobody read is an already_exists failure', async () => {
		const { dir, ctx } = project()
		writeFileSync(join(dir, 'out.txt'), 'x')
		const tracker = createFileReadTracker()
		const result = await WriteFileTool.execute({ path: 'out.txt', content: 'y' }, {
			...ctx,
			fileReadTracker: tracker,
		} as never)
		expect(result.success).toBe(false)
		expect(result.facts).toMatchObject({
			kind: 'failure',
			reason: 'already_exists',
		})
	})
})

describe('admitToolFacts', () => {
	it('keeps the closed shape and drops everything else', () => {
		expect(
			admitToolFacts({
				kind: 'command',
				command: 'npm test',
				exitCode: 1,
				stdout: { head: 'a long output', totalLines: 1, totalBytes: 13 },
				extra: 'x',
			}),
		).toEqual({ kind: 'command', command: 'npm test', exitCode: 1 })
	})

	it('refuses a shape it does not know and a field of the wrong type', () => {
		expect(admitToolFacts({ kind: 'teleport' })).toBeUndefined()
		expect(admitToolFacts({ kind: 'read', path: 3 })).toBeUndefined()
		expect(admitToolFacts({ kind: 'failure', reason: 'because' })).toBeUndefined()
		expect(admitToolFacts('read')).toBeUndefined()
		expect(admitToolFacts({ kind: 'write', path: 'a', operation: 'deleted' })).toBeUndefined()
	})

	it('reads a write back with its operation', () => {
		expect(
			admitToolFacts({
				kind: 'write',
				path: 'n.txt',
				operation: 'created',
				bytes: 4,
			}),
		).toEqual({ kind: 'write', path: 'n.txt', operation: 'created', bytes: 4 })
	})
})
