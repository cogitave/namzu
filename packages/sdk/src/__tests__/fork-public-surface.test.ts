import { describe, expect, it } from 'vitest'
import {
	CheckpointManager,
	MutationNotApplicableError,
	listCheckpoints,
	prepareForkState,
} from '../index.js'
import type { CheckpointListEntry, Mutation, Turn, TurnForkOrigin } from '../index.js'

describe('the fork primitive — root public surface', () => {
	it('exposes runtime values at the package root', () => {
		expect(typeof prepareForkState).toBe('function')
		expect(typeof listCheckpoints).toBe('function')
		expect(typeof CheckpointManager).toBe('function')
		expect(typeof MutationNotApplicableError).toBe('function')
	})

	it('MutationNotApplicableError is a throwable Error subclass with availableToolCallIds', () => {
		const err = new MutationNotApplicableError('nope', ['call_x', 'call_y'] as never)
		expect(err).toBeInstanceOf(Error)
		expect(err).toBeInstanceOf(MutationNotApplicableError)
		expect(err.name).toBe('MutationNotApplicableError')
		expect(err.availableToolCallIds).toEqual(['call_x', 'call_y'])
	})

	// Type-only checks — if these expressions compile, the type surface is
	// correctly flowing through public-types.ts.
	it('exposes fork types (compile-time check)', () => {
		const mutation: Mutation = {
			type: 'injectToolResponse',
			toolCallId: 'call_a' as never,
			response: { success: true, output: '' },
		}
		const entry: CheckpointListEntry = {
			id: 'f496fad2-a721-4bb9-9a40-b959b0f3ecf8' as never,
			sessionId: '5b2f0c1d-7e3a-4c9b-8f10-2a3b4c5d6e7f' as never,
			turnId: 'f4e0af37-43f7-48fd-82b0-f1b1c68881d3' as never,
			iteration: 0,
			createdAt: 0,
			throughSeq: 1,
		}
		const origin: TurnForkOrigin = {
			sessionId: '5b2f0c1d-7e3a-4c9b-8f10-2a3b4c5d6e7f' as never,
			turnId: '773652d8-a3bf-4154-b92c-322af6d773e4' as never,
			checkpointId: 'f496fad2-a721-4bb9-9a40-b959b0f3ecf8' as never,
		}
		const turn: Pick<Turn, 'forkedFrom'> = { forkedFrom: origin }
		expect(mutation.type).toBe('injectToolResponse')
		expect(entry.iteration).toBe(0)
		expect(turn.forkedFrom?.turnId).toBe('773652d8-a3bf-4154-b92c-322af6d773e4')
	})
})
