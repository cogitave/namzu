import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import { ActivityStore } from '../../../store/activity/memory.js'
import { testToolset } from '../../../test-support/toolset.js'
import { fingerprintContent } from '../../../tools/builtins/content-fingerprint.js'
import { EditTool } from '../../../tools/builtins/edit.js'
import { WriteFileTool } from '../../../tools/builtins/write-file.js'
import { ToolManager } from '../../../toolsets/manager.js'
import type { ChatCompletionResponse } from '../../../types/provider/index.js'
import type { FileReadTracker } from '../../../types/tool/index.js'
import { generateSessionId, generateTurnId } from '../../../utils/id.js'
import type { Logger } from '../../../utils/logger.js'
import { ToolExecutor } from '../executor.js'

/**
 * A change the tool already knows it will refuse is not put to a person. The
 * refusal comes with the prepared batch, so no reviewer is ever shown a diff
 * for a file that moved after it was read.
 */

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

function respond(name: string, args: Record<string, unknown>): ChatCompletionResponse {
	return {
		id: 'r',
		model: 'mock',
		message: {
			role: 'assistant',
			content: null,
			toolCalls: [
				{ id: 'call_1', type: 'function', function: { name, arguments: JSON.stringify(args) } },
			],
		},
		finishReason: 'tool_calls',
		usage: {
			promptTokens: 0,
			completionTokens: 0,
			totalTokens: 0,
			cachedTokens: 0,
			cacheWriteTokens: 0,
		},
	}
}

function setup(dir: string, ledger: FileReadTracker, events: unknown[] = []) {
	const turnId = generateTurnId()
	const tools = new ToolManager({
		toolsets: [testToolset(EditTool, WriteFileTool)],
		messages: () => [],
	})
	const stub = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
	const log = { ...stub, child: vi.fn(() => ({ ...stub, child: vi.fn() })) } as unknown as Logger
	return new ToolExecutor(
		{
			tools,
			turnId,
			sessionId: generateSessionId(),
			workingDirectory: dir,
			permissionMode: 'auto',
			env: {},
			abortSignal: new AbortController().signal,
			fileReadTracker: ledger,
		},
		new ActivityStore(turnId, { enabled: false, trackToolCalls: false, trackLlmTurns: false }),
		async (event) => {
			events.push(event)
		},
		log,
	)
}

describe('a call on a file that moved since it was read', () => {
	it('is refused for an edit, with no review and nothing written', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'namzu-before-review-'))
		const file = join(dir, 'a.ts')
		const ledger = tracker()
		writeFileSync(file, 'export const a = 1\n')
		ledger.recordRead(file, 'export const a = 1\n')
		writeFileSync(file, 'export const a = 100 // changed outside\n')
		const events: unknown[] = []
		const executor = setup(dir, ledger, events)
		const call = respond('edit', {
			path: file,
			old_string: 'export const a = 1',
			new_string: 'export const a = 2',
		})

		const batch = await executor.prepareBatchForReview(call)
		expect(batch.reviewCalls).toEqual([])
		const done = await executor.executeBatch(call, undefined, undefined, batch)
		expect(done.results[0]).toMatchObject({ isError: true })
		expect(done.results[0]?.output).toContain('changed on disk after you read it')
		expect(events).toContainEqual(
			expect.objectContaining({
				type: 'tool_completed',
				facts: expect.objectContaining({ kind: 'failure', reason: 'changed_on_disk' }),
			}),
		)
		expect(readFileSync(file, 'utf8')).toBe('export const a = 100 // changed outside\n')
	})

	it('is refused for a write over the file, with no review', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'namzu-before-review-'))
		const file = join(dir, 'b.ts')
		const ledger = tracker()
		writeFileSync(file, 'one\n')
		ledger.recordRead(file, 'one\n')
		writeFileSync(file, 'two\n')
		const executor = setup(dir, ledger)
		const call = respond('write', { path: file, content: 'three\n' })

		const batch = await executor.prepareBatchForReview(call)
		expect(batch.reviewCalls).toEqual([])
		const done = await executor.executeBatch(call, undefined, undefined, batch)
		expect(done.results[0]?.output).toContain('changed on disk after you read it')
		expect(readFileSync(file, 'utf8')).toBe('two\n')
	})

	it('still reaches review when the file is as it was read', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'namzu-before-review-'))
		const file = join(dir, 'c.ts')
		const ledger = tracker()
		writeFileSync(file, 'export const a = 1\n')
		ledger.recordRead(file, 'export const a = 1\n')
		const executor = setup(dir, ledger)

		const batch = await executor.prepareBatchForReview(
			respond('edit', {
				path: file,
				old_string: 'export const a = 1',
				new_string: 'export const a = 2',
			}),
		)
		expect(batch.reviewCalls.map((c) => c.name)).toEqual(['edit'])
	})

	it('leaves a new file and a file never read to the tool', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'namzu-before-review-'))
		const executor = setup(dir, tracker())
		const fresh = await executor.prepareBatchForReview(
			respond('write', { path: join(dir, 'new.ts'), content: 'x\n' }),
		)
		expect(fresh.reviewCalls.map((c) => c.name)).toEqual(['write'])
		writeFileSync(join(dir, 'old.ts'), 'x\n')
		const unread = await executor.prepareBatchForReview(
			respond('write', { path: join(dir, 'old.ts'), content: 'y\n' }),
		)
		expect(unread.reviewCalls.map((c) => c.name)).toEqual(['write'])
	})
})
