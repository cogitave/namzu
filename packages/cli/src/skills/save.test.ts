import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path, { join } from 'node:path'
import { loadSkill } from '@namzu/sdk'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { removeTempDir } from '../__fixtures__/temp-dir.js'
import { createSessionSkillCatalog } from './catalog.js'
import {
	SAVE_SKILL_TOOL_NAME,
	type SaveSkillAnswer,
	type SaveSkillHost,
	type SaveSkillRequest,
	SkillDraftError,
	buildSaveSkillTool,
	composeSkillMarkdown,
	describeCollision,
	displayPath,
	planSkillTargets,
	skillWarnings,
	validateSkillDraft,
} from './save.js'

let home: string
let cwd: string

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), 'namzu-save-home-'))
	cwd = mkdtempSync(join(tmpdir(), 'namzu-save-cwd-'))
})
afterEach(() => {
	removeTempDir(home)
	removeTempDir(cwd)
})

const userDir = () => join(home, '.namzu', 'skills')
const projectDir = () => join(cwd, '.namzu', 'skills')

function skillAt(dir: string, name: string, description = 'an existing skill'): string {
	mkdirSync(join(dir, name), { recursive: true })
	const path = join(dir, name, 'SKILL.md')
	writeFileSync(path, `---\nname: ${name}\ndescription: ${description}\n---\nOld body.`)
	return path
}

const draft = {
	name: 'release-notes',
	description: 'Write release notes from merged PRs. Use when the user asks for release notes.',
	body: '# Release notes\n\n1. List merged PRs.\n2. Group them.',
}

function host(answer: SaveSkillAnswer | (() => Promise<SaveSkillAnswer>)) {
	const requests: SaveSkillRequest[] = []
	const saved: string[] = []
	const value: SaveSkillHost = {
		cwd: () => cwd,
		home: () => home,
		sessionId: () => '019a0000-0000-7000-8000-00000000abcd',
		now: () => new Date('2026-09-23T12:00:00.000Z'),
		confirm: async (request) => {
			requests.push(request)
			return typeof answer === 'function' ? answer() : answer
		},
		saved: ({ path }) => saved.push(path),
	}
	return { value, requests, saved }
}

async function run(
	h: SaveSkillHost,
	input: Record<string, unknown>,
	signal?: AbortSignal,
): Promise<{ success: boolean; output: string; error?: string }> {
	const tool = buildSaveSkillTool(h)
	const parsed = tool.inputSchema.parse(input)
	return tool.execute(parsed as never, { abortSignal: signal } as never) as never
}

describe('validateSkillDraft', () => {
	it('refuses names the loader refuses, empty or oversized fields, and frontmatter in the body', () => {
		expect(() => validateSkillDraft({ ...draft, name: 'Release_Notes' })).toThrow(SkillDraftError)
		expect(() => validateSkillDraft({ ...draft, name: 'a'.repeat(65) })).toThrow(/64/)
		expect(() => validateSkillDraft({ ...draft, description: '  ' })).toThrow(/empty/)
		expect(() => validateSkillDraft({ ...draft, description: 'x'.repeat(1025) })).toThrow(/1024/)
		expect(() => validateSkillDraft({ ...draft, body: 'x'.repeat(64 * 1024 + 1) })).toThrow(/bytes/)
		expect(() => validateSkillDraft({ ...draft, body: '---\nname: x\n---\nbody' })).toThrow(
			/frontmatter/,
		)
	})

	it('folds a multi-line description onto one line', () => {
		expect(validateSkillDraft({ ...draft, description: 'one\n  two' }).description).toBe('one two')
	})
})

