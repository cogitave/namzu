import { createAssistantMessage, createTurnContextEntry, createUserMessage } from '@namzu/sdk'
import { describe, expect, it } from 'vitest'

import type { CheckpointTurn } from '../../checkpoints/store.js'
import { type EditablePrompt, editablePrompts } from '../edit-prompts.js'
import {
	ageText,
	buildRewindRows,
	codeLine,
	conversationLine,
	countRewindRows,
	durableUsers,
	openRewind,
	placeTurns,
	restoreStart,
	rewindKey,
	rewindOptions,
	rewindRowDetail,
} from '../rewind.js'

const turn = (
	index: number,
	label: string,
	promptOrdinal?: number,
	files = ['/w/a.ts'],
): CheckpointTurn => ({
	index,
	turnId: `t${index}`,
	label,
	...(promptOrdinal !== undefined ? { promptOrdinal } : {}),
	startedAt: index,
	status: 'applied',
	files,
})

function conversation(...prompts: string[]) {
	const history = prompts.flatMap((p) => [createUserMessage(p), createAssistantMessage(`re: ${p}`)])
	const editable: EditablePrompt[] = history
		.filter((m) => m.role === 'user')
		.map((message, userOrdinal) => ({
			userOrdinal,
			message: message as EditablePrompt['message'],
			displayText: message.content as string,
		}))
	return { history, editable }
}

describe('placing checkpoint turns on prompts', () => {
	it('trusts a recorded position while the prompt there still has the turn words', () => {
		const { history } = conversation('one', 'two', 'three')
		const placed = placeTurns([turn(1, 'two', 1), turn(2, 'three', 2)], durableUsers(history))
		expect([...placed]).toEqual([
			['t1', 1],
			['t2', 2],
		])
	})

	it('finds a turn by its words when positions moved or were never recorded', () => {
		const { history } = conversation('one', 'two', 'three')
		const placed = placeTurns([turn(1, 'two', 0), turn(2, 'three')], durableUsers(history))
		expect(placed.get('t1')).toBe(1)
		expect(placed.get('t2')).toBe(2)
	})

	it('keeps two alike prompts in order', () => {
		const { history } = conversation('same', 'other', 'same')
		const placed = placeTurns([turn(1, 'same'), turn(2, 'same')], durableUsers(history))
		expect(placed.get('t1')).toBe(0)
		expect(placed.get('t2')).toBe(2)
	})

	it('leaves out a turn that cannot be placed', () => {
		const { history } = conversation('one')
		expect(placeTurns([turn(1, 'gone')], durableUsers(history)).size).toBe(0)
	})

	it('counts host-authored user messages in the positions', () => {
		const history = [
			createUserMessage('one'),
			createAssistantMessage('a'),
			createUserMessage('goal round', undefined, {
				type: 'goal-round',
				goalId: 'g' as never,
				objective: 'o',
				goalRevision: 1,
				round: 1,
				maxGoalRounds: 2,
			}),
			createAssistantMessage('b'),
			createUserMessage('two'),
		]
		expect(durableUsers(history).map((u) => u.ordinal)).toEqual([0, 1, 2])
	})
})

describe('recorded context among the prompts', () => {
	// An entry is a user row the person never wrote. It takes a position on
	// both sides of the count (the recorded ordinal and this list), so a
	// prompt still lands where its turn says it does, and it is no rewind point.
	const withEntries = () => [
		createUserMessage('one'),
		createTurnContextEntry('repository', 'REPO STATE'),
		createAssistantMessage('re: one'),
		createUserMessage('two'),
		createTurnContextEntry('memory', 'A RECORD'),
		createAssistantMessage('re: two'),
	]

	it('counts entries in the positions and trusts a turn recorded with them counted', () => {
		const history = withEntries()
		const users = durableUsers(history)
		expect(users.map((u) => u.ordinal)).toEqual([0, 1, 2, 3])
		const placed = placeTurns([turn(1, 'one', 0), turn(2, 'two', 2)], users)
		expect([...placed]).toEqual([
			['t1', 0],
			['t2', 2],
		])
	})

	it('places a turn recorded before entries existed by its words', () => {
		// Counted without entries, 'two' was position 1, which is an entry now.
		const placed = placeTurns([turn(1, 'one', 0), turn(2, 'two', 1)], durableUsers(withEntries()))
		expect(placed.get('t2')).toBe(2)
	})

	it('offers only what the person wrote, at the position the count gives it', () => {
		const history = withEntries()
		const transcript = [
			{ role: 'user', content: 'one' },
			{ role: 'user', content: 'two' },
		] as never
		const prompts = editablePrompts(history, transcript)
		expect(prompts.map((p) => [p.userOrdinal, p.displayText])).toEqual([
			[0, 'one'],
			[2, 'two'],
		])
	})
})

