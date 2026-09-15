import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { EditTool, type ToolContext, WriteFileTool, createFileReadTracker } from '@namzu/sdk'
import { afterEach, beforeEach, expect, it } from 'vitest'

import { FileCheckpointStore } from '../store.js'
import { CHECKPOINTED_TOOLS, withCheckpoints } from '../wrap.js'

/**
 * The witness is execution-owned, and this wrapper is the thing standing
 * between the executor and the tool that records it.
 *
 * An earlier prototype recognised a built-in write by its function identity;
 * `withCheckpoints` replaces `execute`, so the check withheld the evidence and
 * the model read the file again. Identity is out for good, and what is in —
 * the call id carried on `ToolContext` — has to come through this wrapper
 * untouched for a write and an edit alike. The SDK cannot import the CLI, so
 * this is the only place the production wrapper meets the witness path.
 */

let cwd: string
let store: FileCheckpointStore

beforeEach(async () => {
	cwd = await mkdtemp(join(tmpdir(), 'namzu-ckpt-witness-'))
	store = new FileCheckpointStore(
		join(cwd, '.namzu', 'checkpoints', '9d1d4a1f-6a0d-4a2f-9f2a-7c1f1b0c2f34'),
		cwd,
	)
	store.beginTurn('write then edit')
})

afterEach(async () => {
	await store.close()
	await rm(cwd, { recursive: true, force: true })
})

it('carries the write and edit call ids through the checkpoint wrapper into the ledger', async () => {
	const tracker = createFileReadTracker()
	const context = (toolUseId: string): ToolContext => ({
		runId: '2a4d6e08-0f2b-4a1a-8a9c-1f6b3d5e7a90' as ToolContext['runId'],
		workingDirectory: cwd,
		abortSignal: new AbortController().signal,
		env: {},
		log: () => {},
		fileReadTracker: tracker,
		toolUseId,
	})
	const path = join(cwd, 'doc.md')
	expect(CHECKPOINTED_TOOLS).toEqual(['edit', 'write'])
	const write = withCheckpoints(WriteFileTool, store)
	const edit = withCheckpoints(EditTool, store)

	expect((await write.execute({ path, content: 'alpha\nbeta\n' }, context('w'))).success).toBe(true)
	expect(tracker.writeCallId?.(path)).toBe('w')
	expect(tracker.editChain?.(path)).toBeUndefined()

	expect(
		(await edit.execute({ path, old_string: 'beta', new_string: 'gamma' }, context('e1'))).success,
	).toBe(true)
	expect(
		(await edit.execute({ path, insertLine: 'end', new_string: 'delta\n' }, context('e2'))).success,
	).toBe(true)

	expect(await readFile(path, 'utf8')).toBe('alpha\ngamma\ndelta\n')
	expect(tracker.editChain?.(path)).toEqual({
		rootWriteCallId: 'w',
		editCallIds: ['e1', 'e2'],
	})
	// The body is no longer the write call's body, and the older question keeps
	// its older answer through the wrapper too.
	expect(tracker.writeCallId?.(path)).toBeUndefined()
	// The snapshots the wrapper exists for are still there, one per file per turn.
	expect(store.list()[0]?.files.length).toBe(1)
})
