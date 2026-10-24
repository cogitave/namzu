/**
 * The answers a prompt offers beyond Yes and No, and when.
 *
 * There is no "allow every tool" answer. A session-wide answer is a permission suggestion: switch
 * edits to accept-edits, or
 * remember an allow scoped to what was asked. Each is offered only when it
 * holds for every call in the batch.
 */

import { describe, expect, it } from 'vitest'

import { permissionAnswers } from '../PermissionOverlay.js'
import type { PermissionToolCall } from '../agent.js'

const commandArguments = new Map([['bash', 'command']])
const edit: PermissionToolCall = {
	id: 'e1',
	name: 'edit',
	input: { path: 'a.ts' },
	isDestructive: false,
}
const bash = (command: string, extra: Partial<PermissionToolCall> = {}): PermissionToolCall => ({
	id: command,
	name: 'bash',
	input: { command },
	isDestructive: false,
	...extra,
})
const kinds = (calls: readonly PermissionToolCall[], options = {}) =>
	permissionAnswers(calls, { mode: 'prompt', commandArguments, ...options }).map((a) => a.kind)

describe('the accept-edits answer', () => {
	it('is offered for edits from prompt mode', () => {
		expect(kinds([edit])).toEqual(['approve', 'approve-edits', 'reject'])
		expect(kinds([edit, { ...edit, id: 'e2' }])).toEqual(['approve', 'approve-edits', 'reject'])
		expect(permissionAnswers([edit], { mode: 'prompt' })[1]?.label).toBe(
			'Yes, and switch to accept edits for this session',
		)
	})

	it.each([
		['accept-edits already on', { mode: 'accept-edits' as const }],
		['plan', { mode: 'plan' as const }],
		['a scheduled run', { batchOnly: true }],
	])('is not offered with %s', (_why, options) => {
		expect(kinds([edit], options)).toEqual(['approve', 'reject'])
	})

	it('is not offered for a write, which accept-edits mode still asks about', () => {
		// `write` is always reviewed as destructive (it may overwrite), so the
		// mode would not stop this prompt from coming back.
		expect(kinds([{ ...edit, name: 'write', isDestructive: true }])).toEqual(['approve', 'reject'])
	})

	it('is not offered beside a shell call, a destructive write or an outside path', () => {
		expect(kinds([edit, bash('ls')])).toEqual(['approve', 'reject'])
		expect(kinds([{ ...edit, isDestructive: true }])).toEqual(['approve', 'reject'])
		expect(kinds([{ ...edit, escalation: { outsidePaths: ['/etc/x'] } }])).toEqual([
			'approve',
			'reject',
		])
	})
})

describe('the remembered-allow answer', () => {
	it('is scoped to the project folder', () => {
		const answers = permissionAnswers([bash('npm test')], {
			mode: 'prompt',
			commandArguments,
			rememberWhere: '~/work/app',
		})
		expect(answers.map((a) => a.label)).toEqual([
			'Yes',
			"Yes, and don't ask again for npm test * commands in ~/work/app",
			'No, and tell Namzu what to do differently (esc)',
		])
		expect(answers[1]?.allows).toEqual([{ kind: 'prefix', tool: 'bash', prefix: 'npm test' }])
	})

	it('is offered for a fetch and an MCP tool, and only for the whole batch', () => {
		const fetch: PermissionToolCall = {
			id: 'f',
			name: 'web_fetch',
			input: { url: 'https://example.com/x' },
			isDestructive: false,
		}
		expect(kinds([fetch])).toEqual(['approve', 'approve-rule', 'reject'])
		expect(kinds([{ ...fetch, name: 'mcp__srv__tool', input: {} }])).toEqual([
			'approve',
			'approve-rule',
			'reject',
		])
		expect(kinds([fetch, bash('ls')])).toEqual(['approve', 'approve-rule', 'reject'])
		expect(kinds([fetch, { ...fetch, id: 'k', name: 'browser' }])).toEqual(['approve', 'reject'])
	})

	it('is not offered where the session cannot remember, or for a call asked every time', () => {
		expect(permissionAnswers([bash('npm test')], { mode: 'prompt' }).map((a) => a.kind)).toEqual([
			'approve',
			'reject',
		])
		expect(kinds([bash('curl x', { escalation: { sandboxEscape: true } })])).toEqual([
			'approve',
			'reject',
		])
		expect(kinds([bash('npm test', { authorization: { explicitReview: true } })])).toEqual([
			'approve',
			'reject',
		])
	})

	it('is not offered for an agent launch or a workflow, which stay Yes and No', () => {
		const agent: PermissionToolCall = {
			id: 'a',
			name: 'Agent',
			input: { description: 'x', prompt: 'y' },
			isDestructive: false,
		}
		expect(kinds([agent])).toEqual(['approve', 'reject'])
		expect(kinds([{ ...agent, name: 'workflow', input: { script: 's' } }])).toEqual([
			'approve',
			'reject',
		])
	})

	it('is not offered on the screen-sharing question', () => {
		expect(kinds([bash('npm test')], { screenConsent: true })).toEqual(['approve', 'reject'])
	})
})
