import { describe, expect, it } from 'vitest'
import { boxText } from './box-rows.js'

import { TEAM_COLORS, TeamColors, fallbackTeamColor } from '../integrations/teams/colors.js'
import type { TeamMailEvent } from '../integrations/teams/view.js'
import {
	TeamRowBatcher,
	boxRow,
	idleRows,
	mailRow,
	newlyCompleted,
	parseIdle,
	planAnswerBox,
	planRequestBox,
	planSubmittedBox,
	sentRow,
	shutDownRow,
	shutdownRefusedBox,
	shutdownRequestBox,
	taskAssignedBox,
	taskCompletedRow,
	waitingForLeadBox,
} from './team-rows.js'
import { EXPAND_HINT } from './truncation.js'

const colors = new TeamColors()
const colorOf = (name: string) => colors.assign(name)

function event(patch: Partial<TeamMailEvent>): TeamMailEvent {
	return { team: 't', from: 'one', to: 'lead', kind: 'message', text: 'hello', ...patch }
}

describe('teammate colours', () => {
	it('hands out eight colours in order, the lead first, and keeps each', () => {
		const palette = new TeamColors()
		expect(palette.lead()).toBe(TEAM_COLORS[0])
		const names = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i']
		const given = names.map((name) => palette.assign(name))
		expect(given.slice(0, 7)).toEqual(TEAM_COLORS.slice(1))
		// The ninth wraps round to the lead's colour: eight colours, nine seats.
		expect(given[7]).toBe(TEAM_COLORS[0])
		expect(palette.assign('a')).toBe(given[0])
		expect(palette.get('zzz')).toBeUndefined()
	})

	it('gives a name nobody coloured the same blue or pink every time, never the lead colour', () => {
		for (const name of ['x', 'worker', 'qa-2', '']) {
			expect(fallbackTeamColor(name)).toBe(fallbackTeamColor(name))
			expect(['blue', '#ff69b4']).toContain(fallbackTeamColor(name))
		}
	})
})

describe('mail from a teammate', () => {
	it('is one dim collapsed line with the name in its colour', () => {
		const row = mailRow('one', 'green', [{ summary: 'found it', body: 'the bug is in a.ts' }])
		expect(row.content).toBe('Message from @one')
		expect(row.glyph).toBe('›')
		expect(row.meta).toBe(EXPAND_HINT)
		expect(row.spans?.find((span) => span.text === '@one')).toMatchObject({ tone: 'green' })
		expect(JSON.stringify(row)).not.toContain('untrusted')
	})

	it('opens to a coloured header with the summary and the body indented two', () => {
		const row = mailRow('one', 'green', [
			{ summary: 'found it', body: 'line one\nline two' },
			{ body: 'second' },
		])
		expect(row.content).toBe('2 messages from @one')
		expect(row.detail).toEqual([
			'@ one ❯ found it',
			'  line one',
			'  line two',
			'',
			'@ one',
			'  second',
		])
	})
})

describe('an idle teammate', () => {
	it('reads the record: finished, interrupted, failed', () => {
		expect(parseIdle(JSON.stringify({ idleReason: 'available', result: 'done' }))).toEqual({
			reason: 'available',
			result: 'done',
		})
		expect(parseIdle(JSON.stringify({ idleReason: 'interrupted' }))).toEqual({
			reason: 'interrupted',
		})
		expect(parseIdle('not json')).toEqual({ reason: 'available' })
	})

	it.each([
		['available', 'Teammate @one finished', 'theme:status.ok'],
		['interrupted', 'Teammate @one was interrupted', 'theme:status.warn'],
		['failed', 'Teammate @one failed', 'theme:status.error'],
	] as const)('says %s, coloured by the reason', (reason, words, tone) => {
		const [head] = idleRows('one', 'red', { reason })
		expect(head?.content).toBe(words)
		expect(head?.glyphColor).toBe(tone)
		expect(head?.spans?.find((span) => span.text === '@one')).toMatchObject({ tone: 'red' })
		expect(head?.spans?.[0]).toMatchObject({ tone })
	})

	it('puts the first line of its answer dim under it and the whole answer behind ctrl+o', () => {
		const rows = idleRows(
			'one',
			'red',
			{ reason: 'available', result: 'wrote part one\nand tests' },
			3,
		)
		expect(rows).toHaveLength(2)
		expect(rows[1]).toMatchObject({ glyph: '⎿', content: 'wrote part one', meta: EXPAND_HINT })
		expect(rows[1]?.detail).toEqual(['(task #3)', 'and tests'])
	})

	it('has nothing to open when the answer is one short line and no task', () => {
		const rows = idleRows('one', 'red', { reason: 'available', result: 'done' })
		expect(rows[1]?.detail).toBeUndefined()
		expect(rows[1]?.meta).toBeUndefined()
		expect(idleRows('one', 'red', { reason: 'available' })).toHaveLength(1)
	})

	it('cuts a long first line with an ellipsis', () => {
		const rows = idleRows('one', 'red', { reason: 'available', result: 'x'.repeat(300) })
		expect(rows[1]?.content.length).toBeLessThanOrEqual(100)
		expect(rows[1]?.content.endsWith('…')).toBe(true)
		expect(rows[1]?.detail).toBeDefined()
	})

	it('never cuts an emoji in half', () => {
		const rows = idleRows('one', 'red', { reason: 'available', result: `${'x'.repeat(98)}😀😀😀` })
		const line = rows[1]?.content ?? ''
		expect(line).toBe(`${'x'.repeat(98)}😀…`)
		expect(line).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/u)
	})
})

