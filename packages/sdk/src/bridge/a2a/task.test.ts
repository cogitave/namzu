/**
 * Current-code invariants asserted (2026-04-21, ses_006 Phase 2):
 *
 *   - `isTerminalState(state)` returns true iff state ∈ {completed,
 *     failed, canceled, rejected}.
 *   - `turnStatusToA2AState(status)` is a table lookup:
 *     queued → pending; running → running; awaiting_input → input-required;
 *     completed → completed; failed → failed; cancelled → canceled;
 *     cancelling → running; expired → failed.
 *   - `mapTurnToA2ATask(turn, messages?, options?)`:
 *     - `id` comes from `turn.turn_id`; `contextId` is `options.contextId`
 *       when given, otherwise `turn.session_id`. Never the project.
 *     - `status.timestamp` picks the first defined of
 *       `completed_at`, `started_at`, `created_at` (in that order).
 *     - `status.message` is agent-text of `turn.result` if present,
 *       else of `turn.last_error` if present, else undefined.
 *     - `artifacts` is present iff `turn.result` is present; the single
 *       artifact carries a subset of usage + timing metadata.
 *     - `history` is mapped through `messageToA2A` only when `messages`
 *       is supplied.
 *     - Top-level `metadata` carries agent_id, agent_name, stop_reason
 *       (even if undefined).
 *   - `a2aMessageToCreateTurn(agentId, params)` carries the peer's
 *     `contextId` verbatim with its `a2a`/`context` ref and an `origin`
 *     naming it, and only sets a metadata
 *     field on `config` when the source value has the expected type
 *     (string for model/systemPrompt; number for numeric fields;
 *     'plan' | 'auto' for permissionMode). Everything else is omitted.
 */

import { describe, expect, it } from 'vitest'

import type { ISOTimestamp, WireTurn } from '../../contracts/index.js'
import type { A2AMessage, A2AMessageSendParams, A2ATaskState } from '../../types/a2a/index.js'
import type { ProjectId, SessionId, TurnId } from '../../types/ids/index.js'

import {
	a2aMessageToCreateTurn,
	isTerminalState,
	mapTurnToA2ATask,
	turnStatusToA2AState,
} from './task.js'

