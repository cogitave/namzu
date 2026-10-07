import { expect, it } from 'vitest'
import {
	PERMISSION_FEEDBACK_MAX,
	readPermissionCalls,
	readPermissionResponse,
} from './permission-protocol.js'

it('accepts the two outcomes and trims a note', () => {
	expect(readPermissionResponse({ outcome: 'approve' })).toEqual({ outcome: 'approve' })
	expect(readPermissionResponse({ outcome: 'reject' })).toEqual({ outcome: 'reject' })
	expect(readPermissionResponse({ outcome: 'reject', feedback: '  no  ' })).toEqual({
		outcome: 'reject',
		feedback: 'no',
	})
	expect(readPermissionResponse({ outcome: 'reject', feedback: '   ' })).toEqual({
		outcome: 'reject',
	})
})

it('refuses unknown outcomes, a note on approve, and a note over the limit', () => {
	for (const bad of [
		undefined,
		null,
		'approve',
		true,
		{ outcome: 'approve_all' },
		{ outcome: 'approve', feedback: 'x' },
		{ outcome: 'reject', feedback: 3 },
	])
		expect(() => readPermissionResponse(bad)).toThrow('Invalid approval')
	expect(() =>
		readPermissionResponse({
			outcome: 'reject',
			feedback: 'x'.repeat(PERMISSION_FEEDBACK_MAX + 1),
		}),
	).toThrow('under 4,000')
	expect(
		readPermissionResponse({ outcome: 'reject', feedback: 'x'.repeat(PERMISSION_FEEDBACK_MAX) }),
	).toMatchObject({ outcome: 'reject' })
})

it('keeps a well-formed preview and drops a malformed one without losing the call', () => {
	const calls = readPermissionCalls([
		{
			id: 'a',
			name: 'edit',
			input: {},
			isDestructive: false,
			preview: { path: '/p', before: null, after: 'x' },
		},
		{
			id: 'b',
			name: 'edit',
			input: {},
			isDestructive: true,
			preview: { path: '/p', before: 1, after: 'x' },
		},
		{
			id: 'c',
			name: 'edit',
			input: {},
			preview: { path: '/p', before: '', after: 'x'.repeat(1_200_000) },
		},
		{ nope: true },
	])
	expect(calls.map((call) => call.id)).toEqual(['a', 'b', 'c'])
	expect(calls[0]?.preview).toEqual({ path: '/p', before: null, after: 'x' })
	expect(calls[1]?.preview).toBeUndefined()
	expect(calls[1]?.isDestructive).toBe(true)
	expect(calls[2]?.preview).toBeUndefined()
	expect(readPermissionCalls('nope')).toEqual([])
})