describe('shutdown', () => {
	it('is one dim line for a teammate that left, a count for several', () => {
		expect(shutDownRow([{ name: 'one', color: 'red' }]).content).toBe('Teammate @one shut down')
		expect(
			shutDownRow([
				{ name: 'one', color: 'red' },
				{ name: 'two', color: 'blue' },
			]).content,
		).toBe('2 teammates shut down')
	})

	it('says who refused and why in a neutral box, with the line that it can be asked again', () => {
		const box = shutdownRefusedBox('one', 'still writing the tests')
		expect(boxText(box)).toBe(
			'Shutdown refused by @one\nReason: still writing the tests\nStill working. Ask again later.',
		)
		expect(box.tone).toBe('theme:text.muted')
		expect(box.notes).toHaveLength(1)
		expect(boxText(shutdownRefusedBox('one', undefined)).split('\n')).toHaveLength(2)
	})

	it('shows a request to stop as a warning box with the reason', () => {
		const box = shutdownRequestBox('lead', 'wrapping up for the day')
		expect(boxText(box)).toBe('Shutdown request from lead\nReason: wrapping up for the day')
		expect(box.tone).toBe('theme:status.warn')
		expect(boxText(shutdownRequestBox('lead', undefined))).toBe('Shutdown request from lead')
	})
})

describe('plans', () => {
	it('shows the request as a box in the plan colour with the plan as text, and the plan file dim', () => {
		const box = planRequestBox('one', '# Plan\n1. read **a.ts**\n2. write', '/tmp/plan.md')
		expect(box.tone).toBe('theme:accent.plan')
		expect(boxText(box)).toBe(
			'Plan approval request from @one\nPlan\n1. read a.ts\n2. write\nPlan file: /tmp/plan.md',
		)
		// The heading and the marked word are drawn bold.
		expect(box.body?.[0]?.[0]?.bold).toBe(true)
		expect(box.body?.[1]?.some((span) => span.bold === true && span.text === 'a.ts')).toBe(true)
		expect(box.notes).toHaveLength(1)
		expect(planRequestBox('one', undefined).body).toBeUndefined()
	})

	it('answers approved in green and rejected in red, with the feedback and the line to revise', () => {
		const yes = planAnswerBox('one', true, undefined)
		expect(boxText(yes)).toBe('✓ Plan approved by @one')
		expect(yes.tone).toBe('theme:status.ok')
		const feedback = planAnswerBox('one', true, 'go ahead, keep it small')
		expect(boxText(feedback)).toBe('✓ Plan approved by @one\nFeedback: go ahead, keep it small')
		const no = planAnswerBox('one', false, 'cover the failure case')
		expect(boxText(no)).toBe(
			'✗ Plan rejected by @one\nFeedback: cover the failure case\nRevise the plan and send it again for approval.',
		)
		expect(no.tone).toBe('theme:status.error')
	})

	it('shows only what the person wrote in a refusal, never the stock text sent to the model', () => {
		const stock = planAnswerBox(
			'one',
			false,
			'The user declined this. Do not get the same content or result another way unless you ask first.',
		)
		expect(boxText(stock)).toBe(
			'✗ Plan rejected by @one\nRevise the plan and send it again for approval.',
		)
		const said = planAnswerBox('one', false, 'The user declined this and said: split step two')
		expect(boxText(said)).toBe(
			'✗ Plan rejected by @one\nFeedback: split step two\nRevise the plan and send it again for approval.',
		)
	})

	it('is one box row in the batch for a request, an answer and a refusal', () => {
		const batcher = new TeamRowBatcher(() => 'red')
		batcher.add({
			team: 't',
			from: 'one',
			to: 'lead',
			kind: 'plan_request',
			text: JSON.stringify({ plan: '1. read', planFile: '/tmp/p.md' }),
		})
		batcher.add({
			team: 't',
			from: 'lead',
			to: 'one',
			kind: 'plan_response',
			text: JSON.stringify({ allow: false, feedback: 'smaller' }),
		})
		batcher.add({
			team: 't',
			from: 'two',
			to: 'lead',
			kind: 'shutdown_response',
			text: JSON.stringify({ approve: false, reason: 'busy' }),
		})
		const rows = batcher.flush()
		expect(rows).toHaveLength(3)
		expect(rows.every((row) => row.box !== undefined)).toBe(true)
		expect(rows[0]?.content).toContain('Plan file: /tmp/p.md')
		expect(rows[1]?.content).toContain('Plan rejected by @one')
		expect(rows[2]?.content).toContain('Shutdown refused by @two')
	})
})

