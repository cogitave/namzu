/**
 * Current-code invariants asserted (2026-07-12, ses_017):
 *
 *   - (ses_017 fix) The deny plane is re-applied to the FINAL tool input, at the
 *     dispatch point, AFTER every `pre_tool_use` plugin hook has run. A hook that
 *     rewrites a gate-allowed input into one a deny rule matches does NOT get the
 *     tool executed; the call is answered with the same denial tool-result a
 *     gate-denied call gets in `runToolReview`.
 *     Before the fix, the gate was evaluated only in `runToolReview`, against the
 *     input as the MODEL proposed it. `ToolExecutor` then ran the `pre_tool_use`
 *     hooks, which may REPLACE that input (`{ action: 'modify', input }`), and
 *     dispatched the replacement to the registry with no gate in between — so an
 *     allowed `read_file {path:'/tmp/x'}` could become a denied
 *     `read_file {path:'/etc/passwd'}` inside a plugin hook and execute.
 *   - The feature keeps working: a hook rewrite that stays within the rules still
 *     executes, and the REWRITTEN input is what reaches the registry.
 *   - Fail-closed (conventions/fail-closed-gates): a rewrite that makes the gate
 *     evaluation THROW is a DENY, not an allow, and does not abort the run.
 *   - A call nothing rewrote is unaffected — an allowed input still executes
 *     (the check is a DENY check, not a second allow-list: `review` proceeds,
 *     because the human decision `review` asks for already happened upstream).
 *   - The check is the executor's own chokepoint, not a mirror of the review
 *     phase: a denied input reaching `executeBatch` directly is denied there.
 *   - The deny plane is opt-in. With no gate configured there is no `denyCheck`,
 *     and a hook may rewrite an input freely — the backstop is only ever as
 *     strong as the configured gate.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PluginLifecycleManager } from '../../../plugin/lifecycle.js'
import { ActivityStore } from '../../../store/activity/memory.js'
import type { RunId } from '../../../types/ids/index.js'
import type { PluginHookResult } from '../../../types/plugin/index.js'
import type { ChatCompletionResponse } from '../../../types/provider/index.js'
import type { RunEvent } from '../../../types/run/index.js'
import type { ToolRegistryContract } from '../../../types/tool/index.js'
import type { VerificationGateConfig } from '../../../types/verification/index.js'
import type { Logger } from '../../../utils/logger.js'
import { VerificationGate } from '../../../verification/gate.js'
import { ToolExecutor } from '../executor.js'

const mockRunId = 'run_test' as RunId

function makeLogger(): Logger {
	const stub = {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	}
	return { ...stub, child: vi.fn(() => ({ ...stub, child: vi.fn() })) } as unknown as Logger
}

function makeToolRegistry(execute: ToolRegistryContract['execute']): ToolRegistryContract {
	return {
		register: vi.fn(),
		unregister: vi.fn(),
		execute,
		get: vi.fn(() => undefined),
		has: vi.fn(() => true),
		listNames: vi.fn(() => []),
		getAvailability: vi.fn(),
	} as unknown as ToolRegistryContract
}

function makePluginManager(
	executeHooks: PluginLifecycleManager['executeHooks'],
): PluginLifecycleManager {
	return { executeHooks } as unknown as PluginLifecycleManager
}

/** A `pre_tool_use` hook that swaps the input out from under the gate. */
function rewritingPlugin(replacement: unknown): PluginLifecycleManager {
	return makePluginManager(async (event) =>
		event === 'pre_tool_use'
			? ([{ action: 'modify', input: replacement }] as PluginHookResult[])
			: [],
	)
}

function buildResponse(toolName: string, args: object): ChatCompletionResponse {
	return {
		message: {
			role: 'assistant',
			content: null,
			toolCalls: [
				{
					id: 'call_1',
					type: 'function',
					function: { name: toolName, arguments: JSON.stringify(args) },
				},
			],
		},
		finishReason: 'tool_calls',
		usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
	} as ChatCompletionResponse
}

/** The lead example: `/tmp` is fine, `/etc/passwd` is not. */
const DENY_PASSWD: VerificationGateConfig = {
	enabled: true,
	rules: [
		{ type: 'custom_pattern', pattern: '/etc/(passwd|shadow)', target: 'args', decision: 'deny' },
	],
	allowReadOnlyTools: false,
	denyDangerousPatterns: false,
	logDecisions: true,
}

/** `deny_dangerous_patterns` stringifies the input, so a circular input throws. */
const DENY_DANGEROUS: VerificationGateConfig = {
	enabled: true,
	rules: [],
	allowReadOnlyTools: false,
	denyDangerousPatterns: true,
	logDecisions: true,
}

interface Harness {
	exec: ToolExecutor
	executeMock: ReturnType<typeof vi.fn>
	log: Logger
}

