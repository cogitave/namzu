import { describe, expect, it } from 'vitest'
import {
	type SkillSaveCard,
	readQuestionNotice,
	readSkillSaveCard,
} from '../shared/question-protocol.js'
import {
	SKILL_PREVIEW_LINES,
	savedSkillOf,
	shadowNote,
	skillSaveResponse,
	skillSaveView,
} from './skill-save-card-model.js'

const card = (extra: Partial<SkillSaveCard> = {}): SkillSaveCard => ({
	name: 'release-notes',
	description: 'Write release notes. Use when asked for release notes.',
	file: '---\nname: release-notes\n---\n\n1. List merged PRs.',
	hiddenCharacters: false,
	warnings: [],
	suggested: 'user',
	targets: [
		{
			scope: 'user',
			path: '~/.namzu/skills/release-notes/SKILL.md',
			shadows: [],
		},
		{
			scope: 'project',
			path: './.namzu/skills/release-notes/SKILL.md',
			shadows: [],
		},
	],
	shadowsExisting: false,
	...extra,
})

describe('the skill-save card model', () => {
	it('words the question and the two places, marking the suggested one', () => {
		const view = skillSaveView(card(), false)
		expect(view.title).toBe('Save the skill "release-notes"?')
		expect(view.targets.map((t) => [t.label, t.suggested])).toEqual([
			['Save to my skills', true],
			['Save to this project', false],
		])
		expect(view.canExpand).toBe(false)
		expect(view.hiddenLines).toBe(0)
		expect(view.shadows).toBe(false)
	})

	it('shows the first lines of a long file and all of it once expanded', () => {
		const file = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n')
		const short = skillSaveView(card({ file }), false)
		expect(short.preview.split('\n')).toHaveLength(SKILL_PREVIEW_LINES)
		expect(short.hiddenLines).toBe(40 - SKILL_PREVIEW_LINES)
		const full = skillSaveView(card({ file }), true)
		expect(full.preview).toBe(file)
		expect(full.hiddenLines).toBe(0)
		expect(full.canExpand).toBe(true)
	})

	it('says what a place would replace, and warns about hidden characters', () => {
		const view = skillSaveView(
			card({
				hiddenCharacters: true,
				warnings: ['The skill contains an instruction to ignore instructions.'],
				shadowsExisting: true,
				targets: [
					{
						scope: 'user',
						path: '~/x',
						shadows: ['replaces ~/.namzu/skills skill ~/x (overwrites it)'],
					},
					{
						scope: 'project',
						path: './x',
						shadows: ['hidden by built-in skill /b, which keeps winning'],
					},
				],
			}),
			false,
		)
		expect(view.shadows).toBe(true)
		expect(view.targets[0]?.notes).toEqual([
			'This replaces ~/.namzu/skills skill ~/x (overwrites it).',
		])
		expect(view.targets[1]?.notes).toEqual(['Hidden by built-in skill /b, which keeps winning.'])
		expect(view.warnings).toHaveLength(2)
		expect(view.warnings[1]).toContain('<U+XXXX>')
		expect(shadowNote('replaces a')).toBe('This replaces a.')
	})

	it('answers with the one question the host asked, and names exactly one choice', () => {
		for (const choice of ['user', 'project', 'cancel'] as const)
			expect(skillSaveResponse(choice)).toEqual({
				kind: 'answer',
				answers: [{ questionId: 'skill-save', selectedOptionIds: [choice] }],
			})
	})

	it('reads a saved skill only from the tool’s own line', () => {
		expect(
			savedSkillOf({
				kind: 'generic',
				label: 'Saved skill "release-notes" to ~/.namzu/skills/release-notes/SKILL.md',
			}),
		).toEqual({
			name: 'release-notes',
			path: '~/.namzu/skills/release-notes/SKILL.md',
		})
		expect(
			savedSkillOf({ kind: 'generic', label: 'Cancelled — nothing was saved' }),
		).toBeUndefined()
		expect(savedSkillOf({ kind: 'terminal' })).toBeUndefined()
		expect(savedSkillOf(undefined)).toBeUndefined()
		expect(savedSkillOf({ kind: 'generic', label: 'Saved skill "Bad Name" to x' })).toBeUndefined()
	})
})

describe('reading the host’s skill-save request', () => {
	const params = (skillSave: unknown) => ({
		sessionId: 's',
		requestId: 'r',
		question: {
			questions: [
				{
					id: 'skill-save',
					question: 'Save the skill "release-notes"?',
					options: [
						{ id: 'user', label: 'Save to my skills' },
						{ id: 'project', label: 'Save to this project' },
						{ id: 'cancel', label: 'Cancel' },
					],
					multiSelect: false,
					allowFreeText: false,
				},
			],
		},
		skillSave,
	})

	it('reads a whole card, and drops the request when any part of it does not read', () => {
		expect(readQuestionNotice(params(card()))?.skillSave?.name).toBe('release-notes')
		expect(readQuestionNotice(params(undefined))?.skillSave).toBeUndefined()
		expect(readQuestionNotice(params(card({ file: '' })))).toBeUndefined()
		expect(readQuestionNotice(params({ ...card(), targets: [] }))).toBeUndefined()
		expect(readSkillSaveCard({ ...card(), suggested: 'elsewhere' })).toBeUndefined()
		expect(readSkillSaveCard('nope')).toBeUndefined()
		expect(
			readSkillSaveCard({
				...card(),
				targets: [card().targets[1], card().targets[0]],
			}),
		).toBeUndefined()
	})
})
