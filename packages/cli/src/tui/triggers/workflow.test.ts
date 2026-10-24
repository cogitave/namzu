/** The bare word "workflow" is a composer trigger: matched like hypermode, tagged, dropped with Alt+W. */

import { describe, expect, it } from 'vitest'

import { triggerContextTexts, triggerEffort } from './context-text.js'
import { tagRow, transcriptTagLine } from './copy.js'
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
const stateOf = (text: string, overrides?: ReadonlyMap<string, 'dropped' | 'armed'>) =>
	detectTriggers(text, compileRegistry(), CONTEXT, { overrides }).hits.find(
		(hit) => hit.id === 'workflow',
	)?.state ?? 'none'

describe('the workflow trigger', () => {
	it.each([
		['workflow audit the packages', 'armed'],
		['audit the packages, workflow', 'armed'],
		['workflows scan then fix', 'armed'],
		['how does the build workflow cache work?', 'suggested'],
		['what is a workflow?', 'suggested'],
		['the workflow keyword is odd', 'suggested'],
		['bir iş akışı', 'none'],
		['rework the flow of the checkout', 'none'],
		['my network workflowless setup', 'none'],
		['look at `workflow` in the code', 'none'],
		['/workflow audit', 'none'],
	])('%s -> %s', (text, expected) => {
		expect(stateOf(text)).toBe(expected)
	})

	it('Alt+W drops an armed one', () => {
		const text = 'workflow audit the packages'
		const hit = detectTriggers(text, compileRegistry(), CONTEXT).hits[0]
		expect(hit?.state).toBe('armed')
		expect(stateOf(text, new Map([[hit?.key ?? '', 'dropped']]))).toBe('dropped')
	})

	it('shows a tag row and offers nothing else', () => {
		const detection = detectTriggers('workflow audit the packages', compileRegistry(), CONTEXT)
		const row = tagRow(detection, {
			columns: 100,
			turnActive: false,
			highestEffort: undefined,
			hypermodeEffort: undefined,
			standaloneAllowed: true,
		})
		expect(row).toBe('Workflow · this turn, offers the workflow tool · alt+w drop')
		expect(transcriptTagLine(['workflow'], { effort: undefined, steered: false })).toBe(
			'Workflow is on for this reply.',
		)
		expect(triggerContextTexts(['workflow'])).toHaveLength(1)
		expect(triggerEffort(['workflow'], ['low', 'high'])).toBeUndefined()
	})
})
