import { describe, expect, it } from 'vitest'
import { buildPalSystemPrompt, palConversationGreeting } from './prompt.js'

describe('Pal conversational system context', () => {
	it('reconstructs a stable English prelude from the original claimed revision without inference', () => {
		const pinned = Object.freeze({ id: 'pal-identity', revision: 1, name: 'Kiro' })
		const intro = palConversationGreeting(pinned, 'original-conversation')
		expect(intro).toEqual({
			id: 'pal-intro:pal-identity:1:original-conversation',
			text: "Hey! I'm Kiro. Ready when you are. What's on your mind?",
		})
		expect(palConversationGreeting(pinned, 'original-conversation')).toEqual(intro)
		const context = buildPalSystemPrompt({ name: pinned.name, purpose: '' }, { greeting: intro })
		expect(context).toContain(JSON.stringify(intro.text))
		expect(context).toContain('not a prior model turn or evidence of work')
		expect(
			palConversationGreeting({ ...pinned, revision: 2, name: 'New name' }, 'new'),
		).not.toEqual(intro)
		expect(() => palConversationGreeting(pinned, ' ')).toThrow('conversation id')
	})
	it('uses the captured name, character and purpose without mutating the saved profile', () => {
		const profile = Object.freeze({
			name: 'Kiro',
			purpose: 'Use primary sources.\nKeep useful notes.',
			appearance: Object.freeze({ character: 'sprout' as const, color: 'green' as const }),
		})
		const prompt = buildPalSystemPrompt(profile)
		expect(prompt).toContain('You are "Kiro", a persistent Namzu Pal.')
		expect(prompt).toContain('character is sprout, with the green color')
		expect(prompt).toContain('Use primary sources.\nKeep useful notes.')
		expect(prompt).toContain('You can still chat.')
		expect(prompt).not.toContain('Your own local virtual computer is available.')
		expect(profile.name).toBe('Kiro')
	})

	it('describes confirmed guest access and keeps host access unavailable', () => {
		const prompt = buildPalSystemPrompt(
			{ name: 'Happy', purpose: '' },
			{
				computer: { status: 'ready', workingDirectory: '/guest/work' },
				systemNote: 'One current host note.',
			},
		)
		expect(prompt).toContain('only to its filesystem at /guest/work')
		expect(prompt).toContain('A request to use a computer never authorizes a host fallback.')
		expect(prompt).toContain('One current host note.')
		expect(prompt).not.toContain('undefined')
		expect(prompt).not.toContain('configured visual character')
	})

	it('keeps chat language and public output discipline separate from execution authority', () => {
		const prompt = buildPalSystemPrompt(
			{ name: 'Researcher', purpose: '' },
			{ computer: { status: 'unavailable' } },
		)
		expect(prompt).toContain('Start in English until the user speaks or requests another language')
		expect(prompt).toContain('internal reasoning, raw tool results, command logs')
		expect(prompt).toContain('not for every chat reply')
		expect(prompt).toContain('only after its tool result confirms it')
		expect(prompt).toContain('Do not claim computer access')
	})
})
