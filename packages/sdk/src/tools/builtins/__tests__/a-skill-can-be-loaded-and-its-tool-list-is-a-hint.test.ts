import { describe, expect, it, vi } from 'vitest'

import type { SessionId, TurnId } from '../../../types/ids/index.js'
import type { SkillRegistryRef, ToolContext, ToolRegistryRef } from '../../../types/tool/index.js'
import { SKILL_TOOL_NAME, SkillTool, parseAllowedTools } from '../skill.js'

/**
 * A skill the model can actually open, and a tool list that is only a hint.
 *
 * The manifest told the model a SKILL.md exists and to "read the SKILL.md
 * at its <location>" — a filesystem instruction, so a turn without
 * filesystem tools could see every skill and open none. The protocol text
 * even hedged: *"when the runtime exposes filesystem or skill-loading
 * tools"*. There was no skill-loading tool.
 *
 * `allowed-tools` is content, and loaded content cannot change the tool
 * surface; only the host can. It once narrowed the turn, and a skill that
 * wrote `shell` and `output verification` where tool names belong locked a
 * staging turn out of `bash`. What is left is a hint in the result and a
 * warning, once, about entries that are not tools. The runtime half —
 * that nothing a skill declares reaches dispatch or authorization — is
 * pinned in `runtime/query/__tests__/a-loaded-skill-cannot-change-the-tool-surface.test.ts`.
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

/** A tool registry that can list its names, the way the executor's can. */
function toolRegistry(
	names: readonly string[],
	suspended: readonly string[] = [],
): ToolRegistryRef {
	return {
		searchDeferred: () => [],
		activate: () => {},
		getAvailability: (name) => (suspended.includes(name) ? 'suspended' : 'active'),
		listNames: () => names,
	}
}

const REGISTERED = ['skill', 'read', 'bash', 'write', 'glob', 'verify_outputs']

function contextFor(skills?: SkillRegistryRef, overrides: Partial<ToolContext> = {}): ToolContext {
	return {
		sessionId: '0190a5b2-7c3d-7e4f-8a9b-0c1d2e3f4a5b' as SessionId,
		turnId: '651d7ad7-a79e-4783-85bb-5bcd9da09f20' as TurnId,
		workingDirectory: '/tmp',
		abortSignal: new AbortController().signal,
		env: {},
		log: () => {},
		...(skills ? { skills } : {}),
		...overrides,
	}
}

