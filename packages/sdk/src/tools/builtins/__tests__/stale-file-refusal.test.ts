import { lstatSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import type { FileReadTracker, ToolContext } from '../../../types/tool/index.js'
import { atomicWriteFile } from '../atomic-write-file.js'
import { fingerprintContent } from '../content-fingerprint.js'
import { EditTool } from '../edit.js'

/**
 * The mutation lock serializes THIS runtime's writers. It cannot see a
 * person editing in an editor, another process, or a second agent run —
 * and an edit computed against a body that has since moved is a lost
 * update whichever of those did the moving.
 *
 * Worse than undetected, it was misreported: an `old_string` that no
 * longer matches came back as "not found in file — make sure the string
 * matches exactly", which tells the agent its input was wrong when the
 * file changed underneath it. The agent then retries the same edit
 * against the same moved file.
 */

function trackerOver(store: Map<string, string>): FileReadTracker {
	return {
		recordRead: (key, content) => {
			if (content !== undefined) store.set(key, fingerprintContent(content))
		},
		hasRead: (key) => store.has(key),
		fingerprint: (key) => store.get(key),
	}
}

function contextWith(workingDirectory: string, tracker?: FileReadTracker): ToolContext {
	return {
		runId: 'run_stale' as ToolContext['runId'],
		workingDirectory,
		abortSignal: new AbortController().signal,
		env: {},
		log: () => {},
		...(tracker ? { fileReadTracker: tracker } : {}),
	}
}

describe('an edit against a file that moved is refused, not applied', () => {
	it('refuses when the body changed since the agent read it', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'namzu-stale-'))
		const file = join(dir, 'doc.md')
		writeFileSync(file, 'alpha\nbeta\n')

		const store = new Map<string, string>()
		const tracker = trackerOver(store)
		tracker.recordRead(file, 'alpha\nbeta\n')

		// Somebody else rewrites the very line this edit anchors on.
		writeFileSync(file, 'alpha\nBETA WAS REWRITTEN\n')

		const result = await EditTool.execute(
			{ path: 'doc.md', old_string: 'beta', new_string: 'gamma', replace_all: false },
			contextWith(dir, tracker),
		)

		expect(result.success).toBe(false)
		expect(result.error).toContain('changed on disk after you read it')
		// The refusal has to be actionable, and "nothing was written" is the
		// part that stops the agent re-running the same edit blind.
		expect(result.error).toContain('Read the file again')
		expect(result.error).toContain('Nothing was written')
		expect(readFileSync(file, 'utf-8')).toBe('alpha\nBETA WAS REWRITTEN\n')
	})

	it('applies normally when the file is untouched', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'namzu-stale-'))
		const file = join(dir, 'doc.md')
		writeFileSync(file, 'alpha\nbeta\n')

		const tracker = trackerOver(new Map())
		tracker.recordRead(file, 'alpha\nbeta\n')

		const result = await EditTool.execute(
			{ path: 'doc.md', old_string: 'beta', new_string: 'gamma', replace_all: false },
			contextWith(dir, tracker),
		)

		expect(result.success).toBe(true)
		expect(readFileSync(file, 'utf-8')).toBe('alpha\ngamma\n')
	})

	it('lets a second edit in the same turn proceed against what the first wrote', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'namzu-stale-'))
		const file = join(dir, 'doc.md')
		writeFileSync(file, 'alpha\nbeta\n')

		const tracker = trackerOver(new Map())
		tracker.recordRead(file, 'alpha\nbeta\n')
		const context = contextWith(dir, tracker)

		const first = await EditTool.execute(
			{ path: 'doc.md', old_string: 'beta', new_string: 'gamma', replace_all: false },
			context,
		)
		// Without re-fingerprinting after a successful write, this second edit
		// would see its own predecessor's output as someone else's drift.
		const second = await EditTool.execute(
			{ path: 'doc.md', old_string: 'alpha', new_string: 'omega', replace_all: false },
			context,
		)

		expect(first.success).toBe(true)
		expect(second.success).toBe(true)
		expect(readFileSync(file, 'utf-8')).toBe('omega\ngamma\n')
	})

	it('proceeds when the host tracks nothing, which is the older contract', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'namzu-stale-'))
		writeFileSync(join(dir, 'doc.md'), 'alpha\nbeta\n')

		// `fingerprint` is optional. A host that never captured one must not
		// have every edit refused.
		const result = await EditTool.execute(
			{ path: 'doc.md', old_string: 'beta', new_string: 'gamma', replace_all: false },
			contextWith(dir),
		)

		expect(result.success).toBe(true)
	})

	it('proceeds when the path was never read, so there is nothing to be stale against', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'namzu-stale-'))
		writeFileSync(join(dir, 'doc.md'), 'alpha\nbeta\n')

		const result = await EditTool.execute(
			{ path: 'doc.md', old_string: 'beta', new_string: 'gamma', replace_all: false },
			contextWith(dir, trackerOver(new Map())),
		)

		expect(result.success).toBe(true)
	})
})

