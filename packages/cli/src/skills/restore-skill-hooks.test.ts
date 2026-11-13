import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PluginLifecycleManager, type SessionId } from '@namzu/sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { SkillHooksFact } from '../integrations/sessions/conversation-facts.js'
import { isInsideFolder, readSkillNow, restoreSkillHooks } from './restore-skill-hooks.js'
import { createSkillHooksHost } from './skill-hooks.js'

/**
 * A conversation that is continued puts back the hooks of the skills it used,
 * through the path a first use takes, from the skill file as it is now. A skill
 * that cannot come back is said so, once to the person and once to the model,
 * and its tools are not pre-approved. These run real commands under `sh`.
 */

const SESSION = '0190a5b2-7c3d-7e4f-8a9b-0c1d2e3f4a5b' as SessionId
const dirs: string[] = []
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function manager(): PluginLifecycleManager {
	const logger = {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
		child: () => logger,
	}
	return new PluginLifecycleManager({
		pluginRegistry: {} as never,
		scopeRoots: { project: process.cwd(), user: process.cwd() },
		log: logger as never,
	})
}

interface Setup {
	readonly hooksSwitch?: 'disabled' | 'managed-only'
	readonly trusted?: boolean
	readonly projectDir?: string
}

function host(setup: Setup = {}) {
	const mgr = manager()
	const lines: string[] = []
	const h = createSkillHooksHost({
		manager: () => mgr,
		hookOptions: () => ({ cwd: process.cwd() }),
		hooksSwitch: () => setup.hooksSwitch,
		projectTrusted: () => setup.trusted ?? true,
		isProjectSkill: () => false,
		...(setup.projectDir
			? { isInProject: (dir: string) => isInsideFolder(setup.projectDir as string, dir) }
			: {}),
	})
	h.subscribe((line) => lines.push(line))
	return { mgr, h, lines }
}

const GUARD_ENTRY = [
	'hooks:',
	'  PreToolUse:',
	'    - matcher: Bash',
	'      hooks:',
	'        - type: command',
	'          command: echo "no" >&2; exit 2',
]

/** A skill folder with a SKILL.md carrying the given hook lines. */
function skillFolder(name: string, hookLines: readonly string[] | null, parent?: string): string {
	const root = parent ?? mkdtempSync(join(tmpdir(), 'namzu-skill-restore-'))
	if (!parent) dirs.push(root)
	const dir = join(root, name)
	mkdirSync(dir, { recursive: true })
	writeFileSync(
		join(dir, 'SKILL.md'),
		[
			'---',
			`name: ${name}`,
			'description: guards its shell',
			...(hookLines ?? []),
			'---',
			'Run commands carefully.',
		].join('\n'),
	)
	return dir
}

const fact = (directory: string, skill = 'guarded'): SkillHooksFact => ({
	skill,
	directory,
	grantsWithheld: false,
})

async function preTool(mgr: PluginLifecycleManager) {
	return mgr.executeHooks('pre_tool_use', {
		sessionId: SESSION,
		toolName: 'bash',
		toolInput: { command: 'ls' },
	})
}

