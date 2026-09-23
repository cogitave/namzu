import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { removeTempDir } from '../../__fixtures__/temp-dir.js'
import type { AgentEvent } from '../agent.js'
import {
	type SuggestionContext,
	createTurnActivity,
	judgeSkillSuggestion,
	observeTurnEvent,
	skillSuggestionNotice,
} from './learning.js'
import {
	FRESH_LEDGER,
	admitSuggestion,
	readSuggestionLedger,
	suggestionLedgerPath,
	writeSuggestionLedger,
} from './suggestion-ledger.js'

type Call = readonly [toolName: string, ok: boolean, readOnly?: boolean, output?: string]

const READ: Call = ['read', true, true]
const GREP: Call = ['grep', true, true]
const WRITE: Call = ['write', true, false]
const BASH: Call = ['bash', true, false]

function turn(calls: readonly Call[], end: AgentEvent = { kind: 'done', stopReason: 'end_turn' }) {
	const activity = createTurnActivity()
	for (const [i, [toolName, ok, readOnly, output]] of calls.entries()) {
		const toolUseId = `t${i}`
		observeTurnEvent(activity, {
			kind: 'tool-start',
			toolUseId,
			toolName,
			summary: toolName,
			...(readOnly ? { readOnly: true as const } : {}),
		})
		observeTurnEvent(activity, {
			kind: 'tool-end',
			toolUseId,
			toolName,
			isError: !ok,
			summary: '',
			output: output ?? (ok ? 'ok' : 'Error: failed'),
		})
	}
	observeTurnEvent(activity, end)
	return activity
}

const CONTEXT: SuggestionContext = {
	planMode: false,
	skillUsedInConversation: false,
	proposedInConversation: false,
	skillFlowTurn: false,
}
const SIX: readonly Call[] = [READ, GREP, READ, GREP, READ, WRITE]
const denied = (tool: string): Call => [
	tool,
	false,
	false,
	`Error: Tool "${tool}" was not executed. The user denied this tool call.`,
]