describe('composeSkillMarkdown', () => {
	it('writes a file the kernel loader reads back exactly, with its provenance', async () => {
		const markdown = composeSkillMarkdown(validateSkillDraft({ ...draft, origin: 'learned' }), {
			sessionId: 's-1',
			createdAt: new Date('2026-09-23T12:00:00.000Z'),
		})
		mkdirSync(join(userDir(), draft.name), { recursive: true })
		writeFileSync(join(userDir(), draft.name, 'SKILL.md'), markdown)
		const { skill } = await loadSkill(join(userDir(), draft.name), 'full')
		expect(skill.metadata.name).toBe(draft.name)
		expect(skill.metadata.description).toBe(draft.description)
		expect(skill.metadata.metadata).toEqual({
			'namzu-origin': 'learned',
			'namzu-session': 's-1',
			'namzu-created': '2026-09-23T12:00:00.000Z',
		})
		expect(skill.body).toBe(draft.body)
	})

	it('refuses a description that would read back differently', () => {
		expect(() =>
			composeSkillMarkdown(validateSkillDraft({ ...draft, description: '[a, b]' }), {
				createdAt: new Date(),
			}),
		).toThrow(SkillDraftError)
	})
})

describe('planSkillTargets', () => {
	it('names the file a save overwrites and the lower tier it replaces', () => {
		const user = skillAt(userDir(), 'release-notes')
		const targets = planSkillTargets('release-notes', { cwd, home, config: {} })
		expect(targets.user.path).toBe(user)
		expect(targets.user.collisions).toEqual([
			expect.objectContaining({ path: user, overwrite: true, effect: 'replaces' }),
		])
		expect(targets.project.path).toBe(join(projectDir(), 'release-notes', 'SKILL.md'))
		expect(targets.project.collisions).toEqual([
			expect.objectContaining({ path: user, effect: 'replaces', where: 'user' }),
		])
	})

	it('says when a project skill keeps winning over a user save', () => {
		const project = skillAt(projectDir(), 'release-notes')
		const targets = planSkillTargets('release-notes', { cwd, home })
		expect(targets.user.collisions).toEqual([
			expect.objectContaining({ path: project, effect: 'hidden-by', overwrite: false }),
		])
	})

	it('words a shared or legacy tier with the qualifier in parentheses', () => {
		const shared = skillAt(join(home, '.agents', 'skills'), 'release-notes')
		const legacy = skillAt(join(cwd, 'skills'), 'notes-two')
		const sharedHit = planSkillTargets('release-notes', { cwd, home }).project.collisions[0]
		const legacyHit = planSkillTargets('notes-two', { cwd, home }).user.collisions[0]
		expect(sharedHit?.where).toBe('user (shared)')
		expect(legacyHit?.where).toBe('project (legacy)')
		expect(describeCollision(sharedHit as never, cwd)).toBe(
			`replaces user (shared) skill ${shared}`,
		)
		expect(describeCollision(legacyHit as never, cwd)).toContain('project (legacy) skill')
		expect(legacy).toBeTruthy()
	})

	it('shows the built-in skill a user save replaces', () => {
		const targets = planSkillTargets('skill-creator', { cwd, home })
		expect(targets.user.collisions).toEqual([
			expect.objectContaining({ where: 'built-in', effect: 'replaces', overwrite: false }),
		])
	})
})

