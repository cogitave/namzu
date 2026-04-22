/**
 * Current-code invariants asserted (2026-04-21, ses_006 Phase 2):
 *
 *   - `isTerminalState(state)` returns true iff state ∈ {completed,
 *     failed, canceled, rejected}.
 *   - `runStatusToA2AState(status)` is a table lookup:
 *     queued → pending; running → running; completed → completed;
 *     failed → failed; cancelled → canceled; cancelling → running;
 *     expired → failed.
 *   - `runToA2ATask(run, messages?)`:
 *     - `id` comes from `run.id`; `contextId` comes from
 *       `run.project_id ?? undefined`.
 *     - `status.timestamp` picks the first defined of
 *       `completed_at`, `started_at`, `created_at` (in that order).
 *     - `status.message` is agent-text of `run.result` if present,
 *       else of `run.last_error` if present, else undefined.
 *     - `artifacts` is present iff `run.result` is present; the single
 *       artifact carries a subset of usage + timing metadata.
 *     - `history` is mapped through `messageToA2A` only when `messages`
 *       is supplied.
 *     - Top-level `metadata` carries agent_id, agent_name, stop_reason
 *       (even if undefined).
 *   - `a2aMessageToCreateRun(agentId, params)` only sets a metadata
 *     field on `config` when the source value has the expected type
 *     (string for model/systemPrompt; number for numeric fields;
 *     'plan' | 'auto' for permissionMode). Everything else is omitted.
 */

import { describe, expect, it } from 'vitest'

import type { ISOTimestamp, RunConfig, WireRun } from '../../contracts/index.js'
import type { A2AMessage, A2AMessageSendParams, A2ATaskState } from '../../types/a2a/index.js'
import type { ProjectId, RunId } from '../../types/ids/index.js'

import {
	a2aMessageToCreateRun,
	isTerminalState,
	runStatusToA2AState,
	runToA2ATask,
} from './task.js'

const baseRun: WireRun = {
	id: 'run_1' as RunId,
	project_id: null,
	agent_id: 'coder',
	status: 'running',
	created_at: '2026-04-21T12:00:00Z' as ISOTimestamp,
	config: {} as RunConfig,
}

describe('isTerminalState', () => {
	const terminals: A2ATaskState[] = ['completed', 'failed', 'canceled', 'rejected']
	const nonTerminals: A2ATaskState[] = ['input-required', 'running', 'pending']

	it.each(terminals.map((s) => [s]))('%s is terminal', (state) => {
		expect(isTerminalState(state)).toBe(true)
	})

	it.each(nonTerminals.map((s) => [s]))('%s is not terminal', (state) => {
		expect(isTerminalState(state)).toBe(false)
	})
})

describe('runStatusToA2AState', () => {
	it.each([
		['queued', 'pending'],
		['running', 'running'],
		['completed', 'completed'],
		['failed', 'failed'],
		['cancelled', 'canceled'],
		['cancelling', 'running'],
		['expired', 'failed'],
	] as const)('%s → %s', (wire, a2a) => {
		expect(runStatusToA2AState(wire)).toBe(a2a)
	})
})

