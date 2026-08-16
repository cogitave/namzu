import { describe, expect, it } from 'vitest'

import { ToolRegistry } from '../../registry/index.js'
import { PromptBuilder } from '../../runtime/query/prompt.js'
import type { AgentPersona } from '../../types/persona/index.js'
import type { Skill } from '../../types/skills/index.js'
import {
	type PromptContribution,
	PromptContributionCollisionError,
	PromptContributionRegistry,
	SKILLS_CONTRIBUTION_ID,
	skillsContribution,
} from '../contributions.js'

/**
 * The prompt was closed.
 *
 * `PromptBuilder` assembled a fixed list and every entry was a branch
 * written into it. A capability that needed the model to know something had
 * two options: convince somebody to add a branch, or splice into
 * `systemPrompt` and lose whatever was there.
 */

const PERSONA: AgentPersona = {
	identity: { role: 'Analyst', description: 'reads things' },
}

const SKILL: Skill = {
	metadata: { name: 'reconcile', description: 'reconcile two ledgers' },
	body: 'the body',
} as Skill

const contribution = (
	id: string,
	text: string | null,
	placement: 'static' | 'dynamic' = 'static',
): PromptContribution => ({ id, placement, render: () => text })

const builder = (over: Partial<ConstructorParameters<typeof PromptBuilder>[0]> = {}) =>
	new PromptBuilder({ tools: new ToolRegistry(), ...over })

describe('a contribution reaches the prompt', () => {
	it('appears in the assembled text', () => {
		const contributions = new PromptContributionRegistry()
		contributions.register(contribution('web', '## Citations\nCite what you fetch.'))

		const prompt = builder({ persona: PERSONA, contributions }).build()

		expect(prompt).toContain('Cite what you fetch.')
	})

	it('changes nothing when no registry is supplied', () => {
		// The no-behaviour-change guarantee for every existing caller.
		const withRegistry = builder({
			persona: PERSONA,
			contributions: new PromptContributionRegistry(),
		}).build()
		const without = builder({ persona: PERSONA }).build()

		expect(withRegistry).toBe(without)
	})

	it('drops a contribution that has nothing to say, without a blank section', () => {
		const contributions = new PromptContributionRegistry()
		contributions.register(contribution('quiet', null))
		contributions.register(contribution('loud', '## Loud\nsomething'))

		const prompt = builder({ persona: PERSONA, contributions }).build()

		expect(prompt).toContain('## Loud')
		expect(prompt).not.toMatch(/---\s*\n\s*---/)
	})

	it('drops whitespace-only text too', () => {
		// A contributor returning `'  \n '` meant to return nothing, and a
		// separator around blank text reads as a section the model lost.
		const contributions = new PromptContributionRegistry()
		contributions.register(contribution('blank', '   \n  '))

		const prompt = builder({ persona: PERSONA, contributions }).build()

		expect(prompt).toBe(builder({ persona: PERSONA }).build())
	})

	it('renders in registration order', () => {
		// The contract, and it is not incidental: the prompt is read top to
		// bottom by a model that weights early text more. An order derived
		// from priority numbers would have every contributor arguing about a
		// number.
		const contributions = new PromptContributionRegistry()
		contributions.register(contribution('first', 'AAA'))
		contributions.register(contribution('second', 'BBB'))

		const prompt = builder({ persona: PERSONA, contributions }).build()

		expect(prompt.indexOf('AAA')).toBeLessThan(prompt.indexOf('BBB'))
	})

	it('is given the working directory and the run context', () => {
		const seen: unknown[] = []
		const contributions = new PromptContributionRegistry()
		contributions.register({
			id: 'probe',
			placement: 'static',
			render: (context) => {
				seen.push(context)
				return null
			},
		})

		builder({ persona: PERSONA, contributions }).build('full', '/srv/work')

		expect(seen[0]).toMatchObject({ workingDirectory: '/srv/work' })
	})
})

