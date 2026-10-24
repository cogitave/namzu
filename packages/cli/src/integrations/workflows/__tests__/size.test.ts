import { describe, expect, it } from 'vitest'

import { workflowToolDescription } from '../offering.js'
import {
	guidelineAgents,
	isLargeRun,
	isWorkflowSizeGuideline,
	parseTokenTarget,
	workflowSizeAdvice,
	workflowTokenCeiling,
} from '../size.js'

describe('workflowSizeAdvice', () => {
	it('says nothing when unrestricted', () => {
		expect(workflowSizeAdvice('unrestricted', true)).toBe('')
		expect(workflowSizeAdvice('unrestricted', false)).toBe('')
	})
	it('names the default guideline and how to change it', () => {
		const text = workflowSizeAdvice('medium', false)
		expect(text).toContain(
			'default workflow size guideline: medium, so keep workflows under 10 agents',
		)
		expect(text).toContain('not a hard limit')
		expect(text).toContain('workflow.sizeGuideline')
	})
	it('names a configured guideline without the how-to', () => {
		const text = workflowSizeAdvice('small', true)
		expect(text).toContain(
			'is configured for this session: small, so keep workflows under 5 agents',
		)
		expect(text).not.toContain('raise or remove')
	})
	it('knows each guideline limit', () => {
		expect(
			['small', 'medium', 'large', 'unrestricted'].map((g) => guidelineAgents(g as never)),
		).toEqual([5, 10, 50, undefined])
		expect(isWorkflowSizeGuideline('large')).toBe(true)
		expect(isWorkflowSizeGuideline('huge')).toBe(false)
	})
	it('is appended to the tool description after a blank line', () => {
		const advice = workflowSizeAdvice('large', true)
		expect(workflowToolDescription(advice).endsWith(`\n\n${advice}`)).toBe(true)
		expect(workflowToolDescription()).toBe(workflowToolDescription(''))
	})
})

describe('parseTokenTarget', () => {
	it.each([
		['do it +500k please', 500_000],
		['+1.5m', 1_500_000],
		['go +2B', 2_000_000_000],
		['first +100k then +200k', 200_000],
		['end of sentence +50k.', 50_000],
	])('reads %s', (text, expected) => {
		expect(parseTokenTarget(text)).toBe(expected)
	})
	it.each([
		'a+500k',
		'c++',
		'+k',
		'no target',
		'1+2',
		'+0k',
		'x +500kb',
		'+5 k',
		'+5000',
		'spend +300000 tokens',
	])('ignores %s', (text) => {
		expect(parseTokenTarget(text)).toBeUndefined()
	})
})

describe('workflowTokenCeiling', () => {
	it.each([
		[undefined, undefined, undefined],
		[0, undefined, undefined],
		[1_000_000, undefined, 1_000_000],
		[undefined, 500_000, 500_000],
		[1_000_000, 500_000, 500_000],
		[300_000, 500_000, 300_000],
		[0, 500_000, 500_000],
	])('turn budget %s with typed target %s gives %s', (budget, target, expected) => {
		expect(workflowTokenCeiling(budget, target)).toBe(expected)
	})
	it('carries a typed message through to the ceiling', () => {
		expect(workflowTokenCeiling(undefined, parseTokenTarget('audit it +250k'))).toBe(250_000)
		expect(workflowTokenCeiling(undefined, parseTokenTarget('line 5000 changed'))).toBeUndefined()
	})
})

describe('isLargeRun', () => {
	const base = {
		scheduledAgents: 5,
		startedAgents: 5,
		totalTokens: 10_000,
		hypermode: false,
	}
	it('stays quiet for a small run', () => {
		expect(isLargeRun(base)).toBe(false)
	})
	it('warns above 25 agents', () => {
		expect(isLargeRun({ ...base, scheduledAgents: 26, startedAgents: 26 })).toBe(true)
		expect(
			isLargeRun({
				...base,
				scheduledAgents: 25,
				startedAgents: 25,
				totalTokens: 100_000,
			}),
		).toBe(false)
	})
	it('warns above 1.5M tokens spent', () => {
		expect(isLargeRun({ ...base, totalTokens: 1_500_001 })).toBe(true)
	})
	it('projects tokens from the average of the agents that started', () => {
		expect(
			isLargeRun({
				scheduledAgents: 20,
				startedAgents: 2,
				totalTokens: 200_000,
				hypermode: false,
			}),
		).toBe(true)
		expect(
			isLargeRun({
				scheduledAgents: 20,
				startedAgents: 0,
				totalTokens: 0,
				hypermode: false,
			}),
		).toBe(false)
		expect(
			isLargeRun({
				scheduledAgents: 22,
				startedAgents: 0,
				totalTokens: 0,
				hypermode: false,
			}),
		).toBe(true)
	})
	it('is suppressed by hypermode', () => {
		expect(isLargeRun({ ...base, scheduledAgents: 99, hypermode: true })).toBe(false)
	})
	it('uses a configured guideline as the agent cap', () => {
		expect(
			isLargeRun({
				...base,
				scheduledAgents: 6,
				startedAgents: 6,
				configuredGuideline: 'small',
			}),
		).toBe(true)
		expect(
			isLargeRun({
				...base,
				scheduledAgents: 6,
				startedAgents: 6,
				configuredGuideline: 'large',
			}),
		).toBe(false)
		expect(
			isLargeRun({
				...base,
				scheduledAgents: 30,
				startedAgents: 30,
				configuredGuideline: 'unrestricted',
			}),
		).toBe(true)
	})
	it('lets the environment override both caps', () => {
		const env = {
			NAMZU_WORKFLOW_SIZE_WARNING_AGENTS: '3',
			NAMZU_WORKFLOW_SIZE_WARNING_TOKENS: '5000',
		}
		expect(
			isLargeRun({
				...base,
				scheduledAgents: 4,
				startedAgents: 4,
				totalTokens: 1,
				env,
			}),
		).toBe(true)
		expect(
			isLargeRun({
				...base,
				scheduledAgents: 1,
				startedAgents: 1,
				totalTokens: 6000,
				env,
			}),
		).toBe(true)
		expect(
			isLargeRun({
				...base,
				scheduledAgents: 1,
				startedAgents: 1,
				totalTokens: 1000,
				env,
			}),
		).toBe(false)
	})
})
