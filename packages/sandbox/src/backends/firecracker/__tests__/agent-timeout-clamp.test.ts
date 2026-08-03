/**
 * `resolveTimeoutMs` is the guest agent's only guard against a
 * caller-requested `timeoutMs` that has no schema ceiling upstream (it
 * traces back to the bash tool's model-authored `timeout` argument — see
 * `packages/sdk/src/tools/builtins/bash.ts`). A request above the cap must
 * be refused (the sibling `worker/server.js` answers `invalid_timeout` on
 * response), not silently shortened — a caller that asked for more and got
 * less without being told would believe its process was protected for the
 * duration it actually asked for.
 *
 * Pure-function test, no socket/process involved, so it runs on every
 * platform (unlike `backend.test.ts` / `transport.test.ts`, which spawn
 * `/bin/sh` and skip on Windows).
 */

import { createRequire } from 'node:module'

import { describe, expect, it } from 'vitest'

const require_ = createRequire(import.meta.url)

interface AgentModule {
	resolveTimeoutMs(rawTimeoutMs: unknown): number
}

const agent = require_('../../../../agent/agent.cjs') as AgentModule

describe('agent.cjs resolveTimeoutMs', () => {
	it('passes through a caller value within the cap', () => {
		expect(agent.resolveTimeoutMs(10_000)).toBe(10_000)
	})

	it('falls back to the default for an omitted value', () => {
		expect(agent.resolveTimeoutMs(undefined)).toBe(5 * 60 * 1000)
	})

	it('refuses a request far above the cap instead of honoring or silently shortening it', () => {
		expect(() => agent.resolveTimeoutMs(Number.MAX_SAFE_INTEGER)).toThrow(/timeoutMs/)
		expect(() => agent.resolveTimeoutMs(10 ** 12)).toThrow(/timeoutMs/)
	})

	it('refuses a non-finite or non-positive value', () => {
		expect(() => agent.resolveTimeoutMs(0)).toThrow(/timeoutMs/)
		expect(() => agent.resolveTimeoutMs(-1)).toThrow(/timeoutMs/)
		expect(() => agent.resolveTimeoutMs(Number.NaN)).toThrow(/timeoutMs/)
		expect(() => agent.resolveTimeoutMs(Number.POSITIVE_INFINITY)).toThrow(/timeoutMs/)
	})
})
