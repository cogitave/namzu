/**
 * What the team looks like in the lead's transcript and the opened teammate's: the reference's
 * wording and order in Namzu's plain style, each teammate in its own colour. Rows are checked as
 * data (words, glyph, colour tokens) and the lists on a real screen.
 */

import { describe, expect, it } from 'vitest'

import type { SubagentActivity } from '../../integrations/subagents/activity.js'
import { agentTranscriptRows, teammateRowText } from '../AgentExplorer.js'
import { Checklist, type ChecklistItem, checklistLine, checklistProgress } from '../Checklist.js'
import { expandedTaskRows, taskListRows } from '../TaskList.js'
import { renderToScreen } from './support/screen.js'

const base: SubagentActivity = {
	viewId: 'v-one',
	agentId: 'teammate-type',
	description: 'one works',
	prompt: 'SYSTEM PROMPT AND TOOL DESCRIPTIONS',
	batchId: 'b',
	workflowId: 'w',
	workflowGroupId: 'g',
	phaseId: 'p',
	workflow: 'Delegated work',
	phase: 'Work',
	phaseSequence: 0,
	status: 'completed',
	background: true,
	startedAt: 1,
	completedAt: 2,
	transcript: [
		{
			id: 'r1',
			kind: 'system',
			text: 'A message from the lead. It comes from another session in your team.\n\nlook at a.ts',
			direction: 'to-child',
			mail: { kind: 'message', from: 'lead', body: 'look at a.ts' },
		},
		{
			id: 'r2',
			kind: 'system',
			text: 'framed envelope text',
			direction: 'to-child',
			mail: { kind: 'message', from: 'two', body: 'found the bug' },
		},
		{ id: 'r3', kind: 'assistant', text: 'on it' },
	],
}

describe('an opened teammate transcript', () => {
	const rows = agentTranscriptRows(base, 100, {
		name: 'one',
		colorOf: (n) => (n === 'two' ? 'cyan' : undefined),
	})

	it('leaves out the system prompt and the tool descriptions it was started with', () => {
		expect(rows.map((row) => row.text).join('\n')).not.toContain('SYSTEM PROMPT')
		expect(rows.some((row) => row.source === 'prompt')).toBe(false)
		expect(agentTranscriptRows(base, 100).some((row) => row.source === 'prompt')).toBe(true)
	})

	it('shows the lead as a plain user row and never the envelope text', () => {
		expect(rows[0]?.text).toBe('look at a.ts')
		expect(rows.map((row) => row.text).join('\n')).not.toContain('comes from another session')
		expect(rows.map((row) => row.text).join('\n')).not.toContain('queued from main')
	})

	it('names another teammate as the sender, in that teammate’s colour', () => {
		const peer = rows.find((row) => row.text.startsWith('@two'))
		expect(peer?.text).toBe('@two: found the bug')
		expect(peer?.tone).toBe('cyan')
		expect(rows.find((row) => row.text === 'look at a.ts')?.tone).toBeUndefined()
	})

	it('words a row of mail by who wrote it', () => {
		const row = base.transcript[1] as SubagentActivity['transcript'][number]
		expect(teammateRowText(row)).toBe('@two: found the bug')
		expect(teammateRowText(base.transcript[2] as SubagentActivity['transcript'][number])).toBe(
			'on it',
		)
	})
})

describe('the task block of a team', () => {
	const items: ChecklistItem[] = [
		{
			id: '1',
			subject: 'write it',
			status: 'completed',
			team: true,
			owner: 'one',
			ownerColor: 'green',
		},
		{ id: '2', subject: 'test it', status: 'in_progress', team: true, owner: 'two' },
		{ id: '3', subject: 'ship it', status: 'pending', team: true, blockedBy: ['1', '2'] },
	]

	it('heads with the count and what is in progress', () => {
		expect(checklistProgress(items)).toBe('1/3 tasks done · 1 in progress')
		// A plain plan keeps its own heading.
		expect(checklistProgress([{ id: 'a', subject: 'x', status: 'pending' }])).toBe(
			'Tasks · 0/1 done',
		)
	})

	it('puts the owner in parentheses and what a task waits on after a pointer', () => {
		expect(checklistLine(items[0] as ChecklistItem)).toBe('✓ write it (@one)')
		expect(checklistLine(items[2] as ChecklistItem)).toBe('□ ship it › blocked by #1, #2')
		// Completed work no longer waits on anything.
		expect(checklistLine({ ...(items[2] as ChecklistItem), status: 'completed' })).toBe('✓ ship it')
	})

	it('draws on a screen with the owner and the blocker and no old wording', async () => {
		const screen = await renderToScreen(<Checklist items={items} />, { cols: 60, rows: 6 })
		const frame = screen.viewport().join('\n')
		await screen.unmount()
		expect(frame).toContain('✓ write it (@one)')
		expect(frame).toContain('■ test it (@two)')
		expect(frame).toContain('□ ship it › blocked by #1, #2')
		expect(frame).not.toContain('waits on')
	})

	it('takes the rows the terminal leaves and counts the rest in one line', () => {
		const many: ChecklistItem[] = Array.from({ length: 8 }, (_, i) => ({
			id: String(i + 1),
			subject: `task ${i + 1}`,
			status: i === 5 ? 'in_progress' : i < 2 ? 'completed' : 'pending',
			team: true,
		}))
		const tall = expandedTaskRows(many, 40)
		expect(tall.shown).toHaveLength(4)
		expect(tall.overflow).toBe('8 tasks (1 in progress, 5 open, 2 done)')
		expect(taskListRows(many, true, 40)).toBe(5)
		const short = expandedTaskRows(many, 10)
		expect(short.shown).toHaveLength(0)
		expect(taskListRows(many, true, 10)).toBe(1)
		// A plain plan keeps its own window.
		const plain = expandedTaskRows(
			many.map((item) => ({ ...item, team: undefined })),
			40,
		)
		expect(plain.overflow).toBeUndefined()
	})
})