describe('placement decides which half of the prompt it lands in', () => {
	it('puts a static contribution in the cached segment', () => {
		// `static` is the segment a provider caches across turns. A
		// contributor whose text varies per turn but declares `static` either
		// invalidates the prefix on every iteration or gets served the first
		// turn's text forever.
		const contributions = new PromptContributionRegistry()
		contributions.register(contribution('house-style', 'STATIC TEXT', 'static'))

		const segments = builder({ persona: PERSONA, contributions }).buildSegmented()

		expect(segments.static).toContain('STATIC TEXT')
		expect(segments.dynamic).not.toContain('STATIC TEXT')
	})

	it('puts a dynamic contribution in the re-sent segment', () => {
		const contributions = new PromptContributionRegistry()
		contributions.register(contribution('clock', 'DYNAMIC TEXT', 'dynamic'))

		const segments = builder({ persona: PERSONA, contributions }).buildSegmented()

		expect(segments.dynamic).toContain('DYNAMIC TEXT')
		expect(segments.static).not.toContain('DYNAMIC TEXT')
	})

	it('asks the same question whether or not the prompt cache is used', () => {
		// `build` and `buildSegmented` are two paths to one prompt, and the
		// rejoin upstream is `${static}\n\n---\n\n${dynamic}`. A run that hits
		// the cache must not be asking something different from one that
		// misses it.
		const contributions = new PromptContributionRegistry()
		contributions.register(contribution('a', 'AAA', 'static'))
		contributions.register(contribution('b', 'BBB', 'dynamic'))
		contributions.register(contribution('c', 'CCC', 'static'))
		const built = builder({ persona: PERSONA, contributions })

		const flat = built.build('full', '/srv/work')
		const segments = built.buildSegmented('full', '/srv/work')
		const rejoined =
			segments.dynamic.length > 0
				? `${segments.static}\n\n---\n\n${segments.dynamic}`
				: segments.static

		expect(flat).toBe(rejoined)
	})
})

describe('an id can only be claimed once', () => {
	it('refuses a duplicate rather than letting the second win', () => {
		// "My guidance stopped appearing" is the least debuggable failure
		// this registry could have.
		const contributions = new PromptContributionRegistry()
		contributions.register(contribution('web', 'one'))

		expect(() => contributions.register(contribution('web', 'two'))).toThrow(
			PromptContributionCollisionError,
		)
	})

	it('lets a host that owns both replace one deliberately', () => {
		const contributions = new PromptContributionRegistry()
		contributions.register(contribution('web', 'one'))

		contributions.replace(contribution('web', 'two'))

		expect(contributions.render('static', {})).toEqual(['two'])
	})

	it('keeps the original position when replaced', () => {
		// A replacement is a new implementation of the same contribution, not
		// a new contribution — moving it to the end would silently reorder
		// the prompt.
		const contributions = new PromptContributionRegistry()
		contributions.register(contribution('a', 'AAA'))
		contributions.register(contribution('b', 'BBB'))
		contributions.replace(contribution('a', 'A2'))

		expect(contributions.render('static', {})).toEqual(['A2', 'BBB'])
	})
})

describe('skills is the first contributor, and is not rendered twice', () => {
	it('renders skills through the registry when there is no persona', () => {
		const contributions = new PromptContributionRegistry()
		contributions.register(skillsContribution)

		const prompt = builder({ systemPrompt: 'be brief', contributions, skills: [SKILL] }).build()

		expect(prompt).toContain('## Available Skills')
		expect(prompt).toContain('reconcile')
	})

	it('does NOT render skills twice under a persona', () => {
		// The persona assembler renders skills inside its own section
		// ordering. A model reading the same skill list twice is being told,
		// by repetition, that it matters more than it does.
		const contributions = new PromptContributionRegistry()
		contributions.register(skillsContribution)

		const prompt = builder({ persona: PERSONA, contributions, skills: [SKILL] }).build()

		// The SECTION, not the skill's name — "reconcile" appears three times
		// inside one manifest entry (name, description, location), so counting
		// the name would pass for the wrong reason.
		expect(prompt.split('## Available Skills').length - 1).toBe(1)
	})

	it('leaves the persona prompt byte-identical to what it was', () => {
		// The whole reason skills stays in the persona assembler: moving it
		// out would silently reorder every persona-driven prompt in the
		// estate.
		const contributions = new PromptContributionRegistry()
		contributions.register(skillsContribution)

		const withSeam = builder({ persona: PERSONA, contributions, skills: [SKILL] }).build()
		const before = builder({ persona: PERSONA, skills: [SKILL] }).build()

		expect(withSeam).toBe(before)
	})

	it('says nothing when there are no skills', () => {
		const contributions = new PromptContributionRegistry()
		contributions.register(skillsContribution)

		const prompt = builder({ systemPrompt: 'be brief', contributions }).build()

		expect(prompt).toBe(builder({ systemPrompt: 'be brief' }).build())
	})

	it('registers under a stable, exported id', () => {
		// So a host can tell whether the built-in is already in, and replace
		// it rather than colliding with it.
		expect(skillsContribution.id).toBe(SKILLS_CONTRIBUTION_ID)
		expect(skillsContribution.placement).toBe('static')
	})
})

