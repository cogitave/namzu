import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { loadSkill } from '../../skills/loader.js'
import { BashTool } from '../../tools/builtins/bash.js'
import { EditTool } from '../../tools/builtins/edit.js'
import { JobTool } from '../../tools/builtins/job.js'
import { buildRunCodeTool } from '../../tools/builtins/run-code.js'
import { WriteFileTool } from '../../tools/builtins/write-file.js'
import { isAlwaysDestructive } from '../../tools/defineTool.js'
import { parseFrontmatter } from '../../utils/frontmatter.js'
import {
	SkillGrantSet,
	type SkillGrantToolResolver,
	compileSkillGrant,
	parseAllowedTools,
	permissionPatternToRegExpSource,
} from '../skill-grant.js'

/**
 * `allowed-tools` read the way skill authors write it.
 *
 * The Agent Skills format accepts a space-separated line, a comma-separated
 * line or a YAML list, capitalised tool names, and `Bash(<pattern>)` entries.
 * This kernel split on commas only, so its own loader test fixture
 * `read write edit` was ONE tool name that matched nothing.
 */

/** A turn's registry: namzu names, with `bash` taking a command line. */
const resolve: SkillGrantToolResolver = (name) => {
	const known: Record<
		string,
		{ name: string; commandArgument?: string; alwaysDestructive?: boolean }
	> = {
		read: { name: 'read' },
		write: { name: 'write' },
		edit: { name: 'edit' },
		grep: { name: 'grep' },
		glob: { name: 'glob' },
		bash: { name: 'bash', commandArgument: 'command' },
		web_fetch: { name: 'web_fetch' },
		web_search: { name: 'web_search' },
		job: { name: 'job' },
		task_create: { name: 'task_create' },
		task_update: { name: 'task_update' },
		task_list: { name: 'task_list' },
		search_tools: { name: 'search_tools' },
		run_code: { name: 'run_code', alwaysDestructive: true },
	}
	return known[name.toLowerCase()]
}

function granted(allowed: string, skillDirectory?: string) {
	const grants = new SkillGrantSet()
	const compiled = compileSkillGrant(parseAllowedTools(allowed) ?? [], {
		resolveTool: resolve,
		...(skillDirectory ? { skillDirectory } : {}),
	})
	grants.grant('demo', compiled)
	return { grants, compiled }
}

const bash = (command: string) => ({ name: 'bash', input: { command } })

describe('parsing every spelling the format uses', () => {
	it('splits a space-separated line', () => {
		expect(parseAllowedTools('Read Grep Bash')).toEqual(['Read', 'Grep', 'Bash'])
		// The fixture that used to be one tool name.
		expect(parseAllowedTools('read write edit')).toEqual(['read', 'write', 'edit'])
	})

	it('splits a comma-separated line, with or without spaces', () => {
		expect(parseAllowedTools(' read , grep ,write ')).toEqual(['read', 'grep', 'write'])
		expect(parseAllowedTools('Read,Grep')).toEqual(['Read', 'Grep'])
	})

	it('keeps a pattern whole, spaces and commas inside it included', () => {
		expect(parseAllowedTools('Read Grep Bash(git add *)')).toEqual([
			'Read',
			'Grep',
			'Bash(git add *)',
		])
		expect(parseAllowedTools('Bash(git status *), Bash(echo a, b)')).toEqual([
			'Bash(git status *)',
			'Bash(echo a, b)',
		])
	})

	it('distinguishes "declared nothing" from "declared none"', () => {
		expect(parseAllowedTools(undefined)).toBeUndefined()
		expect(parseAllowedTools('')).toEqual([])
		expect(parseAllowedTools('  ,  ')).toEqual([])
	})

	it('reads a YAML block list and a flow list through the frontmatter reader', () => {
		const block = parseFrontmatter(
			'---\nname: a\nallowed-tools:\n  - Read\n  - Bash(git status *)\n---\nbody',
			'test',
			{ lists: ['allowed-tools'] },
		)
		const flow = parseFrontmatter(
			'---\nname: a\nallowed-tools: [Read, "Grep"]\n---\nbody',
			'test',
			{ lists: ['allowed-tools'] },
		)
		const blockValue = block.values['allowed-tools']
		const flowValue = flow.values['allowed-tools']
		expect(blockValue?.kind === 'scalar' && parseAllowedTools(blockValue.value)).toEqual([
			'Read',
			'Bash(git status *)',
		])
		expect(flowValue?.kind === 'scalar' && parseAllowedTools(flowValue.value)).toEqual([
			'Read',
			'Grep',
		])
	})

	it('still refuses a list for a key the caller did not name', () => {
		expect(() =>
			parseFrontmatter('---\nname: a\ntags:\n  - x\n---\nbody', 'test', {
				lists: ['allowed-tools'],
			}),
		).toThrow(/block sequence/)
		expect(() => parseFrontmatter('---\nallowed-tools: [Read]\n---\nbody', 'test')).toThrow(
			/flow sequence/,
		)
	})
})

