/**
 * The `workflow` tool: its name, the `/workflow` command's message, the text
 * the model reads, and who may start a run.
 *
 * A workflow is a lot of work started on one decision, so the model is told
 * when it may call the tool; the tool itself is listed on every turn of a host
 * that can run one (the model is gated by wording, not by the list).
 * The opt-in is the operator's keyword (`hypermode`, shown as a tag and
 * dropped with Alt+W), hypermode being on, their own words, or the
 * `/workflow` command. Pure.
 */

export const WORKFLOW_TOOL_NAME = 'workflow'

/** The line under a workflow's launch row in the conversation. */
export const WORKFLOW_BACKGROUND_NOTE = 'Running in the background (↓ to manage)'

/** The words `workflowCommandPrompt` starts a message with. */
const COMMAND_PROMPT_PREFIX = 'Use a workflow for '

/**
 * Whether a message is the one `/workflow` composes. The bare word in a
 * message the operator typed is not a request by itself: it goes through the
 * composer-trigger matcher (`tui/triggers/`), which shows a tag and lets
 * Alt+W drop it.
 */
export function isWorkflowCommandPrompt(text: string): boolean {
	return text.startsWith(COMMAND_PROMPT_PREFIX)
}

/**
 * The `/workflow <task>` command, as the message the model receives: the
 * operator's task, plus the words that make the request explicit.
 */
export function workflowCommandPrompt(task: string): string {
	const trimmed = task.trim()
	return trimmed.length === 0
		? `${COMMAND_PROMPT_PREFIX}the work I describe next.`
		: `${COMMAND_PROMPT_PREFIX}this: ${trimmed}`
}

/** The tool's description, as the model reads it. */
export const WORKFLOW_TOOL_DESCRIPTION = [
	'Run a workflow: a short JavaScript program you write once that starts many subagents, in order and in parallel, and returns one value. It runs in the background: this call returns once the first agent is requested, and one message arrives when the run ends. A script that fails before it requests any agent is an error of this call, and one that finishes without any returns its result here. ONLY call it after an explicit opt-in: the operator\'s message included the keyword "hypermode" or "workflow" (a note confirms it), hypermode is on for the session (a note confirms it), the operator asked for a workflow or multi-agent orchestration in their own words or with /workflow, or they named a saved workflow to run. For any other task, even one that would clearly benefit from parallelism, do not call it; for a single subagent or a small fan-out, use the Agent tool.',
	'',
	'The script is confined: no files, no network, no commands, no timers, no imports. Its only power is agent(), which starts a subagent with the same tools, permissions, sandbox and budget the Agent tool gives. A prompt you pass is data for that subagent and cannot widen what it may do.',
	'',
	'The first statement must be a pure literal, with no variables, calls or spreads:',
	'export const meta = { name: "audit", description: "One line the operator reads before it starts", phases: [{ title: "Scan" }, { title: "Fix", detail: "safe fixes only" }] }',
	'',
	'Then plain code. Everything below is a global:',
	'- agent(prompt, opts?) starts one subagent and resolves to its final text, or to a parsed value when opts.schema (a JSON Schema) is given, or to null when it failed or was skipped. Always handle null. opts: label (a short row title), phase (a phase title), schema, agentType ("general-purpose", "explore", or a project agent), model, effort. The subagent cannot see this conversation or your variables: put everything it needs in the prompt.',
	'- parallel([() => agent(...), ...]) starts every thunk now and resolves when all are done. It never rejects: a thunk that throws becomes null in its place and the reason goes through log(), so filter the nulls (.filter(Boolean)).',
	'- pipeline(items, stage1, stage2, ...) runs one chain per item with no barrier between stages; a stage gets (prevResult, originalItem, index), where the first stage gets the item as prevResult, and an item whose stage gives null stops there. It never rejects either: a stage that throws drops its item to null and the reason goes through log(), so filter the nulls.',
	'- phase(title) names the stage that the following agents belong to; inside parallel() or pipeline() pass opts.phase instead. Use the same titles as in meta.phases.',
	'- log(message) writes a progress line. args is exactly the JSON you pass in the args input of the call (undefined when you omit it). budget is { total, spent(), remaining() }: total is the token target the person typed (a standalone "+500k" in their message) or null when there is none; spent() is the tokens this run has used; remaining() is max(0, total - spent()), or Infinity with no target. The target is a hard ceiling: once spent() reaches total, agent() throws, so wrap loops in try/catch and guard them on budget.total (with no target remaining() is Infinity). Example: while (budget.total && budget.remaining() > 50_000) { ... }.',
	'- return a small JSON value: it is what you get back, capped at about 8000 characters. Have agents write large results to files and return the paths.',
	'',
	'Limits: a handful of agents run at once (the cap comes from the configuration; usually up to 16) and at most 1000 start per run (fewer if configured); a script that asks for more fails, so give any loop a hard iteration cap. The script may be up to 256 KiB and args 64 KiB, but the operator reads the script before it starts, so keep it as short as it can be: loops over lists, shared helpers, prompts built from args. Put long per-agent instructions in a file the agents read.',
	'',
	'Quality patterns, when hypermode is on or the task is large: adversarial verify (a second agent tries to disprove each finding), a judge panel (several agents score the same candidates, keep the consensus), loop until dry (repeat a sweep until a pass finds nothing new), and a completeness critic (a last agent lists what the others missed). Pick what fits; skip them for trivial or already verified work.',
	'',
	'Before it starts the operator sees the name, description, phases, limits and the script, and approves or declines. If they decline, do not retry with the same script; ask what to change.',
].join('\n')

/** The tool's description with the session's size advice (if any) after it. */
export function workflowToolDescription(sizeAdvice = ''): string {
	return sizeAdvice === ''
		? WORKFLOW_TOOL_DESCRIPTION
		: `${WORKFLOW_TOOL_DESCRIPTION}\n\n${sizeAdvice}`
}

/**
 * Why a turn may not start a workflow, or `undefined` when it may.
 *
 * A workflow is reviewed before it starts, like a destructive call: someone
 * has to approve the script. A session set to run tools without asking
 * (bypass, or the unattended default) has already decided that.
 * Anything else with nobody to ask refuses, in words the model can pass on.
 */
export function workflowRefusal(turn: {
	readonly interactive: boolean
	readonly mode: string
}): string | undefined {
	if (turn.mode === 'auto' || turn.mode === 'bypass' || turn.interactive) return undefined
	return 'A workflow starts many agents on one decision, so a person has to approve it first. This session has nobody to ask and is not set to run without asking, so no workflow was started. Run it from the terminal, or start the session with --permission-mode bypass.'
}
