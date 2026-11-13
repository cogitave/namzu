import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type Skill, SkillRegistry, SkillTool, assembleSystemPrompt } from '@namzu/sdk'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { removeTempDir } from '../__fixtures__/temp-dir.js'
import { systemSkillsDir } from './store.js'

import {
	SKILL_MANIFEST_MAX_CHARS,
	createSessionSkillCatalog,
	manifestEntryChars,
	skillManifestBudget,
} from './catalog.js'

let home: string
let cwd: string
let system: string

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), 'namzu-cat-home-'))
	cwd = mkdtempSync(join(tmpdir(), 'namzu-cat-cwd-'))
	system = mkdtempSync(join(tmpdir(), 'namzu-cat-sys-'))
})
afterEach(() => {
	removeTempDir(home)
	removeTempDir(cwd)
	removeTempDir(system)
})

function skillAt(skillsDir: string, name: string, description: string, extra = ''): void {
	mkdirSync(join(skillsDir, name), { recursive: true })
	writeFileSync(
		join(skillsDir, name, 'SKILL.md'),
		`---\nname: ${name}\ndescription: ${description}\n${extra}---\nInstructions for ${name}.`,
	)
}

const project = () => join(cwd, '.namzu', 'skills')

/** The prompt the kernel renders from a manifest, through its public assembler. */
function renderSkillsSection(skills: Skill[] | undefined): string {
	return assembleSystemPrompt({ identity: { role: 'r', description: 'd' } } as never, skills)
}

function catalog(config?: Parameters<typeof createSessionSkillCatalog>[0]['config']) {
	return createSessionSkillCatalog({ cwd, home, systemDir: system, ...(config ? { config } : {}) })
}

/** Run the kernel's `skill` tool against a turn's registry, as the executor would. */
async function callSkillTool(
	registry: NonNullable<
		Awaited<ReturnType<Awaited<ReturnType<typeof catalog>>['forTurn']>>['registry']
	>,
	input: { name?: string; cursor?: string },
) {
	return SkillTool.execute(
		input as never,
		{
			skills: registry,
			maxToolOutputChars: 50_000,
		} as never,
	)
}