describe('boxes a teammate reads', () => {
	it('names the task, who gave it, its subject in bold and what it asks dim', () => {
		const box = taskAssignedBox(3, 'lead', 'Write part two', 'two sections\nwith examples')
		expect(box.title.map((span) => span.text).join('')).toBe('Task #3 assigned by lead')
		expect(box.body?.[0]?.[0]).toMatchObject({ text: 'Write part two', bold: true })
		expect(box.notes?.map((line) => line[0]?.text)).toEqual(['two sections', 'with examples'])
		expect(
			taskAssignedBox(undefined, 'two', 'x')
				.title.map((span) => span.text)
				.join(''),
		).toBe('Task assigned by @two')
	})

	it('says what the waiting teammate waits for, and that the request went to the lead', () => {
		const box = waitingForLeadBox({ tool: 'bash', action: 'touch a.txt' })
		expect(box.tone).toBe('theme:status.warn')
		expect(boxText(box)).toBe(
			'Waiting for team lead approval\nTool   bash\nAction touch a.txt\nThe request was sent to the team lead.',
		)
		expect(box.body?.[0]?.[0]?.muted).toBe(true)
	})

	it('says the plan went to the lead after it is sent', () => {
		const box = planSubmittedBox()
		expect(boxText(box)).toBe(
			'Plan submitted for team lead approval\nWaiting for team lead approval…',
		)
		expect(box.tone).toBe('theme:accent.plan')
		expect(boxText(planSubmittedBox('/tmp/p.md'))).toContain('Plan file: /tmp/p.md')
	})

	it('is a row with the box and the same words as plain text', () => {
		const row = boxRow(planSubmittedBox())
		expect(row.box).toBeDefined()
		expect(row.content).toBe(boxText(planSubmittedBox()))
	})
})

describe('what the lead sent', () => {
	it('is one arrow row per kind, with the words behind ctrl+o', () => {
		const sent = sentRow({ kind: 'message', from: 'lead' }, 'one', 'red', 'look at a.ts')
		expect(sent?.content).toBe('Sent to @one')
		expect(sent?.detail).toEqual(['look at a.ts'])
		const stop = sentRow({ kind: 'stop', from: 'lead' }, 'one', 'red', 'wrap up')
		expect(stop?.content).toBe('Asked @one to stop')
	})

	it('shows only the subject of a task, never the instruction text', () => {
		const task = sentRow({ kind: 'task', from: 'lead' }, 'one', 'red', 'Write part two')
		expect(task?.content).toBe('Task assigned to @one · Write part two')
		expect(task?.detail).toBeUndefined()
		expect(task?.meta).toBeUndefined()
	})

	it('writes nothing for mail between two teammates', () => {
		expect(sentRow({ kind: 'message', from: 'two' }, 'one', 'red', 'hi')).toBeUndefined()
	})
})

describe('task completion', () => {
	it('is a dim tick line naming the owner, the number and the subject', () => {
		const row = taskCompletedRow('one', 'red', 2, 'ship it')
		expect(row.content).toBe('@one completed task #2 (ship it)')
		expect(row.glyph).toBe('✓')
		expect(taskCompletedRow(undefined, 'red', 2, 'ship it').content).toBe(
			'Completed task #2 (ship it)',
		)
	})

	it('finds the tasks that became done since the last look, and none on the first look', () => {
		const tasks = [
			{ id: '1', status: 'completed' },
			{ id: '2', status: 'completed' },
			{ id: '3', status: 'pending' },
		]
		expect(newlyCompleted(undefined, tasks)).toEqual([])
		const before = new Map([
			['1', 'completed'],
			['2', 'in_progress'],
			['3', 'pending'],
		])
		expect(newlyCompleted(before, tasks).map((task) => task.id)).toEqual(['2'])
	})
})

