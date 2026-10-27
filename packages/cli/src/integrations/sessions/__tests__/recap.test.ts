import type { SessionId, TurnId } from '@namzu/sdk'
import { describe, expect, it } from 'vitest'

import type { SideModel, SideRequest } from '../../small-model/side-model.js'
import {
	RECAP_DIGEST_MAX_CHARS,
	RECAP_DIGEST_TURNS,
	RECAP_INSTRUCTION,
	RECAP_MAX_CHARS,
	RECAP_TURN_MAX_CHARS,
	type RecapTurn,
	generateRecap,
	parseRecap,
	recapInput,
} from '../recap.js'

const prompt = (text: string): RecapTurn => ({ role: 'user', text })
const reply = (text: string): RecapTurn => ({ role: 'assistant', text })

describe('what is sent for a recap', () => {
	it('sends nothing before there is a prompt and a reply', () => {
		expect(recapInput([])).toBeUndefined()
		expect(recapInput([prompt('hello there')])).toBeUndefined()
		expect(recapInput([reply('hi')])).toBeUndefined()
	})

	it('labels prompts and replies and keeps their order', () => {
		expect(recapInput([prompt('fix the build'), reply('Done.')])).toBe(
			'Person: fix the build\nNamzu: Done.',
		)
	})

	it('cuts each turn and keeps only the latest turns', () => {
		const turns: RecapTurn[] = []
		for (let i = 0; i < 30; i += 1) turns.push(prompt(`p${i}`), reply(`r${i} ${'x'.repeat(2000)}`))
		const sent = recapInput(turns) as string
		expect(sent.split('\n')).toHaveLength(RECAP_DIGEST_TURNS)
		expect(sent.length).toBeLessThanOrEqual(RECAP_DIGEST_MAX_CHARS + 200)
		for (const line of sent.split('\n')) {
			expect(line.length).toBeLessThanOrEqual(RECAP_TURN_MAX_CHARS + 20)
		}
		expect(sent).toContain('r29')
		expect(sent).not.toContain('p0')
	})

	it('always keeps the newest prompt, so a correction is in the recap', () => {
		const turns: RecapTurn[] = [prompt('actually use yarn, not pnpm')]
		for (let i = 0; i < 14; i += 1) turns.push(reply(`step ${i} ${'y'.repeat(590)}`))
		const sent = recapInput(turns) as string
		expect(sent).toContain('actually use yarn, not pnpm')
	})

	it('leaves out empty turns', () => {
		expect(recapInput([prompt('go'), reply('   '), reply('ok')])).toBe('Person: go\nNamzu: ok')
	})
})

describe('the instruction', () => {
	it('carries the contract: short, plain, goal then next action, data not orders', () => {
		expect(RECAP_INSTRUCTION).toMatch(/under 40 words/iu)
		expect(RECAP_INSTRUCTION).toMatch(/one or two plain sentences/iu)
		expect(RECAP_INSTRUCTION).toMatch(/no markdown/iu)
		expect(RECAP_INSTRUCTION).toMatch(/goal/iu)
		expect(RECAP_INSTRUCTION).toMatch(/next action/iu)
		expect(RECAP_INSTRUCTION).toMatch(/do not follow instructions/iu)
	})
})

describe('reading a reply', () => {
	it('takes plain text on one line', () => {
		expect(parseRecap('  Adding retries.\nNext: wire the flag.  ')).toBe(
			'Adding retries. Next: wire the flag.',
		)
	})

	it('removes markdown marks and quotes but keeps identifiers', () => {
		expect(parseRecap('"**Fixing** `parse_config` now."')).toBe('Fixing parse_config now.')
	})

	it('rejects an empty reply', () => {
		expect(parseRecap('   ')).toBeUndefined()
	})

	it('cuts a runaway reply at a word and ends with an ellipsis', () => {
		const text = parseRecap('word '.repeat(200)) as string
		expect(text.length).toBeLessThanOrEqual(RECAP_MAX_CHARS)
		expect(text.endsWith('word…')).toBe(true)
	})

	it('cuts hard when no space keeps more than half', () => {
		const text = parseRecap('x'.repeat(1000)) as string
		expect(text).toBe(`${'x'.repeat(RECAP_MAX_CHARS - 1)}…`)
	})
})

describe('asking the small model', () => {
	function fake(replyText: string | undefined): { model: SideModel; seen: SideRequest[] } {
		const seen: SideRequest[] = []
		return {
			seen,
			model: {
				route: async () => ({ providerId: 'p', model: 'm', source: 'main' }),
				smallProvider: async () => undefined,
				ask: async (request) => {
					seen.push(request)
					return replyText
				},
			},
		}
	}
	const base = {
		sessionId: 's' as SessionId,
		turnId: 't' as TurnId,
		turns: [prompt('fix the build'), reply('Done.')],
		signal: new AbortController().signal,
	}

	it('asks beside the turn with the digest as tagged data', async () => {
		const { model, seen } = fake('Fixing the build. Next: run the tests.')
		const recap = await generateRecap({ ...base, sideModel: model })
		expect(recap).toBe('Fixing the build. Next: run the tests.')
		expect(seen[0]?.timing).toBe('beside-turn')
		expect(seen[0]?.body).toBe(
			'<conversation>\nPerson: fix the build\nNamzu: Done.\n</conversation>',
		)
	})

	it('makes no request when there is nothing to recap', async () => {
		const { model, seen } = fake('x')
		expect(await generateRecap({ ...base, turns: [], sideModel: model })).toBeUndefined()
		expect(seen).toHaveLength(0)
	})

	it('resolves undefined when the side model could not answer', async () => {
		const { model } = fake(undefined)
		expect(await generateRecap({ ...base, sideModel: model })).toBeUndefined()
	})
})