describe('judgeSkillSuggestion', () => {
	it.each<[string, readonly Call[], Partial<SuggestionContext>, AgentEvent | undefined, string]>([
		['six steps, three tools, one write', SIX, {}, undefined, 'suggest'],
		['five steps', SIX.slice(1), {}, undefined, 'too-few-steps'],
		['a lower minimum', SIX.slice(2), { minToolCalls: 4 }, undefined, 'suggest'],
		[
			'an invalid minimum falls back to six',
			SIX.slice(1),
			{ minToolCalls: 0 },
			undefined,
			'too-few-steps',
		],
		['one tool only', [BASH, BASH, BASH, BASH, BASH, BASH], {}, undefined, 'one-tool'],
		['only reads', [READ, GREP, READ, GREP, READ, GREP], {}, undefined, 'read-only'],
		['a failure in the last three', [...SIX, ['bash', false]], {}, undefined, 'failing-tail'],
		[
			'a failure earlier is fine',
			[['bash', false], ...SIX, READ, READ, READ],
			{},
			undefined,
			'suggest',
		],
		[
			'a denial never resolved',
			[denied('bash'), ...SIX, READ, READ, READ],
			{},
			undefined,
			'unresolved-denial',
		],
		[
			'a denial later resolved',
			[denied('write'), ...SIX, READ, READ, READ],
			{},
			undefined,
			'suggest',
		],
		['turned off', SIX, { suggest: false }, undefined, 'turned-off'],
		['turned on explicitly', SIX, { suggest: true }, undefined, 'suggest'],
		['plan mode', SIX, { planMode: true }, undefined, 'plan-mode'],
		['already proposed', SIX, { proposedInConversation: true }, undefined, 'already-proposed'],
		['a skill used earlier', SIX, { skillUsedInConversation: true }, undefined, 'skill-used'],
		['a skill loaded this turn', [['skill', true, true], ...SIX], {}, undefined, 'skill-used'],
		['sent by /skills save', SIX, { skillFlowTurn: true }, undefined, 'skill-flow'],
		['called save_skill', [...SIX, ['save_skill', true, false]], {}, undefined, 'skill-flow'],
		[
			'stopped by a budget',
			SIX,
			{},
			{ kind: 'done', stopReason: 'max_iterations' },
			'not-answered',
		],
		[
			'paused',
			SIX,
			{},
			{ kind: 'paused', turnId: 't', checkpointId: 'c', reason: 'provider' },
			'not-answered',
		],
		['failed', SIX, {}, { kind: 'error', message: 'boom' }, 'not-answered'],
		['an older producer without a stop reason', SIX, {}, { kind: 'done' }, 'suggest'],
		[
			'bookkeeping writes are not steps',
			[READ, GREP, READ, ['task_create', true, false], ['task_update', true, false], WRITE],
			{},
			undefined,
			'too-few-steps',
		],
	])('%s', (_name, calls, context, end, expected) => {
		const verdict = judgeSkillSuggestion(turn(calls, end), { ...CONTEXT, ...context })
		expect(verdict.suggest ? 'suggest' : verdict.reason).toBe(expected)
	})

	it('counts steps and distinct tools for the notice', () => {
		const verdict = judgeSkillSuggestion(turn([...SIX, BASH, READ, ['glob', true, true]]), CONTEXT)
		expect(verdict).toEqual({ suggest: true, steps: 9, tools: 5 })
		expect(skillSuggestionNotice(9, 4)).toBe(
			'That took 9 steps across 4 tools. Save it as a reusable skill? /skills save [name] · /skills save off to stop suggesting',
		)
	})

	it('a start without an end, or an end without a start, is not a changed file', () => {
		const activity = createTurnActivity()
		observeTurnEvent(activity, {
			kind: 'tool-start',
			toolUseId: 'x',
			toolName: 'write',
			summary: '',
		})
		for (const [i, name] of ['read', 'grep', 'read', 'grep', 'read', 'grep'].entries()) {
			observeTurnEvent(activity, {
				kind: 'tool-end',
				toolUseId: `hosted-${i}`,
				toolName: name,
				isError: false,
				summary: '',
			})
		}
		observeTurnEvent(activity, { kind: 'done', stopReason: 'end_turn' })
		expect(judgeSkillSuggestion(activity, CONTEXT)).toEqual({ suggest: false, reason: 'read-only' })
	})
})

describe('suggestion ledger', () => {
	const homes: string[] = []
	afterEach(() => {
		for (const home of homes.splice(0)) removeTempDir(home)
	})
	const home = () => {
		const dir = mkdtempSync(join(tmpdir(), 'namzu-ledger-'))
		homes.push(dir)
		return dir
	}

	it('shows three proposals, then one stop notice, then nothing', () => {
		let ledger = FRESH_LEDGER
		const shown: string[] = []
		for (let i = 0; i < 6; i += 1) {
			const admission = admitSuggestion(ledger)
			shown.push(admission.show)
			if (admission.show !== 'nothing') ledger = admission.next
		}
		expect(shown).toEqual([
			'proposal',
			'proposal',
			'proposal',
			'stopped-notice',
			'nothing',
			'nothing',
		])
		expect(ledger).toEqual({ v: 1, unanswered: 3, stopped: true })
	})

	it('persists under NAMZU_HOME/skills and reads a missing or broken file as fresh', () => {
		const dir = home()
		expect(readSuggestionLedger(dir)).toEqual(FRESH_LEDGER)
		writeSuggestionLedger(dir, { v: 1, unanswered: 2, stopped: false })
		const path = suggestionLedgerPath(dir)
		expect(path).toBe(join(dir, 'skills', '.suggestions.json'))
		expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ v: 1, unanswered: 2, stopped: false })
		expect(readSuggestionLedger(dir)).toEqual({ v: 1, unanswered: 2, stopped: false })

		const broken = home()
		mkdirSync(dirname(suggestionLedgerPath(broken)), { recursive: true })
		writeFileSync(suggestionLedgerPath(broken), '{ not json')
		expect(readSuggestionLedger(broken)).toEqual(FRESH_LEDGER)
		writeFileSync(suggestionLedgerPath(broken), '{"unanswered": -4, "stopped": "yes"}')
		expect(readSuggestionLedger(broken)).toEqual(FRESH_LEDGER)
	})
})
