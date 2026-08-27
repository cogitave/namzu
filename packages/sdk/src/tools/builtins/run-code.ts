import { z } from 'zod'

import type { CodeRuntime } from '../../execution/code-runtime/types.js'
import { WorkerCodeRuntime } from '../../execution/code-runtime/worker.js'
import { defineTool } from '../defineTool.js'

/**
 * A program the model wrote, calling the run's own tools.
 *
 * Twenty tool calls to filter a list is twenty model turns, each at full
 * context size with the whole conversation resent. The same work is one
 * loop. That is the entire argument for this tool, and it only holds if the
 * loop cannot reach further than the twenty calls could have.
 *
 * **The program's reach is the RUN's reach, and nothing wider.** Every
 * capability it can call is a tool already in this run's registry and
 * narrowed by the turn's `allowedTools`. The host dispatch records every
 * child in the run and applies the run's operator authorization gate. An
 * explicit allow proceeds; a denial or an undecided child fails closed and
 * leaves a durable refusal, because an already-executing parent cannot open
 * a second durable human-review turn on the program's behalf.
 *
 * Opt-in, and not in the default builtin set. A run that does not need
 * model-authored control flow should not have a way to execute
 * model-authored text, and "the tool was there so it got used" is not a
 * threat model.
 */

const inputSchema = z.object({
	code: z
		.string()
		.min(1)
		.describe(
			'An async JavaScript body. Call a tool with `await call("tool_name", { ...input })`, print with `print(...)`, and `return` the result. No require, no process, no fetch — everything goes through `call`.',
		),
	tools: z
		.array(z.string())
		.describe(
			'The tools this program may call. It is refused any name not in this list, so keep it to what the program actually needs.',
		),
})

type RunCodeInput = z.infer<typeof inputSchema>

export const RUN_CODE_TOOL_NAME = 'run_code'

export interface RunCodeToolOptions {
	/** Defaults to the `worker_threads` backend. */
	readonly runtime?: CodeRuntime
	readonly timeoutMs?: number
	readonly maxOutputBytes?: number
}

const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_MAX_OUTPUT = 64 * 1024

export function buildRunCodeTool(options: RunCodeToolOptions = {}) {
	const runtime = options.runtime ?? new WorkerCodeRuntime()

	return defineTool({
		name: RUN_CODE_TOOL_NAME,
		description:
			"Runs a short JavaScript program that can call this run's own tools in a loop. Use it when the same tool would otherwise be called many times in a row — filtering, retrying, fanning out — and not for a single call.",
		inputSchema,
		category: 'custom',
		permissions: [],
		// NOT read-only and NOT non-destructive, whatever the program turns
		// out to do. Its effects are the union of the tools it calls, which
		// is not knowable from the input — and a `readOnly: true` here would
		// let a read-only preset auto-approve a program whose whole purpose
		// is calling something else.
		readOnly: false,
		destructive: true,
		concurrencySafe: false,

		async execute(input: RunCodeInput, context) {
			const dispatch = context.dispatchTool
			if (!dispatch) {
				return {
					success: false,
					output: '',
					error: 'This run provides no way to dispatch a tool, so a program has nothing to call.',
				}
			}

			// The intersection, computed HERE rather than trusted from the
			// input. `tools` is model-authored: a program that listed every
			// tool it wished for would otherwise widen its own grant, which is
			// the privilege escalation this whole design exists to prevent.
			const turnAllows = context.allowedTools
			const granted = input.tools.filter(
				(name) => turnAllows === undefined || turnAllows.includes(name),
			)
			const refused = input.tools.filter((name) => !granted.includes(name))

			const result = await runtime.run({
				source: input.code,
				allowedCalls: granted,
				timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
				maxOutputBytes: options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT,
				...(context.abortSignal ? { signal: context.abortSignal } : {}),
				onHostCall: async (request, operation) => {
					// Through the run-owned nested dispatch: registry narrowing,
					// operator authorization, audit/event lineage and invocation
					// cancellation remain host-owned rather than worker-owned.
					try {
						const toolResult = await dispatch(request.name, request.input, {
							signal: operation.signal,
							runtimeToolCallId: operation.runtimeToolCallId,
						})
						return toolResult.success
							? { ok: true, value: toolResult.output }
							: { ok: false, error: toolResult.error ?? 'the tool failed' }
					} catch (err) {
						return {
							ok: false,
							error: err instanceof Error ? err.message : String(err),
						}
					}
				},
			})

			const notes = [
				refused.length > 0
					? `[not granted, and refused to the program: ${refused.join(', ')} — this turn allows only ${turnAllows?.join(', ') ?? 'the run default'}]`
					: '',
				result.outputTruncated
					? '[the program printed more than the output limit and was cut here]'
					: '',
			].filter(Boolean)

			const body = [result.output, ...notes].filter(Boolean).join('\n')

			switch (result.outcome.status) {
				case 'completed':
					return {
						success: true,
						output: `${body}${body ? '\n' : ''}[returned] ${JSON.stringify(result.outcome.result) ?? 'undefined'}`,
						data: { calls: result.calls, truncated: result.outputTruncated },
					}
				case 'timed-out':
					return {
						success: false,
						output: body,
						// The output is carried on the failure too. A program that
						// printed its progress and then hung has told the model
						// where it got to, and discarding that leaves the model
						// retrying from the start.
						error: `The program ran longer than ${options.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms and its worker was stopped. Admitted host calls were asked to cancel; an uncooperative one may still be running.`,
					}
				case 'cancelled':
					return {
						success: false,
						output: body,
						error: 'The program was cancelled.',
					}
				default:
					return { success: false, output: body, error: result.outcome.error }
			}
		},
	})
}
