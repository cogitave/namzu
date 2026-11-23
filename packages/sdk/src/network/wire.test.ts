import { describe, expect, it } from 'vitest'
import {
	NET_PROTOCOL,
	NetDeliverRequestSchema,
	NetRequestSchema,
	PREAUTH_OPS,
	RoleSetRequestSchema,
	RosterSchema,
	sanitizeName,
	sanitizeRole,
} from './wire.js'

const deliver = {
	protocol: NET_PROTOCOL,
	op: 'net_deliver',
	id: 'm1',
	to: { sessionRef: 'abcdef' },
	from: { sessionRef: '123456', sessionName: 'calm-heron', mode: 'auto', kind: 'tui' },
	text: 'hi',
	hops: 0,
}

describe('wire schemas', () => {
	it('allows exactly two operations before membership', () => {
		expect([...PREAUTH_OPS].sort()).toEqual(['join_cancel', 'join_request', 'ping_net'])
	})

	it('refuses unknown fields, unknown ops and a sender that claims to be a person', () => {
		expect(NetDeliverRequestSchema.safeParse(deliver).success).toBe(true)
		expect(NetDeliverRequestSchema.safeParse({ ...deliver, extra: 1 }).success).toBe(false)
		expect(
			NetDeliverRequestSchema.safeParse({ ...deliver, from: { ...deliver.from, kind: 'person' } })
				.success,
		).toBe(false)
		expect(NetRequestSchema.safeParse({ protocol: NET_PROTOCOL, op: 'shell' }).success).toBe(false)
	})

	it('caps message text and role bytes', () => {
		expect(
			NetDeliverRequestSchema.safeParse({ ...deliver, text: 'x'.repeat(32 * 1024 + 1) }).success,
		).toBe(false)
		const role = {
			protocol: NET_PROTOCOL,
			op: 'role_set',
			target: { machine: true },
			role: 'x'.repeat(501),
			by: { machineName: 'a' },
			at: 1,
		}
		expect(RoleSetRequestSchema.safeParse(role).success).toBe(false)
		expect(RoleSetRequestSchema.safeParse({ ...role, role: null }).success).toBe(true)
	})

	it('never carries a path, token or conversation in a roster', () => {
		const roster = {
			machine: { id: 'a'.repeat(64), name: 'm', platform: 'linux' },
			sessions: [
				{
					ref: 'abcdef',
					name: 'n',
					folder: 'proj',
					state: 'idle',
					mode: 'auto',
					acceptsMessages: true,
					kind: 'tui',
					cwd: '/home/x',
				},
			],
		}
		expect(RosterSchema.safeParse(roster).success).toBe(false)
	})

	it('sanitises names and roles', () => {
		expect(sanitizeName('  a\u0000b\n\tc  ')).toBe('a b c')
		expect(sanitizeName('x'.repeat(100))).toHaveLength(40)
		expect(sanitizeRole('line one\nline two‮')).toBe('line one line two')
		expect(sanitizeRole('   ')).toBeUndefined()
		expect(Buffer.byteLength(sanitizeRole('é'.repeat(400)) as string)).toBeLessThanOrEqual(500)
	})
})
