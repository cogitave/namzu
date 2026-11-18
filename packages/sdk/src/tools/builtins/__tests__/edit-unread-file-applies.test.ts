import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import type { ToolContext } from '../../../types/tool/index.js'
import { createFileReadTracker } from '../../file-read-tracker.js'
import { EditTool } from '../edit.js'

/**
 * A model often learns a file's text from a shell print or a search and then
 * edits with an exact `old_string`. Refusing that edit as unread costs a request
 * per file for nothing: the text matched. A file the session has not read is
 * read by `edit` itself, and an exact match is applied.
 */

function setup(body = 'alpha\nbeta\ngamma\n') {
	const dir = mkdtempSync(join(tmpdir(), 'namzu-edit-unread-'))
	writeFileSync(join(dir, 'doc.md'), body)
	const tracker = createFileReadTracker()
	const context: ToolContext = {
		sessionId: '0190a5b2-7c3d-7e4f-8a9b-0c1d2e3f4a5b' as ToolContext['sessionId'],
		turnId: 'd71ecfcb-287a-445a-a34e-48026d38d820' as ToolContext['turnId'],
		workingDirectory: dir,
		abortSignal: new AbortController().signal,
		env: {},
		log: () => {},
		fileReadTracker: tracker,
	}
	return { dir, tracker, context, read: () => readFileSync(join(dir, 'doc.md'), 'utf-8') }
}

describe('edit on a file the session has not read', () => {
	it('applies a unique match in one call and says so briefly', async () => {
		const { context, read, tracker, dir } = setup()
		const result = await EditTool.execute(
			{ path: 'doc.md', old_string: 'beta', new_string: 'delta' },
			context,
		)
		expect(result.success).toBe(true)
		expect(result.output).toContain('1 replacement(s)')
		expect(result.output).toContain('file was not read before')
		expect(read()).toBe('alpha\ndelta\ngamma\n')
		expect(tracker.hasRead(join(dir, 'doc.md'))).toBe(true)
	})

	it('refuses and shows the contents when the text is not found', async () => {
		const { context, read } = setup()
		const result = await EditTool.execute(
			{ path: 'doc.md', old_string: 'betta', new_string: 'delta' },
			context,
		)
		expect(result.success).toBe(false)
		expect(result.error).toContain('had not been read in this session')
		expect(result.error).toContain('2\tbeta')
		expect(read()).toBe('alpha\nbeta\ngamma\n')
	})

	it('refuses an ambiguous match as before', async () => {
		const { context, read } = setup('alpha\nalpha\n')
		const result = await EditTool.execute(
			{ path: 'doc.md', old_string: 'alpha', new_string: 'delta' },
			context,
		)
		expect(result.success).toBe(false)
		expect(result.error).toContain('had not been read in this session')
		expect(read()).toBe('alpha\nalpha\n')
	})

	it('applies replace_all on an unread file', async () => {
		const { context, read } = setup('alpha\nalpha\n')
		const result = await EditTool.execute(
			{ path: 'doc.md', old_string: 'alpha', new_string: 'delta', replace_all: true },
			context,
		)
		expect(result.success).toBe(true)
		expect(result.output).toContain('2 replacement(s)')
		expect(read()).toBe('delta\ndelta\n')
	})

	it('allows a later edit on the same file', async () => {
		const { context, read } = setup()
		await EditTool.execute({ path: 'doc.md', old_string: 'beta', new_string: 'delta' }, context)
		const second = await EditTool.execute(
			{ path: 'doc.md', old_string: 'gamma', new_string: 'omega' },
			context,
		)
		expect(second.success).toBe(true)
		expect(second.output).not.toContain('file was not read before')
		expect(read()).toBe('alpha\ndelta\nomega\n')
	})

	it('still refuses a file that was read and then changed on disk', async () => {
		const { context, read, tracker, dir } = setup()
		const path = join(dir, 'doc.md')
		tracker.recordRead(path, 'alpha\nbeta\ngamma\n')
		writeFileSync(path, 'alpha\nbeta\ngamma\nextra\n')
		const result = await EditTool.execute(
			{ path: 'doc.md', old_string: 'beta', new_string: 'delta' },
			context,
		)
		expect(result.success).toBe(false)
		expect(result.error).toContain('changed')
		expect(read()).toBe('alpha\nbeta\ngamma\nextra\n')
	})
})
