import { describe, expect, it } from 'vitest'
import { createSystemMessage } from '../../types/message/index.js'
import { replaceableSummaries } from '../model-summary.js'
import {
	COMPACTION_HEADER,
	COMPACTION_RECOVERY_NOTE,
	COMPACTION_RESUME_NOTE,
	buildCompactionMessage,
	isCompactionMessage,
} from '../summary.js'

/**
 * After a pass the model has the summary and nothing else. The header is read
 * byte for byte by the cache and by the replace-in-place check; the closing
 * line is what tells the model how to pick the work back up.
 */
describe('the wrapper around a summary', () => {
	it('opens on the unchanged header', () => {
		expect(COMPACTION_HEADER).toBe(
			'[COMPACTED CONTEXT] The following is a structured summary of the conversation so far.',
		)
		const message = buildCompactionMessage('body')
		expect(String(message.content).startsWith(`${COMPACTION_HEADER}\n\nbody`)).toBe(true)
		expect(isCompactionMessage(String(message.content))).toBe(true)
	})

	it('closes on the resume note, once', () => {
		const text = String(buildCompactionMessage('body').content)
		expect(text).toBe(`${COMPACTION_HEADER}\n\nbody\n\n${COMPACTION_RESUME_NOTE}`)
		expect(text.split(COMPACTION_RESUME_NOTE)).toHaveLength(2)
	})

	it('puts the recovery pointer before the resume note', () => {
		const text = String(buildCompactionMessage('body', COMPACTION_RECOVERY_NOTE).content)
		expect(text.endsWith(`\n\n${COMPACTION_RECOVERY_NOTE}\n\n${COMPACTION_RESUME_NOTE}`)).toBe(true)
	})

	it('renders the same message for the same summary', () => {
		expect(buildCompactionMessage('body').content).toBe(buildCompactionMessage('body').content)
	})

	it('says each of the four things', () => {
		expect(COMPACTION_RESUME_NOTE).toMatch(/without asking the person to repeat/)
		expect(COMPACTION_RESUME_NOTE).toMatch(/marks done as done/)
		expect(COMPACTION_RESUME_NOTE).toMatch(
			/may have changed or may not be shown in full, so read a file again before editing/,
		)
		expect(COMPACTION_RESUME_NOTE).toMatch(/still running or waiting, check on that first/)
	})
})

describe('a summary that is summarised again', () => {
	it('hands the next pass the body without the closing notes', () => {
		const first = buildCompactionMessage('Task: port the store.', COMPACTION_RECOVERY_NOTE)
		const [body] = replaceableSummaries([first])
		expect(body).toBe(`${COMPACTION_HEADER}\n\nTask: port the store.`)
	})

	it('carries exactly one note after a second compaction, even when the model echoed it', () => {
		const first = buildCompactionMessage('Task: port the store.', COMPACTION_RECOVERY_NOTE)
		const [earlier] = replaceableSummaries([first])
		// The summary model repeats the earlier note at the end of its own body.
		const second = buildCompactionMessage(
			`${earlier}\n\nNow on the tests.\n\n${COMPACTION_RESUME_NOTE}`,
			COMPACTION_RECOVERY_NOTE,
		)
		const text = String(second.content)
		expect(text.split(COMPACTION_RESUME_NOTE)).toHaveLength(2)
		expect(text.split(COMPACTION_RECOVERY_NOTE)).toHaveLength(2)
		expect(text.endsWith(`\n\n${COMPACTION_RESUME_NOTE}`)).toBe(true)
	})

	it('still drops what a pass restored after the summary', () => {
		const withRestored = createSystemMessage(
			`${COMPACTION_HEADER}\n\nbody\n\n## Restored after compaction\n\nfile text\n\n${COMPACTION_RESUME_NOTE}`,
		)
		expect(replaceableSummaries([withRestored])).toEqual([`${COMPACTION_HEADER}\n\nbody`.trim()])
	})
})
