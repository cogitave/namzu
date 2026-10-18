/**
 * The `workflow` tool and the run registry it feeds, for one session.
 *
 * What starting an agent means is not decided here: `spawn` is the subagent
 * runtime's own path (`launchWorkflowAgent`), so a workflow's agents keep the
 * `Agent` tool's permission mode, rules, sandbox, tool roster and budget. This
 * file adds no way around any of them.
 */

import { randomBytes } from 'node:crypto'
import { join } from 'node:path'

import {
	FileWorkflowJournal,
	type ToolContext,
	type ToolDefinition,
	type TurnId,
	type WorkflowLimits,
	type WorkflowMeta,
	WorkflowScriptError,
	defineTool,
	mcpJsonSchemaToZod,
	parseWorkflowMeta,
} from '@namzu/sdk'

import type { SubagentRuntime } from '../subagents/runtime.js'
import { launchedText } from './notice.js'
import { WORKFLOW_TOOL_DESCRIPTION, WORKFLOW_TOOL_NAME } from './offering.js'
import { type WorkflowRunEnd, WorkflowRunRegistry } from './registry.js'

/** Longest script the tool takes, in characters. The review shows all of it. */
export const MAX_WORKFLOW_SCRIPT_CHARS = 5000
/** Longest `args` JSON the tool takes, in characters. */
export const MAX_WORKFLOW_ARGS_CHARS = 1500

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz'

/** `w` and eight characters of `0-9a-z`, like a background job's `b…`. */
export function createWorkflowRunId(isTaken: (id: string) => boolean = () => false): string {
	for (;;) {
		let body = ''
		while (body.length < 8) {
			for (const byte of randomBytes(16)) {
				if (byte >= 252) continue
				body += ALPHABET[byte % 36]
				if (body.length === 8) break
			}
		}
		const id = `w${body}`
		if (!isTaken(id)) return id
	}
}

/** The registrations one run needs for as long as it lives. */
export interface WorkflowRunTurn {
	/** A turn id the delegation path accepts for this run. */
	readonly turnId: TurnId
	/** Free the registrations. Safe to call twice. */
	release(): Promise<void>
}

export interface WorkflowHostOptions {
	readonly subagents: Pick<SubagentRuntime, 'launchWorkflowAgent'>
	/**
	 * `<session>/runs`: each run keeps its journal in `<runId>/workflow/`.
	 * Absent for a session that keeps nothing on disk (an ephemeral one).
	 */
	readonly runsDirectory: (turnId: TurnId) => string | undefined
	/**
	 * Whether the turn may start a workflow, as a plain reason when it may not.
	 * Reviewed like a destructive call; with nobody to review, only a session
	 * set to run without asking may start one.
	 */
	readonly refusal: (turnId: TurnId) => string | undefined
	/** Register the run with the delegation path under a turn id of its own. */
	readonly openRunTurn: (originTurnId: TurnId, runId: string) => WorkflowRunTurn
	/** Limits the run is held to, from the turn that started it. */
	readonly limitsFor?: (turnId: TurnId) => WorkflowLimits | undefined
	/** Called once when a run ends (the conversation line and the model's message). */
	readonly onEnd?: (end: WorkflowRunEnd) => void
	readonly registry?: WorkflowRunRegistry
}

export interface WorkflowHost {
	readonly registry: WorkflowRunRegistry
	readonly tool: ToolDefinition
}

interface WorkflowToolInput {
	script: string
	args?: unknown
	description?: string
}

function toolName(label: string | undefined): {
	name: string
	summary?: string
} {
	if (!label) return { name: 'tool' }
	const open = label.indexOf('(')
	return open > 0 ? { name: label.slice(0, open), summary: label } : { name: label, summary: label }
}

/** What a call to the tool is for, in one line: the model's own summary, else the script's `meta.description`. */
export function describeWorkflowCall(input: Partial<WorkflowToolInput>): string {
	if (typeof input.description === 'string' && input.description.trim().length > 0) {
		return input.description.trim().replace(/\s+/g, ' ')
	}
	if (typeof input.script === 'string') {
		try {
			return parseWorkflowMeta(input.script).description.replace(/\s+/g, ' ')
		} catch {
			const first = input.script.split('\n').find((line) => line.trim().length > 0)
			if (first) return first.trim().slice(0, 80)
		}
	}
	return 'workflow'
}

