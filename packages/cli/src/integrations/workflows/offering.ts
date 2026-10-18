/**
 * When the `workflow` tool is in the model's tool list.
 *
 * A workflow is a lot of work started on one decision, so the tool is only
 * offered when the operator asked for orchestration: hypermode is on, or the
 * message says "workflow" (or the Turkish "iş akışı"), or it is the `/workflow`
 * command. Everything else gets the `Agent` tool alone. Pure.
 */

export const WORKFLOW_TOOL_NAME = 'workflow'

/** The line under a workflow's launch row in the conversation. */
export const WORKFLOW_BACKGROUND_NOTE = 'Running in the background (↓ to manage)'

/** `workflow`, `workflows`, `Workflow`; and `iş akışı` in any case, with or without the diacritics. */
const WORKFLOW_WORD = /(?:^|[^\p{L}\p{N}])workflows?(?![\p{L}\p{N}])/u
const TURKISH_WORKFLOW = /(?:^|[^\p{L}\p{N}])i[sş]\s+ak[ıi][sş]\p{L}*/u

/** Whether a message asks for a workflow in words. */
export function messageAsksForWorkflow(text: string): boolean {
	if (text.length === 0) return false
	// Lower-cased twice: a Turkish capital `İ` or `I` only becomes `i` or `ı`
	// under the Turkish rules, and a message may be in either language.
	const lowered = [text.toLowerCase(), text.toLocaleLowerCase('tr-TR')]
	return lowered.some((value) => WORKFLOW_WORD.test(value) || TURKISH_WORKFLOW.test(value))
}

export interface WorkflowOffering {
	/** The session's hypermode. */
	readonly hypermode: boolean
	/** The text of the operator's latest message. */
	readonly userText: string
}

export function workflowOffered(input: WorkflowOffering): boolean {
	return input.hypermode || messageAsksForWorkflow(input.userText)
}

/**
 * The `/workflow <task>` command, as the message the model receives: the
 * operator's task, plus the words that make the request explicit.
 */
export function workflowCommandPrompt(task: string): string {
	const trimmed = task.trim()
	return trimmed.length === 0
		? 'Use a workflow for the work I describe next.'
		: `Use a workflow for this: ${trimmed}`
}

/** The tool's description, as the model reads it. */
export const WORKFLOW_TOOL_DESCRIPTION = [
	'Run a workflow: a short JavaScript program you write once that starts many subagents, in order and in parallel, and returns one value. It runs in the background; this call returns at once and one message arrives when it ends. Use it only because the operator asked for orchestration; for a single subagent or a small fan-out, use the Agent tool.',
	'',
	'The script is confined: no files, no network, no commands, no timers, no imports. Its only power is agent(), which starts a subagent with the same tools, permissions, sandbox and budget the Agent tool gives. A prompt you pass is data for that subagent and cannot widen what it may do.',
	'',
	'The first statement must be a pure literal, with no variables, calls or spreads:',
	'export const meta = { name: "audit", description: "One line the operator reads before it starts", phases: [{ title: "Scan" }, { title: "Fix", detail: "safe fixes only" }] }',
	'',
	'Then plain code. Everything below is a global:',
	'- agent(prompt, opts?) starts one subagent and resolves to its final text, or to a parsed value when opts.schema (a JSON Schema) is given, or to null when it failed or was skipped. Always handle null. opts: label (a short row title), phase (a phase title), schema, agentType ("general-purpose", "explore", or a project agent), model, effort. The subagent cannot see this conversation or your variables: put everything it needs in the prompt.',
	'- parallel([() => agent(...), ...]) starts every thunk now and resolves when all are done.',
	'- pipeline(items, stage1, stage2, ...) runs one chain per item with no barrier between stages; a stage gets (value, index, item) and an item whose stage gives null stops there.',
	'- phase(title) names the stage that the following agents belong to; inside parallel() or pipeline() pass opts.phase instead. Use the same titles as in meta.phases.',
	'- log(message) writes a progress line. args is the JSON you pass in the "args" input. budget is { tokensUsed, tokenLimit? }.',
	'- return a small JSON value: it is what you get back, capped at about 8000 characters. Have agents write large results to files and return the paths.',
	'',
	'Limits: at most 8 agents run at once and 200 start per run; a script that asks for more fails. The script may be up to 256 KiB and args 64 KiB, but the operator reads the script before it starts, so keep it as short as it can be: loops over lists, shared helpers, prompts built from args. Put long per-agent instructions in a file the agents read.',
	'',
	'Before it starts the operator sees the name, description, phases, limits and the script, and approves or declines. If they decline, do not retry with the same script; ask what to change.',
].join('\n')

/**
 * Why a turn may not start a workflow, or `undefined` when it may.
 *
 * A workflow is reviewed before it starts, like a destructive call: someone
 * has to approve the script. A session set to run tools without asking
 * (`auto`, which is what "bypass permissions" is) has already decided that.
 * Anything else with nobody to ask refuses, in words the model can pass on.
 */
export function workflowRefusal(turn: {
	readonly interactive: boolean
	readonly mode: string
}): string | undefined {
	if (turn.mode === 'auto' || turn.interactive) return undefined
	return 'A workflow starts many agents on one decision, so a person has to approve it first. This session has nobody to ask and is not set to run without asking, so no workflow was started. Run it from the terminal, or start the session with --permission-mode auto.'
}