describe('the model can open a skill without a filesystem', () => {
	it('refuses list mode when a structural registry cannot enumerate audience-safe metadata', async () => {
		const result = await SkillTool.execute(
			{},
			contextFor(registry([{ name: 'operator-secret', invocation: 'operator' }])),
		)

		expect(result.success).toBe(false)
		expect(result.error).toMatch(/cannot enumerate model-safe metadata/)
		expect(result.output).not.toContain('operator-secret')
	})

	it('uses a warning phase without advancing past an unseen retained entry', async () => {
		const skills: SkillRegistryRef = {
			catalog: () => [
				{
					registeredName: 'oversized',
					description: 'x'.repeat(1_024),
					location: '/skills/oversized/SKILL.md',
				},
				{
					registeredName: 'small',
					description: 'small',
					location: '/skills/small/SKILL.md',
				},
			],
			load: async () => undefined,
			names: () => ['oversized', 'small'],
		}

		let first:
			| {
					cap: number
					output: string
					page: { skills: unknown[]; warnings: string[]; nextCursor: string | null }
			  }
			| undefined
		for (let cap = 120; cap <= 420; cap += 1) {
			const result = await SkillTool.execute({}, contextFor(skills, { maxToolOutputChars: cap }))
			if (!result.success) continue
			const page = JSON.parse(result.output) as {
				skills: unknown[]
				warnings: string[]
				nextCursor: string | null
			}
			if (page.skills.length === 0 && page.warnings.length === 1 && page.nextCursor) {
				first = { cap, output: result.output, page }
				break
			}
		}

		expect(first, 'fixture could not isolate the warning-only budget boundary').toBeDefined()
		const wrongBudget = await SkillTool.execute(
			{ cursor: first?.page.nextCursor as string },
			contextFor(skills, { maxToolOutputChars: (first?.cap as number) + 1 }),
		)
		expect(wrongBudget.success).toBe(false)
		expect(wrongBudget.error).toMatch(/stale or invalid/)
		const continued = await SkillTool.execute(
			{ cursor: first?.page.nextCursor as string },
			contextFor(skills, { maxToolOutputChars: first?.cap }),
		)
		expect(continued.success).toBe(true)
		const second = JSON.parse(continued.output) as {
			skills: Array<{ name: string }>
			warnings: string[]
			nextCursor: string | null
		}
		expect(first?.output.length).toBeLessThanOrEqual(first?.cap as number)
		expect(continued.output.length).toBeLessThanOrEqual(first?.cap as number)
		expect(second).toEqual({
			skills: [
				{
					name: 'small',
					description: 'small',
					location: '/skills/small/SKILL.md',
				},
			],
			warnings: [],
			nextCursor: null,
		})
	})

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
		const ctx = contextFor(registry([{ name: 'long', body }]), { maxToolOutputChars: 360 })
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

	it('rejects a cursor after the declared tool list changes', async () => {
		// A continuation is bound to the body and the declared list, so every
		// page of one read carries the same hint.
		const stored: StoredSkill = {
			name: 'mutable',
			body: 'body '.repeat(200),
			allowedTools: 'read',
		}
		const ctx = contextFor(registry([stored]), { maxToolOutputChars: 360 })
		const first = await SkillTool.execute({ name: 'mutable' }, ctx)
		const cursor = (first.data as { nextCursor?: string } | undefined)?.nextCursor
		expect(cursor).toBeDefined()

		stored.allowedTools = 'bash'
		const continued = await SkillTool.execute({ name: 'mutable', cursor: cursor as string }, ctx)

		expect(continued.success).toBe(false)
		expect(continued.error).toMatch(/stale or invalid/)
	})
})