export function createWorkflowHost(options: WorkflowHostOptions): WorkflowHost {
	const registry = options.registry ?? new WorkflowRunRegistry()
	const tool = defineTool({
		name: WORKFLOW_TOOL_NAME,
		description: WORKFLOW_TOOL_DESCRIPTION,
		inputSchema: mcpJsonSchemaToZod({
			type: 'object',
			properties: {
				script: {
					type: 'string',
					maxLength: MAX_WORKFLOW_SCRIPT_CHARS,
					description:
						'The workflow script: `export const meta = {...}` first, then the code. Plain JavaScript, not wrapped in a function or a code fence.',
				},
				args: {
					description:
						'JSON the script reads as `args`. Keep it small; the operator reads it before the run starts.',
				},
				description: {
					type: 'string',
					maxLength: 200,
					description:
						'Optional one-line summary shown to the operator instead of meta.description.',
				},
			},
			required: ['script'],
			additionalProperties: false,
		}),
		largeStringArguments: { script: MAX_WORKFLOW_SCRIPT_CHARS },
		truncatedInputHint: `Write a shorter script (under ${MAX_WORKFLOW_SCRIPT_CHARS} characters): fewer agents per line, shared helpers, and prompts built from args.`,
		malformedInputHint:
			'Every character of "script" goes inside a JSON string: write a newline as \\n, a tab as \\t, a double quote as \\" and a backslash as \\\\.',
		// The person reads `Workflow(<what it is for>)`, never the script.
		presentCall: (input: unknown) => ({
			kind: 'generic' as const,
			label: `Workflow(${describeWorkflowCall(input as Partial<WorkflowToolInput>)})`,
			presentation: 'activity' as const,
		}),
		category: 'custom',
		permissions: [],
		readOnly: false,
		destructive: false,
		concurrencySafe: false,
		async execute(input: unknown, context: ToolContext) {
			const { script, args } = input as WorkflowToolInput
			const refused = options.refusal(context.turnId)
			if (refused !== undefined) return { success: false, output: '', error: refused }
			if (args !== undefined && JSON.stringify(args).length > MAX_WORKFLOW_ARGS_CHARS) {
				return {
					success: false,
					output: '',
					error: `args is larger than ${MAX_WORKFLOW_ARGS_CHARS} characters. Pass less, or have the agents read a file.`,
				}
			}
			let meta: WorkflowMeta
			try {
				meta = parseWorkflowMeta(script)
			} catch (error) {
				if (error instanceof WorkflowScriptError) {
					return { success: false, output: '', error: error.message }
				}
				throw error
			}
			const runId = createWorkflowRunId((id) => registry.get(id) !== undefined)
			const turn = options.openRunTurn(context.turnId, runId)
			const runs = options.runsDirectory(context.turnId)
			const limits = options.limitsFor?.(context.turnId)
			const journal =
				runs === undefined ? undefined : new FileWorkflowJournal(join(runs, runId, 'workflow'))
			const phaseDetail = (title: string | undefined): string | undefined =>
				title === undefined
					? undefined
					: meta.phases.find((phase) => phase.title.trim() === title.trim())?.detail
			try {
				const view = registry.start({
					runId,
					meta,
					script,
					...(args !== undefined ? { args } : {}),
					...(limits ? { limits } : {}),
					...(journal ? { journal } : {}),
					spawn: async (request, signal, viewed) => {
						const detail = phaseDetail(request.phaseTitle)
						const outcome = await options.subagents.launchWorkflowAgent({
							turnId: turn.turnId,
							runId,
							workflowName: meta.name,
							label: request.label,
							prompt: request.prompt,
							...(request.phaseTitle !== undefined ? { phaseTitle: request.phaseTitle } : {}),
							...(request.phaseIndex !== undefined ? { phaseIndex: request.phaseIndex } : {}),
							...(detail !== undefined ? { phaseDetail: detail } : {}),
							...(request.agentType !== undefined ? { agentType: request.agentType } : {}),
							...(request.model !== undefined ? { model: request.model } : {}),
							...(request.effort !== undefined ? { effort: request.effort } : {}),
							...(request.schema !== undefined ? { schema: request.schema } : {}),
							signal,
							inherit: {
								...(context.env ? { env: context.env } : {}),
								...(context.toolResultGuardrails
									? { toolResultGuardrails: context.toolResultGuardrails }
									: {}),
							},
							onView: viewed,
							onProgress: (progress) => {
								const last = toolName(progress.lastTool)
								request.onProgress({
									...(progress.tokens !== undefined ? { tokens: progress.tokens } : {}),
									...(progress.toolCalls !== undefined ? { toolCalls: progress.toolCalls } : {}),
									...(progress.lastTool !== undefined
										? {
												lastToolName: last.name,
												lastToolSummary: last.summary ?? last.name,
											}
										: {}),
								})
							},
						})
						return {
							state: outcome.state,
							...(outcome.text !== undefined ? { text: outcome.text } : {}),
							tokens: outcome.tokens,
							toolCalls: outcome.toolCalls,
							...(outcome.error !== undefined ? { error: outcome.error } : {}),
						}
					},
					onEnd: (end) => {
						void turn.release().finally(() => options.onEnd?.(end))
					},
				})
				return {
					success: true,
					output: launchedText(view),
					data: {
						run_id: runId,
						name: meta.name,
						description:
							input && typeof (input as WorkflowToolInput).description === 'string'
								? ((input as WorkflowToolInput).description as string)
								: meta.description,
						phases: meta.phases.map((phase) => phase.title),
					},
				}
			} catch (error) {
				await turn.release()
				throw error
			}
		},
	})
	return { registry, tool }
}
