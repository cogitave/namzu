import { type ReactElement, createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { SkillStageItemView } from '../shared/customize-protocol.js'
import {
	AddConnectorForm,
	CreateSkillForm,
	StageCard,
	UploadSkillPage,
} from './customize-actions.js'
import { type SkillRowModel, groupSkills } from './customize-model.js'
import { SkillsList, skillCanBeRemoved } from './customize-skills.js'

const html = (node: ReactElement) => renderToStaticMarkup(node)
const none = () => {}
const item = (over: Partial<SkillStageItemView> = {}): SkillStageItemView => ({
	fileName: 'notes.md',
	kind: 'file',
	name: 'notes',
	description: 'Keep notes in one place.',
	files: 3,
	bytes: 12_300,
	findings: [],
	grants: [],
	scripts: [],
	...over,
})
const card = (over: Partial<SkillStageItemView> = {}, error?: string) => ({
	choice: { fileName: 'notes.md', path: '/x/notes.md' },
	item: item(over),
	...(error ? { error } : {}),
})
const stageCard = (props: Partial<Parameters<typeof StageCard>[0]> = {}) =>
	html(
		createElement(StageCard, {
			card: card(),
			scope: 'user',
			replace: false,
			accept: false,
			onReplace: none,
			onAccept: none,
			onRemove: none,
			...props,
		}),
	)

describe('the Upload a skill page', () => {
	const page = (projectId?: string) =>
		html(
			createElement(UploadSkillPage, {
				api: {},
				projectId,
				onBack: none,
				onDone: none,
			}),
		)
	it('shows the words of the design, with Upload off until a file is chosen', () => {
		const markup = page()
		for (const text of [
			'Your skills',
			'Upload a skill',
			'Add a skill to this computer.',
			'Skill file',
			'Drag and drop skill files here, or ',
			'Choose a folder',
			'A .md file must contain the skill name and description formatted in YAML.',
			'A .zip or .skill file must include a SKILL.md file.',
			'Where to save',
			'Yours',
			'This project',
			'Each skill is checked when you add it: name, description, size, links and what it can run. Nothing leaves your computer.',
			'Choose a file to continue.',
			'Cancel',
		])
			expect(markup).toContain(text)
		expect(markup).toMatch(/<button[^>]*disabled[^>]*>Upload<\/button>/)
	})
	it('disables This project, with the reason, when the folder is not trusted', () => {
		expect(page()).toContain('Open a trusted project folder to save skills there.')
		expect(page('p1')).not.toContain('Open a trusted project folder')
	})
})

describe('a staged card', () => {
	it('shows the name, description, size and no chip for a plain skill', () => {
		const markup = stageCard()
		expect(markup).toContain('notes')
		expect(markup).toContain('Keep notes in one place.')
		expect(markup).toContain('3 files · 12 KB')
		expect(markup).toContain('Remove from list')
		expect(markup).not.toContain('Runs commands')
		expect(markup).not.toContain('I trust what it can run')
	})
	it('shows the chip, its lines and the checkbox for a skill that runs commands', () => {
		const markup = stageCard({
			card: card({
				scripts: ['scripts/pack.sh'],
				grants: ['Pre-approves while this skill runs: Bash(git:*)'],
			}),
		})
		expect(markup).toContain('Runs commands')
		expect(markup).toContain('Uses tools: shell')
		expect(markup).toContain('Pre-approves while this skill runs')
		expect(markup).toContain('I trust what it can run')
	})
	it('offers Replace only where the place already holds the name', () => {
		const taken = card({ collides: ['user'] })
		expect(stageCard({ card: taken })).toContain('Replaces your skill &quot;notes&quot;')
		expect(stageCard({ card: taken, scope: 'project' })).not.toContain('Replaces your skill')
	})
	it('shows a refusal in place of the size', () => {
		const markup = stageCard({
			card: card({ error: 'Skill file is too large. Maximum size is 30 MB.' }),
		})
		expect(markup).toContain('Skill file is too large. Maximum size is 30 MB.')
		expect(markup).not.toContain('3 files')
	})
	it('shows the engine answer to an install that failed', () => {
		expect(stageCard({ failure: 'A skill named "notes" is already there.' })).toContain(
			'is already there.',
		)
	})
})

describe('the Create a skill form', () => {
	const form = () =>
		html(
			createElement(CreateSkillForm, {
				api: {},
				projectId: undefined,
				onClose: none,
				onCreated: none,
			}),
		)
	it('shows its fields, counter and a disabled Create with the hint', () => {
		const markup = form()
		for (const text of [
			'Skill name',
			'Weekly status report',
			'Description',
			'0/1024',
			'Instructions',
			'Where to save',
			'Add a valid name and description before saving.',
			'Cancel',
			'Create',
		])
			expect(markup).toContain(text)
		expect(markup).toMatch(
			/<button[^>]*disabled[^>]*type="submit"[^>]*>Create<\/button>|<button[^>]*type="submit"[^>]*disabled[^>]*>Create<\/button>/,
		)
		expect(markup).not.toContain('Replace')
	})
})

describe('the Add custom connector form', () => {
	const form = () =>
		html(createElement(AddConnectorForm, { save: vi.fn(), onClose: none, onSaved: none }))
	it('shows the design words', () => {
		const markup = form()
		for (const text of [
			'Connect Namzu to your data and tools with an MCP server address.',
			'Name',
			'Shown in the connectors list.',
			'MCP server URL',
			'The https address where the server accepts MCP requests, for example https://mcp.example.com/mcp.',
			'Authentication',
			'No sign-in',
			'Sign in when asked',
			'Header',
			'Only use connectors from developers you trust. Namzu cannot verify what their tools do or that they will not change.',
			'Cancel',
		])
			expect(markup).toContain(text)
		expect(markup).not.toContain('Header name')
	})
})

describe('the skill row menu', () => {
	const row = (over: Partial<SkillRowModel> = {}): SkillRowModel => ({
		name: 'mine',
		description: 'My skill.',
		tier: 'user',
		place: 'user',
		state: 'on',
		fileCount: 1,
		removable: true,
		...over,
	})
	it('allows Remove for the user and project tiers only', () => {
		expect(skillCanBeRemoved(row())).toBe(true)
		expect(skillCanBeRemoved(row({ tier: 'project' }))).toBe(true)
		expect(skillCanBeRemoved(row({ tier: 'system' }))).toBe(false)
		expect(skillCanBeRemoved(row({ tier: 'plugin' }))).toBe(false)
		expect(skillCanBeRemoved(row({ basic: true }))).toBe(false)
	})
	it('lists the rows with their menus', () => {
		const groups = groupSkills([row(), row({ name: 'built', tier: 'system', place: 'built-in' })], {
			query: '',
			sort: 'name',
		})
		const markup = html(
			createElement(SkillsList, {
				groups,
				now: Date.now(),
				onOpen: none,
				onToggle: none,
				onRemove: none,
			}),
		)
		expect(markup).toContain('Actions for mine')
		expect(markup).toContain('Actions for built')
	})
})
