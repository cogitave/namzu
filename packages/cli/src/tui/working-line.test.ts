import { describe, expect, it } from 'vitest'

import { formatLimit, shellFooter } from './shell-cell.js'
import {
	CLOCK_FROM_MS,
	type PhaseInput,
	WORKING_MARK_FRAMES,
	WORKING_MARK_STILL,
	workingFigures,
	workingMark,
	workingWord,
} from './working-line.js'

const base: PhaseInput = {
	retrying: false,
	tools: [],
	running: 0,
	thinking: false,
	tokens: false,
	sinceProgressMs: 0,
}

describe('the mark', () => {
	it('loops through a few shapes, one cell each, and starts and ends on the full disc', () => {
		const seen = new Set(Array.from({ length: 40 }, (_, tick) => workingMark(tick, true)))
		expect([...seen].sort()).toEqual([...new Set(WORKING_MARK_FRAMES)].sort())
		for (const shape of WORKING_MARK_FRAMES) expect([...shape]).toHaveLength(1)
		expect(workingMark(0, true)).toBe(WORKING_MARK_STILL)
	})

	it('holds still when motion is off', () => {
		for (const tick of [0, 3, 9, 100]) expect(workingMark(tick, false)).toBe(WORKING_MARK_STILL)
	})
})

describe('the word', () => {
	it('says Working while no phase is known', () => {
		expect(workingWord(base)).toBe('Working')
	})

	it('names the phase where the kernel knows it', () => {
		expect(workingWord({ ...base, thinking: true })).toBe('Thinking')
		expect(workingWord({ ...base, tokens: true, sinceProgressMs: 400 })).toBe('Writing')
		expect(workingWord({ ...base, retrying: true })).toBe('Retrying')
		expect(workingWord({ ...base, waitingFor: 'approval' })).toBe('Waiting for your approval')
		expect(workingWord({ ...base, activityLabel: 'Compacting conversation…' })).toBe(
			'Compacting conversation…',
		)
	})

	it('names a command, a tool by its plain name, and a plan update in plain words', () => {
		const one = (tool: PhaseInput['tools'][number]) =>
			workingWord({ ...base, tools: [tool], running: 1 })
		expect(one({ toolName: 'bash', shell: true, waitsOnAgent: false })).toBe('Running a command')
		expect(one({ toolName: 'grep', shell: false, waitsOnAgent: false })).toBe('Running grep')
		expect(one({ toolName: 'web_search', shell: false, waitsOnAgent: false })).toBe(
			'Running web search',
		)
		expect(one({ toolName: 'task_update', shell: false, waitsOnAgent: false })).toBe(
			'Updating the plan',
		)
		expect(one({ toolName: 'wait_for_task', shell: false, waitsOnAgent: true })).toBe(
			'Waiting for an agent',
		)
		expect(workingWord({ ...base, running: 3 })).toBe('Running 3 tools')
	})

	it('never names a raw call: no JSON braces, no wire names with underscores', () => {
		const word = workingWord({
			...base,
			tools: [{ toolName: 'task_update', shell: false, waitsOnAgent: false }],
			running: 1,
		})
		expect(word).not.toMatch(/[{}_]/u)
	})

	it('says it is waiting for the model once a few seconds pass with nothing, and not while a call runs or the model thinks', () => {
		expect(workingWord({ ...base, sinceProgressMs: 4_000 })).toBe('Waiting for the model')
		expect(workingWord({ ...base, sinceProgressMs: 40_000, thinking: true })).toBe('Thinking')
		expect(workingWord({ ...base, sinceProgressMs: 40_000, running: 1 })).not.toContain(
			'Waiting for the model',
		)
	})
})

describe('the figures', () => {
	it('stay empty before the second second, then always carry the clock', () => {
		expect(workingFigures({ elapsedMs: CLOCK_FROM_MS - 1, agents: 0 })).toBe('')
		expect(workingFigures({ elapsedMs: CLOCK_FROM_MS, agents: 0 })).toBe('(1s)')
		expect(workingFigures({ elapsedMs: 83_000, agents: 0 })).toBe('(1m 23s)')
	})

	it('adds tokens and agents after the clock, never before it', () => {
		expect(workingFigures({ elapsedMs: 5_000, tokens: 1_100, agents: 2 })).toBe(
			'(5s · ↓ 1.1k tokens · 2 agents · ↓ to view)',
		)
	})

	it('says in words that nothing arrived and for how long, from ten seconds', () => {
		expect(workingFigures({ elapsedMs: 30_000, agents: 0, quietMs: 9_000 })).toBe('(30s)')
		expect(workingFigures({ elapsedMs: 30_000, agents: 0, quietMs: 24_000 })).toBe(
			'(30s · no reply for 24s)',
		)
		// Nothing since the turn began: the clock beside it already says for how long.
		expect(workingFigures({ elapsedMs: 30_000, agents: 0, quietMs: 30_000 })).toBe(
			'(30s · no reply yet)',
		)
		// Colour never carries it alone: with no quiet figure there is nothing to colour.
		expect(workingFigures({ elapsedMs: 30_000, agents: 0 })).not.toContain('no reply')
	})
})

describe('the running command footer', () => {
	it('is one line with the clock, the limit when one is set, the counts and the background hint', () => {
		expect(
			shellFooter({
				elapsed: '12s',
				timeoutMs: 90_000,
				outputLines: 214,
				shownRows: 5,
				backgroundHint: 'ctrl+b to run in background',
			}),
		).toBe('12s · limit 1m 30s · 214 lines, 209 above · ctrl+b to run in background')
	})

	it('is there from the start, with nothing to count yet', () => {
		expect(shellFooter({ elapsed: '0s', shownRows: 0, leadRunning: true })).toBe('Running… · 0s')
		expect(shellFooter({ elapsed: '3s', shownRows: 0, outputLines: 0 })).toBe('3s')
	})

	it('says no lines are above when everything is shown, and counts one line in the singular', () => {
		expect(shellFooter({ elapsed: '3s', outputLines: 3, shownRows: 3 })).toBe('3s · 3 lines')
		expect(shellFooter({ elapsed: '3s', outputLines: 1, shownRows: 1 })).toBe('3s · 1 line')
	})

	it('leaves the limit out when the call set none', () => {
		expect(shellFooter({ elapsed: '3s', shownRows: 0 })).not.toContain('limit')
	})

	it('says a limit as a person does', () => {
		expect(formatLimit(30_000)).toBe('30s')
		expect(formatLimit(120_000)).toBe('2m')
		expect(formatLimit(90_000)).toBe('1m 30s')
	})
})
