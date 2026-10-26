import { createUserMessage } from '@namzu/sdk'
import { render } from 'ink-testing-library'
import { describe, expect, it } from 'vitest'

import { RewindPicker } from '../RewindPicker.js'
import { buildRewindRows, openRewind, rewindOptions } from '../rewind.js'

const prompt = (userOrdinal: number, text: string) => ({
	userOrdinal,
	displayText: text,
	message: createUserMessage(text),
})

describe('the rewind picker', () => {
	it('says there is nothing to rewind to when no prompt qualifies', () => {
		const rows = buildRewindRows([], undefined, [])
		const harness = render(
			<RewindPicker
				rows={rows}
				state={openRewind(rows.length)}
				options={[]}
				checkpointing={false}
				now={0}
			/>,
		)
		expect(harness.lastFrame()).toContain('Nothing to rewind to yet.')
		harness.unmount()
	})

	it('asks to restore and fork when no file history is kept, and draws no file lines', () => {
		const rows = buildRewindRows([prompt(0, 'first\nsecond line')], undefined, [])
		const harness = render(
			<RewindPicker
				rows={rows}
				state={openRewind(rows.length)}
				options={[]}
				checkpointing={false}
				now={0}
			/>,
		)
		const frame = harness.lastFrame() ?? ''
		expect(frame).toContain('Restore and fork the conversation to the point before…')
		expect(frame).toContain('first second line')
		expect(frame).toContain('(current)')
		expect(frame).not.toContain('No code changes')
		harness.unmount()
	})

	it('draws a prompt with no text as an empty message, and an unrestorable one with a warning', () => {
		const history = [createUserMessage('x')]
		const rows = buildRewindRows(
			[prompt(0, '  ')],
			[
				{
					index: 1,
					turnId: 't',
					label: 'other',
					startedAt: 0,
					status: 'applied',
					files: ['/w/a'],
				},
			],
			history,
		)
		const harness = render(
			<RewindPicker
				rows={rows}
				state={openRewind(rows.length)}
				options={[]}
				checkpointing
				now={0}
			/>,
		)
		const frame = harness.lastFrame() ?? ''
		expect(frame).toContain('((empty message))')
		expect(frame).toContain('⚠ No code restore')
		harness.unmount()
	})

	it('shows an error in the dialog and the busy words instead of the keys', () => {
		const rows = buildRewindRows([prompt(0, 'x')], undefined, [])
		const state = {
			...openRewind(rows.length),
			error: 'Failed to restore the code:\nboom',
			busy: 'code' as const,
		}
		const harness = render(
			<RewindPicker
				rows={rows}
				state={state}
				options={rewindOptions(false, false)}
				checkpointing
				now={0}
				working="Restoring…"
			/>,
		)
		const frame = harness.lastFrame() ?? ''
		expect(frame).toContain('Failed to restore the code:')
		expect(frame).toContain('boom')
		expect(frame).toContain('Restoring…')
		harness.unmount()
	})
})
