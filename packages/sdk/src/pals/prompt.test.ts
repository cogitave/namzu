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

	it('knows its connected computer while the user controls it without claiming guest authority', () => {
		const prompt = buildPalSystemPrompt(
			{ name: 'Sıtkı', purpose: '' },
			{ computer: { status: 'connected', control: 'operator' } },
		)
		expect(prompt).toContain('Your own local virtual computer is connected.')
		expect(prompt).toContain('The user currently has control.')
		expect(prompt).toContain('You can still chat while they use it.')
		expect(prompt).toContain('They must return control before you can perform guest actions.')
		expect(prompt).toContain('not a screen observation or execution authority')
		expect(prompt).toContain('No guest tools are admitted')
		expect(prompt).not.toContain('virtual computer is not currently available')
		expect(prompt).not.toContain('observe, act, compare and correct loop')
	})

	it.each([
		['transitioning', 'Its control is changing.'],
		['unavailable', 'cannot currently confirm its input control'],
		['pal', 'has not admitted computer actions'],
	] as const)('describes connected %s control without admitting actions', (control, message) => {
		const prompt = buildPalSystemPrompt(
			{ name: 'Pal', purpose: '' },
			{ computer: { status: 'connected', control } },
		)
		expect(prompt).toContain('Your own local virtual computer is connected.')
		expect(prompt).toContain(message)
		expect(prompt).toContain('No guest tools are admitted')
		expect(prompt).not.toContain('Your own local virtual computer is available.')
	})

	it('scopes common work discipline to an admitted computer, with a compatible basic optout', () => {
		const definition = { name: 'Pal', purpose: '' }
		const computer = {
			status: 'ready' as const,
			workingDirectory: '/guest/work',
		}
		const prompt = buildPalSystemPrompt(definition, { computer })
		expect(prompt).toContain('observe, act, compare and correct loop')
		expect(prompt).toContain('graphics, documents, spreadsheets, browsers, code')
		expect(prompt).toContain('ordinary conversation natural')
		expect(prompt).toContain('application API or script')
		expect(prompt).toContain('after human control returns')
		expect(buildPalSystemPrompt(definition)).not.toContain('observe, act, compare')
		expect(buildPalSystemPrompt(definition, { computer, workGuidance: 'basic' })).not.toContain(
			'observe, act, compare',
		)
		expect(() => buildPalSystemPrompt(definition, { workGuidance: 'unknown' as never })).toThrow(
			'work guidance',
		)
	})

	it('distinguishes observations, saved outputs and task quality from mere tool success', () => {
		const prompt = buildPalSystemPrompt(
			{ name: 'Pal', purpose: '' },
			{ computer: { status: 'ready', workingDirectory: '/guest/work' } },
		)
		expect(prompt).toContain('few meaningful acceptance criteria')
		expect(prompt).toContain('Do not invent references')
		expect(prompt).toContain('If import_reference_images is available')
		expect(prompt).toContain('Do not guess a guest path')
		expect(prompt).toContain('actual resulting artifact')
		expect(prompt).toContain('Correct observed mismatches')
		expect(prompt).toContain('Preserve the original program’s failure status')
		expect(prompt).toContain('Reopen the native file')
		expect(prompt).toContain('independently validate requested exports')
		expect(prompt).toContain('verify_outputs only as a file presence check')
		expect(prompt).toContain('Never claim a reference comparison')
	})
})
