import { describe, expect, it } from 'vitest'
import { generateMessageId, generateTurnId } from '../../utils/id.js'
import {
	HarnessBindingSchema,
	HarnessEventSchema,
	HarnessJournalTransitionSchema,
	HarnessReviewRequestSchema,
	harnessSnapshot,
} from './schema.js'

const binding = {
	v: 1,
	engineId: 'external',
	profileRef: 'opaque-host-profile',
	nativeSessionId: 'opaque-native-session',
	cwd: 'C:\\owned\\project',
	initialModel: 'native-model',
}
const native = { nativeSessionId: binding.nativeSessionId, nativeTurnId: 'opaque-native-turn' }
describe('closed external harness port schemas', () => {
	it('accepts native opaque identities, rejects unrecognized credential/raw wire fields and controls', () => {
		expect(HarnessBindingSchema.parse(binding)).toEqual(binding)
		expect(HarnessBindingSchema.safeParse({ ...binding, token: 'must-not-persist' }).success).toBe(
			false,
		)
		expect(
			HarnessBindingSchema.safeParse({ ...binding, nativeSessionId: 'line\nbreak' }).success,
		).toBe(false)
		expect(
			HarnessEventSchema.safeParse({
				kind: 'reasoning',
				...native,
				nativeItemId: 'message',
				blockId: 'block',
				status: 'completed',
				text: 'public summary',
				signature: 'private',
			}).success,
		).toBe(false)
	})
	it('refuses unknown decision kinds, nonfinite JSON, cycles and excessive nesting', () => {
		const request = {
			...native,
			requestId: 'request',
			kind: 'tool',
			title: 'Tool',
			input: { value: 1 },
			decisions: ['approve-once'],
		}
		expect(HarnessReviewRequestSchema.parse(request)).toEqual(request)
		expect(
			HarnessReviewRequestSchema.safeParse({ ...request, decisions: ['approve-always'] }).success,
		).toBe(false)
		expect(
			HarnessReviewRequestSchema.safeParse({ ...request, input: Number.POSITIVE_INFINITY }).success,
		).toBe(false)
		const cycle: Record<string, unknown> = {}
		cycle.self = cycle
		expect(HarnessReviewRequestSchema.safeParse({ ...request, input: cycle }).success).toBe(false)
		let deep: unknown = null
		for (let i = 0; i < 40; i++) deep = { next: deep }
		expect(HarnessReviewRequestSchema.safeParse({ ...request, input: deep }).success).toBe(false)
	})
	it('records selected native model/mode/effort while rejecting invalid Namzu turn and prompt identities', () => {
		const value = {
			kind: 'dispatch-prepared',
			operationId: 'owned-operation',
			turnId: generateTurnId(),
			promptId: generateMessageId(),
			digest: 'a'.repeat(64),
			model: 'native-model',
			permissionMode: 'plan',
			effort: 'ultra',
		}
		expect(HarnessJournalTransitionSchema.parse(value)).toEqual(value)
		expect(
			HarnessJournalTransitionSchema.safeParse({ ...value, turnId: native.nativeTurnId }).success,
		).toBe(false)
		expect(
			HarnessJournalTransitionSchema.safeParse({ ...value, permissionMode: 'bypass' }).success,
		).toBe(false)
	})
	it('clones and deeply freezes captured requests before asynchronous host work', () => {
		const original = { command: 'original' }
		const input = { values: [original] }
		const copy = harnessSnapshot(input)
		original.command = 'altered'
		expect(copy.values[0]?.command).toBe('original')
		expect(Object.isFrozen(copy)).toBe(true)
		expect(Object.isFrozen(copy.values[0])).toBe(true)
	})
})
