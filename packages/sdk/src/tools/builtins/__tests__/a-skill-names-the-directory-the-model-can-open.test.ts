import { describe, expect, it } from 'vitest'

import type { SessionId, TurnId } from '../../../types/ids/index.js'
import type { Sandbox } from '../../../types/sandbox/index.js'
import type { SkillRegistryRef, ToolContext } from '../../../types/tool/index.js'
import {
	type SkillDirectoryContext,
	type SkillDirectoryRequest,
	SkillTool,
	createSkillTool,
} from '../skill.js'

/**
 * A skill's load result names a directory the model can open (#536).
 *
 * A body that says "run scripts/render.sh" or "read references/api.md" gave
 * the model no directory to find them in, and the listing reported the
 * registry's `location` — where the HOST reads the skill. Under a sandbox or a
 * remote workspace that path is not the model's, so it hard-coded what the
 * skill said to read or searched the filesystem for it. The host now says
 * which directory the model's tools can reach, and the tool passes it on.
 */

const HOST_DIR = '/home/op/.namzu/skills/render'
const SANDBOX_DIR = '/workspace/.skills/render'

interface StoredSkill {
	name: string
	body?: string
	allowedTools?: string
	dirPath?: string
}

function registry(skills: StoredSkill[]): SkillRegistryRef {
	return {
		catalog: () =>
			skills.map((s) => ({
				registeredName: s.name,
				description: `the ${s.name} skill`,
				location: `${s.dirPath ?? '/nowhere'}/SKILL.md`,
				...(s.dirPath === undefined ? {} : { directory: s.dirPath }),
			})),
		async load(name) {
			const found = skills.find((s) => s.name === name)
			if (!found) return undefined
			return {
				skill: {
					metadata: {
						name: found.name,
						description: `the ${found.name} skill`,
						...(found.allowedTools === undefined ? {} : { allowedTools: found.allowedTools }),
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

function contextFor(
	skills: SkillRegistryRef,
	overrides: Partial<ToolContext> & { grants?: GrantCall[] } = {},
): ToolContext {
	const { grants, ...rest } = overrides
	return {
		sessionId: '0190a5b2-7c3d-7e4f-8a9b-0c1d2e3f4a5b' as SessionId,
		turnId: '651d7ad7-a79e-4783-85bb-5bcd9da09f20' as TurnId,
		workingDirectory: '/tmp',
		abortSignal: new AbortController().signal,
		env: {},
		log: () => {},
		skills,
		...(grants
			? {
					// The executor's answer for a turn that has `bash`, compiled the
					// way `compileSkillGrant` would: a `${CLAUDE_SKILL_DIR}` entry
					// with no directory grants nothing.
					grantSkillTools: (grant) => {
						const granted: string[] = []
						const ignored: { entry: string; reason: string }[] = []
						for (const entry of grant.allowedTools) {
							if (entry.includes('${CLAUDE_SKILL_DIR}') && !grant.skillDirectory) {
								ignored.push({ entry, reason: "the skill's directory is not known in this turn" })
							} else {
								granted.push(entry)
							}
						}
						return { granted, ignored, commit: () => grants.push({ ...grant }) }
					},
				}
			: {}),
		...rest,
	}
}

/** What the resolver was asked, in order. */
type Call = [SkillDirectoryRequest, SkillDirectoryContext]

/** A sandbox handle; the resolver reads it, nothing here runs in it. */
const sandbox = { id: 'sbx', rootDir: '/workspace', environment: 'bwrap' } as unknown as Sandbox

function mapped(calls?: Call[]) {
	return createSkillTool({
		resolveModelDirectory: (skill, context) => {
			calls?.push([skill, context])
			if (skill.directory !== HOST_DIR) return undefined
			return context.sandbox ? SANDBOX_DIR : skill.directory
		},
	})
}

describe('a load names the directory the host says the model can open', () => {
	it('opens with the mapped directory, and reports it in the data', async () => {
		const calls: Call[] = []
		const result = await mapped(calls).execute(
			{ name: 'render' },
			contextFor(
				registry([{ name: 'render', body: 'Run scripts/render.sh.', dirPath: HOST_DIR }]),
				{ sandbox },
			),
		)

		expect(result.success).toBe(true)
		expect(result.output).toBe(
			`[Skill directory: ${SANDBOX_DIR}. Relative paths in these instructions, such as scripts/, references/ or assets/, are inside it.]\n\nRun scripts/render.sh.`,
		)
		expect(result.output).not.toContain(HOST_DIR)
		expect(result.data).toMatchObject({ skill: 'render', directory: SANDBOX_DIR })
		// Asked with the host's own path and the turn's sandbox.
		expect(calls).toEqual([[{ name: 'render', directory: HOST_DIR }, { sandbox }]])
	})

	it('gives the host path back on a turn with no sandbox, when that is what the host says', async () => {
		const calls: Call[] = []
		const result = await mapped(calls).execute(
			{ name: 'render' },
			contextFor(registry([{ name: 'render', body: 'B', dirPath: HOST_DIR }])),
		)

		expect(result.output.startsWith(`[Skill directory: ${HOST_DIR}.`)).toBe(true)
		expect(calls[0]?.[1]).toEqual({})
	})

	it('says the files are out of reach, rather than naming a path, when the host says none', async () => {
		const result = await createSkillTool({ resolveModelDirectory: () => undefined }).execute(
			{ name: 'render' },
			contextFor(
				registry([{ name: 'render', body: 'Run scripts/render.sh.', dirPath: HOST_DIR }]),
				{ sandbox },
			),
		)

		expect(result.success).toBe(true)
		expect(result.output).toMatch(/^\[This skill's directory is not reachable from your tools/)
		expect(result.output).toContain('Do not search the filesystem for it')
		expect(result.output).toContain('Run scripts/render.sh.')
		expect(result.output).not.toContain(HOST_DIR)
		expect(result.data).not.toHaveProperty('directory')
	})

	it('reads an empty answer as none', async () => {
		const result = await createSkillTool({ resolveModelDirectory: () => '' }).execute(
			{ name: 'render' },
			contextFor(registry([{ name: 'render', body: 'B', dirPath: HOST_DIR }])),
		)

		expect(result.output).toMatch(/not reachable/)
		expect(result.data).not.toHaveProperty('directory')
	})

	it('awaits a resolver that answers later', async () => {
		const result = await createSkillTool({
			resolveModelDirectory: async () => SANDBOX_DIR,
		}).execute({ name: 'render' }, contextFor(registry([{ name: 'render', body: 'B' }])))

		expect(result.data).toMatchObject({ directory: SANDBOX_DIR })
	})

	it('names nothing without a resolver, as before', async () => {
		const result = await SkillTool.execute(
			{ name: 'render' },
			contextFor(registry([{ name: 'render', body: 'B', dirPath: HOST_DIR }]), { sandbox }),
		)

		expect(result.output).toBe('B')
		expect(result.data).not.toHaveProperty('directory')
	})
})

describe('${CLAUDE_SKILL_DIR} names the path the model was given', () => {
	it('expands to the mapped directory, the one a command line the model writes contains', async () => {
		const grants: GrantCall[] = []
		await mapped().execute(
			{ name: 'render' },
			contextFor(
				registry([
					{
						name: 'render',
						body: 'B',
						dirPath: HOST_DIR,
						allowedTools: 'Bash(${CLAUDE_SKILL_DIR}/scripts/render.sh *)',
					},
				]),
				{ sandbox, grants },
			),
		)

		expect(grants).toEqual([
			{
				skill: 'render',
				allowedTools: ['Bash(${CLAUDE_SKILL_DIR}/scripts/render.sh *)'],
				skillDirectory: SANDBOX_DIR,
			},
		])
	})

	it('grants nothing through it when the host says the directory is out of reach', async () => {
		const grants: GrantCall[] = []
		const result = await createSkillTool({ resolveModelDirectory: () => undefined }).execute(
			{ name: 'render' },
			contextFor(
				registry([
					{
						name: 'render',
						body: 'B',
						dirPath: HOST_DIR,
						allowedTools: 'Bash(${CLAUDE_SKILL_DIR}/scripts/render.sh *)',
					},
				]),
				{ sandbox, grants },
			),
		)

		// The host path would have granted a command that cannot run where the
		// model's commands run.
		expect(grants).toEqual([
			{ skill: 'render', allowedTools: ['Bash(${CLAUDE_SKILL_DIR}/scripts/render.sh *)'] },
		])
		expect(result.output).toContain("the skill's directory is not known in this turn")
	})
})

describe('a long body', () => {
	it('opens with the directory on its first page only, and a changed answer stales the cursor', async () => {
		let directory = SANDBOX_DIR
		const tool = createSkillTool({ resolveModelDirectory: () => directory })
		const ctx = contextFor(
			registry([{ name: 'render', body: 'x'.repeat(900), dirPath: HOST_DIR }]),
			{ maxToolOutputChars: 400 },
		)

		const first = await tool.execute({ name: 'render' }, ctx)
		expect(first.success).toBe(true)
		expect(first.output.length).toBeLessThanOrEqual(400)
		expect(first.output.startsWith(`[Skill directory: ${SANDBOX_DIR}.`)).toBe(true)
		const cursor = (first.data as { nextCursor?: string }).nextCursor
		expect(cursor).toBeDefined()

		const second = await tool.execute({ name: 'render', cursor: cursor as string }, ctx)
		expect(second.success).toBe(true)
		expect(second.output).not.toContain('Skill directory')

		directory = '/elsewhere/render'
		const stale = await tool.execute({ name: 'render', cursor: cursor as string }, ctx)
		expect(stale.success).toBe(false)
		expect(stale.error).toMatch(/stale or invalid/)
	})
})

describe('the listing', () => {
	it("carries the host's directory for the model, and not the registry's location", async () => {
		const calls: Call[] = []
		const result = await mapped(calls).execute(
			{},
			contextFor(
				registry([
					{ name: 'render', dirPath: HOST_DIR },
					{ name: 'unmounted', dirPath: '/opt/skills/unmounted' },
				]),
				{ sandbox },
			),
		)

		expect(result.success).toBe(true)
		expect(JSON.parse(result.output)).toEqual({
			skills: [
				{ name: 'render', description: 'the render skill', directory: SANDBOX_DIR },
				{ name: 'unmounted', description: 'the unmounted skill' },
			],
			warnings: [],
			nextCursor: null,
		})
		expect(result.output).not.toContain(HOST_DIR)
		expect(calls).toEqual([
			[{ name: 'render', directory: HOST_DIR }, { sandbox }],
			[{ name: 'unmounted', directory: '/opt/skills/unmounted' }, { sandbox }],
		])
	})

	it("keeps the registry's location without a resolver, as before", async () => {
		const result = await SkillTool.execute(
			{},
			contextFor(registry([{ name: 'render', dirPath: HOST_DIR }])),
		)

		expect(JSON.parse(result.output).skills).toEqual([
			{ name: 'render', description: 'the render skill', location: `${HOST_DIR}/SKILL.md` },
		])
	})
})
