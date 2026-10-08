import { describe, expect, it } from 'vitest'
import {
	codexItemEvents,
	codexPermissionConfig,
	codexTerminalEvent,
	parseCodexModels,
} from './codex-protocol.js'

const turn = { nativeSessionId: 'native/thread', nativeTurnId: 'native/turn' }

describe('Codex external protocol projection', () => {
	it('uses actual model identities/default/efforts, excluding hidden and duplicate rows', () => {
		expect(
			parseCodexModels([
				{ id: 'public-row', model: 'native-model', displayName: 'Native model' },
				{
					id: 'default-row',
					model: 'native-default',
					isDefault: true,
					supportedReasoningEfforts: [{ reasoningEffort: 'high' }, { reasoningEffort: 'invented' }],
					defaultReasoningEffort: 'high',
				},
				{ model: 'native-model' },
				{ model: 'secret-model', hidden: true },
				{},
			]),
		).toEqual([
			{
				id: 'native-default',
				default: true,
				current: true,
				label: 'native-default',
				effortLevels: ['high'],
				defaultEffort: 'high',
			},
			{ id: 'native-model', label: 'Native model', effortLevels: [], defaultEffort: undefined },
		])
	})
	it('writes display names the way the Codex app does and flags the default row', () => {
		const labels: [string, string][] = [
			['GPT-5.6-Sol', 'GPT-5.6 Sol'],
			['GPT-6.1-Sol', 'GPT-6.1 Sol'],
			['GPT-6-Astra', 'GPT-6 Astra'],
			['GPT-5.6 Sol', 'GPT-5.6 Sol'],
			['gpt-5.5', 'gpt-5.5'],
			['GPT-5.6-Codex-Max', 'GPT-5.6-Codex-Max'],
			['o3-mini', 'o3 mini'],
			['Native model', 'Native model'],
		]
		const rows = parseCodexModels(
			labels.map(([displayName], index) => ({
				model: `m${index}`,
				displayName,
				...(index === 2 ? { isDefault: true } : {}),
			})),
		)
		expect(rows.map((row) => row.label)).toEqual([
			'GPT-6 Astra',
			...labels.filter((_, index) => index !== 2).map(([, label]) => label),
		])
		expect(rows.map((row) => row.id)).toEqual(['m2', 'm0', 'm1', 'm3', 'm4', 'm5', 'm6', 'm7'])
		expect(rows.filter((row) => 'default' in row)).toEqual([
			expect.objectContaining({ id: 'm2', default: true }),
		])
	})
	it('keeps Ask first and planning read-only, with explicit workspace editing/full access', () => {
		expect(codexPermissionConfig('prompt', '/workspace')).toEqual({
			approvalPolicy: 'untrusted',
			sandboxPolicy: { type: 'readOnly', networkAccess: false },
		})
		expect(codexPermissionConfig('plan', '/workspace')).toEqual({
			approvalPolicy: 'never',
			sandboxPolicy: { type: 'readOnly', networkAccess: false },
		})
		expect(codexPermissionConfig('accept-edits', '/workspace')).toMatchObject({
			approvalPolicy: 'untrusted',
			sandboxPolicy: {
				type: 'workspaceWrite',
				writableRoots: ['/workspace'],
				networkAccess: false,
			},
		})
		expect(codexPermissionConfig('auto', '/workspace')).toEqual({
			approvalPolicy: 'on-request',
			sandboxPolicy: { type: 'dangerFullAccess' },
		})
	})
	it('retains native item identity and final text phase instead of creating a second message', () => {
		const item = {
			type: 'agentMessage',
			id: 'native/item',
			text: 'Final answer',
			phase: 'final_answer',
		}
		expect(codexItemEvents(turn, item, false)).toEqual([
			{ ...turn, nativeItemId: 'native/item', kind: 'message-started' },
		])
		expect(codexItemEvents(turn, item, true)).toEqual([
			{
				...turn,
				nativeItemId: 'native/item',
				kind: 'message-completed',
				content: 'Final answer',
				parts: [{ id: 'native/item', text: 'Final answer', phase: 'final_answer' }],
				stopReason: 'end_turn',
			},
		])
	})
	it('publishes public reasoning summaries without native reasoning content/replay', () => {
		expect(
			codexItemEvents(
				turn,
				{
					type: 'reasoning',
					id: 'r',
					summary: ['Public summary'],
					content: ['private native reasoning'],
					encrypted: 'private replay',
				},
				true,
			),
		).toEqual([
			{
				...turn,
				nativeItemId: 'r',
				kind: 'reasoning',
				blockId: 'r:0',
				status: 'completed',
				text: 'Public summary',
			},
		])
	})
	it('keeps interruption separate from successful completion and safe failure reporting', () => {
		expect(codexTerminalEvent(turn, { status: 'interrupted' })).toEqual({
			...turn,
			kind: 'turn-completed',
			status: 'cancelled',
		})
		expect(
			codexTerminalEvent(turn, {
				status: 'failed',
				error: { message: 'secret-key-in-native-diagnostic' },
			}),
		).toEqual({
			...turn,
			kind: 'turn-completed',
			status: 'failed',
			error: { code: 'codex-turn-failed', message: 'Codex could not complete this turn.' },
		})
		expect(codexTerminalEvent(turn, { status: 'inProgress' })).toBeUndefined()
	})
})