describe('the rows', () => {
	it('puts the present last and maps each prompt to the first turn at or after it', () => {
		const { history, editable } = conversation('one', 'two', 'three')
		const turns = [turn(1, 'one', 0, ['/w/a.ts']), turn(2, 'three', 2, ['/w/b.ts', '/w/c.ts'])]
		const rows = buildRewindRows(editable, turns, history)
		expect(rows.map((r) => r.kind)).toEqual(['prompt', 'prompt', 'prompt', 'current'])
		expect(rows[0]?.files).toMatchObject({ kind: 'changes', restoreFrom: 1 })
		// Prompt two changed nothing itself; the first change at or after it is turn 2.
		expect(rows[1]?.files).toMatchObject({ kind: 'changes', restoreFrom: 2 })
		expect(rows[2]?.files).toMatchObject({ kind: 'changes', restoreFrom: 2 })
		expect(rows[0]?.files.kind === 'changes' && rows[0].files.paths).toEqual([
			'/w/a.ts',
			'/w/b.ts',
			'/w/c.ts',
		])
	})

	it('says no code changes when nothing at or after a prompt changed a file', () => {
		const { history, editable } = conversation('one', 'two')
		const rows = buildRewindRows(editable, [turn(1, 'one', 0)], history)
		expect(rows[1]?.files.kind).toBe('none')
		expect(rewindRowDetail(rows[1]?.files as never)).toBe('No code changes')
	})

	it('says no code restore when the history holds changes it cannot tie to a prompt', () => {
		const { history, editable } = conversation('one', 'two')
		const rows = buildRewindRows(editable, [turn(1, 'something else')], history)
		expect(rows[1]?.files.kind).toBe('unavailable')
		expect(rewindRowDetail(rows[1]?.files as never)).toBe('⚠ No code restore')
	})

	it('has no file lines at all when this conversation keeps no file history', () => {
		const { history, editable } = conversation('one')
		const rows = buildRewindRows(editable, undefined, history)
		expect(rows.map((r) => r.files.kind)).toEqual(['off', 'off'])
		expect(rewindRowDetail(rows[0]?.files as never)).toBeUndefined()
	})

	it('shows the file name and counts, or the number of files', () => {
		expect(
			rewindRowDetail({
				kind: 'changes',
				restoreFrom: 1,
				paths: ['/w/src/main.ts'],
				summary: { files: ['/w/src/main.ts'], insertions: 3, deletions: 1 },
			}),
		).toBe('main.ts +3 -1')
		expect(
			rewindRowDetail({
				kind: 'changes',
				restoreFrom: 1,
				paths: ['/w/a', '/w/b', '/w/c'],
				summary: { files: ['/w/a', '/w/b', '/w/c'], insertions: 9, deletions: 2 },
			}),
		).toBe('3 files changed +9 -2')
		// Counting not done or abandoned: the names alone.
		expect(rewindRowDetail({ kind: 'changes', restoreFrom: 1, paths: ['/w/a', '/w/b'] })).toBe(
			'2 files changed',
		)
	})

	it('restoreStart finds the lowest turn at or after a prompt', () => {
		const turns = [turn(3, 'x', 1), turn(5, 'y', 2)]
		const placed = new Map([
			['t3', 1],
			['t5', 2],
		])
		expect(restoreStart(0, turns, placed)).toBe(3)
		expect(restoreStart(2, turns, placed)).toBe(5)
		expect(restoreStart(3, turns, placed)).toBeUndefined()
	})
})

