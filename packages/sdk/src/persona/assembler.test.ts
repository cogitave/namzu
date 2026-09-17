import { describe, expect, it } from 'vitest'

import type { AgentPersona } from '../types/persona/index.js'
import type { Skill } from '../types/skills/index.js'
import {
	assembleSystemPrompt,
	mergePersonas,
	renderOutputDiscipline,
	withSessionContext,
} from './assembler.js'

/**
 * The persona assembler, which had no test file of its own.
 *
 * Its coverage arrived from other modules' tests: four of them declare a
 * `persona` on a config — `the-prompt-is-open`, `prompt-cache`,
 * `structured-response`, `a-delegation-can-narrow-its-child` — and two call
 * `assembleSystemPrompt` directly, `a-skill-says-who-may-invoke-it` and the
 * plugin proc test. Not one of those personas declares an expertise list, a
 * reflex or an output discipline. The 55 uncovered lines are the proof of
 * that, and they are exactly the fields a host sets when they write a
 * persona: every `if` that a persona sets something fell through to its
 * absent side, so the module was measured as if those features did not
 * exist.
 *
 * `mergePersonas` and `withSessionContext` are exported from the package root
 * and nothing inside the kernel calls them yet, which is the other way a
 * function stays dark: a public contract with no caller. Both are assertions
 * about a returned value, so they are testable here without a run.
 *
 * What is pinned below is what the module promises, in the module's own
 * terms: which sections appear (and which do NOT, since an empty heading is
 * a claim the model reads), what is trimmed, the order the sections land in,
 * and the composition rules for a persona that extends another.
 */

const persona = (overrides: Partial<AgentPersona> = {}): AgentPersona => ({
	identity: { role: 'Reviewer', description: 'Reads diffs.' },
	...overrides,
})

/** Every `## ` heading in the prompt, in the order they appear. */
const headings = (prompt: string): string[] =>
	prompt.split('\n').filter((line) => line.startsWith('## '))

const skill = (name: string, body?: string): Skill =>
	({
		metadata: { name, description: `does ${name}` },
		dirPath: `/tmp/${name}`,
		...(body ? { body } : {}),
	}) as Skill

describe('assembleSystemPrompt', () => {
	it('always leads with the identity, with its description trimmed', () => {
		// The one section that is not conditional. A persona's identity is what
		// the rest of the prompt is written in the voice of, so a prompt that
		// opens with anything else is already the wrong prompt.
		const prompt = assembleSystemPrompt(
			persona({ identity: { role: 'Reviewer', description: '  Reads diffs.  ' } }),
		)

		expect(prompt).toBe('## Identity\n**Reviewer**\n\nReads diffs.')
	})

	it('renders a `## Expertise` section only when there are domains', () => {
		expect(
			headings(assembleSystemPrompt(persona({ expertise: { domains: ['TypeScript', 'CI'] } }))),
		).toContain('## Expertise')
		expect(assembleSystemPrompt(persona({ expertise: { domains: ['TypeScript', 'CI'] } }))).toBe(
			'## Identity\n**Reviewer**\n\nReads diffs.\n\n## Expertise\n- TypeScript\n- CI',
		)

		// An empty list is the shape a config loader produces from `domains: []`,
		// and a `## Expertise` heading with nothing under it tells the model it
		// has expertise it was not given.
		expect(headings(assembleSystemPrompt(persona({ expertise: { domains: [] } })))).not.toContain(
			'## Expertise',
		)
		expect(headings(assembleSystemPrompt(persona()))).not.toContain('## Expertise')
	})

	it('renders constraints and tool guidance, each trimmed', () => {
		const prompt = assembleSystemPrompt(
			persona({
				reflexes: {
					constraints: ['  Never rewrite history  ', 'Ask before deleting'],
					toolGuidance: '  Prefer rg over grep.  ',
				},
			}),
		)

		expect(prompt).toContain('## Constraints\n- Never rewrite history\n- Ask before deleting')
		expect(prompt).toContain('## Tool Guidance\nPrefer rg over grep.')
	})

	it('says nothing about constraints or tools when a persona declares neither', () => {
		// `reflexes: { constraints: [] }` is what a schema-defaulted persona
		// looks like. Neither heading may appear for it — an empty
		// `## Constraints` reads as "you have no constraints", which is a
		// stronger statement than this module is entitled to make.
		const prompt = assembleSystemPrompt(persona({ reflexes: { constraints: [] } }))

		expect(headings(prompt)).not.toContain('## Constraints')
		expect(headings(prompt)).not.toContain('## Tool Guidance')
	})

	it('resolves output discipline from the reflexes that carry it', () => {
		// The discipline lives on `reflexes`, and the assembler is one of two
		// places that can reach it. Rendering it here is what makes a persona
		// that declares one actually get it, rather than a config field that
		// only a direct `renderOutputDiscipline` call would ever honour.
		const prompt = assembleSystemPrompt(
			persona({
				reflexes: {
					constraints: [],
					outputDiscipline: { betweenToolCalls: 'silent', suppressInnerMonologue: true },
				},
			}),
		)

		expect(prompt).toContain('## Output Discipline')
		expect(prompt).toContain('- Emit zero words between tool calls.')
		expect(prompt).toContain('- Do not output inner monologue')
	})

	it('carries the output format and the session context when the persona sets them', () => {
		const prompt = assembleSystemPrompt(
			persona({ output: { format: '  Bullet points.  ' }, sessionContext: '  On main.  ' }),
		)

		expect(prompt).toContain('## Output Format\nBullet points.')
		expect(prompt).toContain('## Session Context\nOn main.')
	})

	it('orders the sections: identity, expertise, constraints, tools, skills, discipline, output, context', () => {
		// Section order is this module's decision and it is load-bearing:
		// `prompt/contributions.ts` documents that skills are rendered here
		// rather than in the contributions pipeline precisely so this ordering
		// holds, and `prompt.ts` splits on it to keep the static prefix cached.
		// A reorder is therefore a prompt-cache event, not a cosmetic one.
		const prompt = assembleSystemPrompt(
			persona({
				expertise: { domains: ['TypeScript'] },
				reflexes: {
					constraints: ['Be brief'],
					toolGuidance: 'Prefer rg.',
					outputDiscipline: { betweenToolCalls: 'minimal' },
				},
				output: { format: 'Prose.' },
				sessionContext: 'On main.',
			}),
			[skill('model-one')],
		)

		expect(headings(prompt)).toEqual([
			'## Identity',
			'## Expertise',
			'## Constraints',
			'## Tool Guidance',
			'## Available Skills',
			'## Output Discipline',
			'## Output Format',
			'## Session Context',
		])
	})
})

