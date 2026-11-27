import { describe, expect, it } from 'vitest'
import type { SkillCatalogEntryView } from '../shared/customize-protocol.js'
import {
	type SkillRowModel,
	basicSkillRows,
	connectorRow,
	connectorRows,
	fileTree,
	firstFile,
	groupSkills,
	isMarkdownPath,
	lastUsedWords,
	longUpdated,
	shortUpdated,
	skillChips,
	skillGroupOf,
	skillHasMenu,
	skillLocation,
	skillStateNote,
	skillSubline,
	skillUpdatedAt,
	sortSkills,
	withoutFrontMatter,
} from './customize-model.js'

const NOW = Date.parse('2026-11-27T12:00:00Z')
const day = (n: number) => new Date(NOW - n * 86_400_000).toISOString()

const skill = (over: Partial<SkillCatalogEntryView> = {}): SkillRowModel => ({
	name: 'notes',
	description: 'Keep notes.',
	tier: 'user',
	place: 'user',
	state: 'on',
	fileCount: 1,
	removable: true,
	...over,
})

describe('skill groups', () => {
	const rows = [
		skill({ name: 'b-user' }),
		skill({ name: 'a-project', tier: 'project', place: 'project' }),
		skill({ name: 'legacy', tier: 'legacy-project', place: 'project, legacy' }),
		skill({ name: 'p-skill', tier: 'plugin', place: 'plugin', plugin: 'acme' }),
		skill({ name: 'built', tier: 'system', place: 'built-in', removable: false }),
		skill({ name: 'shared', tier: 'agents-user', place: 'user, shared' }),
	]
	it('puts each skill in its place and orders the groups', () => {
		expect(skillGroupOf(rows[2] as SkillRowModel)).toBe('project')
		expect(skillGroupOf(rows[3] as SkillRowModel)).toBe('plugin')
		const groups = groupSkills(rows, { query: '', sort: 'name' })
		expect(groups.map((g) => g.title)).toEqual([
			'This project',
			'Yours',
			'From plugins',
			'Built-in',
		])
		expect(groups[0]?.rows.map((r) => r.name)).toEqual(['a-project', 'legacy'])
		expect(groups[1]?.rows.map((r) => r.name)).toEqual(['b-user', 'shared'])
	})
	it('leaves out an empty group and filters by name and description', () => {
		const groups = groupSkills(rows, { query: 'built', sort: 'name' })
		expect(groups.map((g) => g.id)).toEqual(['builtin'])
		expect(
			groupSkills([skill({ description: 'Draw maps' })], { query: 'maps', sort: 'name' }),
		).toHaveLength(1)
		expect(groupSkills(rows, { query: 'nothing here', sort: 'name' })).toEqual([])
	})
	it('sorts by name or by last update, newest first', () => {
		const list = [
			skill({ name: 'a', updatedAt: day(9) }),
			skill({ name: 'b', updatedAt: day(1) }),
			skill({ name: 'c' }),
		]
		expect(sortSkills(list, 'name').map((r) => r.name)).toEqual(['a', 'b', 'c'])
		expect(sortSkills(list, 'updated').map((r) => r.name)).toEqual(['b', 'a', 'c'])
	})
})

describe('row words', () => {
	it('shows the plugin and a chip for each state that is not on', () => {
		expect(skillChips(skill())).toEqual([])
		expect(skillChips(skill({ state: 'off' }))).toEqual(['Off'])
		expect(skillChips(skill({ state: 'name-only' }))).toEqual(['Name only'])
		expect(skillChips(skill({ state: 'user-only', plugin: 'acme' }))).toEqual(['acme', 'You only'])
	})
	it('says place and description on one line', () => {
		expect(skillSubline(skill())).toBe('user · Keep notes.')
		expect(skillSubline(skill({ description: '' }))).toBe('user')
		expect(skillSubline(skill({ plugin: 'acme', place: 'plugin' }))).toBe('plugin · Keep notes.')
	})
	it('gives a plugin skill no menu', () => {
		expect(skillHasMenu(skill())).toBe(true)
		expect(skillHasMenu(skill({ plugin: 'acme', tier: 'plugin', place: 'plugin' }))).toBe(false)
	})
	it('explains name only and user only, and nothing else', () => {
		expect(skillStateNote('name-only')).toContain('name only')
		expect(skillStateNote('user-only')).toContain('/skills')
		expect(skillStateNote('on')).toBeUndefined()
		expect(skillStateNote('off')).toBeUndefined()
	})
	it('names the folder with ~ for home', () => {
		expect(skillLocation(skill())).toBe('~/.namzu/skills/notes')
		expect(skillLocation(skill({ tier: 'project' }))).toBe('.namzu/skills/notes')
		expect(skillLocation(skill({ tier: 'system' }))).toBe('Built into Namzu')
		expect(skillLocation(skill({ tier: 'plugin', plugin: 'acme' }))).toContain('acme')
	})
})