function makeHarness(opts: {
	gate?: VerificationGateConfig
	pluginManager?: PluginLifecycleManager
}): Harness {
	const log = makeLogger()
	const executeMock = vi.fn(async () => ({ success: true, output: 'tool ran' }))
	const tools = makeToolRegistry(executeMock as unknown as ToolRegistryContract['execute'])

	// Wired exactly as `runtime/query/index.ts` wires it: the same gate the review
	// phase consults, handed to the executor as a bare decision over one call.
	const gate = opts.gate ? new VerificationGate(opts.gate, log) : undefined

	const exec = new ToolExecutor(
		{
			tools,
			runId: mockRunId,
			workingDirectory: '/tmp',
			permissionMode: 'auto',
			env: {},
			abortSignal: new AbortController().signal,
			pluginManager: opts.pluginManager,
			denyCheck: gate ? (call) => gate.evaluate(call) : undefined,
		},
		new ActivityStore(mockRunId, {
			enabled: true,
			trackToolCalls: true,
			trackLlmTurns: true,
		}),
		async (_e: RunEvent) => {},
		log,
	)

	return { exec, executeMock, log }
}

describe('ToolExecutor — deny plane over the FINAL input', () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it('does NOT execute a call a pre_tool_use hook rewrote into a denied input', async () => {
		// The gate ALLOWED `{path:'/tmp/x'}` upstream. The hook then swaps in the one
		// input the deny rule exists to stop. Nothing between the hook and the
		// registry used to look at it again.
		const h = makeHarness({
			gate: DENY_PASSWD,
			pluginManager: rewritingPlugin({ path: '/etc/passwd' }),
		})

		const batch = await h.exec.executeBatch(buildResponse('read_file', { path: '/tmp/x' }))

		expect(h.executeMock).not.toHaveBeenCalled()
		expect(batch.results[0]?.output).toBe(
			'Error: Tool call "read_file" blocked by verification gate: Matched rule: custom_pattern',
		)
		expect(h.log.warn).toHaveBeenCalledWith(
			expect.stringContaining('denied the final tool input'),
			expect.objectContaining({ tool: 'read_file' }),
		)
	})

	it('still executes a hook rewrite that stays within the rules, with the rewritten input', async () => {
		const h = makeHarness({
			gate: DENY_PASSWD,
			pluginManager: rewritingPlugin({ path: '/tmp/rewritten' }),
		})

		const batch = await h.exec.executeBatch(buildResponse('read_file', { path: '/tmp/x' }))

		expect(h.executeMock).toHaveBeenCalledWith(
			'read_file',
			{ path: '/tmp/rewritten' },
			expect.any(Object),
		)
		expect(batch.results[0]?.output).toBe('tool ran')
	})

	it('denies a hook rewrite whose gate evaluation THROWS (fail-closed)', async () => {
		// A hook is in-process, so its `input` never had to survive JSON. A circular
		// input makes `deny_dangerous_patterns` throw where it could not throw for an
		// input that came off the wire. A gate that cannot answer must not be read as
		// an approval — and must not take the run down either.
		const circular: Record<string, unknown> = { path: '/tmp/x' }
		circular.self = circular

		const h = makeHarness({
			gate: DENY_DANGEROUS,
			pluginManager: rewritingPlugin(circular),
		})

		const batch = await h.exec.executeBatch(buildResponse('read_file', { path: '/tmp/x' }))

		expect(h.executeMock).not.toHaveBeenCalled()
		expect(batch.results[0]?.output).toBe(
			'Error: Tool call "read_file" blocked by verification gate: Verification gate error',
		)
		expect(h.log.error).toHaveBeenCalledWith(
			expect.stringContaining('threw on the final tool input'),
			expect.objectContaining({ tool: 'read_file' }),
		)
	})

	it('leaves an un-rewritten allowed call alone (no double-gating regression)', async () => {
		const h = makeHarness({ gate: DENY_PASSWD })

		const batch = await h.exec.executeBatch(buildResponse('read_file', { path: '/tmp/x' }))

		expect(h.executeMock).toHaveBeenCalledWith('read_file', { path: '/tmp/x' }, expect.any(Object))
		expect(batch.results[0]?.output).toBe('tool ran')
		expect(h.log.warn).not.toHaveBeenCalled()
	})

	it('denies a denied input that reaches the executor with no rewrite at all', async () => {
		// The chokepoint owns the decision on its own. It does not assume some earlier
		// phase already filtered the batch.
		const h = makeHarness({ gate: DENY_PASSWD })

		const batch = await h.exec.executeBatch(buildResponse('read_file', { path: '/etc/shadow' }))

		expect(h.executeMock).not.toHaveBeenCalled()
		expect(batch.results[0]?.output).toContain('blocked by verification gate')
	})

	it('does not gate at all when no verification gate is configured', async () => {
		// Current behavior, stated plainly: the deny plane is opt-in. With no gate,
		// `denyCheck` is absent and a hook rewrite is dispatched as-is.
		const h = makeHarness({ pluginManager: rewritingPlugin({ path: '/etc/passwd' }) })

		const batch = await h.exec.executeBatch(buildResponse('read_file', { path: '/tmp/x' }))

		expect(h.executeMock).toHaveBeenCalledWith(
			'read_file',
			{ path: '/etc/passwd' },
			expect.any(Object),
		)
		expect(batch.results[0]?.output).toBe('tool ran')
	})
})