describe('a SKILL.md with a YAML list loads', () => {
	let root: string | undefined
	afterEach(async () => {
		if (root) await rm(root, { recursive: true, force: true })
		root = undefined
	})

	it('joins the list into the one scalar the metadata carries', async () => {
		root = await mkdtemp(join(tmpdir(), 'namzu-skill-grant-'))
		const dir = join(root, 'lister')
		await mkdir(dir)
		await writeFile(
			join(dir, 'SKILL.md'),
			'---\nname: lister\ndescription: d\nallowed-tools:\n  - Read\n  - Grep\n---\nBody',
		)
		const loaded = await loadSkill(dir, 'full')
		expect(parseAllowedTools(loaded.skill.metadata.allowedTools)).toEqual(['Read', 'Grep'])
	})
})

describe('names, as authors write them', () => {
	it('maps the capitalised names case-insensitively', () => {
		const { grants, compiled } = granted('Read GREP webfetch WebSearch Write edit Glob')
		expect(compiled.ignored).toEqual([])
		for (const name of ['read', 'grep', 'web_fetch', 'web_search', 'write', 'edit', 'glob']) {
			expect(grants.coveringSkill({ name, input: {} }), name).toBe('demo')
		}
	})

	it('maps MultiEdit to edit', () => {
		expect(granted('MultiEdit').grants.coveringSkill({ name: 'edit', input: {} })).toBe('demo')
	})

	it('ignores an unknown name, says so, and never widens to everything', () => {
		const { grants, compiled } = granted('Read NotebookEdit')
		expect(compiled.ignored).toEqual([
			{ entry: 'NotebookEdit', reason: 'this turn has no tool by that name' },
		])
		expect(grants.coveringSkill({ name: 'read', input: {} })).toBe('demo')
		expect(grants.coveringSkill({ name: 'bash', input: { command: 'ls' } })).toBeUndefined()
		expect(grants.coveringSkill({ name: 'write', input: {} })).toBeUndefined()
	})

	it('maps the background-shell and task-list names onto job and task_*', () => {
		const { grants, compiled } = granted(
			'BashOutput KillShell TaskOutput TaskStop TaskCreate TaskUpdate TaskList ToolSearch',
		)
		expect(compiled.ignored).toEqual([])
		for (const name of ['job', 'task_create', 'task_update', 'task_list', 'search_tools']) {
			expect(grants.coveringSkill({ name, input: {} }), name).toBe('demo')
		}
	})

	it('grants nothing for a tool every call of which is destructive, and says why', () => {
		const { grants, compiled } = granted('Read run_code')
		expect(compiled.entries.map((entry) => entry.tool)).toEqual(['read'])
		expect(compiled.ignored).toEqual([
			{
				entry: 'run_code',
				reason:
					'every `run_code` call is destructive and is always reviewed, so nothing was granted for it',
			},
		])
		expect(grants.coveringSkill({ name: 'run_code', input: {} })).toBeUndefined()
	})

	it('knows which shipped tools are destructive for every input', () => {
		// `write` cannot tell a new file from an overwrite by its input, and
		// `run_code` is the union of whatever it calls; both are always
		// reviewed. The others decide per call.
		expect(isAlwaysDestructive(WriteFileTool)).toBe(true)
		expect(isAlwaysDestructive(buildRunCodeTool())).toBe(true)
		expect(isAlwaysDestructive(EditTool)).toBe(false)
		expect(isAlwaysDestructive(BashTool)).toBe(false)
		expect(isAlwaysDestructive(JobTool)).toBe(false)
	})

	it('refuses a pattern on a tool without a command line rather than approximating it', () => {
		const { grants, compiled } = granted('Read(./src/**)')
		expect(compiled.entries).toEqual([])
		expect(compiled.ignored[0]?.reason).toMatch(/only for a tool that takes a command line/)
		expect(grants.coveringSkill({ name: 'read', input: { path: 'src/a.ts' } })).toBeUndefined()
	})

	it('treats `Bash(*)` and `Bash` alike', () => {
		for (const allowed of ['Bash', 'Bash(*)', 'Bash()']) {
			expect(granted(allowed).grants.coveringSkill(bash('anything')), allowed).toBe('demo')
		}
	})
})

