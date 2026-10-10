import { expect, it } from 'vitest'
import type { PermissionView } from '../shared/protocol.js'
import {
	approvalConsequence,
	approvalConsequenceTitle,
	buildApprovalCard,
	riskyCommand,
} from './approval-card-model.js'

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

it('says where a command runs and what it can change, and warns on one that deletes', () => {
	const plain = buildApprovalCard(request([call('bash', { command: 'ls' })]))
	expect(approvalConsequence(plain, '/work/site', 'Site')).toBe(
		'Runs in Site. It can read and change files there.',
	)
	// Without a name the folder is shortened, never printed whole.
	expect(approvalConsequence(plain, '/home/arda/workspaces/site')).toBe(
		'Runs in ~/workspaces/site. It can read and change files there.',
	)
	const risky = buildApprovalCard(request([call('bash', { command: 'rm -rf build && echo done' })]))
	expect(approvalConsequence(risky, '/work/site', 'Site')).toContain('deletes or overwrites files')
	expect(approvalConsequence(plain)).toBe(
		'Runs on your computer. It can read and change files there.',
	)
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
})

it('states the consequence of a file change and a deletion', () => {
	const created = buildApprovalCard(
		request([
			call(
				'write',
				{ path: 'index.html', content: 'x' },
				{ preview: { path: '/work/index.html', before: null, after: 'x\n' } },
			),
		]),
	)
	expect(approvalConsequence(created, '/work')).toBe('Adds a new file, index.html.')
	expect(approvalConsequenceTitle(created, '/work')).toBe('/work/index.html')
	const removed = buildApprovalCard(request([call('delete', { path: 'old.txt' })]))
	expect(approvalConsequence(removed)).toBe('Removes this file from your computer.')
})

it('names an edit and a nested new file by their place in the project, not by their full path', () => {
	const nested = buildApprovalCard(
		request([
			call(
				'write',
				{ path: 'new/deep/n.txt', content: 'x' },
				{
					preview: {
						path: '/tmp/project/new/deep/n.txt',
						before: null,
						after: 'x\n',
					},
				},
			),
		]),
	)
	expect(approvalConsequence(nested, '/tmp/project')).toBe('Adds a new file, new/deep/n.txt.')
	expect(approvalConsequenceTitle(nested, '/tmp/project')).toBe('/tmp/project/new/deep/n.txt')
	const edited = buildApprovalCard(
		request([
			call('edit', {
				path: '/tmp/project/a.ts',
				old_string: 'a',
				new_string: 'b',
			}),
		]),
	)
	expect(approvalConsequence(edited, '/tmp/project')).toBe('Changes a.ts.')
	const outside = buildApprovalCard(
		request([
			call('edit', {
				path: '/home/arda/notes/Günlük.md',
				old_string: 'a',
				new_string: 'b',
			}),
		]),
	)
	expect(approvalConsequence(outside, '/tmp/project')).toBe('Changes ~/notes/Günlük.md.')
})
