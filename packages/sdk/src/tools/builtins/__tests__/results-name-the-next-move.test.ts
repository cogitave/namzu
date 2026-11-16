import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import type { FileReadTracker, ToolContext } from '../../../types/tool/index.js'
import { CURRENT_ON_DISK, fingerprintContent } from '../content-fingerprint.js'
import { EditTool } from '../edit.js'
import { GrepTool } from '../grep.js'
import { ReadFileTool } from '../read-file.js'
import { WriteFileTool } from '../write-file.js'

/**
 * Five results say the next correct move because a wrong one was common in the
 * benchmark runs: reading a file back after a write (16 times), reading again
 * a file the refusal had just handed over (10), guessing another path after
 * "no such file" (9), writing over a file nobody read (6), and re-asking a
 * search with an inline flag that does not exist (5). Tool descriptions are
 * unchanged.
 */

function context(workingDirectory: string, tracker?: FileReadTracker): ToolContext {
	return {
		sessionId: '0190a5b2-7c3d-7e4f-8a9b-0c1d2e3f4a5b' as ToolContext['sessionId'],
		turnId: '9bf74d42-964f-4a93-aabb-d20245d81daf' as ToolContext['turnId'],
		workingDirectory,
		abortSignal: new AbortController().signal,
		env: {},
		log: () => {},
		...(tracker ? { fileReadTracker: tracker } : {}),
	}
}

function tracker(): FileReadTracker {
	const store = new Map<string, string>()
	return {
		recordRead: (key, content) => {
			if (content !== undefined) store.set(key, fingerprintContent(content))
		},
		hasRead: (key) => store.has(key),
		fingerprint: (key) => store.get(key),
	}
}

const scratch = () => mkdtempSync(join(tmpdir(), 'namzu-next-move-'))

describe('a write or an edit that went through', () => {
	it('says the file is current and needs no read-back', async () => {
		const dir = scratch()
		const created = await WriteFileTool.execute({ path: 'new.txt', content: 'one\n' }, context(dir))
		expect(created.success).toBe(true)
		expect(created.output).toMatch(/ bytes\. The file on disk is now exactly this/)
		expect(created.output.endsWith(CURRENT_ON_DISK)).toBe(true)

		writeFileSync(join(dir, 'doc.md'), 'alpha\nbeta\n')
		const read = tracker()
		await ReadFileTool.execute({ path: 'doc.md' }, context(dir, read))
		const edited = await EditTool.execute(
			{ path: 'doc.md', old_string: 'beta', new_string: 'gamma', replace_all: false },
			context(dir, read),
		)
		expect(edited.success).toBe(true)
		expect(edited.output).toContain('replacement(s) (+1 -1).')
		expect(edited.output.endsWith(CURRENT_ON_DISK)).toBe(true)
	})
})

describe('an edit refused because the file was never read', () => {
	it('hands the file over and says not to read it again', async () => {
		const dir = scratch()
		writeFileSync(join(dir, 'doc.md'), 'alpha\nbeta\n')
		const refused = await EditTool.execute(
			{ path: 'doc.md', old_string: 'beta', new_string: 'gamma', replace_all: false },
			context(dir, tracker()),
		)
		expect(refused.success).toBe(false)
		expect(refused.error).toContain('without reading the file again')
		expect(refused.error).toContain('1\talpha')
	})
})

describe('a path that does not exist', () => {
	it.each([
		['read', () => ReadFileTool.execute({ path: 'src/nope.js' }, context(scratch()))],
		[
			'edit',
			() =>
				EditTool.execute(
					{ path: 'src/nope.js', old_string: 'a', new_string: 'b', replace_all: false },
					context(scratch(), tracker()),
				),
		],
	])('is answered with where to look, by %s', async (_tool, run) => {
		const result = await run()
		expect(result.success).toBe(false)
		expect(result.error).toContain('ENOENT')
		expect(result.error).toContain('Find the file with `glob` instead of trying another guess.')
	})

	it('adds nothing to a failure that is not a missing path', async () => {
		const dir = scratch()
		const result = await GrepTool.execute({ pattern: '(' } as never, context(dir))
		expect(result.error ?? '').not.toContain('Find the file with `glob`')
	})
})

describe('a write over a file that exists', () => {
	it('says a second write without reading fails the same way', async () => {
		const dir = scratch()
		writeFileSync(join(dir, 'a.txt'), 'old\n')
		const refused = await WriteFileTool.execute(
			{ path: 'a.txt', content: 'new\n' },
			context(dir, tracker()),
		)
		expect(refused.success).toBe(false)
		expect(refused.error).toContain('Calling `write` again without reading it fails the same way.')
	})
})

describe('a search with an inline regex flag', () => {
	it('names the parameter that does what the flag was for', async () => {
		const dir = scratch()
		writeFileSync(join(dir, 'a.txt'), 'Upload\n')
		const refused = await GrepTool.execute({ pattern: '(?i)upload' } as never, context(dir))
		expect(refused.success).toBe(false)
		expect(refused.error).toContain('Invalid regex pattern')
		expect(refused.error).toContain('set `case_sensitive: false`')
	})
})
