import { describe, expect, it } from 'vitest'
import type { SkillStageItemView } from '../shared/customize-protocol.js'
import {
	type CardState,
	collisionLine,
	connectorChange,
	connectorProblem,
	createProblem,
	emptyConnector,
	sizeWords,
	skillFolderName,
	stageChips,
	stageNeedsAccept,
	stageSize,
	startsWithFrontmatter,
	uploadBlocked,
	uploadToast,
} from './customize-actions-model.js'

const item = (over: Partial<SkillStageItemView> = {}): SkillStageItemView => ({
	fileName: 'notes.md',
	kind: 'file',
	name: 'notes',
	description: 'Keep notes.',
	files: 3,
	bytes: 12_300,
	findings: [],
	grants: [],
	scripts: [],
	...over,
})
const card = (over: Partial<SkillStageItemView> = {}): CardState => ({
	choice: { fileName: 'notes.md', path: '/x/notes.md' },
	item: item(over),
})
const none = new Set<string>()

describe('what a card says', () => {
	it('writes sizes for people', () => {
		expect(sizeWords(812)).toBe('812 B')
		expect(sizeWords(12_300)).toBe('12 KB')
		expect(sizeWords(3_500_000)).toBe('3.3 MB')
		expect(stageSize(item())).toBe('3 files · 12 KB')
		expect(stageSize(item({ files: 1, bytes: undefined }))).toBe('1 file')
	})
	it('reads chips from what the engine says it grants', () => {
		expect(stageChips(item())).toEqual([])
		expect(stageChips(item({ scripts: ['scripts/a.sh'] }))).toEqual(['Runs commands'])
		expect(
			stageChips(
				item({
					grants: [
						'Pre-approves while this skill runs: Bash(git:*)',
						'Carries hooks that attach while it is in use.',
					],
				}),
			),
		).toEqual(['Uses tools: shell', 'Has hooks'])
		expect(stageNeedsAccept(item())).toBe(false)
		expect(stageNeedsAccept(item({ scripts: ['a'] }))).toBe(true)
	})
	it('names a collision only for the place chosen', () => {
		const taken = item({ collides: ['user'] })
		expect(collisionLine(taken, 'user')).toBe('Replaces your skill "notes"')
		expect(collisionLine(taken, 'project')).toBeUndefined()
	})
})

describe('when Upload may be pressed', () => {
	it('waits for a file, then a decision on every collision and every grant', () => {
		expect(uploadBlocked([], 'user', none, none)).toBe('Choose a file to continue.')
		expect(
			uploadBlocked([{ choice: { fileName: 'x', error: 'no' }, error: 'no' }], 'user', none, none),
		).toBe('Choose a file to continue.')
		expect(uploadBlocked([card()], 'user', none, none)).toBeUndefined()
		expect(uploadBlocked([card({ collides: ['user'] })], 'user', none, none)).toMatch(
			/replace "notes"/,
		)
		expect(
			uploadBlocked([card({ collides: ['user'] })], 'user', new Set(['notes']), none),
		).toBeUndefined()
		expect(uploadBlocked([card({ scripts: ['a.sh'] })], 'user', none, none)).toMatch(
			/Accept what "notes" can run/,
		)
		expect(
			uploadBlocked([card({ scripts: ['a.sh'] })], 'user', none, new Set(['notes'])),
		).toBeUndefined()
	})
})

describe('the toast after an upload', () => {
	it('counts what was added', () => {
		expect(
			uploadToast([
				{ name: 'a', outcome: 'added' },
				{ name: 'b', outcome: 'replaced' },
			]),
		).toEqual({
			text: 'Added 2 skills. They are available from your next message.',
			tone: 'success',
		})
		expect(uploadToast([{ name: 'a', outcome: 'added' }]).text).toBe(
			'Added a. It is available from your next message.',
		)
	})
	it('says what failed', () => {
		expect(uploadToast([{ name: 'a', outcome: 'failed', error: 'Too big.' }])).toEqual({
			text: 'Too big.',
			tone: 'error',
		})
		expect(
			uploadToast([
				{ name: 'a', outcome: 'added' },
				{ name: 'b', outcome: 'failed', error: 'Too big.' },
			]).tone,
		).toBe('warning')
	})
})

describe('creating a skill', () => {
	it('derives the folder name', () => {
		expect(skillFolderName('Weekly status report')).toBe('weekly-status-report')
		expect(skillFolderName('  Çok güzel!  ')).toBe('cok-guzel')
		expect(skillFolderName('***')).toBe('')
		expect(skillFolderName('a'.repeat(100))).toHaveLength(64)
	})
	it('names what is missing', () => {
		const ok = { name: 'Weekly report', description: 'Makes it.', instructions: 'Do it.' }
		expect(createProblem(ok)).toBeUndefined()
		expect(createProblem({ ...ok, name: '' })).toBe(
			'Add a valid name and description before saving.',
		)
		expect(createProblem({ ...ok, description: ' ' })).toBe(
			'Add a valid name and description before saving.',
		)
		expect(createProblem({ ...ok, description: 'Use <b>this</b>' })).toBe(
			'Description cannot contain XML tags',
		)
		expect(createProblem({ ...ok, description: 'x'.repeat(1025) })).toMatch(/longer than 1024/)
		expect(createProblem({ ...ok, instructions: '' })).toMatch(/what the skill should do/)
	})
	it('notices a leading frontmatter fence', () => {
		expect(startsWithFrontmatter('---\nname: x\n---')).toBe(true)
		expect(startsWithFrontmatter('Do this\n---')).toBe(false)
	})
})

describe('the connector form', () => {
	const draft = (over: Partial<ReturnType<typeof emptyConnector>> = {}) => ({
		...emptyConnector(),
		name: 'tickets',
		url: 'https://mcp.example.com/mcp',
		...over,
	})
	it('accepts an https address and a local http one', () => {
		expect(connectorProblem(draft())).toBeUndefined()
		expect(connectorProblem(draft({ url: 'http://localhost:8080/mcp' }))).toBeUndefined()
	})
	it('refuses a name, an address and a header that cannot work', () => {
		expect(connectorProblem(draft({ name: '' }))).toBe('Name the connector.')
		expect(connectorProblem(draft({ name: '1x' }))).toMatch(/starts with a letter/)
		expect(connectorProblem(draft({ url: 'mcp.example.com' }))).toMatch(/https address/)
		expect(connectorProblem(draft({ url: 'http://example.com/mcp' }))).toMatch(/Use https/)
		expect(connectorProblem(draft({ url: 'https://u:p@example.com/mcp' }))).toMatch(/user name/)
		expect(
			connectorProblem(
				draft({ auth: 'header', header: { name: 'Authorization', value: 'Bearer abc' } }),
			),
		).toMatch(/environment reference/)
	})
	it('sends the header as a reference only when the header option is chosen', () => {
		expect(connectorChange(draft())).toEqual({
			mode: 'add',
			name: 'tickets',
			url: 'https://mcp.example.com/mcp',
		})
		expect(
			connectorChange(
				draft({
					auth: 'header',
					header: { name: 'Authorization', value: 'Bearer ${EXAMPLE_TOKEN}' },
				}),
			).headers,
		).toEqual({ Authorization: 'Bearer ${EXAMPLE_TOKEN}' })
		expect(
			connectorChange(draft({ auth: 'sign-in', header: { name: 'X', value: 'y' } })).headers,
		).toBeUndefined()
	})
})
