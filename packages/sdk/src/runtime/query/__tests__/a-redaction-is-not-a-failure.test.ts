/**
 * A tool result can be sanitized without the call being reported as failed.
 *
 * The substitution seam existed and was typed as a failure channel: the only
 * way a `post_tool_use` hook could change what the model sees was
 * `action: 'error'`, which prefixes `Error: ` and sets the error flag. So
 * redacting a credential out of a SUCCESSFUL result arrived at the model as a
 * tool failure — and a model told a call failed routes around it: retries it,
 * or reports to the user that it did not work.
 *
 * Every assertion here reads the `ToolCallOutcome` the executor produces,
 * because that is what becomes the `tool_result` the model actually receives.
 * Asserting that the hook ran, or that the manager returned the action, would
 * pass against every version of this defect.
 */

import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { ToolRegistry } from '../../../registry/tool/execute.js'
import { ActivityStore } from '../../../store/activity/memory.js'
import type { ToolCall } from '../../../types/message/index.js'
import type { PluginHookResult } from '../../../types/plugin/index.js'
import { ToolExecutor } from '../executor.js'

const SECRET = 'sk-live-11112222333344445555'
const REDACTED = 'token: [redacted]'

function toolsThatReturn(result: {
	success: boolean
	output: string
	content?: unknown
}): ToolRegistry {
	const tools = new ToolRegistry()
	tools.register({
		name: 'fetch_config',
		description: 'Returns configuration.',
		inputSchema: z.object({}),
		execute: async () => result as never,
	})
	return tools
}

/**
 * A plugin manager stub that returns one hook result for `post_tool_use`.
 *
 * Only the shape the executor consumes: it calls `executeHooks(event, ctx,
 * emit)` and reads the array back. A fuller fake would be a second
 * implementation of the manager to keep in agreement with the first.
 */
function managerReturning(event: string, results: PluginHookResult[]) {
	return {
		async executeHooks(e: string) {
			return e === event ? results : []
		},
	} as never
}

function call(): ToolCall {
	return {
		id: 'call_1',
		type: 'function',
		function: { name: 'fetch_config', arguments: '{}' },
	} as ToolCall
}

async function runWith(
	tools: ToolRegistry,
	hookResults: PluginHookResult[],
): Promise<{ output: string; isError?: boolean; content?: unknown }> {
	const stub = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }
	const logger = { ...stub, child: () => ({ ...stub, child: () => stub }) }
	const executor = new ToolExecutor(
		{
			tools,
			runId: 'run_redact' as never,
			workingDirectory: process.cwd(),
			permissionMode: 'auto',
			env: {},
			abortSignal: new AbortController().signal,
			pluginManager: managerReturning('post_tool_use', hookResults),
		},
		new ActivityStore('run_redact' as never, {
			enabled: true,
			trackToolCalls: true,
			trackLlmTurns: true,
		}),
		(async () => {}) as never,
		logger as never,
	)

	const batch = await executor.executeBatch({
		id: 'r',
		model: 'm',
		message: { role: 'assistant', content: null, toolCalls: [call()] },
		finishReason: 'tool_calls',
		usage: {
			promptTokens: 0,
			completionTokens: 0,
			totalTokens: 0,
			cachedTokens: 0,
			cacheWriteTokens: 0,
		},
	})
	const outcome = batch.results[0]
	if (!outcome) throw new Error('the executor produced no outcome')
	return outcome
}

describe('a post-tool hook that replaces the output', () => {
	it('does not report the successful call as an error', async () => {
		const outcome = await runWith(toolsThatReturn({ success: true, output: SECRET }), [
			{ action: 'replace', output: REDACTED },
		])

		// The three halves of the defect, each asserted. The `Error:` check is
		// the one that fails against a fix which cleared the flag and left the
		// prefix — the model reads the text, not the field.
		expect(outcome.isError).toBeFalsy()
		expect(outcome.output).toBe(REDACTED)
		expect(outcome.output).not.toContain('Error:')
	})

	it('keeps the secret out of what the model is given', async () => {
		// The point of the feature, stated as the property rather than as the
		// mechanism: whatever else happens, the credential is not in the result.
		const outcome = await runWith(toolsThatReturn({ success: true, output: SECRET }), [
			{ action: 'replace', output: REDACTED },
		])

		expect(outcome.output).not.toContain(SECRET)
	})

	it('preserves an image block the redaction did not touch', async () => {
		// A screenshot beside a redacted line is still a screenshot. Dropping it
		// was the old behaviour for every override, and it made the model reason
		// as though the tool had returned text only.
		const image = [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }]
		const outcome = await runWith(
			toolsThatReturn({ success: true, output: SECRET, content: image }),
			[{ action: 'replace', output: REDACTED }],
		)

		expect(outcome.content).toBeDefined()
	})

	it('drops content when the hook replaces it explicitly', async () => {
		// The escape hatch for a secret that is also in the image. `content: []`
		// is a decision the hook made, not an omission.
		const image = [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }]
		const outcome = await runWith(
			toolsThatReturn({ success: true, output: SECRET, content: image }),
			[{ action: 'replace', output: REDACTED, content: [] }],
		)

		expect(outcome.content).toEqual([])
	})
})

describe('the failure channel still reports failures', () => {
	it('an error override keeps the flag and the prefix', async () => {
		// The preservation case. A change that made every override succeed would
		// pass every test above and silently turn real failures into successes.
		const outcome = await runWith(toolsThatReturn({ success: true, output: 'fine' }), [
			{ action: 'error', message: 'policy violation' },
		])

		expect(outcome.isError).toBe(true)
		expect(outcome.output).toContain('Error:')
		expect(outcome.output).toContain('policy violation')
	})

	it('an error override still drops rich content', async () => {
		const image = [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }]
		const outcome = await runWith(
			toolsThatReturn({ success: true, output: 'fine', content: image }),
			[{ action: 'error', message: 'policy violation' }],
		)

		expect(outcome.content).toBeUndefined()
	})

	it('a tool that genuinely failed stays failed through a replace', async () => {
		// A hook may sanitize an error message too, and doing so must not
		// promote the call to a success — the tool, not the hook, decides
		// whether the work happened.
		const outcome = await runWith(toolsThatReturn({ success: false, output: SECRET }), [
			{ action: 'replace', output: REDACTED },
		])

		expect(outcome.isError).toBe(true)
		expect(outcome.output).toBe(REDACTED)
	})
})