describe('the save_skill tool', () => {
	it('shows the operator the whole file and writes exactly that, atomically, where they chose', async () => {
		const h = host('user')
		const result = await run(h.value, { ...draft, scope: 'project' })
		expect(result.success).toBe(true)
		const request = h.requests[0] as SaveSkillRequest
		expect(request.suggested).toBe('project')
		expect(request.targets.user.path).toBe(join(userDir(), 'release-notes', 'SKILL.md'))
		const written = readFileSync(request.targets.user.path, 'utf8')
		expect(written).toBe(request.markdown)
		expect(written).toContain('namzu-origin: created')
		expect(written).toContain('namzu-session: "019a0000-0000-7000-8000-00000000abcd"')
		expect(written).toContain('namzu-created: "2026-09-23T12:00:00.000Z"')
		// Only SKILL.md: no temporary left beside it, nothing else created.
		expect(readdirSync(join(userDir(), 'release-notes'))).toEqual(['SKILL.md'])
		expect(existsSync(projectDir())).toBe(false)
		expect(h.saved).toEqual([request.targets.user.path])
		expect(result.output).toContain('usable from the next message')
		expect(result.output).not.toMatch(/\/skills /)
	})

	it('writes nothing when the operator cancels', async () => {
		const h = host('cancel')
		const result = await run(h.value, draft)
		expect(result.success).toBe(false)
		expect(result.error).toContain('nothing was written')
		// Drawn as the operator's answer, not as a failure.
		expect(buildSaveSkillTool(h.value).presentResult?.(draft as never, result)).toEqual({
			kind: 'generic',
			label: 'Cancelled — nothing was saved',
			outcome: 'cancelled',
		})
		expect(existsSync(userDir())).toBe(false)
		expect(existsSync(projectDir())).toBe(false)
	})

	it('writes nothing when the confirmation fails or the turn is aborted', async () => {
		const failing = host(async () => {
			throw new Error('screen closed')
		})
		expect((await run(failing.value, draft)).success).toBe(false)
		const controller = new AbortController()
		const aborted = host(async () => {
			controller.abort()
			return 'project'
		})
		expect((await run(aborted.value, draft, controller.signal)).success).toBe(false)
		expect(existsSync(userDir())).toBe(false)
		expect(existsSync(projectDir())).toBe(false)
	})

	it('reveals hidden characters on the screen and warns about them', async () => {
		const h = host('cancel')
		await run(h.value, { ...draft, body: 'Step one.‮eno petS' })
		const request = h.requests[0] as SaveSkillRequest
		expect(request.revealed).toContain('<U+202E>')
		expect(request.revealed).not.toContain('‮')
		expect(request.warnings).toContain(
			'The skill contains invisible or direction-changing characters.',
		)
	})

	it('shows the skill a save replaces', async () => {
		const existing = skillAt(userDir(), 'release-notes')
		const h = host('project')
		const result = await run(h.value, { ...draft, replaces: 'release-notes' })
		expect(result.success).toBe(true)
		const request = h.requests[0] as SaveSkillRequest
		expect(request.targets.user.collisions[0]).toMatchObject({ path: existing, overwrite: true })
		expect(request.targets.project.collisions[0]).toMatchObject({
			path: existing,
			effect: 'replaces',
		})
		expect(result.output).toContain('replaces user skill')
	})

	it('refuses before asking when the draft is invalid or replaces names another skill', async () => {
		const h = host('user')
		expect((await run(h.value, { ...draft, name: 'Bad Name' })).error).toMatch(/lowercase/)
		expect((await run(h.value, { ...draft, replaces: 'other' })).error).toMatch(/must equal/)
		expect(h.requests).toEqual([])
	})

	it('reaches the model on the next turn through the session catalog', async () => {
		const system = mkdtempSync(join(tmpdir(), 'namzu-save-sys-'))
		try {
			const catalog = await createSessionSkillCatalog({ cwd, home, systemDir: system })
			const before = await catalog.forTurn({ toolNames: [], contextWindowTokens: 200_000 })
			expect(before.manifest).toBeUndefined()
			await run(host('user').value, draft)
			const after = await catalog.forTurn({ toolNames: [], contextWindowTokens: 200_000 })
			expect(after.manifest?.map((skill) => skill.metadata.name)).toEqual(['release-notes'])
			expect((await after.registry?.load('release-notes'))?.skill.body).toBe(draft.body)
		} finally {
			removeTempDir(system)
		}
	})

	it('is named save_skill and asks nothing of the permission gate about paths', () => {
		const tool = buildSaveSkillTool(host('cancel').value)
		expect(tool.name).toBe(SAVE_SKILL_TOOL_NAME)
		expect(tool.pathArgument).toBeUndefined()
		expect(vi.isMockFunction(tool.execute)).toBe(false)
	})
})

