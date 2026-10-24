import { describe, expect, it } from 'vitest'

import {
	END_WORDS,
	INTERRUPTED_BY_STEER_TEXT,
	INTERRUPTED_TEXT,
	clipboardSentNotice,
	endLevel,
	endOutcome,
	endWord,
	goalRoundHeadline,
	interruptionRow,
	systemRowStyle,
} from './system-rows.js'
import { theme } from './theme.js'

describe('systemRowStyle', () => {
	it('is one dot whose colour is the level', () => {
		expect(systemRowStyle('warning')).toEqual({
			glyph: '●',
			color: theme.status.warn,
		})
		expect(systemRowStyle('error')).toEqual({
			glyph: '●',
			color: theme.status.error,
		})
		expect(systemRowStyle('notice')).toEqual({
			glyph: '●',
			color: theme.text.muted,
		})
	})
})

describe('interruptionRow', () => {
	it('asks what to do instead, under the call that was running', () => {
		expect(interruptionRow({ callRunning: true })).toEqual({
			content: 'Interrupted · What should Namzu do instead?',
			glyph: '⎿',
			color: theme.text.muted,
		})
		expect(INTERRUPTED_TEXT).toBe('Interrupted · What should Namzu do instead?')
	})

	it('stands alone as a dim notice when no call was running', () => {
		expect(interruptionRow({ callRunning: false })).toMatchObject({
			glyph: '●',
			color: theme.text.muted,
		})
	})

	it('drops the question after a send-now steer', () => {
		expect(interruptionRow({ callRunning: false, steered: true }).content).toBe(
			INTERRUPTED_BY_STEER_TEXT,
		)
		expect(INTERRUPTED_BY_STEER_TEXT).toBe('Interrupted')
	})
})

describe('the finished, failed, stopped table', () => {
	it('maps every runtime status to one of three words', () => {
		expect(END_WORDS).toEqual({
			finished: 'finished',
			failed: 'failed',
			stopped: 'stopped',
		})
		for (const status of ['completed', 'done', 'exited', undefined, 'success'])
			expect(endWord(status)).toBe('finished')
		for (const status of ['failed', 'error', 'timeout']) expect(endWord(status)).toBe('failed')
		for (const status of ['stopped', 'killed', 'cancelled', 'aborted'])
			expect(endWord(status)).toBe('stopped')
	})

	it('never prints a raw status', () => {
		expect(endWord('some_new_status')).toBe('finished')
		expect(endOutcome('killed')).toBe('stopped')
	})

	it('draws a failure red, a stop yellow and a finish quiet', () => {
		expect(endLevel('failed')).toBe('error')
		expect(endLevel('stopped')).toBe('warning')
		expect(endLevel('finished')).toBe('notice')
	})
})

describe('small shared wording', () => {
	it('words a goal round without slashes', () => {
		expect(goalRoundHeadline(2, 5)).toBe('Goal, attempt 2 of 5')
	})

	it('keeps the copy notice short', () => {
		expect(clipboardSentNotice(1234)).toBe(
			'Sent 1,234 chars via OSC 52 · if paste fails, allow clipboard access in your terminal',
		)
		expect(clipboardSentNotice(1, 'the latest answer')).toContain('Sent 1 char (the latest answer)')
	})
})

describe('failure rows', () => {
	it('every explainFailure row goes through the shared error level', async () => {
		const { readFileSync } = await import('node:fs')
		const source = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')
		// The startup failures keep their own stop glyph, so they are the only
		// ones allowed to stay on the bare call.
		const bare = [...source.matchAll(/pushMessage\(\s*'system',\s*explainFailure\(/g)].filter(
			(m) => !source.slice(m.index, m.index + 700).includes('STARTUP_STOP_GLYPH'),
		)
		expect(bare).toHaveLength(0)
	})

	it('gives a system row with no glyph the notice style in the one pushMessage', async () => {
		const { readFileSync } = await import('node:fs')
		const source = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')
		const start = source.indexOf('const pushMessage = useCallback(')
		const body = source.slice(start, start + 2200)
		expect(body).toContain("role === 'system' && glyph === undefined")
		expect(body).toContain("systemRowStyle('notice')")
	})
})
