import { describe, expect, it } from 'vitest'

import type { RunId } from '../../../types/ids/index.js'
import type { SkillRegistryRef, ToolContext } from '../../../types/tool/index.js'
import { SKILL_TOOL_NAME, SkillTool, parseAllowedTools } from '../skill.js'

/**
 * A skill the model can actually open, and a scope it cannot decline.
 *
 * The manifest told the model a SKILL.md exists and to "read the SKILL.md
 * at its <location>" — a filesystem instruction, so a run without
 * filesystem tools could see every skill and open none. The protocol text
 * even hedged: *"when the runtime exposes filesystem or skill-loading
 * tools"*. There was no skill-loading tool.
 *
 * `allowed-tools` failed from the other side: parsed, stored, rendered into
 * the prompt, and read by nothing — advice the model could ignore, phrased
 * as a declaration.
 */

interface StoredSkill {
	name: string
	description?: string
	body?: string
	allowedTools?: string
	invocation?: 'model' | 'operator' | 'both'
}

function registry(skills: StoredSkill[]): SkillRegistryRef {
	return {
		async load(name) {
			const found = skills.find((s) => s.name === name)
			if (!found) return undefined
			return {
				skill: {
					metadata: {
						name: found.name,
						description: found.description ?? 'd',
						...(found.allowedTools === undefined ? {} : { allowedTools: found.allowedTools }),
						...(found.invocation === undefined ? {} : { invocation: found.invocation }),
					},
					...(found.body === undefined ? {} : { body: found.body }),
				},
			}
		},
		names: () => skills.map((s) => s.name),
	}
}

function contextFor(
	skills?: SkillRegistryRef,
	adopted?: { scope?: { skill: string; allowedTools: readonly string[] } },
	overrides: Partial<ToolContext> = {},
): ToolContext {
	return {
		runId: 'run_skill' as RunId,
		workingDirectory: '/tmp',
		abortSignal: new AbortController().signal,
		env: {},
		log: () => {},
		...(skills ? { skills } : {}),
		...(adopted
			? {
					adoptSkillScope: (scope: { skill: string; allowedTools: readonly string[] }) => {
						adopted.scope = scope
					},
				}
			: {}),
		...overrides,
	}
}

describe('the model can open a skill without a filesystem', () => {
	it('returns the body', async () => {
		const result = await SkillTool.execute(
			{ name: 'reconcile' },
			contextFor(registry([{ name: 'reconcile', body: 'THE INSTRUCTIONS' }])),
		)

		expect(result.success).toBe(true)
		expect(result.output).toContain('THE INSTRUCTIONS')
	})

	it('names what IS available when the name misses', async () => {
		// A bare "not found" sends the model guessing at spellings, from a
		// manifest already in its own prompt.
		const result = await SkillTool.execute(
			{ name: 'reconsile' },
			contextFor(registry([{ name: 'reconcile' }, { name: 'audit' }])),
		)

		expect(result.success).toBe(false)
		expect(result.error).toContain('reconcile')
		expect(result.error).toContain('audit')
	})

	it('says so rather than reporting an empty list with no registry', async () => {
		// "No skills here" and "no registry" are different answers.
		const result = await SkillTool.execute({ name: 'reconcile' }, contextFor())

		expect(result.success).toBe(false)
		expect(result.error).toMatch(/no skills registry/i)
	})

	it('answers usefully for a skill with no body', async () => {
		const result = await SkillTool.execute(
			{ name: 'empty' },
			contextFor(registry([{ name: 'empty' }])),
		)

		expect(result.success).toBe(true)
		expect(result.output).toContain('no body')
	})

	it('REFUSES an operator-only skill the model named anyway', async () => {
		// The manifest omits it, and the model can still name it — from
		// earlier context, from a replayed prefix, from a guess. A check that
		// only filtered the listing would be a menu restriction rather than a
		// kitchen one, which is the exact defect `allowedTools` had.
		const result = await SkillTool.execute(
			{ name: 'rotate-keys' },
			contextFor(registry([{ name: 'rotate-keys', invocation: 'operator', body: 'SECRET' }])),
		)

		expect(result.success).toBe(false)
		expect(result.error).toMatch(/not for you to run/)
		expect(result.output).not.toContain('SECRET')
	})

	it('allows a `both` skill, and a `model` one', async () => {
		for (const invocation of ['both', 'model'] as const) {
			const result = await SkillTool.execute(
				{ name: 's' },
				contextFor(registry([{ name: 's', invocation, body: 'B' }])),
			)
			expect(result.success).toBe(true)
		}
	})

	it('pages a long body without losing its middle to generic truncation', async () => {
		const middle = 'MIDDLE_INSTRUCTIONS_MUST_SURVIVE'
		const body = `${'a'.repeat(700)}${middle}${'z'.repeat(700)}`
		const ctx = contextFor(registry([{ name: 'long', body }]), undefined, {
			maxToolOutputChars: 360,
		})
		const outputs: string[] = []
		let cursor: string | undefined

		for (let page = 0; page < 20; page++) {
			const result = await SkillTool.execute({ name: 'long', ...(cursor ? { cursor } : {}) }, ctx)
			expect(result.success).toBe(true)
			expect(result.output.length).toBeLessThanOrEqual(360)
			expect(result.output).not.toContain('characters omitted')
			outputs.push(result.output)
			cursor = (result.data as { nextCursor?: string } | undefined)?.nextCursor
			if (!cursor) break
		}

		expect(cursor).toBeUndefined()
		expect(outputs.length).toBeGreaterThan(1)
		expect(outputs.join('\n')).toContain(middle)
	})

	it('rejects a cursor after authorization metadata changes before adopting scope', async () => {
		const stored: StoredSkill = {
			name: 'mutable',
			body: 'body '.repeat(200),
			allowedTools: 'read',
		}
		const adopted: { scope?: { skill: string; allowedTools: readonly string[] } } = {}
		const ctx = contextFor(registry([stored]), adopted, { maxToolOutputChars: 360 })
		const first = await SkillTool.execute({ name: 'mutable' }, ctx)
		const cursor = (first.data as { nextCursor?: string } | undefined)?.nextCursor
		expect(cursor).toBeDefined()
		expect(adopted.scope).toEqual({ skill: 'mutable', allowedTools: ['read'] })

		stored.allowedTools = 'bash'
		const continued = await SkillTool.execute({ name: 'mutable', cursor: cursor as string }, ctx)

		expect(continued.success).toBe(false)
		expect(continued.error).toMatch(/stale or invalid/)
		expect(adopted.scope).toEqual({ skill: 'mutable', allowedTools: ['read'] })
	})
})

