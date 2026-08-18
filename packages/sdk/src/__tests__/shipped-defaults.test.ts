import { describe, expect, it } from 'vitest'

import {
	DEFAULT_ASSUMED_CONTEXT_WINDOW,
	resolveContextWindow,
} from '../compaction/context-window.js'
import { DEFAULT_MCP_REQUEST_TIMEOUT_MS } from '../constants/mcp/index.js'
import { DEFAULT_STRUCTURED_OUTPUT_RETRIES } from '../constants/tools/index.js'
import { DEFAULT_STREAM_IDLE_TIMEOUT_MS } from '../provider/idle-timeout.js'
import { MOCK_CAPABILITIES } from '../provider/mock-register.js'
import { DEFAULT_PROVIDER_RETRY } from '../provider/retry.js'
import { DEFAULT_TOOL_CONCURRENCY, DEFAULT_TOOL_TIMEOUT_MS } from '../runtime/query/executor.js'
import { DEFAULT_MAX_TOOL_OUTPUT_CHARS } from '../runtime/query/tool-output-budget.js'

/**
 * A conformance test over the SHIPPED DEFAULTS.
 *
 * Every P0 in the hardening audit was a defect in what namzu does out of the
 * box, masked by a non-default test path: `autoApproveHandler` hid the
 * dangling-`tool_use` bug, the CLI's `tokenBudget: 1_000_000` hid the
 * compaction trigger, and `MOCK_CAPABILITIES.supportsTools: false` meant no
 * consumer could reach the tool loop at all. Each was individually tested
 * and each was individually wrong, because the tests configured their way
 * out of the default.
 *
 * So this file asserts the defaults themselves. It is deliberately boring:
 * the value of a default is that it does not drift, and a number changing
 * here should be a decision someone made, not a side effect of a refactor.
 * Every expectation carries the reason the value is what it is.
 */

describe('a run cannot hang', () => {
	it('tools have a deadline, and it is survivable rather than generous', () => {
		// bash defaulted to ONE HOUR while ignoring Stop entirely.
		expect(DEFAULT_TOOL_TIMEOUT_MS).toBe(120_000)
		expect(DEFAULT_TOOL_TIMEOUT_MS).toBeLessThanOrEqual(5 * 60_000)
	})

	it('MCP round trips have a deadline', () => {
		// stdio — the default transport for local servers — armed no timer at
		// all, so a wedged server hung the run with no error and no run_failed.
		expect(DEFAULT_MCP_REQUEST_TIMEOUT_MS).toBeGreaterThan(0)
		expect(DEFAULT_MCP_REQUEST_TIMEOUT_MS).toBeLessThanOrEqual(60_000)
	})

	it('provider streams have a finite silence bound', () => {
		// A request can open successfully and then stop producing bytes, so the
		// whole-request timeout and the between-iteration run timeout do not see it.
		expect(DEFAULT_STREAM_IDLE_TIMEOUT_MS).toBeGreaterThan(0)
		expect(DEFAULT_STREAM_IDLE_TIMEOUT_MS).toBeLessThanOrEqual(5 * 60_000)
	})

	it('tool fan-out is bounded', () => {
		// `Promise.all` over an unbounded batch: fifty parallel reads opened
		// fifty handles and fifty activity records at once.
		expect(DEFAULT_TOOL_CONCURRENCY).toBeGreaterThan(0)
		expect(DEFAULT_TOOL_CONCURRENCY).toBeLessThanOrEqual(16)
	})
})

describe('a run cannot be killed by one bad response', () => {
	it('transient provider failures are retried by default', () => {
		// A single 429 or 503 used to terminate a run outright.
		expect(DEFAULT_PROVIDER_RETRY.maxRetries).toBeGreaterThan(0)
	})

	it('backoff is bounded on both ends', () => {
		expect(DEFAULT_PROVIDER_RETRY.initialDelayMs).toBeGreaterThan(0)
		expect(DEFAULT_PROVIDER_RETRY.maxDelayMs).toBeGreaterThan(DEFAULT_PROVIDER_RETRY.initialDelayMs)
		// A server asking for 15 minutes must not silently park an
		// interactive run for 15 minutes.
		expect(DEFAULT_PROVIDER_RETRY.maxRetryAfterMs).toBeLessThanOrEqual(120_000)
	})
})

describe('a run cannot blow its own context', () => {
	it('tool output is capped, and the cap is a fraction of a small window', () => {
		// `read` returned whole files, `bash` allowed a 100 MB buffer: a 2 MB
		// lockfile became ~500k tokens in one tool_result.
		expect(DEFAULT_MAX_TOOL_OUTPUT_CHARS).toBeGreaterThan(0)
		// ~4 chars/token; one result must not be able to eat a fifth of a
		// 200k window.
		expect(DEFAULT_MAX_TOOL_OUTPUT_CHARS / 4).toBeLessThan(200_000 / 5)
	})

	it('compaction always resolves a real window, never a spend budget', () => {
		// The trigger divided by `runConfig.tokenBudget` — a cumulative spend
		// cap — whenever `contextWindowTokens` was absent, which was always.
		for (const model of [undefined, '', 'totally-unknown-model', 'claude-opus-5', 'gpt-4']) {
			const resolved = resolveContextWindow(undefined, model)
			expect(resolved.tokens).toBeGreaterThan(0)
			expect(resolved.source).not.toBe('config')
		}
	})

	it('the unknown-model fallback is conservative, not optimistic', () => {
		// Under-estimating costs a summarization pass. Over-estimating kills
		// the run on a provider context-length error with nothing recoverable.
		expect(DEFAULT_ASSUMED_CONTEXT_WINDOW).toBeLessThanOrEqual(200_000)
	})
})

describe('a run cannot loop on a demand the model will not meet', () => {
	it('structured-output re-prompts are bounded well below the iteration cap', () => {
		expect(DEFAULT_STRUCTURED_OUTPUT_RETRIES).toBeGreaterThan(0)
		// The shipped `maxIterations` default is 200; this must fail fast.
		expect(DEFAULT_STRUCTURED_OUTPUT_RETRIES).toBeLessThan(10)
	})
})

describe('the shipped test model can exercise the tool loop', () => {
	it('declares tool support', () => {
		// `supportsTools: false` made capability negotiation strip the tool
		// surface before a request was built, so no consumer could test that
		// the loop calls their tool — and namzu hand-rolled eight fakes.
		expect(MOCK_CAPABILITIES.supportsTools).toBe(true)
		expect(MOCK_CAPABILITIES.supportsFunctionCalling).toBe(true)
	})
})