describe('times', () => {
	it('gives a built-in skill no time', () => {
		expect(skillUpdatedAt(skill({ updatedAt: day(1) }))).toBe(day(1))
		expect(skillUpdatedAt(skill({ place: 'built-in', updatedAt: day(1) }))).toBeUndefined()
	})
	it('is "3d ago" for a week and a date after that', () => {
		expect(shortUpdated(day(3), NOW)).toBe('3d ago')
		expect(shortUpdated(day(0.2), NOW)).toBe('today')
		expect(shortUpdated('2026-11-19T00:00:00Z', NOW)).toBe('Nov 19')
		expect(shortUpdated(undefined, NOW)).toBe('')
	})
	it('says it for a sentence', () => {
		expect(longUpdated(day(4), NOW)).toBe('4 days ago')
		expect(longUpdated(day(1), NOW)).toBe('yesterday')
		expect(longUpdated('2026-11-01T00:00:00Z', NOW)).toBe('on Nov 1')
		expect(lastUsedWords(undefined, NOW)).toBe('—')
	})
})

describe('older engine', () => {
	it('lists names and places only, with the switch from skills.disabled', () => {
		const rows = basicSkillRows(
			[
				{ name: 'a', where: 'user' },
				{ name: 'b', where: 'project, shared' },
				{ name: 'c', where: 'built-in' },
			],
			['b'],
		)
		expect(rows.map((r) => [r.name, r.state, skillGroupOf(r)])).toEqual([
			['a', 'on', 'user'],
			['b', 'off', 'project'],
			['c', 'on', 'builtin'],
		])
		expect(rows.every((r) => r.basic && r.fileCount === 0)).toBe(true)
	})
})

describe('file tree', () => {
	const files = [
		{ path: 'SKILL.md' },
		{ path: 'scripts/run.sh' },
		{ path: 'scripts/lib/a.py' },
		{ path: 'README.md' },
	]
	it('lists folders first and nests by path', () => {
		const tree = fileTree(files)
		expect(tree.map((n) => n.name)).toEqual(['scripts', 'README.md', 'SKILL.md'])
		expect(tree[0]?.children.map((n) => n.name)).toEqual(['lib', 'run.sh'])
	})
	it('opens SKILL.md first and knows markdown', () => {
		expect(firstFile(files)).toBe('SKILL.md')
		expect(firstFile([{ path: 'b.txt' }])).toBe('b.txt')
		expect(firstFile([])).toBeUndefined()
		expect(isMarkdownPath('x/README.md')).toBe(true)
		expect(isMarkdownPath('run.sh')).toBe(false)
	})
})

describe('front matter', () => {
	it('is left out of a rendered file, and only at the top', () => {
		expect(withoutFrontMatter('---\nname: a\n---\n# Title\n')).toBe('# Title\n')
		expect(withoutFrontMatter('# Title\n\n---\nrule\n')).toBe('# Title\n\n---\nrule\n')
		expect(withoutFrontMatter('---\nunclosed\n# Title')).toBe('---\nunclosed\n# Title')
	})
})

describe('connectors', () => {
	it('tells a command from an address and a status from its reason', () => {
		const ok = connectorRow({
			name: 'a',
			origin: 'your-config',
			state: 'connected',
			detail: 'node',
		})
		expect(ok).toMatchObject({
			type: 'Local',
			source: 'Your own settings',
			status: { kind: 'connected' },
		})
		const remote = connectorRow({
			name: 'b',
			origin: 'this-project',
			state: 'idle',
			detail: 'https://example.com/mcp',
		})
		expect(remote).toMatchObject({ type: 'Remote', status: { kind: 'idle' } })
		const wait = connectorRow({
			name: 'c',
			origin: 'project-file',
			state: 'waiting',
			fingerprint: 'f',
		})
		expect(wait.status).toEqual({ kind: 'approve' })
		expect(wait.source).toBe('.mcp.json in this project')
		const failed = connectorRow({
			name: 'd',
			origin: 'this-project',
			state: 'failed',
			reason: 'No answer.',
		})
		expect(failed.status).toEqual({ kind: 'failed', reason: 'No answer.' })
		expect(failed.title).toBe('d: No answer.')
	})
	it('falls back to the person’s own servers when no project is open', () => {
		expect(connectorRows(undefined, [{ name: 'x', kind: 'address' }])).toMatchObject([
			{ name: 'x', type: 'Remote', source: 'Your own settings' },
		])
		expect(connectorRows({ servers: [] }, [{ name: 'x', kind: 'command' }])).toEqual([])
	})
})
