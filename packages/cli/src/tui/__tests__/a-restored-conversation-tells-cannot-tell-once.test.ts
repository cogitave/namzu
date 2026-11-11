/**
 * The line under a finished turn that says a command ran and the program
 * cannot tell whether files changed describes the folder, not the turn. A
 * conversation says it once; a resumed conversation reads the same, with the
 * once-only rule applied over the whole restored history.
 */
import {
	type Message,
	type SessionRecord,
	type TurnOutcome,
	createAssistantMessage,
	createUserMessage,
} from '@namzu/sdk'
import { describe, expect, it } from 'vitest'

import { projectConversation } from '../App.js'
import { NOTHING_TOLD, type OutcomeTelling, outcomeNotice } from '../outcome-line.js'
import { type RestoreOptions, trailFromRecords } from '../restored-rows.js'

const SESSION = '00000000-0000-4000-8000-0000000000aa'
const turnId = (n: number) => `00000000-0000-4000-8000-00000000010${n}`

const record = (over: Partial<TurnOutcome>): TurnOutcome => ({
	verdict: 'unknown',
	basis: 'calls',
	changes: { total: 0, paths: [], outsideKnownTools: false },
	checks: [],
	...over,
})
const UNKNOWN = record({})
const UNCHECKED = record({
	verdict: 'unchecked',
	changes: { total: 1, paths: ['a.ts'], outsideKnownTools: false },
})

const FULL =
	'A command ran that may have changed files · cannot tell here · not repeated in this conversation'

interface Turn {
	readonly outcome?: unknown
	readonly end?: 'turn_completed' | 'turn_failed'
}

function conversation(turns: readonly Turn[], extra: Partial<RestoreOptions> = {}) {
	const messages: Message[] = []
	const records: SessionRecord[] = []
	let seq = 0
	const push = (r: Record<string, unknown>) =>
		records.push({
			v: 1,
			id: `r-${seq}`,
			seq: seq++,
			ts: '2026-10-24T10:00:00.000Z',
			sessionId: SESSION,
			...r,
		} as unknown as SessionRecord)
	turns.forEach((turn, i) => {
		const id = turnId(i)
		const user = { ...createUserMessage(`ask ${i}`), id: `u-${i}` } as Message
		const reply = { ...createAssistantMessage(`reply ${i}`), id: `a-${i}` } as Message
		messages.push(user, reply)
		push({ type: 'turn_started', turnId: id })
		for (const m of [user, reply])
			push({ type: 'message', turnId: id, messageId: m.id, role: m.role, content: m })
		if (turn.outcome !== undefined)
			push({ type: 'turn_outcome_recorded', turnId: id, ignorable: true, outcome: turn.outcome })
		push({ type: turn.end ?? 'turn_completed', turnId: id, result: '' })
	})
	let n = 0
	const rows = projectConversation(messages, () => `row-${++n}`, [], {
		trail: trailFromRecords(records),
		...extra,
	})
	return rows.map((row) => row.content)
}

describe('the cannot-tell line, live', () => {
	it('is said in full the first time and not again', () => {
		const first = outcomeNotice(UNKNOWN, NOTHING_TOLD)
		expect(first.line).toBe(FULL)
		const second = outcomeNotice(UNKNOWN, first.telling)
		expect(second.line).toBeUndefined()
		expect(second.telling.toldCannotTell).toBe(true)
	})

	it('gives the reason only when it is known', () => {
		expect(outcomeNotice(UNKNOWN, NOTHING_TOLD, 'copy').line).toBe(
			'A command ran that may have changed files · cannot tell here (the tools work in a separate copy of the folder) · not repeated in this conversation',
		)
	})

	it('draws every other verdict each time, and they do not use up the telling', () => {
		let telling = NOTHING_TOLD
		for (let i = 0; i < 2; i++) {
			const said = outcomeNotice(UNCHECKED, telling)
			expect(said.line).toBe('Changed 1 file · not checked')
			telling = said.telling
		}
		expect(telling).toBe(NOTHING_TOLD)
		expect(outcomeNotice(UNKNOWN, telling).line).toBe(FULL)
	})
})

describe('a resumed conversation carries what it told into the next live turn', () => {
	it('reports what the restored rows told, so the next unknown turn stays silent', () => {
		let told: OutcomeTelling | undefined
		conversation([{ outcome: UNKNOWN }], {
			onTold: (t) => {
				told = t
			},
		})
		expect(told?.toldCannotTell).toBe(true)
		expect(outcomeNotice(UNKNOWN, told as OutcomeTelling).line).toBeUndefined()
	})

	it('reports nothing told when the history had no such turn', () => {
		let told: OutcomeTelling | undefined
		conversation([{ outcome: UNCHECKED }], {
			onTold: (t) => {
				told = t
			},
		})
		expect(told?.toldCannotTell).toBeFalsy()
		expect(outcomeNotice(UNKNOWN, told as OutcomeTelling).line).toBe(FULL)
	})

	it('draws the reason of a separate copy in the restored line', () => {
		expect(conversation([{ outcome: UNKNOWN }], { cannotTellReason: 'copy' })).toContain(
			'A command ran that may have changed files · cannot tell here (the tools work in a separate copy of the folder) · not repeated in this conversation',
		)
	})

	it('carries on from a telling given in', () => {
		expect(
			conversation([{ outcome: UNKNOWN }], { telling: { toldCannotTell: true } as OutcomeTelling }),
		).toEqual(['ask 0', 'reply 0'])
	})
})

describe('the cannot-tell line, in a resumed conversation', () => {
	it('draws the outcome lines of past turns from the log, the cannot-tell one once', () => {
		const rows = conversation([
			{ outcome: UNKNOWN },
			{ outcome: UNCHECKED },
			{ outcome: UNKNOWN },
			{ outcome: UNCHECKED },
		])
		expect(rows).toEqual([
			'ask 0',
			'reply 0',
			FULL,
			'ask 1',
			'reply 1',
			'Changed 1 file · not checked',
			'ask 2',
			'reply 2',
			'ask 3',
			'reply 3',
			'Changed 1 file · not checked',
		])
	})

	it('reads like the live run over the same turns', () => {
		const verdicts = [UNKNOWN, UNCHECKED, UNKNOWN]
		let telling = NOTHING_TOLD
		const live: string[] = []
		verdicts.forEach((outcome, i) => {
			live.push(`ask ${i}`, `reply ${i}`)
			const said = outcomeNotice(outcome, telling)
			telling = said.telling
			if (said.line) live.push(said.line)
		})
		expect(conversation(verdicts.map((outcome) => ({ outcome })))).toEqual(live)
	})

	it('draws nothing for a turn with no record, an unreadable one, or an unchanged one', () => {
		expect(
			conversation([
				{},
				{ outcome: { verdict: 'nonsense' } },
				{ outcome: record({ verdict: 'unchanged' }) },
			]),
		).toEqual(['ask 0', 'reply 0', 'ask 1', 'reply 1', 'ask 2', 'reply 2'])
	})

	it('draws no line for a failed turn, as live, and a failed turn does not use up the telling', () => {
		expect(
			conversation([{ outcome: UNKNOWN, end: 'turn_failed' }, { outcome: UNKNOWN }]).filter(
				(text) => text.startsWith('A command ran'),
			),
		).toEqual([FULL])
	})

	it('puts the line before the Worked-for line, after a stop notice', () => {
		const rows = conversation([{ outcome: UNCHECKED }])
		expect(rows.at(-1)).toBe('Changed 1 file · not checked')
	})
})