describe('renderOutputDiscipline', () => {
	it('says zero words for `silent` and one sentence for `minimal`, never both', () => {
		// `betweenToolCalls` is a two-valued enum that the schema defaults, so
		// the `else` is not an unreachable fallback — it is the branch half the
		// estate is on. Both must be present in the output and mutually
		// exclusive, or a model is told to be silent and to narrate.
		const silent = renderOutputDiscipline({ betweenToolCalls: 'silent' })
		const minimal = renderOutputDiscipline({ betweenToolCalls: 'minimal' })

		expect(silent).toContain('Emit zero words between tool calls')
		expect(silent).not.toContain('Emit minimal text')

		expect(minimal).toContain('Emit minimal text between tool calls')
		expect(minimal).not.toContain('Emit zero words')

		expect(silent.startsWith('## Output Discipline\n')).toBe(true)
	})

	it('adds the inner-monologue line only when asked to suppress it', () => {
		expect(renderOutputDiscipline({ betweenToolCalls: 'minimal' })).not.toContain('inner monologue')
		expect(
			renderOutputDiscipline({ betweenToolCalls: 'minimal', suppressInnerMonologue: true }),
		).toContain(
			'- Do not output inner monologue, reasoning traces, or planning text between turns.',
		)
	})

	it('names each word budget that is set, and neither when none is', () => {
		// The numbers matter: they are the only part of the discipline the model
		// can count against, and a budget rendered without its number is a
		// sentence with no limit in it.
		const single = renderOutputDiscipline({
			betweenToolCalls: 'minimal',
			finalResponse: { singleFileMaxWords: 40 },
		})
		expect(single).toContain('Final response for single-file changes: 40 words maximum')
		expect(single).not.toContain('multi-file changes')

		const multi = renderOutputDiscipline({
			betweenToolCalls: 'minimal',
			finalResponse: { multiFileMaxWords: 120 },
		})
		expect(multi).toContain('Final response for multi-file changes: 120 words maximum')
		expect(multi).not.toContain('single-file changes')

		expect(renderOutputDiscipline({ betweenToolCalls: 'minimal' })).not.toContain('words maximum')
	})

	it('emits both budgets, in single-then-multi order, when both are set', () => {
		const both = renderOutputDiscipline({
			betweenToolCalls: 'silent',
			suppressInnerMonologue: true,
			finalResponse: { singleFileMaxWords: 40, multiFileMaxWords: 120 },
		})

		expect(both.indexOf('single-file changes')).toBeLessThan(both.indexOf('multi-file changes'))
		// And the whole thing is one section, in the order the fields are read:
		// between-tool-calls, monologue, then the budgets.
		expect(both.indexOf('Emit zero words')).toBeLessThan(both.indexOf('inner monologue'))
		expect(both.indexOf('inner monologue')).toBeLessThan(both.indexOf('single-file changes'))
	})
})

