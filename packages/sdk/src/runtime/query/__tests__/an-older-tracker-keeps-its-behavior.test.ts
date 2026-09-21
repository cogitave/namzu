import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { removeTempDirs } from '../../../__fixtures__/temp-dir.js'
import { fingerprintContent } from '../../../tools/builtins/content-fingerprint.js'
import { EditTool } from '../../../tools/builtins/edit.js'
import { WriteFileTool } from '../../../tools/builtins/write-file.js'
import type { Message } from '../../../types/message/index.js'
import type { FileReadTracker, ToolContext } from '../../../types/tool/index.js'
import { describeVisibleFileEvidence } from '../file-evidence-context.js'

/**
 * `editChain` and `recordEdit` are optional on the interface, and a host that
 * implemented the ledger against the older shape never gets to find that out
 * by being wrong. The tool below falls back to `recordRead`, so this tracker
 * sees the same three calls it saw before chains existed and answers the same
 * question the same way: after an edit, the body is no longer the write call's
 * body, and the projection says nothing about the path.
 */
function olderTracker(): FileReadTracker & { calls: string[] } {
	const fingerprints = new Map<string, string>()
	const writes = new Map<string, string>()
	const paths = new Set<string>()
	const calls: string[] = []
	return {
		calls,
		recordRead(key, content, fullWriteCallId) {
			calls.push(`recordRead:${content === undefined ? '-' : 'content'}:${fullWriteCallId ?? '-'}`)
			paths.add(key)
			const next = content === undefined ? undefined : fingerprintContent(content)
			if (next === undefined || next !== fingerprints.get(key)) writes.delete(key)
			if (next !== undefined) fingerprints.set(key, next)
			else fingerprints.delete(key)
			if (next !== undefined && fullWriteCallId) writes.set(key, fullWriteCallId)
		},
		hasRead: (key) => paths.has(key),
		fingerprint: (key) => fingerprints.get(key),
		writeCallId: (key) => writes.get(key),
	}
}

function contextIn(cwd: string, tracker: FileReadTracker, toolUseId: string): ToolContext {
	return {
		turnId: '5b1d3b6a-59f7-4f4b-9d4f-7f8f8a0d2a11' as ToolContext['runId'],
		workingDirectory: cwd,
		abortSignal: new AbortController().signal,
		env: {},
		log: () => {},
		fileReadTracker: tracker,
		toolUseId,
	}
}

function history(path: string, body: string): Message[] {
	return [
		{
			role: 'assistant',
			content: null,
			toolCalls: [
				{
					id: 'w',
					type: 'function',
					function: { name: 'write', arguments: JSON.stringify({ path, content: body }) },
				},
			],
		},
		{ role: 'tool', toolCallId: 'w', content: 'Created file', isError: false },
		{
			role: 'assistant',
			content: null,
			toolCalls: [
				{
					id: 'e',
					type: 'function',
					function: {
						name: 'edit',
						arguments: JSON.stringify({ path, old_string: 'beta', new_string: 'gamma' }),
					},
				},
			],
		},
		{ role: 'tool', toolCallId: 'e', content: 'Edited: 1 replacement(s)', isError: false },
	]
}

it('leaves a tracker without recordEdit or editChain exactly where it was', async () => {
	const cwd = await mkdtemp(join(tmpdir(), 'namzu-older-tracker-'))
	try {
		const path = join(cwd, 'doc.md')
		const tracker = olderTracker()
		const context = (toolUseId: string) => contextIn(cwd, tracker, toolUseId)
		const written = await WriteFileTool.execute({ path, content: 'alpha\nbeta\n' }, context('w'))
		expect(written.success).toBe(true)
		expect(tracker.writeCallId?.(path)).toBe('w')
		const edited = await EditTool.execute(
			{ path, old_string: 'beta', new_string: 'gamma' },
			context('e'),
		)
		expect(edited.success).toBe(true)
		expect(await readFile(path, 'utf8')).toBe('alpha\ngamma\n')
		// The fallback: a contentless-witness observation, third argument absent.
		expect(tracker.calls).toEqual(['recordRead:content:w', 'recordRead:content:-'])
		expect(tracker.fingerprint?.(path)).toBe(fingerprintContent('alpha\ngamma\n'))
		expect(tracker.writeCallId?.(path)).toBeUndefined()
		expect(
			describeVisibleFileEvidence(history(path, 'alpha\nbeta\n'), tracker, cwd, false),
		).toBeUndefined()
	} finally {
		await removeTempDirs([cwd])
	}
})

it('takes no drift note from a refused mutation, and keeps the reference it had', async () => {
	const cwd = await mkdtemp(join(tmpdir(), 'namzu-older-tracker-drift-'))
	try {
		const path = join(cwd, 'doc.md')
		const tracker = olderTracker()
		const context = contextIn(cwd, tracker, 'w')
		const written = await WriteFileTool.execute({ path, content: 'alpha\nbeta\n' }, context)
		expect(written.success).toBe(true)
		const witnessed = history(path, 'alpha\nbeta\n').slice(0, 2)
		expect(describeVisibleFileEvidence(witnessed, tracker, cwd, false)).toContain(
			'"bodyInCall":"w"',
		)

		// Somebody else writes. The refusal below wants to tell the ledger the
		// path has moved, and this ledger has no method for it — so the call is
		// skipped, the mutation is refused exactly as it was before, and the
		// entry survives rather than being withheld on a flag nobody holds.
		await writeFile(path, 'ALPHA\nbeta\n')
		const refused = await EditTool.execute(
			{ path, old_string: 'beta', new_string: 'gamma' },
			context,
		)
		expect(refused.success).toBe(false)
		expect(refused.error).toContain('changed on disk')
		expect(tracker.calls).toEqual(['recordRead:content:w'])
		expect(describeVisibleFileEvidence(witnessed, tracker, cwd, false)).toContain(
			'"bodyInCall":"w"',
		)
	} finally {
		await removeTempDirs([cwd])
	}
})