describe('the session skill catalog', () => {
	it('offers file skills from every tier to the model, loadable by the skill tool', async () => {
		skillAt(system, 'shipped', 'a built-in skill')
		skillAt(join(home, '.agents', 'skills'), 'shared', 'shared with other agents')
		skillAt(project(), 'local', 'the project one')

		const cat = await catalog()
		expect(cat.hasFileSkills).toBe(true)
		const turn = await cat.forTurn({ toolNames: ['read'], contextWindowTokens: 200_000 })

		expect(turn.manifest?.map((s) => s.metadata.name)).toEqual(['local', 'shared', 'shipped'])
		expect(turn.overflowNote).toBeNull()
		const section = renderSkillsSection(turn.manifest)
		expect(section).toContain('<name>shared</name>')

		const loaded = await callSkillTool(turn.registry!, { name: 'shared' })
		expect(loaded.success).toBe(true)
		expect(loaded.output).toContain('Instructions for shared.')
	})

	it('keeps bodies out of the manifest after the model loaded one', async () => {
		skillAt(project(), 'local', 'the project one')
		const cat = await catalog()
		const first = await cat.forTurn({ toolNames: [], contextWindowTokens: 200_000 })
		await callSkillTool(first.registry!, { name: 'local' })

		const next = await cat.forTurn({ toolNames: [], contextWindowTokens: 200_000 })
		expect(next.manifest?.[0]?.body).toBeUndefined()
		expect(renderSkillsSection(next.manifest)).not.toContain('## Loaded Skills')
	})

	it('hides a skill whose required tools the session lacks, from the manifest and the tool', async () => {
		skillAt(
			project(),
			'browse',
			'drives the browser',
			'metadata:\n  namzu-requires-tools: "browser, browser_act"\n',
		)
		const cat = await catalog()

		const without = await cat.forTurn({ toolNames: ['browser'], contextWindowTokens: 200_000 })
		expect(without.manifest).toBeUndefined()
		expect(without.registry).toBeUndefined()

		skillAt(project(), 'other', 'always there')
		const cat2 = await catalog()
		const partial = await cat2.forTurn({ toolNames: ['browser'], contextWindowTokens: 200_000 })
		expect(partial.manifest?.map((s) => s.metadata.name)).toEqual(['other'])
		const refused = await callSkillTool(partial.registry!, { name: 'browse' })
		expect(refused.success).toBe(false)
		expect(refused.error).toMatch(/No skill named "browse"/)

		const withBoth = await cat2.forTurn({
			toolNames: ['browser', 'browser_act'],
			contextWindowTokens: 200_000,
		})
		expect(withBoth.manifest?.map((s) => s.metadata.name)).toEqual(['browse', 'other'])
		expect((await callSkillTool(withBoth.registry!, { name: 'browse' })).success).toBe(true)
	})

	it('caps the manifest at min(2% of the window, 4 KB) and names the rest', async () => {
		expect(skillManifestBudget(200_000)).toBe(SKILL_MANIFEST_MAX_CHARS)
		expect(skillManifestBudget(10_000)).toBe(800)

		const long = 'x'.repeat(300)
		for (let i = 0; i < 30; i++) skillAt(project(), `skill-${String(i).padStart(2, '0')}`, long)
		const cat = await catalog()

		const turn = await cat.forTurn({ toolNames: [], contextWindowTokens: 200_000 })
		const described = turn.manifest ?? []
		const spent = described.reduce((sum, skill) => sum + manifestEntryChars(skill), 0)
		expect(spent).toBeLessThanOrEqual(SKILL_MANIFEST_MAX_CHARS)
		expect(described.length).toBeGreaterThan(0)
		expect(described.length + turn.overflow.length).toBe(30)
		expect(turn.overflow.length).toBeGreaterThan(0)
		expect(turn.overflowNote).toContain(turn.overflow.join(', '))
		expect(turn.overflowNote).toContain('`skill` tool without a name')

		// An overflowed skill is still loadable, and the list mode pages them all.
		const last = turn.overflow.at(-1) as string
		expect((await callSkillTool(turn.registry!, { name: last })).success).toBe(true)
		const listed: string[] = []
		let cursor: string | undefined
		do {
			const page = await callSkillTool(turn.registry!, cursor ? { cursor } : {})
			expect(page.success).toBe(true)
			const parsed = JSON.parse(page.output) as {
				skills: { name: string }[]
				nextCursor: string | null
			}
			listed.push(...parsed.skills.map((s) => s.name))
			cursor = parsed.nextCursor ?? undefined
		} while (cursor)
		expect(listed).toHaveLength(30)

		// A small window describes fewer.
		const small = await cat.forTurn({ toolNames: [], contextWindowTokens: 10_000 })
		expect((small.manifest ?? []).length).toBeLessThan(described.length)
	})

	it('offers the shipped built-ins, the two review skills included, in full on a 32k window', async () => {
		const real = await createSessionSkillCatalog({
			cwd,
			home,
			systemDir: systemSkillsDir(),
		})
		const withTools = await real.forTurn({
			toolNames: ['browser', 'schedule'],
			contextWindowTokens: 32_768,
		})
		expect(withTools.manifest?.map((s) => s.metadata.name)).toEqual([
			'browser-automation',
			'review-changes',
			'schedule-task',
			'skill-creator',
			'verify-change',
		])
		expect(withTools.overflow).toEqual([])
		expect(withTools.overflowNote).toBeNull()

		// Without the browser and schedule tools those two are hidden; the rest stay.
		const bare = await real.forTurn({
			toolNames: [],
			contextWindowTokens: 32_768,
		})
		expect(bare.manifest?.map((s) => s.metadata.name)).toEqual([
			'review-changes',
			'skill-creator',
			'verify-change',
		])
		const loaded = await callSkillTool(bare.registry!, {
			name: 'verify-change',
		})
		expect(loaded.success).toBe(true)
		expect(loaded.output).toContain('Proving a change works')
	})

	it('describes the highest-precedence tiers first when the budget runs out', async () => {
		const long = 'y'.repeat(900)
		for (let i = 0; i < 4; i++) skillAt(system, `builtin-${i}`, long)
		skillAt(project(), 'mine', long)
		const turn = await (await catalog()).forTurn({ toolNames: [], contextWindowTokens: 200_000 })
		expect(turn.manifest?.[0]?.metadata.name).toBe('mine')
		expect(turn.overflow).toContain('builtin-3')
	})

	it('offers nothing named in skills.disabled, and no built-ins under builtin: false', async () => {
		skillAt(system, 'shipped', 'a built-in')
		skillAt(project(), 'noisy', 'noisy')
		skillAt(project(), 'kept', 'kept')

		const turn = await (await catalog({ builtin: false, disabled: ['noisy'] })).forTurn({
			toolNames: [],
			contextWindowTokens: 200_000,
		})
		expect(turn.manifest?.map((s) => s.metadata.name)).toEqual(['kept'])
		expect((await callSkillTool(turn.registry!, { name: 'noisy' })).success).toBe(false)
		expect((await callSkillTool(turn.registry!, { name: 'shipped' })).success).toBe(false)
	})

	it('keeps an operator-only skill from the model without spending budget on it', async () => {
		skillAt(project(), 'deploy', 'rotates the deploy key', 'disable-model-invocation: true\n')
		skillAt(project(), 'guide', 'model guidance')
		const turn = await (await catalog()).forTurn({ toolNames: [], contextWindowTokens: 200_000 })

		const section = renderSkillsSection(turn.manifest)
		expect(section).toContain('<name>guide</name>')
		expect(section).not.toContain('deploy')
		const refused = await callSkillTool(turn.registry!, { name: 'deploy' })
		expect(refused.success).toBe(false)
		expect(refused.error).toMatch(/operator-invocable/)
	})

	it('leaves out a file the kernel loader refuses, without taking the others', async () => {
		// The directory says one name and the frontmatter another.
		mkdirSync(join(project(), 'dir-name'), { recursive: true })
		writeFileSync(
			join(project(), 'dir-name', 'SKILL.md'),
			'---\nname: other-name\ndescription: d\n---\nB',
		)
		skillAt(project(), 'fine', 'fine')
		const cat = await catalog()
		expect(cat.fileSkills.map((s) => s.name)).toEqual(['fine'])
	})

	it('merges plugin skills into the same manifest and tool', async () => {
		skillAt(project(), 'local', 'the project one')
		const pluginDir = mkdtempSync(join(tmpdir(), 'namzu-cat-plugin-'))
		try {
			skillAt(pluginDir, 'reconcile', 'reconciles the ledger')
			const plugins = new SkillRegistry()
			const loaded = await plugins.register(join(pluginDir, 'reconcile'))
			plugins.unregister('reconcile')
			plugins.add('ledger__reconcile', loaded)

			const turn = await (await catalog()).forTurn({
				toolNames: [],
				contextWindowTokens: 200_000,
				pluginSkills: plugins,
			})
			expect(turn.manifest?.map((s) => s.metadata.name)).toEqual(['local', 'ledger__reconcile'])
			const result = await callSkillTool(turn.registry!, { name: 'ledger__reconcile' })
			expect(result.success).toBe(true)
			expect(result.output).toContain('Instructions for reconcile.')
		} finally {
			removeTempDir(pluginDir)
		}
	})

	it('offers nothing and no tool when there are no skills', async () => {
		const cat = await catalog()
		expect(cat.hasFileSkills).toBe(false)
		const turn = await cat.forTurn({ toolNames: [], contextWindowTokens: 200_000 })
		expect(turn).toEqual({
			registry: undefined,
			manifest: undefined,
			overflowNote: null,
			overflow: [],
		})
	})
})

