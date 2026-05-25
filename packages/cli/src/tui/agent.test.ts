import type {
	CheckpointId,
	HITLDecisionRequest,
	ProjectId,
	RunEvent,
	RunId,
	SessionId,
	ToolCallSummary,
	ToolUseId,
} from '@namzu/sdk'
import { describe, expect, it, vi } from 'vitest'

import {
	type PermissionDecision,
	type PermissionRequest,
	batchNeedsPrompt,
	makeResumeHandler,
	previewToolInput,
	toAgentEvent,
	toolEndDetail,
	toolStartDetail,
} from './agent.js'

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

	it('maps tool_completed to tool-end with a first-line summary + detail lines', () => {
		const ev = {
			type: 'tool_completed',
			toolUseId,
			toolName: 'bash',
			result: 'multi\n  line  ',
			isError: false,
			...env,
		} as unknown as RunEvent
		expect(toAgentEvent(ev)).toEqual({
			kind: 'tool-end',
			toolName: 'bash',
			isError: false,
			summary: 'multi',
			detail: ['multi', '  line'],
		})
	})

	it('maps run_completed to done and run_failed to error', () => {
		expect(
			toAgentEvent({
				type: 'run_completed',
				result: 'ok',
				...env,
			} as unknown as RunEvent),
		).toEqual({ kind: 'done' })
		expect(
			toAgentEvent({
				type: 'run_failed',
				error: 'boom',
				...env,
			} as unknown as RunEvent),
		).toEqual({ kind: 'error', message: 'boom' })
	})

	it('maps token_usage_updated to a usage event', () => {
		expect(
			toAgentEvent({
				type: 'token_usage_updated',
				usage: { totalTokens: 1234 },
				cost: { totalCost: 0.0456 },
				...env,
			} as unknown as RunEvent),
		).toEqual({ kind: 'usage', totalTokens: 1234, costUsd: 0.0456 })
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
				type: 'checkpoint_created',
				...env,
			} as unknown as RunEvent),
		).toBeNull()
	})
})

const checkpointId = 'cp_x' as CheckpointId
const tc = (over: Partial<ToolCallSummary>): ToolCallSummary => ({
	id: 'call_1',
	name: 'read',
	input: {},
	isDestructive: false,
	...over,
})
const toolReview = (toolCalls: ToolCallSummary[]): HITLDecisionRequest => ({
	type: 'tool_review',
	runId,
	checkpointId,
	toolCalls,
})

describe('batchNeedsPrompt', () => {
	it('does not prompt for read-only batches', () => {
		expect(batchNeedsPrompt([tc({ name: 'read' }), tc({ name: 'glob' })])).toBe(false)
		expect(batchNeedsPrompt([tc({ name: 'Grep' })])).toBe(false) // case-insensitive
	})

	it('prompts when any tool mutates or is flagged destructive', () => {
		expect(batchNeedsPrompt([tc({ name: 'read' }), tc({ name: 'write' })])).toBe(true)
		expect(batchNeedsPrompt([tc({ name: 'edit' })])).toBe(true)
		expect(batchNeedsPrompt([tc({ name: 'bash', isDestructive: true })])).toBe(true)
	})

	it('prompts for unknown/future tools (safe-by-default)', () => {
		expect(batchNeedsPrompt([tc({ name: 'SomeClawtoolThing' })])).toBe(true)
	})
})

describe('previewToolInput', () => {
	it('previews write content with a head + overflow note', () => {
		const content = Array.from({ length: 12 }, (_, i) => `line${i}`).join('\n')
		const preview = previewToolInput('write', { path: '/x', content })
		expect(preview?.[0]).toBe('line0')
		expect(preview?.at(-1)).toContain('+4 more lines')
	})

	it('previews edit as -old / +new diff lines', () => {
		const preview = previewToolInput('edit', {
			path: '/x',
			old_string: 'foo',
			new_string: 'bar',
		})
		expect(preview).toEqual(['- foo', '+ bar'])
	})

	it('returns undefined for non-previewable tools', () => {
		expect(previewToolInput('bash', { command: 'ls' })).toBeUndefined()
		expect(previewToolInput('read', { path: '/x' })).toBeUndefined()
	})
})

