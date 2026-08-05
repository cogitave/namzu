import { z } from 'zod'

import type { AgentRuntimeContext } from '../../types/agent/base.js'
import type { TaskGateway } from '../../types/agent/gateway.js'
import type { ToolDefinition } from '../../types/tool/index.js'
import { defineTool } from '../defineTool.js'
import { wrapUntrusted } from '../untrusted-envelope.js'
import { failureLabel, taskSucceeded } from './outcome.js'

import type { TaskLaunchedCallback } from './index.js'

/**
 * Build the `Agent` tool — synchronous subagent delegation.
 *
 * Semantics: parent calls `Agent({ description, prompt, subagent_type })`,
 * the runtime spawns the chosen subagent with its own context window,
 * the parent's tool call BLOCKS until the subagent finishes, and the
 * subagent's final text comes back as the tool result. Intermediate
 * subagent tool calls are isolated — only the summary surfaces to
 * the parent.
 *
 * **How this relates to `create_task`.** This paragraph used to say the two
 * were different shapes — that `create_task` / `continue_task` /
 * `cancel_task` were a non-blocking trio driven by a `<task-notification>`
 * callback, and that the blocking `Agent` tool should be preferred. None of
 * that is true any more. `create_task` blocks and returns the worker's output
 * as its own `tool_result`, exactly like this tool; `continue_task` and
 * `cancel_task` are still defined in `./index.ts` but are deliberately not
 * registered, because a blocking launch leaves every worker terminal by the
 * time a later turn learns its id. So a reader following the old advice was
 * choosing between two tools on a distinction that no longer existed.
 *
 * What actually separates them is the surface, not the timing:
 *
 * - `create_task` arrives with the rest of the coordinator surface —
 *   `agent_task_list`, and `approve_plan` / `ask_user_question` when their
 *   dependencies are wired. That is the supervisor's toolkit.
 * - This builds one tool and nothing else, for an agent whose only delegation
 *   need is "hand this to a specialist". `terminal: true` additionally lets a
 *   pure router settle on the specialist's answer instead of spending a turn
 *   at full parent context to paraphrase it.
 *
 * Neither is legacy. Pick by how much of the coordinator surface you want.
 */
export interface AgentToolOptions {
	gateway: TaskGateway
	workingDirectory: string
	runtimeContext?: AgentRuntimeContext
	allowedAgentIds: string[]

	onTaskLaunched?: TaskLaunchedCallback

	/**
	 * Settle the parent run with the subagent's answer instead of looping
	 * once more to restate it. See {@link ToolDefinition.terminal}.
	 *
	 * For a router — an agent whose whole job is to pick a specialist —
	 * the relay turn is pure overhead at the parent's full context size,
	 * and it hands the caller the parent's paraphrase rather than the
	 * specialist's answer. Off by default: an agent that delegates as one
	 * step of a longer plan needs the loop to continue.
	 */
	terminal?: boolean
}