describe('a declared tool scope is adopted, not merely announced', () => {
	it('hands the scope to the runtime', async () => {
		// The difference between the field as it was and the field as a
		// declaration: this happens whether or not the model reads the notice.
		const adopted: { scope?: { skill: string; allowedTools: readonly string[] } } = {}

		await SkillTool.execute(
			{ name: 'reconcile' },
			contextFor(registry([{ name: 'reconcile', body: 'B', allowedTools: 'read, grep' }]), adopted),
		)

		expect(adopted.scope).toEqual({ skill: 'reconcile', allowedTools: ['read', 'grep'] })
	})

	it('adopts nothing when the skill declares nothing', async () => {
		// Absent is unrestricted, and must not be collapsed into an empty
		// scope — that would silently narrow every skill that says nothing to
		// no tools at all.
		const adopted: { scope?: { skill: string; allowedTools: readonly string[] } } = {}

		await SkillTool.execute(
			{ name: 'reconcile' },
			contextFor(registry([{ name: 'reconcile', body: 'B' }]), adopted),
		)

		expect(adopted.scope).toBeUndefined()
	})

	it('adopts an EMPTY scope when the author declared one', async () => {
		// `allowed-tools: ""` is an author saying this skill needs no tools.
		// Collapsing it to `undefined` would widen that to everything.
		const adopted: { scope?: { skill: string; allowedTools: readonly string[] } } = {}

		await SkillTool.execute(
			{ name: 'reconcile' },
			contextFor(registry([{ name: 'reconcile', body: 'B', allowedTools: '' }]), adopted),
		)

		expect(adopted.scope).toEqual({ skill: 'reconcile', allowedTools: [] })
	})

	it('tells the model, and tells it WHEN', async () => {
		// A restriction that lands next turn while the model believes it
		// landed now produces a batch it cannot explain.
		const result = await SkillTool.execute(
			{ name: 'reconcile' },
			contextFor(registry([{ name: 'reconcile', body: 'B', allowedTools: 'read' }])),
		)

		expect(result.output).toContain('restrict yourself to: read')
		expect(result.output).toContain('next turn')
	})

	it('still announces the scope where nothing can enforce it', async () => {
		// A host driving this tool outside a run has no executor. Saying
		// nothing there would be worse than advice.
		const result = await SkillTool.execute(
			{ name: 'reconcile' },
			contextFor(registry([{ name: 'reconcile', body: 'B', allowedTools: 'read' }])),
		)

		expect(result.success).toBe(true)
		expect(result.output).toContain('restrict yourself to')
	})
})

describe('parsing what an author wrote', () => {
	it('splits and trims a comma list', () => {
		expect(parseAllowedTools(' read , grep ,write ')).toEqual(['read', 'grep', 'write'])
	})

	it('distinguishes "declared nothing" from "declared none"', () => {
		expect(parseAllowedTools(undefined)).toBeUndefined()
		expect(parseAllowedTools('')).toEqual([])
		expect(parseAllowedTools('  ,  ')).toEqual([])
	})
})

describe('the tool that must always be reachable', () => {
	it('is read-only and named', () => {
		// A skill that narrowed the model out of reaching for another skill
		// would be a one-way door. The executor keeps this name in scope, and
		// the name is exported so it can.
		expect(SKILL_TOOL_NAME).toBe('skill')
		expect(SkillTool.isReadOnly?.({ name: 'x' })).toBe(true)
		expect(SkillTool.isDestructive?.({ name: 'x' })).toBe(false)
	})
})
