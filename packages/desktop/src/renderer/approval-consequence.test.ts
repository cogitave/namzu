import { expect, it } from 'vitest'
import type { PermissionView } from '../shared/protocol.js'
import {
	approvalConsequence,
	approvalConsequenceTitle,
	approvalFlags,
	buildApprovalCard,
	elevatedCommand,
	outsideProject,
	riskyCommand,
	waitingLabel,
} from './approval-card-model.js'
import { headingOf } from './composer-approval.js'

const request = (calls: PermissionView['calls']): PermissionView => ({
	id: 'r',
	sessionId: 's',
	projectId: 'p',
	calls,
})
const call = (
	name: string,
	input: unknown,
	extra: Partial<PermissionView['calls'][number]> = {},
): PermissionView['calls'][number] => ({
	id: `c-${name}`,
	name,
	input,
	isDestructive: false,
	...extra,
})
const flagsOf = (calls: PermissionView['calls'], folder?: string) => {
	const permission = request(calls)
	return approvalFlags(buildApprovalCard(permission), permission, folder)
}

it('says where a command runs, and nothing else about it', () => {
	const plain = buildApprovalCard(request([call('bash', { command: 'ls' })]))
	expect(approvalConsequence(plain, '/work/site', 'Site')).toBe('Runs in Site.')
	// Without a name the folder is shortened, never printed whole.
	expect(approvalConsequence(plain, '/home/arda/workspaces/site')).toBe(
		'Runs in ~/workspaces/site.',
	)
	expect(approvalConsequence(plain)).toBe('Runs on your computer.')
	expect(approvalConsequenceTitle(plain, '/work/site')).toBe('/work/site')
	// A file change already names its target in the question; the foot adds nothing.
	const edit = buildApprovalCard(
		request([call('edit', { path: '/work/a.ts', old_string: 'a', new_string: 'b' })]),
	)
	expect(approvalConsequence(edit, '/work')).toBeUndefined()
})

it('recognises commands that are hard to take back, and not ordinary ones', () => {
	for (const command of [
		'rm -rf node_modules',
		'sudo apt install x',
		'git reset --hard HEAD~1',
		'git push origin main --force',
	])
		expect(riskyCommand(command), command).toBe(true)
	for (const command of ['ls -la', 'npm test', 'echo form', 'cat firm.txt'])
		expect(riskyCommand(command), command).toBe(false)
	expect(elevatedCommand('sudo apt install x')).toBe(true)
	expect(elevatedCommand('echo pseudo')).toBe(false)
})

it('names an edit and a nested new file by their place in the project, not by their full path', () => {
	const nested = buildApprovalCard(
		request([
			call(
				'write',
				{ path: 'new/deep/n.txt', content: 'x' },
				{ preview: { path: '/tmp/project/new/deep/n.txt', before: null, after: 'x\n' } },
			),
		]),
	)
	expect(headingOf(nested, '/tmp/project')).toEqual({
		lead: 'Create',
		chip: 'new/deep/n.txt',
		tail: '?',
	})
	expect(nested.path).toBe('/tmp/project/new/deep/n.txt')
	const outside = buildApprovalCard(
		request([
			call('edit', { path: '/home/arda/notes/Günlük.md', old_string: 'a', new_string: 'b' }),
		]),
	)
	expect(headingOf(outside, '/tmp/project').chip).toBe('~/notes/Günlük.md')
	const command = buildApprovalCard(request([call('bash', { command: 'pnpm test\npnpm lint' })]))
	expect(headingOf(command)).toEqual({ lead: 'Run', chip: 'pnpm test …', tail: '?' })
})

it('flags what the request itself says about a deletion, an overwrite and a risky command', () => {
	expect(flagsOf([call('delete', { path: 'old.txt' }, { isDestructive: true })])).toEqual([
		'This deletes old.txt.',
	])
	expect(
		flagsOf([
			call(
				'write',
				{ path: 'n.md', content: 'x' },
				{ preview: { path: '/w/n.md', before: 'old\n', after: 'x\n' } },
			),
		]),
	).toEqual(['This replaces n.md, which already exists.'])
	expect(flagsOf([call('bash', { command: 'sudo rm -rf /var/cache/x' })])).toEqual([
		'Runs with elevated rights.',
		'Looks like it deletes or overwrites files.',
	])
	// A call the agent marked destructive says so when nothing more specific is known.
	expect(flagsOf([call('bash', { command: 'make clean' }, { isDestructive: true })])).toEqual([
		'This command can change or remove files on your computer.',
	])
})

it('says nothing about an ordinary edit, a new file or a plain command', () => {
	expect(
		flagsOf([call('edit', { path: '/w/a.ts', old_string: 'a', new_string: 'b' })], '/w'),
	).toEqual([])
	expect(
		flagsOf([
			call(
				'write',
				{ path: 'n.md', content: 'x' },
				{ preview: { path: '/w/n.md', before: null, after: 'x\n' }, isDestructive: true },
			),
		]),
	).toEqual([])
	expect(flagsOf([call('bash', { command: 'npm test' })])).toEqual([])
})

it('puts a request the agent always asks about, and a path outside the folder, first', () => {
	expect(
		flagsOf(
			[
				call(
					'write',
					{ path: '.husky/pre-commit', content: 'x' },
					{
						alwaysAsk: true,
						preview: { path: '/w/.husky/pre-commit', before: null, after: 'x\n' },
					},
				),
			],
			'/w',
		),
	).toEqual(['Namzu asks about this every time, whatever you allowed before.'])
	expect(
		flagsOf(
			[
				call(
					'write',
					{ path: '../notes.txt', content: 'x' },
					{ alwaysAsk: true, preview: { path: '/notes.txt', before: null, after: 'x\n' } },
				),
			],
			'/w',
		),
	).toEqual([
		'Namzu asks about this every time, whatever you allowed before.',
		'Outside the project folder.',
	])
})

it('decides outside the project from the path and the folder alone', () => {
	expect(outsideProject('/w/src/a.ts', '/w')).toBe(false)
	expect(outsideProject('src/../a.ts', '/w')).toBe(false)
	expect(outsideProject('../a.ts', '/w')).toBe(true)
	expect(outsideProject('/etc/hosts', '/w')).toBe(true)
	expect(outsideProject('C:\\other\\a.ts', 'C:\\work')).toBe(true)
	// Nothing is claimed without a folder, or for a home-relative path.
	expect(outsideProject('/etc/hosts')).toBe(false)
	expect(outsideProject('~/notes.md', '/w')).toBe(false)
})

it('names the step a waiting request is about for the line of the turn in flight', () => {
	const label = (calls: PermissionView['calls']) => waitingLabel(request(calls))
	expect(label([call('edit', { path: '/w/session.ts', old_string: 'a', new_string: 'b' })])).toBe(
		'Waiting to edit session.ts',
	)
	expect(label([call('bash', { command: 'ls' })])).toBe('Waiting to run command')
	expect(label([call('delete', { path: 'old.txt' })])).toBe('Waiting to delete old.txt')
	expect(
		label([
			call(
				'write',
				{ path: 'n.txt', content: 'x' },
				{ preview: { path: '/w/n.txt', before: null, after: 'x\n' } },
			),
		]),
	).toBe('Waiting to create n.txt')
	expect(waitingLabel(undefined)).toBe('Waiting for your decision')
})
