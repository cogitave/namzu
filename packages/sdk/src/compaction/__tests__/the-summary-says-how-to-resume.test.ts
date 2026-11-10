import { describe, expect, it } from 'vitest'
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
		expect(COMPACTION_RESUME_NOTE).toMatch(/read a file again before editing/)
		expect(COMPACTION_RESUME_NOTE).toMatch(/still running or waiting, check on that first/)
	})
})
