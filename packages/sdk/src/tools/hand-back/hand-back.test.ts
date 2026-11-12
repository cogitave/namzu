import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { estimateTextTokens } from '../../compaction/token-estimate.js'

import {
	HAND_BACK_GUIDANCE,
	HAND_BACK_MAX_CHARS,
	HAND_BACK_TOOL_NAME,
	buildHandBackTool,
	describeHandBack,
	handBackModelLines,
	handBackReason,
	parseHandBack,
} from './index.js'

const input = {
	kind: 'conflict',
	blocker: 'the test expects 3 and the request says 4',
	tried: 'read both, ran the test',
	needed: 'say which number is right',
}

describe('parseHandBack', () => {
	it('reads an object or its JSON text', () => {
		expect(parseHandBack(input)).toEqual(input)
		expect(parseHandBack(JSON.stringify(input))).toEqual(input)
	})

	it('reads nothing from a shape that is not a hand-back, and never throws', () => {
		for (const bad of [
			undefined,
			null,
			42,
			'not json',
			{},
			{ ...input, kind: 'other' },
			{ ...input, blocker: '   ' },
			{ ...input, needed: undefined },
		]) {
			expect(parseHandBack(bad)).toBeUndefined()
		}
	})

	it('folds whitespace and clips each sentence', () => {
		const long = 'a  b\n'.repeat(1000)
		const read = parseHandBack({ ...input, blocker: long })
		expect(read?.blocker.length).toBeLessThanOrEqual(HAND_BACK_MAX_CHARS)
		expect(read?.blocker).not.toContain('\n')
		expect(read?.blocker.endsWith('…')).toBe(true)
	})
})

describe('the words', () => {
	it('keeps the kernel line free of the model words and labels the model lines', () => {
		const read = parseHandBack(input)
		if (!read) throw new Error('unreachable')
		expect(describeHandBack(read)).toBe(
			'The model handed the task back to a person: the request conflicts with itself or with its checks.',
		)
		expect(describeHandBack(read)).not.toContain('expects 3')
		const lines = handBackModelLines(read)
		expect(lines[0]).toBe(
			'The model says it is blocked by: the test expects 3 and the request says 4',
		)
		expect(lines).toHaveLength(3)
		expect(handBackReason(read)).toContain('The model said: the test expects 3')
	})

	it('holds the guidance to a short paragraph that names the tool', () => {
		expect(HAND_BACK_GUIDANCE).toContain(HAND_BACK_TOOL_NAME)
		expect(HAND_BACK_GUIDANCE).toContain('Never weaken, skip, delete or special-case a check')
		// The kernel's own estimate; the docs quote these numbers.
		expect(estimateTextTokens(HAND_BACK_GUIDANCE)).toBeLessThanOrEqual(100)
	})
})

describe('the tool', () => {
	it('adds no more than 200 tokens to the tool list', () => {
		const tool = buildHandBackTool()
		const schema = JSON.stringify(z.toJSONSchema(tool.inputSchema))
		expect(estimateTextTokens(tool.name + tool.description + schema)).toBeLessThanOrEqual(200)
	})

	it('returns the hand-back as data and refuses an incomplete one', async () => {
		const tool = buildHandBackTool()
		expect(tool.name).toBe(HAND_BACK_TOOL_NAME)
		expect(tool.inputSchema.safeParse({ ...input, tried: '' }).success).toBe(false)
		const result = await tool.execute(input, {} as never)
		expect(result).toMatchObject({ success: true, data: input })
	})
})
