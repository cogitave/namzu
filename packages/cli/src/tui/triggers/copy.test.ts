/**
 * The tag row's words: what each state says at every width, that the state
 * is always a word or a mark and never only the glyph's fill, that the row
 * is one line, and that the copy is true in every permission mode.
 */

import { describe, expect, it } from 'vitest'

import { STEERED_NOT_APPLIED_REASON, notAppliedLine, tagRow, transcriptTagLine } from './copy.js'
import { type TriggerContext, detectTriggers } from './detect.js'
import { compileRegistry } from './registry.js'

const CONTEXT: TriggerContext = {
	permissionMode: 'prompt',
	sessionHypermode: false,
	effortMenu: true,
	agentTool: true,
	skillCreator: true,
	scheduleTool: true,
}
const REGISTRY = compileRegistry()
const row = (
	text: string,
	columns: number,
	options: {
		turnActive?: boolean
		context?: Partial<TriggerContext>
		overrides?: Map<string, 'dropped' | 'armed'>
		nonTyped?: [number, number][]
	} = {},
) =>
	tagRow(
		detectTriggers(
			text,
			REGISTRY,
			{ ...CONTEXT, ...options.context },
			{
				...(options.overrides ? { overrides: options.overrides } : {}),
				...(options.nonTyped ? { nonTyped: options.nonTyped } : {}),
			},
		),
		{
			columns,
			turnActive: options.turnActive ?? false,
			// A menu that goes up to max: hypermode still names xhigh.
			highestEffort: 'max',
			hypermodeEffort: 'xhigh',
			standaloneAllowed: true,
		},
	)

describe('the tag row', () => {
	it('says what an armed hypermode does, and that it pins the highest effort', () => {
		expect(row('hypermode fix the flaky test', 116)).toBe(
			'Hypermode · this reply: effort xhigh, delegate to parallel agents · alt+w drop',
		)
		expect(row('hypermode fix the flaky test', 70)).toBe(
			'Hypermode · this reply, effort xhigh · alt+w',
		)
		expect(row('hypermode fix the flaky test', 45)).toBe('Hypermode · effort xhigh · alt+w')
		expect(row('hypermode fix the flaky test', 30)).toBe('Hypermode')
	})

	it('says what save as skill does embedded, standalone, and while a turn runs', () => {
		expect(row('fix it, then save it as a skill', 116)).toBe(
			'Save as skill · after this reply, if it did work; you confirm the file · alt+w drop',
		)
		expect(row('bunu skill olarak kaydet', 116)).toBe(
			'Save as skill · runs /skills save · alt+w drop',
		)
		expect(row('fix it, then save it as a skill', 116, { turnActive: true })).toBe(
			'Save as skill · enter: after the running reply · tab: after the next · alt+w drop',
		)
	})

	it('says Enter steers without a turn trigger while a turn runs', () => {
		expect(row('hypermode fix it', 116, { turnActive: true })).toBe(
			'Hypermode · enter steers without it · tab: new message with it · alt+w drop',
		)
	})

	it('names the missing task for a trigger-only hypermode', () => {
		expect(row('hypermode', 116)).toBe('Hypermode · type the task in the same message · alt+w drop')
	})

	it('keeps the state in words at every width', () => {
		const suggested = 'what is hypermode?'
		const dropped = new Map([['hypermode@0', 'dropped' as const]])
		for (const columns of [120, 80, 60, 40, 30]) {
			expect(row(suggested, columns), `${columns}`).toMatch(/^Hypermode\?/u)
			expect(row('hypermode fix it', columns, { overrides: dropped }), `${columns}`).toMatch(
				/^Hypermode \(off\)/u,
			)
			expect(
				row('save it as a skill', columns, { context: { permissionMode: 'plan' } }),
				`${columns}`,
			).toMatch(/^Save as skill · unavailable/u)
			for (const text of [
				suggested,
				'hypermode fix it',
				'hypermode fix it, then save it as a skill',
			]) {
				const drawn = row(text, columns) ?? ''
				expect(drawn).not.toContain('\n')
				expect([...drawn].length).toBeLessThanOrEqual(columns)
			}
		}
	})

	it('lists several, and counts them where there is no room', () => {
		const text = 'hypermode fix it, then save it as a skill'
		expect(row(text, 116)).toBe('Hypermode (effort xhigh) · save as skill · alt+w drop')
		expect(row(text, 50)).toBe('2 armed · alt+w')
		expect(row(text, 30)).toBe('2 armed')
		const oneOff = new Map([['hypermode@0', 'dropped' as const]])
		expect(row(text, 50, { overrides: oneOff })).toBe('1 armed · 1 off · alt+w')
	})

	it('offers a suggestion for text that was not typed here', () => {
		expect(row('hypermode fix it', 116, { nonTyped: [[0, 16]] })).toBe('Hypermode? · alt+w arms')
	})

	it('is nothing when no trigger is named', () => {
		expect(row('fix the flaky test', 116)).toBeNull()
	})
})

describe('the copy is true in every permission mode', () => {
	// `save_skill` shows its own screen in every mode that allows it, `auto`
	// included, and plan and strict refuse it; the `schedule` tool is always
	// confirmed on screen and plan refuses it. The row says exactly that.
	it.each(['prompt', 'accept-edits', 'auto', 'plan', 'strict'])('%s', (mode) => {
		const context = { permissionMode: mode }
		const save = row('fix it, then save it as a skill', 116, { context })
		if (mode === 'plan' || mode === 'strict')
			expect(save).toBe(`Save as skill · unavailable in ${mode} mode`)
		else expect(save).toContain('you confirm the file')
		const schedule = row('schedule it', 116, {
			context,
			overrides: new Map([['schedule@0', 'armed']]),
		})
		if (mode === 'plan') expect(schedule).toBe('Schedule · unavailable in plan mode')
		else expect(schedule).toContain('you confirm it on screen')
		// Hypermode reviews nothing differently in any mode: the row never
		// claims otherwise.
		expect(row('hypermode fix it', 116, { context })).toContain('delegate to parallel agents')
	})
})

describe('the transcript line', () => {
	it('names what the message carried', () => {
		expect(
			transcriptTagLine(['hypermode', 'save-skill'], { effort: 'xhigh', steered: false }),
		).toBe(
			'Hypermode is on for this reply (effort xhigh). Namzu will offer to save a skill after this reply.',
		)
		expect(transcriptTagLine(['hypermode'], { effort: undefined, steered: true })).toBeUndefined()
		expect(transcriptTagLine(['save-skill'], { effort: undefined, steered: true })).toBe(
			'Namzu will offer to save a skill after the running reply.',
		)
	})

	it('says why a trigger did not apply, in a sentence', () => {
		expect(notAppliedLine(['hypermode'], 'the message has no task')).toBe(
			'Hypermode was not applied: the message has no task.',
		)
		expect(notAppliedLine(['hypermode', 'save as skill'], STEERED_NOT_APPLIED_REASON)).toBe(
			'Hypermode, save as skill were not applied: Enter sent this message into the running reply. Press Tab to queue it as a new message instead.',
		)
	})
})
