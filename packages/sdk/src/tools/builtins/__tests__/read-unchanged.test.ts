import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'

import type { ToolContext } from '../../../types/tool/index.js'
import { createFileReadTracker } from '../../file-read-tracker.js'
import { fingerprintContent } from '../content-fingerprint.js'
import { ReadFileTool } from '../read-file.js'

/**
 * A repeat read of lines the model already has, in a file that has not
 * changed, is answered in one short sentence — but only while the earlier
 * receipt is still in front of the model.
 */

let directory: string
let file: string

beforeEach(() => {
	directory = realpathSync(mkdtempSync(join(tmpdir(), 'namzu-read-unchanged-')))
	file = join(directory, 'a.txt')
	writeFileSync(file, 'one\ntwo\nthree\n')
})

/** A context whose "conversation" is whatever receipts the test has put in `shown`. */
function session() {
	const tracker = createFileReadTracker()
	const shown = new Map<string, string>()
	let counter = 0
	const call = async (input: Record<string, unknown>) => {
		counter += 1
		const toolUseId = `call_${counter}`
		const context = {
			sessionId: '0190a5b2-7c3d-7e4f-8a9b-0c1d2e3f4a5b',
			turnId: '4adf3fdd-2823-4640-be0a-5d21fe28b6d2',
			workingDirectory: directory,
			abortSignal: new AbortController().signal,
			env: {},
			log: () => {},
			toolUseId,
			fileReadTracker: tracker,
			receiptVisible: (callId: string, renderedFingerprint: string) => {
				const text = shown.get(callId)
				return text !== undefined && fingerprintContent(text) === renderedFingerprint
			},
		} as unknown as ToolContext
		const result = await ReadFileTool.execute(ReadFileTool.inputSchema.parse(input), context)
		if (result.success && !(result.data as { unchanged?: boolean } | undefined)?.unchanged) {
			shown.set(toolUseId, result.output)
		}
		return result
	}
	return { call, shown }
}

describe('a repeat read of an unchanged file', () => {
	it('answers that nothing changed instead of returning the lines again', async () => {
		const s = session()

		const first = await s.call({ path: file })
		const second = await s.call({ path: file })

		expect(first.output).toContain('two')
		expect(second.output).toMatch(/^Unchanged since your earlier read/)
		expect(second.output).not.toContain('two')
		expect(second.facts).toMatchObject({ kind: 'read', unchanged: true })
	})

	it('keeps answering that while the first receipt is still shown', async () => {
		const s = session()

		await s.call({ path: file })
		await s.call({ path: file })
		const third = await s.call({ path: file })

		expect(third.output).toMatch(/^Unchanged/)
	})

	it('treats a different window as a different read', async () => {
		const s = session()

		await s.call({ path: file, readRange: [1, 2] })
		const other = await s.call({ path: file, readRange: [2, 3] })
		const same = await s.call({ path: file, readRange: [1, 2] })

		expect(other.output).toContain('three')
		expect(same.output).toMatch(/^Unchanged/)
	})

	it('returns the lines again once the file has changed', async () => {
		const s = session()
		await s.call({ path: file })

		writeFileSync(file, 'one\nTWO\nthree\n')
		const again = await s.call({ path: file })

		expect(again.output).toContain('TWO')
	})

	it('returns the lines again once the earlier receipt is no longer shown', async () => {
		const s = session()
		await s.call({ path: file })

		// Compaction or clearing replaced the receipt.
		s.shown.set('call_1', '[tool result cleared]')
		const again = await s.call({ path: file })

		expect(again.output).toContain('two')
	})

	it('returns the lines when the host cannot say what is shown', async () => {
		const tracker = createFileReadTracker()
		const context = (id: string) =>
			({
				sessionId: '0190a5b2-7c3d-7e4f-8a9b-0c1d2e3f4a5b',
				turnId: '4adf3fdd-2823-4640-be0a-5d21fe28b6d2',
				workingDirectory: directory,
				abortSignal: new AbortController().signal,
				env: {},
				log: () => {},
				toolUseId: id,
				fileReadTracker: tracker,
			}) as unknown as ToolContext
		const input = ReadFileTool.inputSchema.parse({ path: file })

		await ReadFileTool.execute(input, context('a'))
		const again = await ReadFileTool.execute(input, context('b'))

		expect(again.output).toContain('two')
	})
})
