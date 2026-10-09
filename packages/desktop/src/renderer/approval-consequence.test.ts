import { expect, it } from 'vitest'
import type { PermissionView } from '../shared/protocol.js'
import { approvalConsequence, buildApprovalCard, riskyCommand } from './approval-card-model.js'

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
	expect(approvalConsequence(plain, '/work/site')).toBe(
		'Runs on your computer in /work/site. It can read and change files there.',
	)
	const risky = buildApprovalCard(request([call('bash', { command: 'rm -rf build && echo done' })]))
	expect(approvalConsequence(risky, '/work/site')).toContain('deletes or overwrites files')
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
	expect(approvalConsequence(created)).toBe('Adds a new file at /work/index.html.')
	const removed = buildApprovalCard(request([call('delete', { path: 'old.txt' })]))
	expect(approvalConsequence(removed)).toBe('Removes this file from your computer.')
})