describe('counting the second lines', () => {
	it('counts newest first, under one budget measured on the injected clock', async () => {
		const { history, editable } = conversation('one', 'two', 'three')
		const rows = buildRewindRows(
			editable,
			[turn(1, 'one', 0), turn(2, 'two', 1), turn(3, 'three', 2)],
			history,
		)
		let now = 0
		const asked: number[] = []
		const counted: number[] = []
		await countRewindRows(
			rows,
			async (from, expired) => {
				asked.push(from)
				now += 400
				return { files: [], ...(expired() ? {} : { insertions: 1, deletions: 0 }) }
			},
			{ now: () => now, budgetMs: 1000, onRow: (i) => counted.push(i) },
		)
		expect(asked).toEqual([3, 2, 1])
		expect(counted).toEqual([2, 1, 0])
	})
})

describe('the words', () => {
	it('offers the options in order, only conversation without file history', () => {
		expect(rewindOptions(true, true)).toEqual([
			'both',
			'conversation',
			'code',
			'summarize',
			'summarize_up_to',
			'nevermind',
		])
		expect(rewindOptions(false, true)).toEqual([
			'conversation',
			'summarize',
			'summarize_up_to',
			'nevermind',
		])
		expect(rewindOptions(false, false)).toEqual(['conversation', 'nevermind'])
	})

	it('changes the conversation line with the focused option', () => {
		expect(conversationLine('both')).toBe('The conversation will be forked.')
		expect(conversationLine('conversation')).toBe('The conversation will be forked.')
		expect(conversationLine('code')).toBe('The conversation will be unchanged.')
		expect(conversationLine('nevermind')).toBe('The conversation will be unchanged.')
		expect(conversationLine('summarize')).toBe('Messages after this point will be summarized.')
		expect(conversationLine('summarize_up_to')).toMatch(/^Preceding messages will be summarized\./)
	})

	it('says what the code will do, per option', () => {
		const files = {
			kind: 'changes',
			restoreFrom: 1,
			paths: ['/w/a.ts'],
			summary: { files: ['/w/a.ts'], insertions: 2, deletions: 1 },
		} as const
		expect(codeLine('code', files)).toBe('The code will be restored +2 -1 in a.ts.')
		expect(codeLine('both', files)).toBe('The code will be restored +2 -1 in a.ts.')
		expect(codeLine('conversation', files)).toBe('The code will be unchanged.')
		expect(codeLine('nevermind', files)).toBe('The code will be unchanged.')
		expect(codeLine('summarize', files)).toBeUndefined()
		expect(
			codeLine('code', { kind: 'changes', restoreFrom: 1, paths: ['/w/a.ts', '/w/b.ts'] }),
		).toBe('The code will be restored in a.ts and b.ts.')
		expect(
			codeLine('code', {
				kind: 'changes',
				restoreFrom: 1,
				paths: ['/w/a', '/w/b', '/w/c', '/w/d'],
			}),
		).toBe('The code will be restored in a and 3 other files.')
	})

	it('writes ages in plain words', () => {
		const now = 10_000_000
		expect(ageText(now - 5_000, now)).toBe('just now')
		expect(ageText(now - 60_000, now)).toBe('1 minute ago')
		expect(ageText(now - 5 * 60_000, now)).toBe('5 minutes ago')
		expect(ageText(now - 2 * 3_600_000, now)).toBe('2 hours ago')
		expect(ageText(now - 3 * 86_400_000, now)).toBe('3 days ago')
		expect(ageText(undefined, now)).toBeUndefined()
	})
})

