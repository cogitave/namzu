import type { ProjectId, RunEvent, RunId, SessionId, ToolUseId } from '@namzu/sdk'
import { describe, expect, it } from 'vitest'

import { toAgentEvent } from './agent.js'

const runId = 'run_x' as RunId
const sessionId = 'ses_x' as SessionId
const projectId = 'prj_x' as ProjectId
const toolUseId = 'toolu_x' as ToolUseId

// Minimal envelope fields the RunEvent union carries beyond the discriminant.
const env = { schemaVersion: 1 as const, runId, sessionId, projectId }

describe('toAgentEvent', () => {
	it('maps text_delta to a delta', () => {
		const ev = {
			type: 'text_delta',
			iteration: 0,
			messageId: 'msg_1',
			text: 'hello',
			...env,
		} as unknown as RunEvent
		expect(toAgentEvent(ev)).toEqual({ kind: 'delta', text: 'hello' })
	})

	it('maps tool_executing to tool-start with a command summary', () => {
		const ev = {
			type: 'tool_executing',
			toolUseId,
			toolName: 'bash',
			input: { command: 'ls -la /tmp' },
			...env,
		} as unknown as RunEvent
		expect(toAgentEvent(ev)).toEqual({
			kind: 'tool-start',
			toolName: 'bash',
			summary: 'ls -la /tmp',
		})
	})

	it('prefers a path field when there is no command', () => {
		const ev = {
			type: 'tool_executing',
			toolUseId,
			toolName: 'read',
			input: { file_path: '/etc/hosts' },
			...env,
		} as unknown as RunEvent
		expect(toAgentEvent(ev)).toEqual({
			kind: 'tool-start',
			toolName: 'read',
			summary: '/etc/hosts',
		})
	})

	it('maps tool_completed to tool-end and collapses whitespace', () => {
		const ev = {
			type: 'tool_completed',
			toolUseId,
			toolName: 'bash',
			result: '  multi\n  line  ',
			isError: false,
			...env,
		} as unknown as RunEvent
		expect(toAgentEvent(ev)).toEqual({
			kind: 'tool-end',
			toolName: 'bash',
			isError: false,
			summary: 'multi line',
		})
	})

	it('maps run_completed to done and run_failed to error', () => {
		expect(
			toAgentEvent({ type: 'run_completed', result: 'ok', ...env } as unknown as RunEvent),
		).toEqual({ kind: 'done' })
		expect(
			toAgentEvent({ type: 'run_failed', error: 'boom', ...env } as unknown as RunEvent),
		).toEqual({ kind: 'error', message: 'boom' })
	})

	it('returns null for events the chat surface ignores', () => {
		expect(
			toAgentEvent({
				type: 'iteration_started',
				iteration: 1,
				...env,
			} as unknown as RunEvent),
		).toBeNull()
		expect(
			toAgentEvent({
				type: 'token_usage_updated',
				...env,
			} as unknown as RunEvent),
		).toBeNull()
	})
})