export function buildAgentTool(opts: AgentToolOptions): ToolDefinition {
	const { gateway, allowedAgentIds: agentIds, onTaskLaunched } = opts
	const cwd = opts.workingDirectory

	// This tool IS the delegation surface — it is the only thing this builder
	// returns — so "do not mount it on an empty roster" collapses to "do not
	// build it". Refusing at construction is therefore coherent here in a way
	// it is not for `buildCoordinatorTools`, whose other tools remain useful
	// with no delegates.
	//
	// It carried the same widen-to-string fallback `create_task` did: an empty
	// roster, which is the one input meaning "delegate to nobody", produced the
	// one schema accepting anybody. Saltzer & Schroeder's own reason for
	// checking the twin applies — "in a large system some objects will be
	// inadequately considered, so a default of lack of permission is safer"
	// (§I.A.3(b)) — and shipping the closed reading in one delegation surface
	// while leaving it open in the exported one is exactly that oversight.
	if (agentIds.length === 0) {
		throw new Error(
			'buildAgentTool requires at least one entry in allowedAgentIds. An empty roster means this run may delegate to nobody, so there is no subagent the tool could name — do not build the tool.',
		)
	}
	const subagentTypeEnum = z.enum(agentIds as [string, ...string[]])

	return defineTool({
		name: 'Agent',
		description: `Delegate a task to a specialized subagent. BLOCKING: returns when the subagent has finished, with the subagent's final text as the tool result. The subagent runs in its own context window and cannot see your conversation — include all necessary context in the prompt. Available subagents: ${agentIds.join(', ')}. To run multiple subagents in parallel, call this tool multiple times in a single response.`,
		inputSchema: z.object({
			description: z.string().describe('Short label for tracking (shown to the user)'),
			prompt: z
				.string()
				.describe('Self-contained task description with all context the subagent needs'),
			subagent_type:
				agentIds.length === 1
					? subagentTypeEnum
							.optional()
							.describe(`Which subagent to run (defaults to the only one: ${agentIds[0]})`)
					: subagentTypeEnum.describe('Which subagent to run'),
		}),
		category: 'custom',
		permissions: [],
		readOnly: false,
		destructive: false,
		concurrencySafe: true,
		...(opts.terminal !== undefined ? { terminal: opts.terminal } : {}),
		async execute({ description, prompt, subagent_type }, context) {
			// With a single registered subagent the type is optional — default to
			// it so the model can't trip the "subagent_type required" validation.
			const agentId = subagent_type ?? (agentIds.length === 1 ? agentIds[0] : undefined)
			if (!agentId) {
				return {
					success: false,
					output: '',
					error: `subagent_type is required — choose one of: ${agentIds.join(', ')}`,
				}
			}
			// The roster is enforced here as well as in the schema. `execute` is
			// reachable without going through the registry — this repo's own
			// callers do it — so a schema-only check leaves the roster
			// unenforced on that path, and the id would reach the gateway to be
			// resolved against an AgentManager that is typically shared and may
			// well hold an agent this run's roster deliberately omits. Every
			// access checked for authority, not only the mediated one
			// (Saltzer & Schroeder §I.A.3(c), complete mediation).
			if (!agentIds.includes(agentId)) {
				return {
					success: false,
					output: '',
					error: `Unknown subagent_type "${agentId}" — choose one of: ${agentIds.join(', ')}`,
				}
			}
			const handle = await gateway.createTask({
				agentId,
				prompt,
				workingDirectory: cwd,
				runtimeContext: opts.runtimeContext,
				// Hang the child off the executing tool's span, so the
				// delegation appears inside the turn that asked for it rather
				// than as a disconnected root trace. `create_task` has done
				// this all along; this tool — the kernel's other delegation
				// surface, and the one it exports as the canonical shape —
				// did not.
				...(context.parentSpan ? { parentSpan: context.parentSpan } : {}),
			})

			onTaskLaunched?.(handle.taskId, {
				agentId,
				description,
				// Same canonical-envelope plumbing as coordinator/index.ts
				// (ses_009-task-notification-envelope). For Agent-tool path
				// the subagent run is awaited synchronously below, so this
				// id is only used if a probe / hook unexpectedly forks the
				// completion to the background notification channel.
				originalToolUseId: context.toolUseId,
			})

			const completed = await gateway.waitForTask(handle.taskId)

			// Both authorities must agree — see `taskSucceeded` for which two
			// and why either alone is wrong. The reasoning used to live here
			// alone, which is exactly how `create_task` came to ship without
			// it: a review caught this site, and nothing carried the answer to
			// the other one.
			const succeeded = taskSucceeded(completed)

			const resultText =
				typeof completed.result?.result === 'string'
					? completed.result.result
					: completed.result?.result !== undefined
						? JSON.stringify(completed.result.result)
						: ''

			if (!succeeded) {
				const detail =
					completed.result?.lastError ?? resultText ?? '(subagent provided no failure detail)'
				return {
					success: false,
					output: '',
					error: `Subagent ${agentId} ${failureLabel(completed)}: ${detail}`,
					data: {
						task_id: handle.taskId,
						subagent_type: agentId,
						state: completed.state,
						status: completed.result?.status,
						lastError: completed.result?.lastError,
					},
				}
			}

			// Framed for the same reason `create_task` frames its result: a
			// subagent is the component most likely to have consumed material
			// nobody here wrote, and its final text lands straight in this
			// parent's context, where the parent usually holds the broader
			// tool grant. `data.result` keeps it verbatim for a host reading
			// the result programmatically.
			return {
				success: true,
				output: wrapUntrusted(
					{
						kind: 'agent-result',
						attributes: { agent: agentId, task: handle.taskId },
						provenance: `This is the output of the delegated subagent "${agentId}", not this agent's own work.`,
					},
					resultText || '(subagent returned no text)',
				),
				data: {
					task_id: handle.taskId,
					subagent_type: agentId,
					result: resultText,
					state: completed.state,
					status: completed.result?.status,
				},
			}
		},
	})
}