describe('mergePersonas', () => {
	it('takes the overriding identity and keeps the base one when there is none', () => {
		const base = persona()

		expect(
			mergePersonas(base, { identity: { role: 'Auditor', description: 'Checks.' } }),
		).toMatchObject({ identity: { role: 'Auditor', description: 'Checks.' } })
		expect(mergePersonas(base, {}).identity).toEqual(base.identity)
	})

	it('concatenates expertise domains, base first', () => {
		// Additive, not replacing: the base persona is a floor, and a host that
		// extends it is adding to what it already knows rather than silently
		// dropping the domains it inherited. Order is part of the contract —
		// the prompt is read top to bottom and inherited domains come first.
		const merged = mergePersonas(persona({ expertise: { domains: ['TypeScript'] } }), {
			expertise: { domains: ['Cilium', 'Kubernetes'] },
		})

		expect(merged.expertise).toEqual({ domains: ['TypeScript', 'Cilium', 'Kubernetes'] })
	})

	it('always returns an expertise object, even when neither side declares one', () => {
		// The result is `AgentPersona`, where `expertise` is optional — so the
		// merge could legally have returned `{}`. It returns `{ domains: [] }`
		// instead, which is what keeps a chained merge from crashing on the
		// second hop and gives the assembler the same empty-list shape every
		// other reader checks.
		expect(mergePersonas(persona(), {}).expertise).toEqual({ domains: [] })
	})

	it('concatenates constraints, base first', () => {
		const merged = mergePersonas(
			persona({ reflexes: { constraints: ['Never rewrite history'] } }),
			{ reflexes: { constraints: ['Ask before deleting'] } },
		)

		expect(merged.reflexes?.constraints).toEqual(['Never rewrite history', 'Ask before deleting'])
	})

	it('lets an override win for the singular fields and falls back to the base', () => {
		// The singular slots — tool guidance, output discipline, output
		// format, session context, and identity above — replace rather than
		// concatenate. Both directions are asserted because a merge that only
		// ever replaced, or only ever kept the base, would pass half of this
		// and lose the other.
		const base = persona({
			reflexes: {
				constraints: [],
				toolGuidance: 'base guidance',
				outputDiscipline: { betweenToolCalls: 'minimal' },
			},
			output: { format: 'Base format.' },
			sessionContext: 'base context',
		})

		const overridden = mergePersonas(base, {
			reflexes: {
				constraints: [],
				toolGuidance: 'override guidance',
				outputDiscipline: { betweenToolCalls: 'silent' },
			},
			output: { format: 'Override format.' },
			sessionContext: 'override context',
		})

		expect(overridden.reflexes?.toolGuidance).toBe('override guidance')
		expect(overridden.reflexes?.outputDiscipline).toEqual({ betweenToolCalls: 'silent' })
		expect(overridden.output).toEqual({ format: 'Override format.' })
		expect(overridden.sessionContext).toBe('override context')

		const inherited = mergePersonas(base, {})

		expect(inherited.reflexes?.toolGuidance).toBe('base guidance')
		expect(inherited.reflexes?.outputDiscipline).toEqual({ betweenToolCalls: 'minimal' })
		expect(inherited.output).toEqual({ format: 'Base format.' })
		expect(inherited.sessionContext).toBe('base context')
	})

	it('does not hand back the base’s own arrays', () => {
		// A merge that returned `base.expertise.domains` when the override had
		// none would make the next `push` on the result an edit to the base —
		// and a base persona is shared by every run built from it. Fresh arrays
		// are what keeps an extending persona from writing through.
		const base = persona({
			expertise: { domains: ['TypeScript'] },
			reflexes: { constraints: ['Be brief'] },
		})

		const merged = mergePersonas(base, {})

		expect(merged.expertise?.domains).not.toBe(base.expertise?.domains)
		expect(merged.expertise?.domains).toEqual(['TypeScript'])
		expect(merged.reflexes?.constraints).not.toBe(base.reflexes?.constraints)
		expect(base.expertise?.domains).toEqual(['TypeScript'])
		expect(base.reflexes?.constraints).toEqual(['Be brief'])
	})

	it('assembles the merged persona into a prompt that carries both sides', () => {
		// The reason the merge exists: the result has to be a persona the
		// assembler can render, not an intermediate shape with a hole in it.
		const merged = mergePersonas(
			persona({ expertise: { domains: ['TypeScript'] } }),
			persona({
				identity: { role: 'Auditor', description: 'Checks.' },
				sessionContext: 'On main.',
			}),
		)

		const prompt = assembleSystemPrompt(merged)

		expect(prompt).toContain('**Auditor**')
		expect(prompt).toContain('- TypeScript')
		expect(prompt).toContain('## Session Context\nOn main.')
	})
})

describe('withSessionContext', () => {
	it('returns a persona carrying the context and leaves the original alone', () => {
		// The original is not incidental: a run's persona is the host's config
		// object, often shared across runs, and stamping a turn's context onto
		// it would leak one run's context into the next.
		const base = persona({ sessionContext: 'from the file' })

		const stamped = withSessionContext(base, 'turn two')

		expect(stamped.sessionContext).toBe('turn two')
		expect(base.sessionContext).toBe('from the file')
		expect(stamped).not.toBe(base)
		expect(stamped.identity).toEqual(base.identity)
	})

	it('is how a session context reaches the assembled prompt', () => {
		const prompt = assembleSystemPrompt(withSessionContext(persona(), '  On main.  '))

		expect(prompt).toContain('## Session Context\nOn main.')
	})
})