describe('Bash(<pattern>) uses the permission-table glob', () => {
	it('matches `git status -s` and not `git push`', () => {
		const { grants } = granted('Bash(git status *)')
		expect(grants.coveringSkill(bash('git status -s'))).toBe('demo')
		expect(grants.coveringSkill(bash('git status'))).toBe('demo')
		expect(grants.coveringSkill(bash('git push'))).toBeUndefined()
		expect(grants.coveringSkill(bash('git statusx'))).toBeUndefined()
	})

	it('reads the line as commands, every one of which must match', () => {
		const { grants } = granted('Bash(git status *)')
		expect(grants.coveringSkill(bash('git status && git push'))).toBeUndefined()
		expect(grants.coveringSkill(bash('rm -rf ~; git status'))).toBeUndefined()
		expect(grants.coveringSkill(bash('echo $(git push)'))).toBeUndefined()
	})

	it('reads the legacy `:*` prefix form', () => {
		const { grants } = granted('Bash(npm run test:*)')
		expect(grants.coveringSkill(bash('npm run test -- --watch'))).toBe('demo')
		expect(grants.coveringSkill(bash('npm run build'))).toBeUndefined()
	})

	it('expands ${CLAUDE_SKILL_DIR} and ${NAMZU_SKILL_DIR} to the skill directory', () => {
		const dir = '/repo/.namzu/skills/render'
		for (const placeholder of ['${CLAUDE_SKILL_DIR}', '${NAMZU_SKILL_DIR}']) {
			const { grants } = granted(`Read Bash(${placeholder}/scripts/render.sh *)`, dir)
			expect(grants.coveringSkill(bash(`${dir}/scripts/render.sh out.png`))).toBe('demo')
			expect(grants.coveringSkill(bash('/elsewhere/scripts/render.sh out.png'))).toBeUndefined()
		}
	})

	it('grants nothing for a placeholder when the directory is unknown', () => {
		const { grants, compiled } = granted('Bash(${CLAUDE_SKILL_DIR}/x.sh)')
		expect(compiled.entries).toEqual([])
		expect(compiled.ignored[0]?.reason).toMatch(/directory is not known/)
		expect(grants.coveringSkill(bash('${CLAUDE_SKILL_DIR}/x.sh'))).toBeUndefined()
	})

	it('is the same dialect the CLI permission table compiles', () => {
		expect(permissionPatternToRegExpSource('git push *')).toBe('^git push( .*)?$')
		expect(permissionPatternToRegExpSource('a?c.ts')).toBe('^a.c\\.ts$')
	})
})

describe('the set', () => {
	it('keeps one copy when the same skill is loaded again', () => {
		const grants = new SkillGrantSet()
		const compiled = compileSkillGrant(['Read'], { resolveTool: resolve })
		grants.grant('demo', compiled)
		grants.grant('demo', compiled)
		expect(grants.size).toBe(1)
		expect(grants.list()).toEqual([{ skill: 'demo', entry: 'Read' }])
	})

	it('names the skill that covered the call', () => {
		const grants = new SkillGrantSet()
		grants.grant('first', compileSkillGrant(['Read'], { resolveTool: resolve }))
		grants.grant('second', compileSkillGrant(['Bash(ls *)'], { resolveTool: resolve }))
		expect(grants.coveringSkill({ name: 'read', input: {} })).toBe('first')
		expect(grants.coveringSkill(bash('ls -la'))).toBe('second')
	})
})
