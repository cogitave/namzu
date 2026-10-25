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
import { completionNotice, launchedText } from './notice.js'
import { WORKFLOW_TOOL_DESCRIPTION, WORKFLOW_TOOL_NAME } from './offering.js'
import { type WorkflowRunEnd, WorkflowRunRegistry } from './registry.js'

/** Longest script the tool takes, in characters. The review shows all of it. */
export const MAX_WORKFLOW_SCRIPT_CHARS = 262_144
/** Longest `args` JSON the tool takes, in characters. */
export const MAX_WORKFLOW_ARGS_CHARS = 65_536

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

type LaunchOutcome =
	| { readonly kind: 'background' }
	| { readonly kind: 'ended'; readonly end: WorkflowRunEnd }

/**
 * A script failure as one plain sentence for the person: the interpreter's
 * error names (`TypeError: Error: `) are dropped, the position leads, and the
 * source line follows on a line of its own. Text that is not in the runtime's
 * `<what> — line L, column C: <source>` shape only loses the error names.
 */
export function plainScriptFailure(raw: string): string {
	const newline = raw.indexOf('\n')
	const first = newline === -1 ? raw : raw.slice(0, newline)
	const rest = newline === -1 ? '' : raw.slice(newline)
	const names = /^(?:[A-Za-z]*Error:\s*)+/
	const at = /^([\s\S]*?) — line (\d+), column (\d+): ([\s\S]*)$/.exec(first)
	if (at) {
		const [, what, line, column, source] = at
		return `The script stopped at line ${line}, column ${column}: ${(what ?? '').replace(names, '')}\nThat line reads: ${source}${rest}`
	}
	const none = /^([\s\S]*?) — the interpreter gave no line number for this error\.$/.exec(first)
	if (none) return `The script stopped: ${(none[1] ?? '').replace(names, '')}${rest}`
	return `${first.replace(names, '')}${rest}`
}

/** The tool's answer for a run that ended before it asked for any agent. */
function endedBeforeAgents(end: WorkflowRunEnd, noArgs: boolean) {
	const { view } = end
	if (view.status === 'completed') {
		return {
			success: true,
			output: completionNotice(view),
			data: { run_id: view.runId, name: view.name, status: 'completed', inline: true },
		}
	}
	const reason = plainScriptFailure(view.error ?? 'no reason was given')
	const hint =
		view.status === 'failed' && noArgs && /\bargs\b/.test(reason)
			? '\nThis call passed no "args", so `args` was undefined in the script.'
			: ''
	return {
		success: false,
		output: '',
		error:
			view.status === 'stopped'
				? `Workflow "${view.name}" was stopped before it started any agent${view.error ? `: ${reason}` : '.'}`
				: `${reason}${hint}`,
	}
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
						'JSON the script reads as `args`; undefined when omitted, so pass it or hard-code the values. Keep it small; the operator reads it before the run starts.',
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
		largeStringArguments: { script: 20_000 },
		truncatedInputHint:
			'Write a shorter script: shared helpers, loops instead of repeated lines, and prompts built from args.',
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
			// The call answers once the run has reached its first agent(), or ended
			// without one. Both are events of the run itself; nothing here races a
			// clock. Until then the run's end is the tool's to report, not a
			// background notice.
			let launching = true
			let settleLaunch: (outcome: LaunchOutcome) => void = () => {}
			const launch = new Promise<LaunchOutcome>((resolve) => {
				settleLaunch = resolve
			})
			const detach = (): void => {
				if (!launching) return
				launching = false
				settleLaunch({ kind: 'background' })
			}
			const onAbort = (): void => detach()
			context.abortSignal.addEventListener('abort', onAbort, { once: true })
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
					onFirstAgent: detach,
					onEnd: async (end) => {
						// The run's registrations are given back first, so whoever hears of
						// the end finds the delegation path free.
						await turn.release().catch(() => undefined)
						if (launching) {
							// It ended before any agent was asked for: the tool call reports
							// it, so there is no background notice to follow.
							launching = false
							settleLaunch({ kind: 'ended', end })
							return
						}
						options.onEnd?.(end)
					},
				})
				void view
				const outcome = await launch
				context.abortSignal.removeEventListener('abort', onAbort)
				if (outcome.kind === 'ended') {
					registry.discard(runId)
					return endedBeforeAgents(outcome.end, args === undefined)
				}
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
				context.abortSignal.removeEventListener('abort', onAbort)
				await turn.release()
				throw error
			}
		},
	})
	return { registry, tool }
}
