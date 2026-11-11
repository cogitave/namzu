import { describe, expect, it } from 'vitest'
import {
	DRAFT_LIMIT,
	composerPlaceholder,
	decidePaste,
	pasteOverflow,
	pasteOverflowNotice,
	stopTooltip,
} from './composer-input.js'

const base = { text: '', fileCount: 0, importDisabled: false, attachmentsSupported: true }

it('lets a plain text paste through untouched', () => {
	expect(decidePaste({ ...base, text: 'hello' })).toEqual({ action: 'default' })
})

it('keeps the pasted text when the clipboard also carries an image rendering of it', () => {
	expect(decidePaste({ ...base, text: 'table cells', fileCount: 1 })).toEqual({ action: 'default' })
	expect(decidePaste({ ...base, text: 'table cells', fileCount: 1, importDisabled: true })).toEqual(
		{
			action: 'default',
		},
	)
})

it('imports files when the clipboard has no text', () => {
	expect(decidePaste({ ...base, fileCount: 2 })).toEqual({ action: 'import' })
})

it('says why files were refused instead of swallowing them', () => {
	expect(decidePaste({ ...base, fileCount: 1, importDisabled: true })).toEqual({
		action: 'notice',
		notice: 'Files can’t be attached here.',
	})
	expect(
		decidePaste({ ...base, fileCount: 1, importDisabled: true, attachmentsSupported: false }),
	).toEqual({ action: 'notice', notice: 'This engine doesn’t take attachments yet.' })
})

it('explains in the Stop tooltip why Queue is off', () => {
	const open = { waitingOnPerson: false, liveInputSupported: true, queueDisabled: false }
	expect(stopTooltip(open)).toBe('Stop · Esc')
	expect(stopTooltip({ ...open, queueDisabled: true })).toContain('Queue is off until you type')
	expect(stopTooltip({ ...open, queueDisabled: true, attachmentsStranded: true })).toContain(
		'remove the attachments',
	)
	expect(stopTooltip({ ...open, liveInputSupported: false })).toContain('can’t take a new message')
	expect(stopTooltip({ ...open, waitingOnPerson: true, queueDisabled: true })).toContain(
		'action waiting for you will not run',
	)
})

describe('a paste longer than the box', () => {
	const at = (current: string, pasted: string, from = current.length, to = from) =>
		pasteOverflow({ current, selectionStart: from, selectionEnd: to, pasted })

	it('counts what the limit cuts off', () => {
		expect(at('', 'a'.repeat(DRAFT_LIMIT))).toBe(0)
		expect(at('', 'a'.repeat(DRAFT_LIMIT + 7))).toBe(7)
		expect(at('b'.repeat(DRAFT_LIMIT - 10), 'a'.repeat(25))).toBe(15)
	})

	it('gives back the room a selection frees', () => {
		const full = 'b'.repeat(DRAFT_LIMIT)
		expect(at(full, 'a'.repeat(100), 0, 100)).toBe(0)
		expect(at(full, 'a'.repeat(100), 0, 40)).toBe(60)
	})

	it('says it in plain words with the numbers written for people', () => {
		expect(pasteOverflowNotice(1234)).toBe(
			'The box holds 50,000 characters, so the last 1,234 of that paste were left out.',
		)
		expect(pasteOverflowNotice(1)).toContain('the last 1 of that paste was left out')
	})
})

describe('the empty box hint', () => {
	const base = {
		compact: false,
		cliMode: false,
		cliLabel: 'Codex',
		editableQueued: false,
		hasDraft: false,
		running: false,
		liveInputSupported: false,
		mac: false,
	}

	it('keeps the plain prompts while nothing runs', () => {
		expect(composerPlaceholder(base)).toBe('Ask Namzu anything')
		expect(composerPlaceholder({ ...base, compact: true })).toBe('Send a message')
		expect(composerPlaceholder({ ...base, cliMode: true })).toBe(
			'Optional first message for Codex in a terminal',
		)
	})

	it('teaches the send and queue keys while a reply runs and takes a message', () => {
		expect(composerPlaceholder({ ...base, running: true, liveInputSupported: true })).toBe(
			'Enter sends now · Ctrl+Enter or Tab sends after this reply',
		)
		expect(
			composerPlaceholder({ ...base, running: true, liveInputSupported: true, mac: true }),
		).toContain('Cmd+Enter')
	})

	it('does not promise a queue chord on an engine that cannot take a message mid-reply', () => {
		const hint = composerPlaceholder({ ...base, running: true })
		expect(hint).toBe('Enter sends after this reply')
		expect(composerPlaceholder({ ...base, running: true, compact: true })).toBe(hint)
	})

	it('still points at a waiting message first', () => {
		expect(composerPlaceholder({ ...base, running: true, waitingOnPerson: true })).toBe(
			'Waiting for you. Type to message Namzu.',
		)
		expect(composerPlaceholder({ ...base, running: true, editableQueued: true })).toBe(
			'Press ↑ to edit queued messages',
		)
		expect(
			composerPlaceholder({ ...base, running: true, editableQueued: true, hasDraft: true }),
		).toBe('Enter sends after this reply')
	})
})