describe('the keys', () => {
	const { history, editable } = conversation('one', 'two')
	const rows = buildRewindRows(editable, [turn(1, 'two', 1)], history)
	const env = { rows, canSummarize: true }

	it('opens on the present and closes on Enter there', () => {
		const state = openRewind(rows.length)
		expect(state.selected).toBe(2)
		expect(rewindKey(state, '', { return: true }, env).effect).toEqual({ kind: 'close' })
	})

	it('moves with the arrows and Home/End and stays inside the list', () => {
		let state = openRewind(rows.length)
		state = rewindKey(state, '', { upArrow: true }, env).state
		expect(state.selected).toBe(1)
		state = rewindKey(state, '', { home: true }, env).state
		expect(state.selected).toBe(0)
		state = rewindKey(state, '', { upArrow: true }, env).state
		expect(state.selected).toBe(0)
		state = rewindKey(state, '', { end: true }, env).state
		expect(state.selected).toBe(2)
	})

	it('Enter on a prompt opens its options, focused on the first; Esc goes back, then closes', () => {
		let state = openRewind(rows.length)
		state = rewindKey(state, '', { upArrow: true }, env).state
		state = rewindKey(state, '', { return: true }, env).state
		expect(state).toMatchObject({ stage: 'confirm', target: 1, option: 'both' })
		state = rewindKey(state, '', { escape: true }, env).state
		expect(state).toMatchObject({ stage: 'list', selected: 1 })
		expect(rewindKey(state, '', { escape: true }, env).effect).toEqual({ kind: 'close' })
	})

	it('focuses conversation when there is no code to restore', () => {
		const bare = buildRewindRows(editable, [turn(1, 'one', 0)], history)
		let state = openRewind(bare.length)
		state = rewindKey(state, '', { upArrow: true }, { ...env, rows: bare }).state
		state = rewindKey(state, '', { return: true }, { ...env, rows: bare }).state
		expect(state.option).toBe('conversation')
	})

	it('moves the focus through the options and chooses with Enter', () => {
		let state = rewindKey(
			rewindKey(openRewind(rows.length), '', { upArrow: true }, env).state,
			'',
			{ return: true },
			env,
		).state
		state = rewindKey(state, '', { downArrow: true }, env).state
		expect(state.option).toBe('conversation')
		state = rewindKey(state, '', { downArrow: true }, env).state
		expect(state.option).toBe('code')
		const chosen = rewindKey(state, '', { return: true }, env)
		expect(chosen.effect).toEqual({ kind: 'choose', row: 1, option: 'code', context: undefined })
	})

	it('Never mind goes back to the list', () => {
		let state = rewindKey(
			rewindKey(openRewind(rows.length), '', { upArrow: true }, env).state,
			'',
			{ return: true },
			env,
		).state
		state = rewindKey(state, '', { end: true }, env).state
		expect(state.option).toBe('nevermind')
		const step = rewindKey(state, '', { return: true }, env)
		expect(step.state.stage).toBe('list')
		expect(step.effect).toBeUndefined()
	})

	it('types context into a summarize row, edits it, and sends it trimmed', () => {
		let state = rewindKey(
			rewindKey(openRewind(rows.length), '', { upArrow: true }, env).state,
			'',
			{ return: true },
			env,
		).state
		state = rewindKey(state, '', { downArrow: true }, env).state
		state = rewindKey(state, '', { downArrow: true }, env).state
		state = rewindKey(state, '', { downArrow: true }, env).state
		expect(state.option).toBe('summarize')
		for (const ch of ' keep the api ') state = rewindKey(state, ch, {}, env).state
		state = rewindKey(state, '', { backspace: true }, env).state
		expect(state.texts.summarize).toBe(' keep the api')
		const chosen = rewindKey(state, '', { return: true }, env)
		expect(chosen.effect).toEqual({
			kind: 'choose',
			row: 1,
			option: 'summarize',
			context: 'keep the api',
		})
	})

	it('chooses a summarize row with no context at all', () => {
		let state = rewindKey(
			rewindKey(openRewind(rows.length), '', { upArrow: true }, env).state,
			'',
			{ return: true },
			env,
		).state
		state = { ...state, option: 'summarize_up_to' }
		expect(rewindKey(state, '', { return: true }, env).effect).toMatchObject({
			option: 'summarize_up_to',
			context: undefined,
		})
	})

	it('ignores every key while a choice is being carried out', () => {
		const state = { ...openRewind(rows.length), busy: 'code' as const }
		expect(rewindKey(state, '', { escape: true }, env)).toEqual({ state })
	})
})
