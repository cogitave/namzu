import { describe, expect, it } from 'vitest'

import type { SessionId, TurnId } from '../../../types/ids/index.js'
import type { SkillRegistryRef, ToolContext } from '../../../types/tool/index.js'
import { SKILL_TOOL_NAME, SkillTool, parseAllowedTools } from '../skill.js'

/**
 * A skill the model can actually open, and an `allowed-tools` that grants.
 *
 * The manifest told the model a SKILL.md exists and to "read the SKILL.md
 * at its <location>" — a filesystem instruction, so a turn without
 * filesystem tools could see every skill and open none.
 *
 * `allowed-tools` was then read as a RESTRICTION: the tool told the model to
 * "restrict yourself to" the listed tools and the executor narrowed the next
 * batch to them. The owner loaded a skill with `allowed-tools` and watched
 * the model stop using `bash`. The field pre-approves; it never narrows.
 */

interface StoredSkill {
	name: string
	description?: string
	body?: string
	allowedTools?: string
	invocation?: 'model' | 'operator' | 'both'
	dirPath?: string
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
					...(found.dirPath === undefined ? {} : { dirPath: found.dirPath }),
				},
			}
		},
		names: () => skills.map((s) => s.name),
	}
}

interface GrantCall {
	skill: string
	allowedTools: readonly string[]
	skillDirectory?: string
}

/** Records every COMMITTED grant, and answers the way the executor does for a turn with `read` and `grep`. */
function granting(calls: GrantCall[]): NonNullable<ToolContext['grantSkillTools']> {
	return (grant) => {
		const known = new Set(['read', 'grep', 'bash'])
		const granted: string[] = []
		const ignored: { entry: string; reason: string }[] = []
		for (const entry of grant.allowedTools) {
			if (known.has(entry.toLowerCase())) granted.push(entry.toLowerCase())
			else ignored.push({ entry, reason: 'this turn has no tool by that name' })
		}
		return { granted, ignored, commit: () => calls.push({ ...grant }) }
	}
}

function contextFor(
	skills?: SkillRegistryRef,
	grants?: GrantCall[],
	overrides: Partial<ToolContext> = {},
): ToolContext {
	return {
		sessionId: '0190a5b2-7c3d-7e4f-8a9b-0c1d2e3f4a5b' as SessionId,
		turnId: '651d7ad7-a79e-4783-85bb-5bcd9da09f20' as TurnId,
		workingDirectory: '/tmp',
		abortSignal: new AbortController().signal,
		env: {},
		log: () => {},
		...(skills ? { skills } : {}),
		...(grants ? { grantSkillTools: granting(grants) } : {}),
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
					page: {
						skills: unknown[]
						warnings: string[]
						nextCursor: string | null
					}
			  }
			| undefined
		for (let cap = 120; cap <= 420; cap += 1) {
			const result = await SkillTool.execute(
				{},
				contextFor(skills, undefined, { maxToolOutputChars: cap }),
			)
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
			contextFor(skills, undefined, {
				maxToolOutputChars: (first?.cap as number) + 1,
			}),
		)
		expect(wrongBudget.success).toBe(false)
		expect(wrongBudget.error).toMatch(/stale or invalid/)
		const continued = await SkillTool.execute(
			{ cursor: first?.page.nextCursor as string },
			contextFor(skills, undefined, { maxToolOutputChars: first?.cap }),
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

	it('rejects a cursor after authorization metadata changes', async () => {
		const stored: StoredSkill = {
			name: 'mutable',
			body: 'body '.repeat(400),
			allowedTools: 'read',
		}
		const grants: GrantCall[] = []
		// Room for the grant notice, which rides on every page.
		const ctx = contextFor(registry([stored]), grants, {
			maxToolOutputChars: 700,
		})
		const first = await SkillTool.execute({ name: 'mutable' }, ctx)
		const cursor = (first.data as { nextCursor?: string } | undefined)?.nextCursor
		expect(cursor).toBeDefined()
		expect(grants).toEqual([{ skill: 'mutable', allowedTools: ['read'] }])

		stored.allowedTools = 'bash'
		const continued = await SkillTool.execute({ name: 'mutable', cursor: cursor as string }, ctx)

		expect(continued.success).toBe(false)
		expect(continued.error).toMatch(/stale or invalid/)
		// Nothing new granted under the stale cursor.
		expect(grants).toEqual([{ skill: 'mutable', allowedTools: ['read'] }])
	})
})

