import { describe, expect, expectTypeOf, it } from 'vitest'
import type { z } from 'zod'
import { zodToJsonSchema } from 'zod-to-json-schema'

import * as publicRuntime from '../../../index.js'
import type { TurnStatus } from '../../../types/session/turn.js'
import { generateMessageId, generateSessionId, generateTurnId } from '../../../utils/id.js'
import {
	type CreateEphemeralSessionRequest,
	CreateEphemeralSessionSchema,
	type CreateTurnRequest,
	CreateTurnSchema,
	SessionIdSchema,
	type SessionStreamEventType,
	TURN_STATUS_TO_WIRE,
	TURN_STREAM_EVENT_TYPES,
	type TurnConfigSchema,
	TurnIdSchema,
	type TurnStreamEventType,
	TurnStreamEventTypeSchema,
	WIRE_TURN_STATUSES,
	type WireTurnConfig,
	type WireTurnStatus,
	WireTurnStatusSchema,
	toWireTurnStatus,
} from '../index.js'

// Every domain status, spelled as a `Record` so adding a member to
// `TurnStatus` without adding it here is a type error: the table below is
// total over the union by construction, not by someone remembering.
const EXPECTED: Record<TurnStatus, WireTurnStatus> = {
	queued: 'queued',
	running: 'running',
	awaiting_hitl: 'awaiting_input',
	awaiting_hitl_resolution: 'awaiting_input',
	awaiting_subsession: 'running',
	succeeded: 'completed',
	failed: 'failed',
	cancelled: 'cancelled',
}
const DOMAIN_STATUSES = Object.keys(EXPECTED) as TurnStatus[]

describe('toWireTurnStatus', () => {
	it.each(DOMAIN_STATUSES)('maps %s onto the wire', (status) => {
		expect(toWireTurnStatus(status)).toBe(EXPECTED[status])
		expect(WIRE_TURN_STATUSES).toContain(toWireTurnStatus(status))
	})

	it('is total over TurnStatus and nothing else', () => {
		expect(Object.keys(TURN_STATUS_TO_WIRE).sort()).toEqual([...DOMAIN_STATUSES].sort())
		expect(TURN_STATUS_TO_WIRE).toEqual(EXPECTED)
	})

	it('tells a client a turn waiting on a person is awaiting input, not running', () => {
		expect(toWireTurnStatus('awaiting_hitl')).toBe('awaiting_input')
		expect(toWireTurnStatus('awaiting_hitl_resolution')).toBe('awaiting_input')
		// A delegated turn settles by itself when its child does.
		expect(toWireTurnStatus('awaiting_subsession')).toBe('running')
	})

	it('leaves only the host-set statuses unreachable from the domain', () => {
		const reached = new Set(DOMAIN_STATUSES.map(toWireTurnStatus))
		const unreached = WIRE_TURN_STATUSES.filter((status) => !reached.has(status))
		expect(unreached).toEqual(['cancelling', 'expired'])
	})

	it('throws on a status outside the union instead of returning undefined', () => {
		expect(() => toWireTurnStatus('paused' as TurnStatus)).toThrow(/Unmapped turn status: paused/)
		expect(() => toWireTurnStatus('toString' as TurnStatus)).toThrow(/Unmapped turn status/)
	})

	it('cannot be mutated', () => {
		expect(Object.isFrozen(TURN_STATUS_TO_WIRE)).toBe(true)
	})
})

describe('WireTurnStatus', () => {
	it('lists every member once, awaiting_input included', () => {
		expectTypeOf<(typeof WIRE_TURN_STATUSES)[number]>().toEqualTypeOf<WireTurnStatus>()
		expect(new Set(WIRE_TURN_STATUSES).size).toBe(WIRE_TURN_STATUSES.length)
		expect(WIRE_TURN_STATUSES).toContain('awaiting_input')
	})

	it('has a schema that accepts exactly its members', () => {
		expectTypeOf<z.infer<typeof WireTurnStatusSchema>>().toEqualTypeOf<WireTurnStatus>()
		for (const status of WIRE_TURN_STATUSES) {
			expect(WireTurnStatusSchema.parse(status)).toBe(status)
		}
		expect(WireTurnStatusSchema.safeParse('succeeded').success).toBe(false)
		expect(WireTurnStatusSchema.safeParse('awaiting_hitl').success).toBe(false)
	})
})

describe('session stream events', () => {
	it('names the turn lifecycle turn.*', () => {
		expect(TURN_STREAM_EVENT_TYPES).toEqual([
			'turn.started',
			'turn.completed',
			'turn.failed',
			'turn.cancelled',
			'turn.paused',
			'turn.resuming',
		])
		expectTypeOf<TurnStreamEventType>().toMatchTypeOf<SessionStreamEventType>()
		expectTypeOf<z.infer<typeof TurnStreamEventTypeSchema>>().toEqualTypeOf<TurnStreamEventType>()
	})

	it('carries no run.* event', () => {
		expectTypeOf<Extract<SessionStreamEventType, `run.${string}`>>().toBeNever()
		expect(TurnStreamEventTypeSchema.safeParse('run.started').success).toBe(false)
	})
})

