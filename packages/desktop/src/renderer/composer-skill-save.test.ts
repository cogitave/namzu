import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { PermissionView } from '../shared/protocol.js'
import type { SkillSaveCard } from '../shared/question-protocol.js'
import { ComposerSkillSave } from './composer-skill-save.js'
import { SkillSwitchesView } from './config-settings-lists.js'
import { newSkillPrompt } from './skill-create.js'
import { SkillSavedCard } from './skill-saved-card.js'
import { SLASH_DEFINITIONS, slashRows } from './slash-actions.js'

const card = (extra: Partial<SkillSaveCard> = {}): SkillSaveCard => ({
	name: 'release-notes',
	description: 'Write release notes. Use when asked for release notes.',
	file: Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n'),
	hiddenCharacters: false,
	warnings: [],
	suggested: 'project',
	targets: [
		{
			scope: 'user',
			path: '~/.namzu/skills/release-notes/SKILL.md',
			shadows: ['replaces user skill ~/old (overwrites it)'],
		},
		{
			scope: 'project',
			path: './.namzu/skills/release-notes/SKILL.md',
			shadows: [],
		},
	],
	shadowsExisting: true,
	...extra,
})
const ask = (skillSave: SkillSaveCard): PermissionView => ({
	id: 'r1',
	sessionId: 's',
	projectId: 'p',
	calls: [
		{
			id: 'r1',
			name: 'ask_user_question',
			input: {},
			isDestructive: false,
			alwaysAsk: true,
		},
	],
	question: { questions: [] },
	skillSave,
})
const draw = (skillSave: SkillSaveCard, count = 1) =>
	renderToStaticMarkup(
		createElement(ComposerSkillSave, {
			permission: ask(skillSave),
			count,
			onAnswer: () => true,
		}),
	)

describe('the skill-save card', () => {
	it('shows the whole file, both places, the shadow warning and three buttons', () => {
		const html = draw(card())
		expect(html).toContain('Save skill &quot;release-notes&quot;?')
		expect(html).toContain('line 0')
		expect(html).toContain('line 29')
		expect(html).not.toContain('Show all')
		// Cancel takes the focus on open; no Save button is auto-focused.
		expect(html).toContain('Save skill')
		expect(html).toContain('Save to project')
		expect(html).toContain('>Cancel')
		expect(html).toContain('./.namzu/skills/release-notes/SKILL.md')
		// The heading over each path names the place; the buttons say what they do.
		expect(html).toMatch(/skill-save-target-label">User</)
		expect(html).toMatch(/skill-save-target-label">Project</)
		expect(html).toContain('This replaces user skill ~/old (overwrites it).')
		// The suggested place is named in words, and is the one with the accent.
		expect(html.match(/Suggested/g)).toHaveLength(1)
		expect(html).toMatch(/data-action="save-project"[^>]*data-tone="accept"/)
		expect(html).not.toMatch(/data-action="save-user"[^>]*data-tone="accept"/)
	})

	it('draws nothing when the request carries no skill', () => {
		const permission = { ...ask(card()), skillSave: undefined }
		expect(
			renderToStaticMarkup(
				createElement(ComposerSkillSave, {
					permission,
					count: 1,
					onAnswer: () => true,
				}),
			),
		).toBe('')
	})
})

describe('the saved card', () => {
	it('says it is usable from the next message and links to Settings > Skills', () => {
		const html = renderToStaticMarkup(
			createElement(SkillSavedCard, {
				name: 'release-notes',
				path: '~/.namzu/skills/release-notes/SKILL.md',
			}),
		)
		expect(html).toContain('Saved skill &quot;release-notes&quot;')
		expect(html).toContain('Usable from your next message.')
		expect(html).toContain('Open Skills in Settings')
	})
})

describe('the ways in', () => {
	it('puts a Create skill button on the Skills list, only where it can start one', () => {
		const rows = { installed: [], unknown: [] }
		const props = {
			label: 'Skills',
			rows,
			onSwitch: () => {},
			onRemoveUnknown: () => {},
		}
		expect(renderToStaticMarkup(createElement(SkillSwitchesView, props))).not.toContain(
			'Create skill',
		)
		expect(
			renderToStaticMarkup(createElement(SkillSwitchesView, { ...props, onNewSkill: () => {} })),
		).toContain('Create skill')
	})

	it('lists "skills new" in the composer menu, spelled as keywords, wherever a handler is given', () => {
		const entry = SLASH_DEFINITIONS.find((row) => row.id === 'skills-new')
		expect(entry?.name).toBe('skills new')
		expect(entry?.name).not.toContain('-')
		const rows = slashRows(
			{ 'skills-new': (idea) => newSkillPrompt(idea) },
			{ newConversation: true },
		)
		expect(rows.map((row) => row.name)).toEqual(['skills new'])
		expect(slashRows({}, { newConversation: false }).some((row) => row.id === 'skills-new')).toBe(
			false,
		)
	})

	it('seeds a request that names the skill-creator flow and says nothing about a terminal', () => {
		const text = newSkillPrompt('  weekly report ')
		expect(text).toContain('skill-creator')
		expect(text).toContain('What the skill should do: weekly report')
		expect(text).not.toMatch(/terminal/i)
		expect(newSkillPrompt('')).toContain('Start by asking what the skill should do.')
	})
})