const baseTurn: WireTurn = {
	turn_id: '37ddff8e-e13f-4e57-937f-d048fa323f5e' as TurnId,
	session_id: '0199b3a0-0000-7000-8000-0000000000b1' as SessionId,
	project_id: null,
	agent_id: 'coder',
	status: 'running',
	created_at: '2026-04-21T12:00:00Z' as ISOTimestamp,
	config: {},
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

describe('turnStatusToA2AState', () => {
	it.each([
		['queued', 'pending'],
		['running', 'running'],
		['awaiting_input', 'input-required'],
		['completed', 'completed'],
		['failed', 'failed'],
		['cancelled', 'canceled'],
		['cancelling', 'running'],
		['expired', 'failed'],
	] as const)('%s → %s', (wire, a2a) => {
		expect(turnStatusToA2AState(wire)).toBe(a2a)
	})
})

describe('mapTurnToA2ATask', () => {
	it('sets id + contextId from turn.turn_id + turn.session_id, never the project', () => {
		const task = mapTurnToA2ATask({
			...baseTurn,
			project_id: 'b27ca023-39ba-4362-b823-1fc8f4460876' as ProjectId,
		})
		expect(task.id).toBe('37ddff8e-e13f-4e57-937f-d048fa323f5e')
		expect(task.contextId).toBe('0199b3a0-0000-7000-8000-0000000000b1')
	})

	it('echoes the peer’s own context id when the host passes it', () => {
		const task = mapTurnToA2ATask(baseTurn, undefined, { contextId: 'ctx: not a uuid' })
		expect(task.contextId).toBe('ctx: not a uuid')
	})

	it('timestamp prefers completed_at > started_at > created_at', () => {
		const created = '2026-04-21T10:00:00Z' as ISOTimestamp
		const started = '2026-04-21T10:05:00Z' as ISOTimestamp
		const completed = '2026-04-21T10:10:00Z' as ISOTimestamp

		expect(
			mapTurnToA2ATask({
				...baseTurn,
				created_at: created,
				started_at: started,
				completed_at: completed,
			}).status.timestamp,
		).toBe(completed)
		expect(
			mapTurnToA2ATask({ ...baseTurn, created_at: created, started_at: started }).status.timestamp,
		).toBe(started)
		expect(mapTurnToA2ATask({ ...baseTurn, created_at: created }).status.timestamp).toBe(created)
	})

	it('status.message is the result text when result is present', () => {
		const task = mapTurnToA2ATask({ ...baseTurn, status: 'completed', result: 'all done' })
		expect(task.status.message?.parts).toEqual([{ kind: 'text', text: 'all done' }])
		expect(task.status.message?.role).toBe('agent')
	})

	it('status.message falls back to last_error when result is absent', () => {
		const task = mapTurnToA2ATask({ ...baseTurn, status: 'failed', last_error: 'boom' })
		expect(task.status.message?.parts).toEqual([{ kind: 'text', text: 'boom' }])
	})

	it('status.message is undefined when neither result nor last_error is set', () => {
		const task = mapTurnToA2ATask(baseTurn)
		expect(task.status.message).toBeUndefined()
	})

	it('attaches an artifact iff result is present', () => {
		expect(mapTurnToA2ATask(baseTurn).artifacts).toBeUndefined()

		const withResult = mapTurnToA2ATask({
			...baseTurn,
			status: 'completed',
			result: 'done',
			model: 'claude-opus-4-7',
			iterations: 3,
			duration_ms: 1200,
			usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30, total_cost_usd: 0.05 },
		})
		expect(withResult.artifacts).toHaveLength(1)
		const artifact = withResult.artifacts?.[0]
		expect(artifact?.artifactId).toBe(`${baseTurn.turn_id}-result`)
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
		expect(mapTurnToA2ATask(baseTurn).history).toBeUndefined()
	})

	it('history maps through messageToA2A for every message', () => {
		const task = mapTurnToA2ATask(baseTurn, [
			{ role: 'user', content: 'hi' },
			{ role: 'assistant', content: 'ack' },
		])
		expect(task.history).toHaveLength(2)
		expect(task.history?.[0]?.role).toBe('user')
		expect(task.history?.[1]?.role).toBe('agent')
	})

	it('top-level metadata carries agent_id + stop_reason', () => {
		const task = mapTurnToA2ATask({ ...baseTurn, agent_name: 'Coder', stop_reason: 'end_turn' })
		expect(task.metadata).toMatchObject({
			agent_id: 'coder',
			agent_name: 'Coder',
			stop_reason: 'end_turn',
		})
	})
})

describe('a2aMessageToCreateTurn', () => {
	const baseMsg: A2AMessage = { role: 'user', parts: [{ kind: 'text', text: 'do a thing' }] }

	it('extracts input text from the message', () => {
		const params: A2AMessageSendParams = { message: baseMsg }
		const result = a2aMessageToCreateTurn('agent_1', params)
		expect(result.agentId).toBe('agent_1')
		expect(result.input).toBe('do a thing')
		expect(result.config).toEqual({})
	})

	it('carries the peer’s contextId verbatim, as a ref and on the origin', () => {
		const params: A2AMessageSendParams = { message: baseMsg, contextId: 'ctx_2' }
		const request = a2aMessageToCreateTurn('agent_1', params)
		expect(request.contextId).toBe('ctx_2')
		expect(request.externalRef).toEqual({ protocol: 'a2a', kind: 'context', externalId: 'ctx_2' })
		expect(request.origin).toEqual({ protocol: 'a2a', kind: 'prompt', externalSessionId: 'ctx_2' })
		expect(request).not.toHaveProperty('projectId')
	})

	it('names no context when the peer sent none', () => {
		const request = a2aMessageToCreateTurn('agent_1', { message: baseMsg })
		expect(request).not.toHaveProperty('contextId')
		expect(request).not.toHaveProperty('externalRef')
		expect(request.origin).toEqual({ protocol: 'a2a', kind: 'prompt' })
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
		const config = a2aMessageToCreateTurn('a', params).config
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
		expect(a2aMessageToCreateTurn('a', params).config).toEqual({})
	})

	it('accepts permissionMode only for "plan" or "auto"', () => {
		for (const mode of ['plan', 'auto'] as const) {
			const params: A2AMessageSendParams = { message: baseMsg, metadata: { permissionMode: mode } }
			expect(a2aMessageToCreateTurn('a', params).config.permissionMode).toBe(mode)
		}
	})
})