describe('the registry answers about itself', () => {
	it('reports whether an id is taken', () => {
		const contributions = new PromptContributionRegistry()
		expect(contributions.has('web')).toBe(false)

		contributions.register(contribution('web', 'x'))

		expect(contributions.has('web')).toBe(true)
	})

	it('renders only the placement it was asked about', () => {
		const contributions = new PromptContributionRegistry()
		contributions.register(contribution('s', 'S', 'static'))
		contributions.register(contribution('d', 'D', 'dynamic'))

		expect(contributions.render('static', {})).toEqual(['S'])
		expect(contributions.render('dynamic', {})).toEqual(['D'])
	})
})

describe('the skills contribution is load-bearing, not decorative', () => {
	it('is what renders skills when a registry carries it', () => {
		// A mutation caught the first version of this: the builder rendered
		// skills either way, so the contribution could be deleted with no
		// observable effect. A seam whose first consumer is inert proves
		// nothing about the seam. Replacing the contribution must therefore
		// change the prompt.
		const contributions = new PromptContributionRegistry()
		contributions.register(skillsContribution)
		contributions.replace({
			id: SKILLS_CONTRIBUTION_ID,
			placement: 'static',
			render: () => 'MY OWN SKILLS SECTION',
		})

		const prompt = builder({ systemPrompt: 'be brief', contributions, skills: [SKILL] }).build()

		expect(prompt).toContain('MY OWN SKILLS SECTION')
		expect(prompt).not.toContain('## Available Skills')
	})

	it('keeps skills in the slot they were always in, not at the tail', () => {
		// The registry renders at the END. Skills belong immediately after
		// the system prompt, so a host that registers the built-in gets the
		// seam and not a reordered prompt.
		const contributions = new PromptContributionRegistry()
		contributions.register(skillsContribution)
		contributions.register(contribution('trailing', 'TRAILING SECTION'))

		const prompt = builder({ systemPrompt: 'be brief', contributions, skills: [SKILL] }).build()

		expect(prompt.indexOf('## Available Skills')).toBeLessThan(prompt.indexOf('TRAILING SECTION'))
	})

	it('leaves the tail alone under a persona, where skills already rendered', () => {
		const contributions = new PromptContributionRegistry()
		contributions.register(skillsContribution)

		const prompt = builder({ persona: PERSONA, contributions, skills: [SKILL] }).build()

		expect(prompt.split('## Available Skills').length - 1).toBe(1)
	})
})

describe('the registry’s own render drops what has nothing in it', () => {
	it('drops null and whitespace-only alike', () => {
		// `render` is public and a host may drive it directly, so the filter
		// cannot live only in the builder.
		const contributions = new PromptContributionRegistry()
		contributions.register(contribution('null', null))
		contributions.register(contribution('blank', '   \n\t '))
		contributions.register(contribution('real', 'REAL'))

		expect(contributions.render('static', {})).toEqual(['REAL'])
	})
})

describe('a caller that never heard of the registry is unaffected', () => {
	it('still renders skills with no registry at all', () => {
		// The backward-compat guarantee, and the branch a mutation survived
		// on: every other test here supplies a registry carrying the skills
		// contribution, so the fallback was never exercised.
		const prompt = builder({ systemPrompt: 'be brief', skills: [SKILL] }).build()

		expect(prompt).toContain('## Available Skills')
	})

	it('still renders skills when a registry carries other things', () => {
		// A host that registers web guidance and nothing else must not lose
		// its skills section as a side effect of opting into the seam.
		const contributions = new PromptContributionRegistry()
		contributions.register(contribution('web', 'CITE THINGS'))

		const prompt = builder({ systemPrompt: 'be brief', contributions, skills: [SKILL] }).build()

		expect(prompt).toContain('## Available Skills')
		expect(prompt).toContain('CITE THINGS')
	})

	it('renders skills with no registry in the segmented path too', () => {
		const segments = builder({ systemPrompt: 'be brief', skills: [SKILL] }).buildSegmented()

		expect(segments.static).toContain('## Available Skills')
	})
})