describe('id schemas', () => {
	it('accept the ids the SDK mints', () => {
		expect(SessionIdSchema.parse(generateSessionId())).toBeTypeOf('string')
		expect(TurnIdSchema.parse(generateTurnId())).toBeTypeOf('string')
	})

	it('refuse what is not an id', () => {
		expect(SessionIdSchema.safeParse('session-1').success).toBe(false)
		expect(TurnIdSchema.safeParse('').success).toBe(false)
	})

	it('keep their spelling constraint in JSON Schema', () => {
		for (const schema of [SessionIdSchema, TurnIdSchema]) {
			const json = zodToJsonSchema(schema) as { type?: string; pattern?: string }
			expect(json.type).toBe('string')
			expect(json.pattern).toBeTypeOf('string')
			expect(new RegExp(json.pattern as string).test(generateMessageId())).toBe(true)
		}
	})
})

describe('CreateTurnSchema', () => {
	it('validates exactly CreateTurnRequest', () => {
		expectTypeOf<z.infer<typeof CreateTurnSchema>>().toEqualTypeOf<CreateTurnRequest>()
		expectTypeOf<z.infer<typeof TurnConfigSchema>>().toEqualTypeOf<WireTurnConfig>()
	})

	it('accepts a turn with a message and a config', () => {
		const request = {
			message: 'summarize the diff',
			config: { model: 'm', permissionMode: 'plan' },
			env: { A: '1' },
			stream: true,
		}
		expect(CreateTurnSchema.parse(request)).toEqual(request)
		expect(CreateTurnSchema.parse({ message: 'hi', config: {} })).toEqual({
			message: 'hi',
			config: {},
		})
	})

	it('requires a non-empty message', () => {
		expect(CreateTurnSchema.safeParse({ config: {} }).success).toBe(false)
		const empty = CreateTurnSchema.safeParse({ message: '', config: {} })
		expect(empty.success).toBe(false)
		expect(empty.error?.issues[0]?.message).toBe('message is required')
	})

	it('refuses an agent_id: the session fixed its agent when it started', () => {
		expect(CreateTurnSchema.safeParse({ agent_id: 'a', message: 'hi', config: {} }).success).toBe(
			false,
		)
	})

	it('refuses unknown config keys and out-of-range values', () => {
		expect(CreateTurnSchema.safeParse({ message: 'hi', config: { nope: 1 } }).success).toBe(false)
		expect(CreateTurnSchema.safeParse({ message: 'hi', config: { temperature: 3 } }).success).toBe(
			false,
		)
		expect(
			CreateTurnSchema.safeParse({ message: 'hi', config: { timeoutMs: 3_600_001 } }).success,
		).toBe(false)
		expect(
			CreateTurnSchema.safeParse({ message: 'hi', config: { permissionMode: 'yolo' } }).success,
		).toBe(false)
	})
})

describe('CreateEphemeralSessionSchema', () => {
	it('validates exactly CreateEphemeralSessionRequest', () => {
		expectTypeOf<
			z.infer<typeof CreateEphemeralSessionSchema>
		>().toEqualTypeOf<CreateEphemeralSessionRequest>()
	})

	it('accepts an agent, a message and a config', () => {
		const request = { agent_id: 'coder', message: 'hi', config: { tokenBudget: 1000 } }
		expect(CreateEphemeralSessionSchema.parse(request)).toEqual(request)
	})

	it('requires the agent and the message', () => {
		expect(CreateEphemeralSessionSchema.safeParse({ message: 'hi', config: {} }).success).toBe(
			false,
		)
		expect(CreateEphemeralSessionSchema.safeParse({ agent_id: 'a', config: {} }).success).toBe(
			false,
		)
		expect(
			CreateEphemeralSessionSchema.safeParse({ agent_id: 'a', message: 'hi', config: {}, x: 1 })
				.success,
		).toBe(false)
	})
})

describe('package root', () => {
	it('exports the session wire contracts', () => {
		expect(publicRuntime.toWireTurnStatus).toBe(toWireTurnStatus)
		expect(publicRuntime.CreateTurnSchema).toBe(CreateTurnSchema)
		expect(publicRuntime.CreateEphemeralSessionSchema).toBe(CreateEphemeralSessionSchema)
		expect(publicRuntime.WIRE_TURN_STATUSES).toBe(WIRE_TURN_STATUSES)
		expect(publicRuntime.TURN_STREAM_EVENT_TYPES).toBe(TURN_STREAM_EVENT_TYPES)
	})
})
