import type { SessionId, TurnId } from '@namzu/sdk'
import { describe, expect, it } from 'vitest'

import type { SideModel } from '../small-model/side-model.js'
import {
	PROMPT_SUGGESTION_INSTRUCTION,
	PROMPT_SUGGESTION_MAX_CHARS,
	generatePromptSuggestion,
	parsePromptSuggestion,
} from './prompt-suggestion.js'

describe('parsePromptSuggestion', () => {
	it('keeps one short plain message and strips quotes and markdown', () => {
		expect(parsePromptSuggestion('"run the tests"')).toBe('run the tests')
		expect(parsePromptSuggestion('**commit it**')).toBe('commit it')
		expect(parsePromptSuggestion('check the build\nand then deploy')).toBe('check the build')
	})

	it('shows nothing for an empty reply, the no-suggestion word or an answer-length reply', () => {
		expect(parsePromptSuggestion('')).toBeUndefined()
		expect(parsePromptSuggestion('  ')).toBeUndefined()
		expect(parsePromptSuggestion('NONE')).toBeUndefined()
		expect(parsePromptSuggestion('none.')).toBeUndefined()
		expect(parsePromptSuggestion('a'.repeat(PROMPT_SUGGESTION_MAX_CHARS + 1))).toBeUndefined()
	})
})

describe('generatePromptSuggestion', () => {
	const turns = [
		{ role: 'user', text: 'add a retry to the fetch helper' },
		{ role: 'assistant', text: 'Added a retry with backoff.' },
	] as const
	const ids = { sessionId: 'ses_1' as SessionId, turnId: 'turn_1' as TurnId }

	function sideModel(reply: string | undefined, seen: Record<string, unknown>[] = []): SideModel {
		return {
			ask: async (request: Record<string, unknown>) => {
				seen.push(request)
				return reply
			},
		} as unknown as SideModel
	}

	it('asks beside the turn with the digest as data and returns the parsed message', async () => {
		const seen: Record<string, unknown>[] = []
		const text = await generatePromptSuggestion({
			sideModel: sideModel('run the tests', seen),
			...ids,
			turns,
			signal: new AbortController().signal,
		})
		expect(text).toBe('run the tests')
		expect(seen[0]).toMatchObject({
			instruction: PROMPT_SUGGESTION_INSTRUCTION,
			timing: 'beside-turn',
		})
		expect(String(seen[0]?.body)).toContain('<conversation>')
		expect(String(seen[0]?.body)).toContain('add a retry to the fetch helper')
	})

	it('sends nothing when there is no reply yet, and shows nothing when the side model fails', async () => {
		const seen: Record<string, unknown>[] = []
		expect(
			await generatePromptSuggestion({
				sideModel: sideModel('x', seen),
				...ids,
				turns: [turns[0]],
				signal: new AbortController().signal,
			}),
		).toBeUndefined()
		expect(seen).toEqual([])
		expect(
			await generatePromptSuggestion({
				sideModel: sideModel(undefined),
				...ids,
				turns,
				signal: new AbortController().signal,
			}),
		).toBeUndefined()
	})
})