describe('a save never writes through a symlink', () => {
	const linkable = process.platform !== 'win32'

	it.skipIf(!linkable)(
		'refuses a project skill folder linked to the user skill folder, and leaves the user skill alone',
		async () => {
			const userSkill = skillAt(userDir(), draft.name, 'the person’s own')
			mkdirSync(projectDir(), { recursive: true })
			symlinkSync(join(userDir(), draft.name), join(projectDir(), draft.name))
			const before = readFileSync(userSkill, 'utf8')
			const h = host('project')
			const result = await run(h.value, draft)
			expect(result.success).toBe(false)
			expect(result.error).toMatch(/symbolic link/)
			expect(readFileSync(userSkill, 'utf8')).toBe(before)
			expect(h.saved).toEqual([])
			// The collision is read by real path: the linked file is the user's own.
			const target = h.requests[0]?.targets.project
			expect(target?.collisions.some((c) => c.overwrite)).toBe(true)
		},
	)

	it.skipIf(!linkable)('refuses a linked .namzu folder in the project', async () => {
		const elsewhere = mkdtempSync(join(tmpdir(), 'namzu-save-elsewhere-'))
		try {
			symlinkSync(elsewhere, join(cwd, '.namzu'))
			const result = await run(host('project').value, draft)
			expect(result.success).toBe(false)
			expect(result.error).toMatch(/symbolic link/)
			expect(readdirSync(elsewhere)).toEqual([])
		} finally {
			removeTempDir(elsewhere)
		}
	})

	it.skipIf(!linkable)('refuses a linked SKILL.md and keeps its target', async () => {
		const outside = join(cwd, 'outside.md')
		writeFileSync(outside, 'keep me')
		mkdirSync(join(userDir(), draft.name), { recursive: true })
		symlinkSync(outside, join(userDir(), draft.name, 'SKILL.md'))
		const result = await run(host('user').value, draft)
		expect(result.success).toBe(false)
		expect(readFileSync(outside, 'utf8')).toBe('keep me')
		expect(lstatSync(join(userDir(), draft.name, 'SKILL.md')).isSymbolicLink()).toBe(true)
	})

	it('still writes a plain new skill', async () => {
		const result = await run(host('project').value, draft)
		expect(result.success).toBe(true)
		expect(existsSync(join(projectDir(), draft.name, 'SKILL.md'))).toBe(true)
	})
})

describe('skillWarnings', () => {
	it('warns about load-time shell commands, inline and fenced', () => {
		const inline = skillWarnings('---\nname: a\n---\nRun !`git status` first.')
		expect(inline.some((w) => /every time the skill loads/.test(w))).toBe(true)
		const fenced = skillWarnings('---\nname: a\n---\n```!\nls\n```\n')
		expect(fenced.some((w) => /every time the skill loads/.test(w))).toBe(true)
		expect(skillWarnings('---\nname: a\n---\nJust text.')).toEqual([])
	})
})

describe('displayPath', () => {
	it('shows a path on another drive in full, never behind a .\\ prefix', () => {
		expect(displayPath('D:\\skills\\a\\SKILL.md', 'C:\\proj', 'C:\\Users\\me', path.win32)).toBe(
			'D:\\skills\\a\\SKILL.md',
		)
	})
	it('shows an outside path in full and an inside one short', () => {
		expect(displayPath('C:\\other\\x', 'C:\\proj', 'C:\\Users\\me', path.win32)).toBe(
			'C:\\other\\x',
		)
		expect(displayPath('C:\\proj\\a\\b', 'C:\\proj', 'C:\\Users\\me', path.win32)).toBe('.\\a\\b')
		expect(displayPath('C:\\Users\\me\\s', 'C:\\proj', 'C:\\Users\\me', path.win32)).toBe('~\\s')
	})
})