describe('the rows of one moment', () => {
	it('folds messages in a row from one teammate into one line, in the order they came', () => {
		const batcher = new TeamRowBatcher(colorOf)
		batcher.add(event({ text: 'a' }))
		batcher.add(event({ text: 'b' }))
		batcher.add(event({ from: 'two', text: 'c' }))
		batcher.add(event({ text: 'd' }))
		expect(batcher.flush().map((row) => row.content)).toEqual([
			'2 messages from @one',
			'Message from @two',
			'Message from @one',
		])
		expect(batcher.pending).toBe(false)
		expect(batcher.flush()).toEqual([])
	})

	it('writes nothing for mail between teammates or from the lead', () => {
		const batcher = new TeamRowBatcher(colorOf)
		expect(batcher.add(event({ from: 'one', to: 'two' }))).toBe(false)
		expect(batcher.add(event({ from: 'lead', to: 'one' }))).toBe(false)
		expect(batcher.add(event({ kind: 'permission_request' }))).toBe(false)
		expect(batcher.flush()).toEqual([])
	})

	it('folds teammates that shut down together, and shows a refusal on its own', () => {
		const batcher = new TeamRowBatcher(colorOf)
		const approve = JSON.stringify({ approve: true })
		batcher.add(event({ kind: 'shutdown_response', from: 'one', text: approve }))
		batcher.add(event({ kind: 'shutdown_response', from: 'two', text: approve }))
		batcher.add(
			event({
				kind: 'shutdown_response',
				from: 'three',
				text: JSON.stringify({ approve: false, reason: 'busy' }),
			}),
		)
		expect(batcher.flush().map((row) => row.content)).toEqual([
			'2 teammates shut down',
			'Shutdown refused by @three\nReason: busy\nStill working. Ask again later.',
		])
	})

	it('writes the idle line with its answer and the task number when asked for one', () => {
		const batcher = new TeamRowBatcher(colorOf)
		batcher.add(
			event({
				kind: 'idle',
				text: JSON.stringify({ idleReason: 'available', result: 'done\nmore' }),
			}),
			(name) => (name === 'one' ? 4 : undefined),
		)
		const rows = batcher.flush()
		expect(rows.map((row) => row.content)).toEqual(['Teammate @one finished', 'done'])
		expect(rows[1]?.detail?.[0]).toBe('(task #4)')
	})

	it('adds what the teammate last told the lead to the expanded idle row', () => {
		const note = parseIdle(
			JSON.stringify({
				idleReason: 'available',
				result: 'done',
				lastMessage: 'part two is ready for review',
			}),
		)
		expect(note.lastMessage).toBe('part two is ready for review')
		const rows = idleRows('one', 'red', note, 2)
		expect(rows[1]?.content).toBe('done')
		expect(rows[1]?.detail).toEqual(['(task #2)', 'Last message: part two is ready for review'])
		// A first line cut short is shown whole in the expansion.
		const long = 'x'.repeat(130)
		expect(idleRows('one', 'red', { reason: 'available', result: long })[1]?.detail).toEqual([long])
		// Without one, the expanded row has no such line.
		expect(
			idleRows('one', 'red', { reason: 'available', result: 'done\nmore' })[1]?.detail?.some((l) =>
				l.startsWith('Last message'),
			),
		).toBe(false)
		// A teammate that only sent a message still shows it, dim.
		expect(
			idleRows('one', 'red', { reason: 'available', lastMessage: 'ping' }).map((r) => r.content),
		).toEqual(['Teammate @one finished', 'Last message: ping'])
	})

	it('writes the plan request, and the answer under the name of the teammate it was for', () => {
		const batcher = new TeamRowBatcher(colorOf)
		batcher.add(event({ kind: 'plan_request', text: JSON.stringify({ plan: 'step 1' }) }))
		batcher.add(
			event({
				kind: 'plan_response',
				from: 'lead',
				to: 'one',
				text: JSON.stringify({ allow: true }),
			}),
		)
		expect(batcher.flush().map((row) => row.content)).toEqual([
			'Plan approval request from @one\nstep 1',
			'✓ Plan approved by @one',
		])
	})

	it('draws a name nobody coloured in a fixed fallback colour', () => {
		const batcher = new TeamRowBatcher()
		batcher.add(event({ from: 'ghost' }))
		const span = batcher.flush()[0]?.spans?.find((s) => s.text === '@ghost')
		expect(span?.tone).toBe(fallbackTeamColor('ghost'))
	})
})