describe('makeResumeHandler', () => {
	it('auto-approves read-only batches without calling onPermission', async () => {
		const onPermission = vi.fn<(r: PermissionRequest) => Promise<PermissionDecision>>()
		const handler = makeResumeHandler({ all: false }, onPermission)
		const decision = await handler(toolReview([tc({ name: 'read' })]))
		expect(decision).toEqual({ action: 'approve_tools' })
		expect(onPermission).not.toHaveBeenCalled()
	})

	it('prompts for destructive batches and maps approve', async () => {
		const onPermission = vi.fn(async () => ({ kind: 'approve' }) as PermissionDecision)
		const handler = makeResumeHandler({ all: false }, onPermission)
		const decision = await handler(toolReview([tc({ name: 'write' })]))
		expect(onPermission).toHaveBeenCalledOnce()
		expect(decision).toEqual({ action: 'approve_tools' })
	})

	it('maps reject to reject_tools with feedback', async () => {
		const onPermission = vi.fn(
			async () => ({ kind: 'reject', feedback: 'no' }) as PermissionDecision,
		)
		const handler = makeResumeHandler({ all: false }, onPermission)
		const decision = await handler(toolReview([tc({ name: 'bash', isDestructive: true })]))
		expect(decision).toEqual({ action: 'reject_tools', feedback: 'no' })
	})

	it('approve-all flips the session flag so later batches skip the prompt', async () => {
		const approval = { all: false }
		const onPermission = vi.fn(async () => ({ kind: 'approve-all' }) as PermissionDecision)
		const handler = makeResumeHandler(approval, onPermission)
		await handler(toolReview([tc({ name: 'write' })]))
		expect(approval.all).toBe(true)
		await handler(toolReview([tc({ name: 'edit' })]))
		expect(onPermission).toHaveBeenCalledOnce() // second batch not prompted
	})

	it('auto-approves everything when no onPermission is supplied', async () => {
		const handler = makeResumeHandler({ all: false }, undefined)
		expect(await handler(toolReview([tc({ name: 'write' })]))).toEqual({
			action: 'approve_tools',
		})
	})

	it('approves plans and continues checkpoints', async () => {
		const handler = makeResumeHandler({ all: false }, vi.fn())
		expect(
			await handler({
				type: 'plan_approval',
				runId,
				checkpointId,
				plan: { planId: 'plan_x', title: 't', steps: [] },
			} as HITLDecisionRequest),
		).toEqual({ action: 'approve_plan' })
		expect(
			await handler({
				type: 'iteration_checkpoint',
				runId,
				checkpointId,
				summary: {},
			} as unknown as HITLDecisionRequest),
		).toEqual({ action: 'continue' })
	})
})

describe('toolStartDetail', () => {
	it('builds a -old/+new diff for edit', () => {
		expect(toolStartDetail('edit', { path: '/x', old_string: 'a\nb', new_string: 'a\nc' })).toEqual(
			['- a', '- b', '+ a', '+ c'],
		)
	})

	it('returns the content lines for write', () => {
		expect(toolStartDetail('write', { path: '/x', content: 'one\ntwo' })).toEqual(['one', 'two'])
	})

	it('returns undefined for non-mutating tools', () => {
		expect(toolStartDetail('bash', { command: 'ls' })).toBeUndefined()
		expect(toolStartDetail('read', { file_path: '/x' })).toBeUndefined()
	})
})

describe('toolEndDetail', () => {
	it('returns output lines for read/bash', () => {
		expect(toolEndDetail('bash', 'line1\nline2')).toEqual(['line1', 'line2'])
	})

	it('returns undefined for edit/write (diff already shown at call time)', () => {
		expect(toolEndDetail('edit', 'Updated /x')).toBeUndefined()
		expect(toolEndDetail('write', 'Wrote /x')).toBeUndefined()
	})

	it('returns undefined for single-line or empty results', () => {
		expect(toolEndDetail('bash', 'ok')).toBeUndefined()
		expect(toolEndDetail('bash', '   ')).toBeUndefined()
	})
})
