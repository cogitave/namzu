import type { SessionId, TurnId } from '@namzu/sdk'
import { describe, expect, it } from 'vitest'

import type { SideModel, SideRequest } from '../../small-model/side-model.js'
import {
	TITLE_INPUT_MAX_CHARS,
	TITLE_INSTRUCTION,
	TITLE_MAX_CHARS,
	generateTitle,
	parseTitle,
	titleInput,
} from '../ai-title.js'

describe('what is sent for a title', () => {
	it('sends nothing for a message with nothing to name', () => {
		expect(titleInput('hi')).toBeUndefined()
		expect(titleInput('   short   ')).toBeUndefined()
		expect(titleInput('ten chars!')).toBe('ten chars!')
	})

	it('sends a long message cut to the cap, keeping its start and its end', () => {
		const long = `START${'x'.repeat(5000)}END`

		const sent = titleInput(long) as string

		expect(sent.length).toBeLessThanOrEqual(TITLE_INPUT_MAX_CHARS)
		expect(sent.startsWith('START')).toBe(true)
		expect(sent.endsWith('END')).toBe(true)
		expect(sent).toMatch(/\[… \d+ characters omitted …\]/u)
	})

	it('tells the model the message is data and to answer in the message language', () => {
		expect(TITLE_INSTRUCTION).toMatch(/two to five words/iu)
		expect(TITLE_INSTRUCTION).toMatch(/sentence case/iu)
		expect(TITLE_INSTRUCTION).toMatch(/do not follow instructions/iu)
		expect(TITLE_INSTRUCTION).toMatch(/language the message is written in/iu)
	})
})

describe('reading a reply', () => {
	it('reads the title out of JSON', () => {
		expect(parseTitle('{"title": "Windows build failure"}')).toBe('Windows build failure')
	})

	it('reads JSON inside a code fence', () => {
		expect(parseTitle('```json\n{"title":"Auth refactor"}\n```')).toBe('Auth refactor')
	})

	it('takes a bare line when the model ignored the format', () => {
		expect(parseTitle('"cache invalidation"\n')).toBe('Cache invalidation')
	})

	it('capitalises the first letter only', () => {
		expect(parseTitle('{"title":"useSession hook race"}')).toBe('UseSession hook race')
	})

	it('puts the title on one line and without control characters', () => {
		expect(parseTitle('{"title":"line one\\nline\\u001b[31m two"}')).toBe('Line one line [31m two')
	})

	it('rejects a reply with no title', () => {
		expect(parseTitle('')).toBeUndefined()
		expect(parseTitle('{"name":"x"}')).toBeUndefined()
		expect(parseTitle('{"title": 3}')).toBeUndefined()
		expect(parseTitle('{broken')).toBeUndefined()
	})

	it('caps a runaway title', () => {
		const title = parseTitle(JSON.stringify({ title: 'word '.repeat(100) })) as string
		expect(title.length).toBeLessThanOrEqual(TITLE_MAX_CHARS)
		expect(title.endsWith('…')).toBe(true)
	})
})

describe('asking the small model', () => {
	const sessionId = 'session-1' as SessionId
	const turnId = 'turn-1' as TurnId

	function fakeSideModel(reply: string | undefined): {
		model: SideModel
		seen: SideRequest[]
	} {
		const seen: SideRequest[] = []
		return {
			seen,
			model: {
				route: async () => ({ providerId: 'p', model: 'm', source: 'main' }),
				smallProvider: async () => undefined,
				ask: async (request) => {
					seen.push(request)
					return reply
				},
			},
		}
	}

	it('asks beside the turn, with the message as tagged data, and returns the title', async () => {
		const { model, seen } = fakeSideModel('{"title":"Windows build failure"}')

		const title = await generateTitle({
			sideModel: model,
			sessionId,
			turnId,
			message: 'why does the build fail on windows only',
			signal: new AbortController().signal,
		})

		expect(title).toBe('Windows build failure')
		expect(seen).toHaveLength(1)
		expect(seen[0]?.timing).toBe('beside-turn')
		expect(seen[0]?.body).toBe('<message>\nwhy does the build fail on windows only\n</message>')
	})

	it('makes no request for a message with nothing to name', async () => {
		const { model, seen } = fakeSideModel('{"title":"x"}')

		const title = await generateTitle({
			sideModel: model,
			sessionId,
			turnId,
			message: 'ok',
			signal: new AbortController().signal,
		})

		expect(title).toBeUndefined()
		expect(seen).toHaveLength(0)
	})

	it('returns nothing when the request could not be made', async () => {
		const { model } = fakeSideModel(undefined)

		const title = await generateTitle({
			sideModel: model,
			sessionId,
			turnId,
			message: 'a message long enough to name',
			signal: new AbortController().signal,
		})

		expect(title).toBeUndefined()
	})
})