describe('a continued conversation', () => {
	it('gets the hooks of a skill it used back, from the skill file as it is now, and refuses the command', async () => {
		const dir = skillFolder('guarded', GUARD_ENTRY)
		const { mgr, h, lines } = host()
		expect(await preTool(mgr)).toEqual([])
		expect(restoreSkillHooks(h, [fact(dir)])).toEqual([])
		expect(h.attached().map((row) => row.skill)).toEqual(['guarded'])
		expect(await preTool(mgr)).toMatchObject([{ action: 'skip' }])
		expect(lines).toEqual([])
	})

	it('uses the file as it reads now: a guard edited meanwhile is the one that comes back', async () => {
		const dir = skillFolder('guarded', GUARD_ENTRY)
		writeFileSync(
			join(dir, 'SKILL.md'),
			[
				'---',
				'name: guarded',
				'description: d',
				...GUARD_ENTRY.slice(0, -1),
				'          command: echo "changed" >&2; exit 2',
				'---',
				'x',
			].join('\n'),
		)
		const { h } = host()
		restoreSkillHooks(h, [fact(dir)])
		expect(h.attached()[0]?.runs).toBe('echo "changed" >&2; exit 2')
	})

	it('is told, once to the person and once to the model, when the skill file is gone, and attaches nothing', async () => {
		const dir = skillFolder('guarded', GUARD_ENTRY)
		rmSync(dir, { recursive: true })
		const { mgr, h, lines } = host()
		const notes = restoreSkillHooks(h, [fact(dir)])
		expect(notes).toHaveLength(1)
		expect(notes[0]).toContain('Skill guarded')
		expect(notes[0]).toContain('its file is gone')
		expect(notes[0]).toContain('not attached')
		expect(notes[0]).toContain('not pre-approved')
		expect(lines).toEqual(notes)
		expect(mgr.listHooks()).toEqual([])
		expect(h.attached()).toEqual([])
	})

	it('is told when the file changed so that its guard cannot be loaded, and attaches none of it', async () => {
		const dir = skillFolder('guarded', ['hooks: [this is not a mapping'])
		const { mgr, h, lines } = host()
		const notes = restoreSkillHooks(h, [fact(dir)])
		expect(notes).toHaveLength(1)
		expect(notes[0]).toContain('Skill guarded')
		expect(notes[0]).toContain('None of its hooks are attached')
		expect(lines).toEqual(notes)
		expect(mgr.listHooks()).toEqual([])
	})

	it('is told when the file no longer carries hooks at all', async () => {
		const dir = skillFolder('guarded', null)
		const { mgr, h, lines } = host()
		const notes = restoreSkillHooks(h, [fact(dir)])
		expect(notes).toHaveLength(1)
		expect(notes[0]).toContain('no longer carries hooks')
		expect(lines).toEqual(notes)
		expect(mgr.listHooks()).toEqual([])
	})

	it('is told when the skill is in a folder that is not trusted now, and attaches nothing', async () => {
		const project = mkdtempSync(join(tmpdir(), 'namzu-skill-project-'))
		dirs.push(project)
		const dir = skillFolder('guarded', GUARD_ENTRY, join(project, '.namzu', 'skills'))
		const { mgr, h, lines } = host({ trusted: false, projectDir: project })
		const notes = restoreSkillHooks(h, [fact(dir)])
		expect(notes).toHaveLength(1)
		expect(notes[0]).toContain('not trusted')
		expect(lines).toEqual(notes)
		expect(mgr.listHooks()).toEqual([])
	})

	it('attaches a skill of the folder once the folder is trusted', async () => {
		const project = mkdtempSync(join(tmpdir(), 'namzu-skill-project-'))
		dirs.push(project)
		const dir = skillFolder('guarded', GUARD_ENTRY, join(project, '.namzu', 'skills'))
		const { mgr, h } = host({ trusted: true, projectDir: project })
		expect(restoreSkillHooks(h, [fact(dir)])).toEqual([])
		expect(mgr.listHooks()).toHaveLength(1)
	})

	it('says nothing and attaches nothing when the person switched hooks off, as for a first use', async () => {
		const dir = skillFolder('guarded', GUARD_ENTRY)
		for (const hooksSwitch of ['disabled', 'managed-only'] as const) {
			const { mgr, h, lines } = host({ hooksSwitch })
			expect(restoreSkillHooks(h, [fact(dir)])).toEqual([])
			expect(lines).toEqual([])
			expect(mgr.listHooks()).toEqual([])
		}
	})

	it('puts back each skill on its own: one that cannot come back does not cost another its guard', async () => {
		const good = skillFolder('good', GUARD_ENTRY)
		const gone = skillFolder('gone', GUARD_ENTRY)
		rmSync(gone, { recursive: true })
		const { h } = host()
		const notes = restoreSkillHooks(h, [fact(gone, 'gone'), fact(good, 'good')])
		expect(notes).toHaveLength(1)
		expect(notes[0]).toContain('Skill gone')
		expect(h.attached().map((row) => row.skill)).toEqual(['good'])
	})

	it('does not attach a skill twice when it is restored again', async () => {
		const dir = skillFolder('guarded', GUARD_ENTRY)
		const { mgr, h } = host()
		restoreSkillHooks(h, [fact(dir)])
		restoreSkillHooks(h, [fact(dir)])
		expect(mgr.listHooks()).toHaveLength(1)
	})

	it('ends with the next conversation: clearing takes the restored hooks off', async () => {
		const dir = skillFolder('guarded', GUARD_ENTRY)
		const { mgr, h } = host()
		restoreSkillHooks(h, [fact(dir)])
		h.endConversation()
		expect(mgr.listHooks()).toEqual([])
	})
})

describe('reading a skill file now', () => {
	it('says a missing folder is gone and a broken fence cannot be read', () => {
		const root = mkdtempSync(join(tmpdir(), 'namzu-skill-read-'))
		dirs.push(root)
		expect(readSkillNow(join(root, 'nowhere'))).toMatchObject({
			problem: expect.stringContaining('is gone'),
		})
		const dir = join(root, 'broken')
		mkdirSync(dir)
		writeFileSync(join(dir, 'SKILL.md'), '---\nname: [unclosed\n')
		const now = readSkillNow(dir)
		expect('problem' in now).toBe(true)
	})
})

describe('a skill folder inside the project', () => {
	it('is inside, and a sibling with the same prefix is not', () => {
		expect(isInsideFolder('/work/proj', '/work/proj/.namzu/skills/x')).toBe(true)
		expect(isInsideFolder('/work/proj', '/work/proj')).toBe(true)
		expect(isInsideFolder('/work/proj', '/work/proj-other/skills/x')).toBe(false)
		expect(isInsideFolder('/work/proj', '/home/me/.namzu/skills/x')).toBe(false)
	})
})