describe('runToA2ATask', () => {
	it('sets id + contextId from run.id + run.project_id', () => {
		const task = runToA2ATask({ ...baseRun, project_id: 'proj_9' as ProjectId })
		expect(task.id).toBe('run_1')
		expect(task.contextId).toBe('proj_9')
	})

	it('contextId is undefined when project_id is null', () => {
		const task = runToA2ATask(baseRun)
		expect(task.contextId).toBeUndefined()
	})

	it('timestamp prefers completed_at > started_at > created_at', () => {
		const created = '2026-04-21T10:00:00Z' as ISOTimestamp
		const started = '2026-04-21T10:05:00Z' as ISOTimestamp
		const completed = '2026-04-21T10:10:00Z' as ISOTimestamp

		expect(
			runToA2ATask({
				...baseRun,
				created_at: created,
				started_at: started,
				completed_at: completed,
			}).status.timestamp,
		).toBe(completed)
		expect(
			runToA2ATask({ ...baseRun, created_at: created, started_at: started }).status.timestamp,
		).toBe(started)
		expect(runToA2ATask({ ...baseRun, created_at: created }).status.timestamp).toBe(created)
	})

	it('status.message is the result text when result is present', () => {
		const task = runToA2ATask({ ...baseRun, status: 'completed', result: 'all done' })
		expect(task.status.message?.parts).toEqual([{ kind: 'text', text: 'all done' }])
		expect(task.status.message?.role).toBe('agent')
	})

	it('status.message falls back to last_error when result is absent', () => {
		const task = runToA2ATask({ ...baseRun, status: 'failed', last_error: 'boom' })
		expect(task.status.message?.parts).toEqual([{ kind: 'text', text: 'boom' }])
	})

	it('status.message is undefined when neither result nor last_error is set', () => {
		const task = runToA2ATask(baseRun)
		expect(task.status.message).toBeUndefined()
	})

	it('attaches an artifact iff result is present', () => {
		expect(runToA2ATask(baseRun).artifacts).toBeUndefined()

		const withResult = runToA2ATask({
			...baseRun,
			status: 'completed',
			result: 'done',
			model: 'claude-opus-4-7',
			iterations: 3,
			duration_ms: 1200,
			usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30, total_cost_usd: 0.05 },
		})
		expect(withResult.artifacts).toHaveLength(1)
		const artifact = withResult.artifacts?.[0]
		expect(artifact?.artifactId).toBe('run_1-result')
		expect(artifact?.name).toBe('Agent Response')
		expect(artifact?.parts).toEqual([{ kind: 'text', text: 'done' }])
		expect(artifact?.metadata).toMatchObject({
			model: 'claude-opus-4-7',
			iterations: 3,
			duration_ms: 1200,
			input_tokens: 10,
			output_tokens: 20,
			total_cost_usd: 0.05,
		})
	})

	it('history is undefined when messages are not supplied', () => {
		expect(runToA2ATask(baseRun).history).toBeUndefined()
	})

	it('history maps through messageToA2A for every message', () => {
		const task = runToA2ATask(baseRun, [
			{ role: 'user', content: 'hi' },
			{ role: 'assistant', content: 'ack' },
		])
		expect(task.history).toHaveLength(2)
		expect(task.history?.[0]?.role).toBe('user')
		expect(task.history?.[1]?.role).toBe('agent')
	})

	it('top-level metadata carries agent_id + stop_reason', () => {
		const task = runToA2ATask({ ...baseRun, agent_name: 'Coder', stop_reason: 'end_turn' })
		expect(task.metadata).toMatchObject({
			agent_id: 'coder',
			agent_name: 'Coder',
			stop_reason: 'end_turn',
		})
	})
})

describe('a2aMessageToCreateRun', () => {
	const baseMsg: A2AMessage = { role: 'user', parts: [{ kind: 'text', text: 'do a thing' }] }

	it('extracts input text from the message', () => {
		const params: A2AMessageSendParams = { message: baseMsg }
		const result = a2aMessageToCreateRun('agent_1', params)
		expect(result.agentId).toBe('agent_1')
		expect(result.input).toBe('do a thing')
		expect(result.config).toEqual({})
	})

	it('threads contextId from params into projectId', () => {
		const params: A2AMessageSendParams = { message: baseMsg, contextId: 'proj_2' }
		expect(a2aMessageToCreateRun('agent_1', params).projectId).toBe('proj_2')
	})

	it('only includes typed metadata fields in config', () => {
		const params: A2AMessageSendParams = {
			message: baseMsg,
			metadata: {
				model: 'opus',
				tokenBudget: 1000,
				timeoutMs: 5000,
				temperature: 0.2,
				maxResponseTokens: 2048,
				permissionMode: 'plan',
				systemPrompt: 'be terse',
			},
		}
		const config = a2aMessageToCreateRun('a', params).config
		expect(config).toEqual({
			model: 'opus',
			tokenBudget: 1000,
			timeoutMs: 5000,
			temperature: 0.2,
			maxResponseTokens: 2048,
			permissionMode: 'plan',
			systemPrompt: 'be terse',
		})
	})

	it('drops metadata fields with wrong types', () => {
		const params: A2AMessageSendParams = {
			message: baseMsg,
			metadata: {
				model: 123, // wrong type → dropped
				tokenBudget: 'big', // wrong type → dropped
				permissionMode: 'invalid', // not 'plan'|'auto' → dropped
			},
		}
		expect(a2aMessageToCreateRun('a', params).config).toEqual({})
	})

	it('accepts permissionMode only for "plan" or "auto"', () => {
		for (const mode of ['plan', 'auto'] as const) {
			const params: A2AMessageSendParams = { message: baseMsg, metadata: { permissionMode: mode } }
			expect(a2aMessageToCreateRun('a', params).config.permissionMode).toBe(mode)
		}
	})
})