describe('allowed-tools grants, and never restricts', () => {
	it("hands the parsed entries and the skill's directory to the turn", async () => {
		const grants: GrantCall[] = []

		await SkillTool.execute(
			{ name: 'reconcile' },
			contextFor(
				registry([
					{
						name: 'reconcile',
						body: 'B',
						allowedTools: 'Read Grep Bash(git status *)',
						dirPath: '/skills/reconcile',
					},
				]),
				grants,
			),
		)

		expect(grants).toEqual([
			{
				skill: 'reconcile',
				allowedTools: ['Read', 'Grep', 'Bash(git status *)'],
				skillDirectory: '/skills/reconcile',
			},
		])
	})

	it('grants nothing when the instructions could not be delivered', async () => {
		// The budget cannot hold even one page, so the model receives no
		// instructions — and a skill it never read must not have approved
		// anything for the rest of the turn.
		const grants: GrantCall[] = []
		const result = await SkillTool.execute(
			{ name: 'reconcile' },
			contextFor(
				registry([
					{
						name: 'reconcile',
						body: 'B'.repeat(500),
						allowedTools: 'Read Grep',
					},
				]),
				grants,
				{ maxToolOutputChars: 40 },
			),
		)

		expect(result.success).toBe(false)
		expect(result.error).toMatch(/too small to read "reconcile"/)
		expect(grants).toEqual([])
	})

	it('grants nothing when the skill declares nothing, or declares it empty', async () => {
		for (const allowedTools of [undefined, '']) {
			const grants: GrantCall[] = []
			const result = await SkillTool.execute(
				{ name: 'reconcile' },
				contextFor(
					registry([
						{
							name: 'reconcile',
							body: 'B',
							...(allowedTools === undefined ? {} : { allowedTools }),
						},
					]),
					grants,
				),
			)
			expect(grants).toEqual([])
			expect(result.output).toBe('B')
		}
	})

	it('tells the model what was pre-approved, and that nothing was taken away', async () => {
		// The old notice said "restrict yourself to", and a model told that
		// does what the owner saw: it stops using bash.
		const result = await SkillTool.execute(
			{ name: 'reconcile' },
			contextFor(registry([{ name: 'reconcile', body: 'B', allowedTools: 'Read Grep' }]), []),
		)

		expect(result.output).toContain('Pre-approved for the rest of this turn: read, grep')
		expect(result.output).toContain('Every other tool remains available')
		expect(result.output).not.toMatch(/restrict yourself/i)
		expect(result.data).toMatchObject({
			granted: ['read', 'grep'],
			ignored: [],
		})
	})

	it('names an entry it ignored', async () => {
		const result = await SkillTool.execute(
			{ name: 'reconcile' },
			contextFor(registry([{ name: 'reconcile', body: 'B', allowedTools: 'Read Frobnicate' }]), []),
		)

		expect(result.output).toContain('Ignored allowed-tools entry "Frobnicate"')
		expect(result.output).toContain('Pre-approved for the rest of this turn: read')
	})

	it('says nothing is pre-approved where no turn can hold the grant', async () => {
		// A host driving this tool outside a turn has no executor.
		const result = await SkillTool.execute(
			{ name: 'reconcile' },
			contextFor(registry([{ name: 'reconcile', body: 'B', allowedTools: 'read' }])),
		)

		expect(result.success).toBe(true)
		expect(result.output).toContain('this host applies no pre-approval')
		expect(result.output).toContain('Every other tool remains available')
		expect(result.output).not.toMatch(/restrict yourself/i)
	})
})

describe('parsing what an author wrote', () => {
	it('splits on spaces and commas alike', () => {
		expect(parseAllowedTools(' read , grep ,write ')).toEqual(['read', 'grep', 'write'])
		expect(parseAllowedTools('read write edit')).toEqual(['read', 'write', 'edit'])
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

describe('the row a host draws for a skill call', () => {
	it('names the skill and leaves the body to the model', () => {
		const present = (input: unknown) => SkillTool.presentCall?.(input as never)
		expect(present({ name: 'browser-automation' })).toEqual({
			kind: 'generic',
			presentation: 'activity',
			label: 'Read skill browser-automation',
		})
		expect(present({})).toMatchObject({ label: 'List skills' })
		expect(present({ name: 'x', cursor: 'c' })).toMatchObject({
			label: 'Read skill x (continued)',
		})
		const result = (success: boolean) =>
			SkillTool.presentResult?.(
				{ name: 'x' } as never,
				{
					success,
					output: 'body',
					...(success ? {} : { error: 'no' }),
				} as never,
			)
		expect(result(true)).toMatchObject({ visibility: 'hidden' })
		expect(result(false)).toBeUndefined()
	})
})