describe('a file skill that carries hooks', () => {
	const HOOKS = 'hooks:\n  PreToolUse:\n    - command: ./guard.sh\n'

	it('is handed to the host that reads hooks, with its hooks block and its folder, by the skill tool', async () => {
		skillAt(project(), 'guarded', 'a guarded skill', HOOKS)
		const cat = await catalog()
		const asked: unknown[] = []
		const turn = await cat.forTurn({
			toolNames: [],
			contextWindowTokens: 200_000,
			skillHooks: {
				prepareHooks: (skill, options) => {
					asked.push({ skill, options })
					return {
						withholdGrants: false,
						notice: 'its hooks are on',
						attach: () => ({ remove: () => undefined }),
					}
				},
			},
		})
		const result = await SkillTool.execute(
			{ name: 'guarded' } as never,
			{ skills: turn.registry, maxToolOutputChars: 50_000 } as never,
		)
		expect(result.success).toBe(true)
		expect(result.output).toContain('[its hooks are on]')
		expect(asked).toEqual([
			{
				skill: {
					name: 'guarded',
					dirPath: join(project(), 'guarded'),
					hooksSource: HOOKS.trimEnd(),
				},
				options: { forked: false },
			},
		])
	})

	it('loads without hooks and without a pre-approval when the session has nobody to read them', async () => {
		skillAt(project(), 'guarded', 'a guarded skill', `allowed-tools: Bash\n${HOOKS}`)
		const cat = await catalog()
		const turn = await cat.forTurn({ toolNames: [], contextWindowTokens: 200_000 })
		const result = await SkillTool.execute(
			{ name: 'guarded' } as never,
			{ skills: turn.registry, maxToolOutputChars: 50_000 } as never,
		)
		expect(result.success).toBe(true)
		expect(result.output).toContain('cannot run a skill')
	})
})
