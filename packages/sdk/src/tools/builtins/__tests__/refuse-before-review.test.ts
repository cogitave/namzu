import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import type { FileReadTracker, ToolContext } from '../../../types/tool/index.js'
import { BashTool } from '../bash.js'
import { fingerprintContent } from '../content-fingerprint.js'
import { EditTool } from '../edit.js'
import { WriteFileTool } from '../write-file.js'

/**
 * A call the tool already knows it will refuse is refused before a person is
 * asked, with the words `execute` gives, so no dialog is followed by a failure.
 */

function tracker(store: Map<string, string>): FileReadTracker {
	return {
		recordRead: (key, content) => {
			if (content !== undefined) store.set(key, fingerprintContent(content))
		},
		hasRead: (key) => store.has(key),
		fingerprint: (key) => store.get(key),
	}
}

function ctx(dir: string, t?: FileReadTracker, extra: Partial<ToolContext> = {}): ToolContext {
	return {
		sessionId: '0190a5b2-7c3d-7e4f-8a9b-0c1d2e3f4a5b' as ToolContext['sessionId'],
		turnId: '9bf74d42-964f-4a93-aabb-d20245d81daf' as ToolContext['turnId'],
		workingDirectory: dir,
		abortSignal: new AbortController().signal,
		env: {},
		log: () => {},
		...(t ? { fileReadTracker: t } : {}),
		...extra,
	}
}

describe('refuseBeforeReview', () => {
	it('refuses an edit that does not match a file never read, with the run-time text', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'rbr-'))
		const file = join(dir, 'a.txt')
		writeFileSync(file, 'one\ntwo\n')
		const store = new Map<string, string>()
		const context = ctx(dir, tracker(store))
		const input = { path: file, old_string: 'absent', new_string: 'x' }
		const refusal = await EditTool.refuseBeforeReview?.(input, context)
		expect(refusal?.error).toContain('had not been read')
		// The contents were handed back, so the read is credited as at run time.
		expect(store.has(file)).toBe(true)
	})

	it('lets an edit through that matches a file never read', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'rbr-'))
		const file = join(dir, 'a.txt')
		writeFileSync(file, 'one\ntwo\n')
		const store = new Map<string, string>()
		const refusal = await EditTool.refuseBeforeReview?.(
			{ path: file, old_string: 'two', new_string: 'x' },
			ctx(dir, tracker(store)),
		)
		expect(refusal).toBeUndefined()
		expect(store.size).toBe(0)
	})

	it('refuses an edit whose text is not in a file that was read', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'rbr-'))
		const file = join(dir, 'a.txt')
		writeFileSync(file, 'one\ntwo\n')
		const store = new Map([[file, fingerprintContent('one\ntwo\n')]])
		const refusal = await EditTool.refuseBeforeReview?.(
			{ path: file, old_string: 'absent', new_string: 'x' },
			ctx(dir, tracker(store)),
		)
		expect(refusal?.error).toBeTruthy()
	})

	it('refuses a write over an existing file never read, and allows a new file', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'rbr-'))
		const file = join(dir, 'a.txt')
		writeFileSync(file, 'one\n')
		const context = ctx(dir, tracker(new Map()))
		const refusal = await WriteFileTool.refuseBeforeReview?.({ path: file, content: 'x' }, context)
		expect(refusal?.error).toContain('already exists')
		const fresh = await WriteFileTool.refuseBeforeReview?.(
			{ path: join(dir, 'new.txt'), content: 'x' },
			context,
		)
		expect(fresh).toBeUndefined()
	})

	it('refuses a command that opens with a long sleep only where jobs can be waited on', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'rbr-'))
		const input = { command: 'sleep 60 && echo done' }
		const withJobs = ctx(dir, undefined, {
			backgroundJobs: {} as ToolContext['backgroundJobs'],
		})
		const refusal = await BashTool.refuseBeforeReview?.(input as never, withJobs)
		expect(refusal?.error).toContain('Blocked')
		expect(await BashTool.refuseBeforeReview?.(input as never, ctx(dir))).toBeUndefined()
		expect(
			await BashTool.refuseBeforeReview?.({ command: 'sleep 2' } as never, withJobs),
		).toBeUndefined()
	})
})
