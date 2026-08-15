import { describe, expect, it } from 'vitest'

import type { AuditEvent } from '../audit.js'

/**
 * `AuditEvent.cost` is non-optional by design (LOG-14, ses_020 §5): "what it
 * did and what it cost" is the kernel's own sentence about itself, and an
 * audit entry that cannot say what something cost has not answered the
 * question it exists to answer. This is a compile-time guarantee, so the
 * test IS the compiler — `@ts-expect-error` fails the suite if the object
 * below ever starts compiling.
 */
describe('AuditEvent — cost is non-optional', () => {
	it('does not compile without `cost`', () => {
		// @ts-expect-error — AuditEvent.cost is non-optional; omitting it must
		// not compile.
		const incomplete: AuditEvent = {
			id: 'aud_test' as AuditEvent['id'],
			runId: 'run_test' as AuditEvent['runId'],
			seq: 1,
			timestamp: 0,
			who: { agentId: 'agent_test', tenantId: 'tnt_test' as AuditEvent['who']['tenantId'] },
			what: { action: 'tool_call' },
			outcome: 'refused',
		}

		expect(incomplete.outcome).toBe('refused')
	})

	it('compiles with every required field present, including `cost`', () => {
		const complete: AuditEvent = {
			id: 'aud_test' as AuditEvent['id'],
			runId: 'run_test' as AuditEvent['runId'],
			seq: 1,
			timestamp: 0,
			who: { agentId: 'agent_test', tenantId: 'tnt_test' as AuditEvent['who']['tenantId'] },
			what: { action: 'tool_call', tool: 'bash' },
			outcome: 'refused',
			cost: { totalCost: 0, cacheDiscount: 0, unpricedTokens: 0 },
			reason: 'denied by name',
		}

		expect(complete.cost.totalCost).toBe(0)
	})
})