describe('a declared tool list is a hint, never a scope', () => {
	it('adopts nothing, and tells the model to keep to nothing', async () => {
		// The context is frozen: a tool that tried to record a scope on it, or
		// swap its list, would throw here. And the model is not told to
		// restrict itself, which would narrow the turn by instruction instead.
		const context = Object.freeze(
			contextFor(registry([{ name: 'delivery', body: 'B', allowedTools: 'read' }]), {
				toolRegistry: toolRegistry(REGISTERED),
				allowedTools: Object.freeze([...REGISTERED]),
			}),
		)

		const result = await SkillTool.execute({ name: 'delivery' }, context)

		expect(result.success).toBe(true)
		expect(context.allowedTools).toEqual(REGISTERED)
		expect(result.output).not.toMatch(/restrict|only use|allowed/i)
	})

	it('names the tools it mentions by their registered names', async () => {
		// `Read` finds `read`, and the pattern in `Bash(git:*)` is dropped: the
		// list grants nothing, so there is no pattern to scope.
		const result = await SkillTool.execute(
			{ name: 'delivery' },
			contextFor(registry([{ name: 'delivery', body: 'B', allowedTools: 'Read, Bash(git:*)' }]), {
				toolRegistry: toolRegistry(REGISTERED),
			}),
		)

		expect(result.output).toContain('Tools this skill mentions: read, bash.')
		expect(result.output).toContain('For reference only')
		expect(result.output).toContain('does not change which tools you can call')
		expect(result.data).toMatchObject({ allowedTools: ['Read', 'Bash(git:*)'] })
	})

	it('names what is not a tool, and warns the host once', async () => {
		// The staging skill, verbatim. The author learns that `shell` and
		// `output verification` are not tools; the model learns not to call
		// them.
		const log = vi.fn()
		const skills = registry([
			{ name: 'delivery', body: 'B', allowedTools: 'skill, read, shell, output verification' },
		])
		const ctx = contextFor(skills, { toolRegistry: toolRegistry(REGISTERED), log })

		const first = await SkillTool.execute({ name: 'delivery' }, ctx)
		await SkillTool.execute({ name: 'delivery' }, ctx)

		expect(first.output).toContain('Tools this skill mentions: skill, read.')
		expect(first.output).toContain('It also mentions "shell", "output verification"')
		expect(first.output).toContain('which are not available here')
		expect(log).toHaveBeenCalledOnce()
		expect(log).toHaveBeenCalledWith('warn', expect.stringContaining('"delivery"'))
		expect(log).toHaveBeenCalledWith(
			'warn',
			expect.stringContaining('"shell", "output verification"'),
		)
	})

	it('warns once per registry, so a host with a registry per turn is told every turn', async () => {
		const log = vi.fn()
		const skills = registry([{ name: 'delivery', body: 'B', allowedTools: 'shell' }])

		await SkillTool.execute(
			{ name: 'delivery' },
			contextFor(skills, { toolRegistry: toolRegistry(REGISTERED), log }),
		)
		await SkillTool.execute(
			{ name: 'delivery' },
			contextFor(skills, { toolRegistry: toolRegistry(REGISTERED), log }),
		)

		expect(log).toHaveBeenCalledTimes(2)
	})

	it('warns about nothing when every entry is a tool', async () => {
		const log = vi.fn()

		await SkillTool.execute(
			{ name: 'delivery' },
			contextFor(registry([{ name: 'delivery', body: 'B', allowedTools: 'read bash' }]), {
				toolRegistry: toolRegistry(REGISTERED),
				log,
			}),
		)

		expect(log).not.toHaveBeenCalled()
	})

	it('passes names through unchecked when there is no registry to check against', async () => {
		// A host driving the tool outside a turn has nothing to validate with,
		// and a false "not a tool" would be worse than no check.
		const log = vi.fn()
		const result = await SkillTool.execute(
			{ name: 'delivery' },
			contextFor(registry([{ name: 'delivery', body: 'B', allowedTools: 'Read, shell' }]), { log }),
		)

		expect(result.output).toContain('Tools this skill mentions: Read, shell.')
		expect(result.output).not.toContain('not available here')
		expect(log).not.toHaveBeenCalled()
	})

	it('does not tell the model whether a tool the step withheld exists', async () => {
		// A registered tool outside the turn's list reads exactly like a name
		// that is no tool at all, the rule `search_tools` keeps. The host is not
		// warned: the name is a real tool, so the author made no mistake.
		const log = vi.fn()
		const withheld = await SkillTool.execute(
			{ name: 'delivery' },
			contextFor(registry([{ name: 'delivery', body: 'B', allowedTools: 'read, bash' }]), {
				toolRegistry: toolRegistry(REGISTERED),
				allowedTools: ['skill', 'read'],
				log,
			}),
		)
		const missing = await SkillTool.execute(
			{ name: 'delivery' },
			contextFor(registry([{ name: 'delivery', body: 'B', allowedTools: 'read, nosuch' }]), {
				toolRegistry: toolRegistry(REGISTERED),
				allowedTools: ['skill', 'read'],
			}),
		)

		expect(withheld.output).toContain('Tools this skill mentions: read.')
		expect(withheld.output).toContain('"bash", which is not available here.')
		expect(missing.output.replace('nosuch', 'bash')).toBe(withheld.output)
		expect(log).not.toHaveBeenCalled()
	})

	it('does not mention a suspended tool as one the model can call', async () => {
		const result = await SkillTool.execute(
			{ name: 'delivery' },
			contextFor(registry([{ name: 'delivery', body: 'B', allowedTools: 'bash' }]), {
				toolRegistry: toolRegistry(REGISTERED, ['bash']),
			}),
		)

		expect(result.output).not.toContain('Tools this skill mentions')
		expect(result.output).toContain('It mentions "bash", which is not available here.')
	})

	it('reports an entry that is not shaped like a tool rather than reading a tool out of it', async () => {
		// `Bash(git:*)Read` is not `Bash`, and an unclosed parenthesis must not
		// swallow the entries after it: both would hide a name the author
		// should hear about.
		const log = vi.fn()
		const result = await SkillTool.execute(
			{ name: 'delivery' },
			contextFor(
				registry([{ name: 'delivery', body: 'B', allowedTools: 'Bash(git:*)Read, write' }]),
				{ toolRegistry: toolRegistry(REGISTERED), log },
			),
		)
		const unclosed = await SkillTool.execute(
			{ name: 'unclosed' },
			contextFor(
				registry([{ name: 'unclosed', body: 'B', allowedTools: 'Bash(git:*, Read, Write' }]),
				{ toolRegistry: toolRegistry(REGISTERED), log },
			),
		)

		expect(result.output).toContain('Tools this skill mentions: write.')
		expect(result.output).toContain('"Bash(git:*)Read"')
		expect(unclosed.output).toContain('Tools this skill mentions: read, write.')
		expect(unclosed.output).toContain('"Bash(git:*"')
		expect(log).toHaveBeenCalledTimes(2)
	})

	it('says nothing about tools when the skill declares none', async () => {
		for (const allowedTools of [undefined, '']) {
			const result = await SkillTool.execute(
				{ name: 'delivery' },
				contextFor(
					registry([
						{
							name: 'delivery',
							body: 'B',
							...(allowedTools === undefined ? {} : { allowedTools }),
						},
					]),
					{ toolRegistry: toolRegistry(REGISTERED) },
				),
			)

			expect(result.success).toBe(true)
			expect(result.output).toBe('B')
		}
	})
})