describe('the fingerprint distinguishes bodies', () => {
	it('is stable for identical content', () => {
		expect(fingerprintContent('alpha\n')).toBe(fingerprintContent('alpha\n'))
	})

	it('differs on a one-character change', () => {
		expect(fingerprintContent('alpha\n')).not.toBe(fingerprintContent('alphb\n'))
	})

	it('differs on trailing whitespace, which a diff would also treat as a change', () => {
		expect(fingerprintContent('alpha')).not.toBe(fingerprintContent('alpha '))
	})
})

describe('an atomic commit writes through a symlink rather than over it', () => {
	/** Creating one needs a privilege this platform does not always grant. */
	function symlinkOrSkip(target: string, link: string): boolean {
		try {
			symlinkSync(target, link)
			return true
		} catch {
			return false
		}
	}

	it('keeps the link and updates its target', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'namzu-symlink-'))
		const real = join(dir, 'real.md')
		const link = join(dir, 'link.md')
		writeFileSync(real, 'original\n')
		if (!symlinkOrSkip(real, link)) return

		await atomicWriteFile(link, 'replaced\n')

		// `rename` onto the link path would have swapped the link for a plain
		// file, silently detaching every other path that pointed through it.
		expect(lstatSync(link).isSymbolicLink()).toBe(true)
		expect(readFileSync(real, 'utf-8')).toBe('replaced\n')
		expect(readFileSync(link, 'utf-8')).toBe('replaced\n')
	})

	it('still creates a file that does not exist yet', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'namzu-symlink-'))
		const fresh = join(dir, 'new.md')

		await atomicWriteFile(fresh, 'created\n')

		expect(readFileSync(fresh, 'utf-8')).toBe('created\n')
	})
})

describe('drift that does not touch the anchor is not a conflict', () => {
	it('applies when someone changed an unrelated part of the file', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'namzu-stale-'))
		const file = join(dir, 'doc.md')
		writeFileSync(file, 'alpha\nbeta\n')

		const tracker = trackerOver(new Map())
		tracker.recordRead(file, 'alpha\nbeta\n')

		// Someone appends a line. The edit's anchor is untouched, so the edit
		// is still exactly as well defined as when it was computed —
		// refusing here would reject a safe edit every time anybody wrote
		// anywhere in the file.
		writeFileSync(file, 'alpha\nbeta\nan unrelated new line\n')

		const result = await EditTool.execute(
			{ path: 'doc.md', old_string: 'beta', new_string: 'gamma', replace_all: false },
			contextWith(dir, tracker),
		)

		expect(result.success).toBe(true)
		expect(readFileSync(file, 'utf-8')).toBe('alpha\ngamma\nan unrelated new line\n')
	})

	it('reports a genuinely wrong anchor as wrong, not as drift', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'namzu-stale-'))
		const file = join(dir, 'doc.md')
		writeFileSync(file, 'alpha\nbeta\n')

		const tracker = trackerOver(new Map())
		tracker.recordRead(file, 'alpha\nbeta\n')

		// Nothing moved. The anchor is simply not in the file, and telling
		// the agent to re-read would send it to look for a change that never
		// happened.
		const result = await EditTool.execute(
			{ path: 'doc.md', old_string: 'nowhere', new_string: 'x', replace_all: false },
			contextWith(dir, tracker),
		)

		expect(result.success).toBe(false)
		expect(result.error).toContain('not found in file')
		expect(result.error).not.toContain('changed on disk')
	})

	it('reports drift when the anchor became ambiguous because of it', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'namzu-stale-'))
		const file = join(dir, 'doc.md')
		writeFileSync(file, 'alpha\nbeta\n')

		const tracker = trackerOver(new Map())
		tracker.recordRead(file, 'alpha\nbeta\n')

		// A second copy of the anchor appears. "not unique — add more
		// context" would send the agent to widen an anchor that was unique
		// when it read the file.
		writeFileSync(file, 'alpha\nbeta\nbeta\n')

		const result = await EditTool.execute(
			{ path: 'doc.md', old_string: 'beta', new_string: 'gamma', replace_all: false },
			contextWith(dir, tracker),
		)

		expect(result.success).toBe(false)
		expect(result.error).toContain('changed on disk')
	})
})
