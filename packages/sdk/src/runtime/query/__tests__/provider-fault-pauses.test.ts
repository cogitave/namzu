import { describe, expect, it } from 'vitest'

import { ToolRegistry } from '../../../registry/index.js'
import { ProviderError } from '../../../types/provider/errors.js'
import {
	generateProjectId,
	generateSessionId,
	generateTenantId,
	generateThreadId,
} from '../../../utils/id.js'
import { drainQuery } from '../index.js'

/**
 * A transient provider fault that survived every retry is not the same
 * thing as a bad API key, and the run settles differently for a reason:
 * one can be resumed from its checkpoint and the other cannot.
 *
 * The stream turn flattened the driver's classified error to a message
 * and threw a fresh one, whose default for `provider_error` is
 * not-retryable — so a 429 settled the run FAILED and the documented
 * pause never happened. `toPlatformError` already projects the right
 * shape; it was simply never handed one.
 *
 * The asymmetry was visible in the codebase: the same fault raised
 * inside the compaction verifier propagates untouched and DOES pause, so
 * identical faults settled oppositely depending on whether compaction
 * happened to run that iteration.
 */

/**
 * A driver that fails the way a real one does: with a CLASSIFIED error.
 * The scripted mock throws a plain `Error`, which is the shape this
 * defect is invisible under — the classification is exactly what was
 * being lost.
 */
function failingProvider(code: 'rate_limit' | 'auth', status: number) {
	return {
		id: 'test',
		name: 'Test',
		capabilities: {},
		// biome-ignore lint/correctness/useYield: it fails before producing anything
		async *chatStream() {
			throw new ProviderError({
				code,
				message: `the provider said ${status}`,
				providerId: 'test',
				status,
			})
		},
	}
}

type Failure = { retryable?: boolean; details?: unknown; code?: string }

async function runAgainst(code: 'rate_limit' | 'auth', status: number) {
	// The classification rides the `run_failed` EVENT, which is where a
	// host reads it; the settled Run carries only the message.
	let failure: Failure | undefined
	await drainQuery(
		{
			provider: failingProvider(code, status),
			tools: new ToolRegistry(),
			agentId: 'a',
			agentName: 'A',
			messages: [{ role: 'user', content: 'go' }],
			workingDirectory: process.cwd(),
			runConfig: { model: 'mock', tokenBudget: 100_000, timeoutMs: 30_000, maxIterations: 2 },
			projectId: generateProjectId(),
			sessionId: generateSessionId(),
			threadId: generateThreadId(),
			tenantId: generateTenantId(),
			retry: false,
		} as never,
		(event) => {
			if (event.type === 'run_failed') failure = (event as { failure?: Failure }).failure
		},
	).catch(() => undefined)

	return { failure }
}

describe('a provider fault that survives the retries', () => {
	it('keeps the classification the driver produced', async () => {
		const settled = await runAgainst('rate_limit', 429)

		// Without this the run cannot tell a 429 from a bad key, and the
		// documented pause-and-resume never fires.
		expect(settled.failure?.retryable).toBe(true)
		expect(JSON.stringify(settled.failure?.details)).toContain('429')
	})

	it('does not report a permanent fault as retryable', async () => {
		// Pausing on a permanent error would invite a resume that cannot
		// work, which is worse than reporting the failure.
		expect((await runAgainst('auth', 401)).failure?.retryable).toBe(false)
	})

	it('tells the two apart at the run boundary', async () => {
		const transient = await runAgainst('rate_limit', 429)
		const permanent = await runAgainst('auth', 401)

		expect(transient.failure?.retryable).not.toBe(permanent.failure?.retryable)
	})
})