describe('parsing what an author wrote', () => {
	it('splits and trims a comma list', () => {
		expect(parseAllowedTools(' read , grep ,write ')).toEqual(['read', 'grep', 'write'])
	})

	it('splits a space list, the agentskills.io form', () => {
		expect(parseAllowedTools('Bash(git:*) Bash(jq:*)  Read')).toEqual([
			'Bash(git:*)',
			'Bash(jq:*)',
			'Read',
		])
	})

	it('keeps an entry written in words whole when commas separate', () => {
		expect(parseAllowedTools('skill, read, shell, output verification')).toEqual([
			'skill',
			'read',
			'shell',
			'output verification',
		])
	})

	it('does not let an unbalanced parenthesis swallow the entries after it', () => {
		expect(parseAllowedTools('Bash(git:*, Read, Write')).toEqual(['Bash(git:*', 'Read', 'Write'])
		expect(parseAllowedTools('Bash(git:* Read')).toEqual(['Bash(git:*', 'Read'])
		expect(parseAllowedTools('Bash) Read')).toEqual(['Bash)', 'Read'])
	})

	it('never splits inside parentheses', () => {
		expect(parseAllowedTools('Bash(git add:*) Read')).toEqual(['Bash(git add:*)', 'Read'])
		expect(parseAllowedTools('Bash(git add:*, git commit:*), Read')).toEqual([
			'Bash(git add:*, git commit:*)',
			'Read',
		])
	})

	it('distinguishes "declared nothing" from "declared none"', () => {
		expect(parseAllowedTools(undefined)).toBeUndefined()
		expect(parseAllowedTools('')).toEqual([])
		expect(parseAllowedTools('  ,  ')).toEqual([])
	})
})

describe('the tool itself', () => {
	it('is read-only and named', () => {
		expect(SKILL_TOOL_NAME).toBe('skill')
		expect(SkillTool.isReadOnly?.({ name: 'x' })).toBe(true)
		expect(SkillTool.isDestructive?.({ name: 'x' })).toBe(false)
	})
})
