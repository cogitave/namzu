/**
 * How a turn resolves calls routed to review.
 *
 * An authorization rule says what a tool may do. A review policy says what
 * happens to calls the rules did not cover or explicitly routed to REVIEW.
 * The two axes are separate on purpose — a rule is a durable
 * statement an operator reviewed, and a mode is a property of ONE turn, the
 * difference between "we never force-push" and "this turn is unattended".
 *
 * Only calls the gate routed to review arrive here. A rule that denied one
 * already stopped it, and a rule that allowed one never asked. So a mode
 * decides the undecided and can never reopen what a rule closed; a host's
 * `--permission-mode` flag cannot widen a `deny`. That is the whole
 * precedence story between a flag and a config file, in one sentence.
 *
 * This lived in the operator application as one closure. It moved here
 * because none of it is about a terminal: the modes name kernel tools, the
 * exemptions reason about kernel tools' blast radius, and a second host
 * would otherwise write the same five branches and drift on the sixth.
 * What a host supplies is the one thing the kernel cannot: how to ask a
 * person (`prompt`).
 */

import { unknownProgramInLine } from '../../authorization/program.js'
import { readShellLine, shellPathAccess } from '../../authorization/shell-paths.js'
import { isTrustedReadOnly } from '../../tools/trusted-read-only.js'
import type { ToolManager } from '../../toolsets/manager.js'
import type {
	HITLResumeDecision,
	ResumeContext,
	ResumeHandler,
	ToolCallDeclined,
	ToolCallSummary,
} from '../../types/hitl/index.js'
import type { ApprovalPolicy } from '../../types/hitl/policy.js'
import type { SessionId, TurnId } from '../../types/ids/index.js'
import { PLAN_MODE_REFUSAL } from '../../types/permission/index.js'
import { type AutoReviewClassifier, autoReviewBlockedFeedback } from './auto-review/classifier.js'
import { DECLINED_TOOL_CALL_FEEDBACK } from './declined.js'
import { shellEscalations } from './path-escalation.js'

export type ReviewMode =
	/** Ask a person. The default when a `prompt` is supplied. */
	| 'prompt'
	/** Approve it. The default without a `prompt`, and what every headless turn has always done. */
	| 'auto'
	/**
	 * Approve a file edit, ask about everything else.
	 *
	 * The mode an operator watching the agent write code actually wants: an
	 * `edit` or `write` inside the working directory is what they asked for
	 * and is undoable with `git`, so a prompt on each one is a prompt they
	 * answer `y` to forty times an hour — and a prompt that is always
	 * answered the same way trains the hand to answer the next one, which is
	 * the shell prompt, the same way. Shell commands, delegation and anything
	 * a tool declares destructive still ask.
	 */
	| 'accept-edits'
	/**
	 * Read and think, do not act. A call that only reads is approved (one that
	 * reads outside the roots is asked about, as in every mode but `strict`); a
	 * call that would change anything is refused with feedback telling the model
	 * to present its plan instead. The operator reads the plan and switches
	 * mode to have it carried out — the switch IS the approval. The kernel's
	 * `permissionMode: 'plan'` is the floor under this: it blocks a mutating
	 * call at execution with no feedback, where this refuses it at review
	 * with the words that make the model plan.
	 */
	| 'plan'
	/**
	 * Refuse it. Nothing runs unless a rule allowed it by name or pattern —
	 * the allowlist is the whole permission surface, which is the only form
	 * an unattended turn can actually be reasoned about.
	 */
	| 'strict'
	/**
	 * Run everything except what no mode may approve in advance.
	 *
	 * Where `auto` approves what remains after the questions a person must
	 * answer (a path outside the roots, a program nobody can name, a protected
	 * write), `bypass` also approves those. It still asks, or refuses when
	 * nobody can be asked: a `deny` rule (the gate refuses before this is
	 * reached), an `ask` rule or a hook that asked for a person, a catastrophic
	 * removal, a tool's own `requiresApproval`, a sandbox escape, and a call
	 * whose safety checks did not finish. The dangerous-pattern floor refuses in
	 * the gate, unchanged. With nobody to ask, whatever would have been asked is
	 * refused.
	 */
	| 'bypass'
	/**
	 * Let a classifier model decide what a person would otherwise be asked.
	 *
	 * Needs a {@link ReviewPolicyOptions.classifier}. A call that `prompt` would
	 * ask about goes to it instead, and it allows or blocks; the questions that
	 * are a person's to answer (the same set `bypass` keeps) still go to one,
	 * or are refused when nobody can be asked. Calls that would not be asked
	 * about in `prompt`, calls `accept-edits` would approve, and the tools on
	 * {@link CLASSIFIER_SAFE_TOOLS} never reach it. See
	 * `runtime/query/auto-review/`.
	 */
	| 'classify'

export const REVIEW_MODES: readonly ReviewMode[] = [
	'prompt',
	'accept-edits',
	'auto',
	'strict',
	'plan',
	'bypass',
	'classify',
]

export function isReviewMode(value: unknown): value is ReviewMode {
	return typeof value === 'string' && (REVIEW_MODES as readonly string[]).includes(value)
}

export { PLAN_MODE_REFUSAL }

/** What the model is told when a call is refused under `strict`. */
export const STRICT_MODE_REFUSAL =
	'Refused: this turn only permits tools an explicit rule allows, and no rule covers this call. Asking again will not change it — either the operator adds a rule, or this has to be done another way.'

/** The tools `accept-edits` approves without asking. Everything else prompts. */
export const ACCEPT_EDITS_TOOLS: ReadonlySet<string> = new Set(['edit', 'write'])

/**
 * Writes that skip review anyway, in spite of declaring `readOnly: false`.
 *
 * This is an OVERRIDE of the tool's own declaration, and it is named as one.
 * The bar for an entry is that prompting would be unusable AND a bad write
 * cannot reach beyond the agent's own bookkeeping:
 *
 * - `task_create` / `task_update` / `update_goal` — the model's own plan for
 *   the current request, written several times per planning turn; asking
 *   each time would put a consent dialog between the agent and its todo
 *   list. What a bad write costs is a polluted task list, visible in the
 *   transcript, and it grants nothing.
 *
 * `save_memory` is deliberately NOT here. Content saved now is retrievable
 * by `search_memory` in a later session, so a tool result that talks the
 * model into saving something reaches a future turn's reasoning. A write
 * that survives the process is not read-only under any reading.
 */
export const REVIEW_EXEMPT_WRITES: ReadonlySet<string> = new Set([
	'task_create',
	'task_update',
	'update_goal',
])

/**
 * Whether a call runs without review: it declares itself read-only and is
 * trusted to say so, or it is a named exemption above.
 *
 * The read-only half comes from the tool's own declaration through
 * `isTrustedReadOnly`, the predicate the authorization gate uses, never from
 * a list of names kept here: a renamed tool would otherwise change posture
 * with nothing to notice. A fetch declares itself read-only and is still a
 * request leaving the machine to an address the model chose, so `network`
 * tools are reviewed like a shell command. A tool the registry does not
 * know, or one that declares nothing, is reviewed.
 */
export function isReviewExempt(
	registry: Pick<ToolManager, 'get' | 'sourceOf'>,
	name: string,
	input: unknown,
): boolean {
	if (REVIEW_EXEMPT_WRITES.has(name.toLowerCase())) return true
	const resolvedName = registry.get(name) ? name : name.toLowerCase()
	const tool = registry.get(resolvedName)
	if (tool?.category === 'network') return false
	const source = tool ? registry.sourceOf(resolvedName) : undefined
	return isTrustedReadOnly(tool, input, source)
}

export type ReviewExemption = (name: string, input: unknown) => boolean

/**
 * Review explicit requests, escalated calls, and calls that are destructive
 * or not exempt.
 *
 * An escalated call (`ToolCallSummary.escalation`) is reviewed even when its
 * tool only reads: a read of a file outside the working directory is exactly
 * the read the boundary was about, and "the tool is read-only" answers a
 * different question.
 */
export function batchNeedsReview(
	toolCalls: readonly ToolCallSummary[],
	exempt: ReviewExemption,
): boolean {
	return toolCalls.some(
		(tc) =>
			tc.authorization?.explicitReview ||
			tc.escalation !== undefined ||
			tc.isDestructive ||
			tc.requiresApproval === true ||
			!exempt(tc.name, tc.input),
	)
}

/**
 * Whether every call in a batch only reads, so that what brought it to review
 * can only be a path outside the roots: no explicit review from a rule,
 * nothing destructive, no sandbox escape, and a tool exempt from review.
 */
function onlyReadsOutsideRoots(
	toolCalls: readonly ToolCallSummary[],
	exempt: ReviewExemption,
): boolean {
	return toolCalls.every(
		(tc) =>
			!tc.authorization?.explicitReview &&
			!tc.isDestructive &&
			tc.escalation?.sandboxEscape !== true &&
			exempt(tc.name, tc.input),
	)
}

/**
 * What the model is told when a batch asks to leave the sandbox and nobody
 * can be asked.
 *
 * The whole batch is refused rather than the escape alone: the policy
 * answers for the batch as a unit, and approving its other calls while the
 * one that needed a person is dropped would run a plan with a hole in it.
 */
export const SANDBOX_ESCAPE_UNATTENDED_REFUSAL =
	'Refused: a call in this batch asks to run outside the sandbox, which needs a person to confirm it each time, and nobody can be asked in this session. Nothing in this batch ran. Run the command inside the sandbox, or resend the other calls without the escape.'

/**
 * What the model is told when a batch reaches a path outside the turn's roots
 * and nobody can be asked.
 *
 * Refused rather than approved by `auto`: the path is outside what the turn
 * was given, and an approval of it is a person's, per call. A host with
 * nobody to ask widens the roots up front instead (`additionalDirectories`,
 * the CLI's `--add-dir`), where an operator wrote the directory down.
 */
export const OUTSIDE_ROOTS_UNATTENDED_REFUSAL =
	"Refused: a call in this batch reaches a path outside the working directory and the added directories, which needs a person to approve it each time, and nobody can be asked in this session. Nothing in this batch ran. Stay inside the working directory, or tell the user which directory you need so they can add it to the session (the CLI's --add-dir)."

/**
 * What the model is told when a batch carries a call the tool itself
 * declared always needs a person's approval and nobody can be asked.
 *
 * Refuses the whole batch, the same way a sandbox escape does: the
 * declaration is the tool author's, not the operator's, so no rule, mode or
 * remembered grant can stand in for the person it names.
 */
export const REQUIRES_APPROVAL_UNATTENDED_REFUSAL =
	"Refused: a call in this batch is one the tool itself declared always needs a person's approval, and nobody can be asked in this session. Nothing in this batch ran. This cannot be granted by a rule, an automation mode, a remembered approval or a skill; run it in a session where a person can be asked."

/**
 * What the model is told when a batch runs a command whose own program name
 * is decided at runtime and nobody can be asked.
 *
 * Refused rather than approved by `auto`: no rule, allow, grant or
 * unattended setting can vouch for a program nobody can read the name of
 * before it runs — unlike a sandbox escape, there is no equivalent
 * "unattended allow" for this.
 */
export const UNKNOWN_PROGRAM_UNATTENDED_REFUSAL =
	'Refused: a call in this batch runs a command whose own program name is decided at runtime (a substitution or a variable stands for it), which needs a person to approve it each time, and nobody can be asked in this session. Nothing in this batch ran. Write the program name literally; compute what needs computing in the arguments instead.'

/**
 * What the model is told when a batch writes a protected path (a git hook, a
 * shell rc file, editor or tool configuration, the project's `.namzu`
 * directory) and nobody can be asked.
 *
 * Refused in every mode, `auto` included: a write there runs later, outside
 * the turn, with the operator's rights, so an answer given before the call
 * existed (a mode, a rule, "approve all") is not an answer about it.
 */
export const PROTECTED_PATH_UNATTENDED_REFUSAL =
	"Refused: a call in this batch writes a protected path (a git hook or config, a shell startup file, editor or tool configuration, or the project's .namzu directory), which needs a person to approve it each time, and nobody can be asked in this session. Nothing in this batch ran. Leave those files alone, or tell the user what change you need so they can make it."

/**
 * What the model is told when a batch removes something catastrophic (the
 * root, the home directory, the working directory or a parent of it, a glob
 * across directories, a target a variable may empty) and nobody can be asked.
 */
export const DANGEROUS_REMOVAL_UNATTENDED_REFUSAL =
	'Refused: a call in this batch removes something this check treats as catastrophic (the file system root, a top-level or home directory, the working directory or a parent of it, a glob across directories, or a target a variable or substitution may leave empty), which needs a person to approve it each time, and nobody can be asked in this session. Nothing in this batch ran. Name the exact directory to remove with a literal path.'

/**
 * What the model is told when a batch carries a call a rule or a hook asked a
 * person to approve and nobody can be asked.
 */
export const ASK_RULE_UNATTENDED_REFUSAL =
	'Refused: a call in this batch is one a rule or a hook says a person must approve, and nobody can be asked in this session. Nothing in this batch ran. Run it in a session where a person can be asked, or have the operator change the rule.'

/**
 * What the model is told when the checks that decide whether a call reaches
 * past its boundary did not finish and nobody can be asked.
 */
export const UNFINISHED_CHECK_UNATTENDED_REFUSAL =
	'Refused: the safety checks on a call in this batch did not finish, so it cannot be shown to be safe, and a person has to approve it and nobody can be asked in this session. Nothing in this batch ran. Try a simpler form of the call.'

/** What the model is told when the conversation is too long for the classifier to read. */
export const CLASSIFIER_TRANSCRIPT_TOO_LONG_FEEDBACK =
	'Blocked by auto mode: the conversation has become too long for the safety check to read, so this action was not run. The conversation is being shortened; try the action again.'

/**
 * Tools the classifier is never asked about: they read, plan or keep the
 * agent's own notes, and cannot change anything outside the session.
 */
export const CLASSIFIER_SAFE_TOOLS: ReadonlySet<string> = new Set([
	'read',
	'grep',
	'glob',
	'ls',
	'lsp',
	'code_analysis',
	'search_tools',
	'view_image',
	'task_create',
	'task_update',
	'task_list',
	'task_get',
	'update_goal',
	'enter_plan_mode',
	'exit_plan_mode',
])

/**
 * Programs an allow rule must not stand in for the classifier on: each runs
 * whatever it is handed, so a rule that let `python` through would approve any
 * script without the classifier reading it.
 */
const CLASSIFIER_LAUNCHERS: ReadonlySet<string> = new Set([
	'python',
	'python2',
	'python3',
	'node',
	'deno',
	'tsx',
	'ruby',
	'perl',
	'php',
	'lua',
	'npx',
	'bunx',
	'bash',
	'sh',
	'zsh',
	'fish',
	'ssh',
	'eval',
	'exec',
	'env',
	'xargs',
	'sudo',
])

/** Package managers whose `run`/`exec` verbs start a script. */
const CLASSIFIER_SCRIPT_RUNNERS: ReadonlySet<string> = new Set(['npm', 'yarn', 'pnpm', 'bun'])

/** Tools that start other agents; an allow rule for one is not consulted under `classify`. */
const CLASSIFIER_DELEGATION_TOOLS: ReadonlySet<string> = new Set([
	'agent',
	'create_task',
	'continue_task',
])

/** The shell commands `accept-edits` also approves, when every path they name is inside the roots. */
export const ACCEPT_EDITS_SHELL_COMMANDS: ReadonlySet<string> = new Set([
	'mkdir',
	'touch',
	'rm',
	'rmdir',
	'mv',
	'cp',
	'sed',
])

/**
 * What the model is told when a batch would show it the operator's screen for
 * the first time in a session and nobody can be asked.
 */
export const SCREEN_CONSENT_UNATTENDED_REFUSAL =
	"Refused: this call would send what is on the user's screen to the model provider, which a person agrees to once per session, and nobody can be asked in this session. Nothing in this batch ran. Tell the user computer use needs their consent in an interactive session."

/** What the model is told when the operator declines to share the screen. */
export const SCREEN_CONSENT_DECLINED_FEEDBACK =
	'The user declined to share their screen in this session. Nothing in this batch ran. Do not take screenshots or read windows again; ask the user how they want to proceed.'

/**
 * The sessions whose operator agreed to let the model see the screen.
 *
 * A host keeps one for as long as its sessions live and hands the same box to
 * every policy it builds, so a mode switch keeps the answer and a new session
 * (a different id) is asked again. The policy only adds to it.
 */
export interface ScreenConsentRecord {
	readonly sessions: Set<string>
}

/**
 * Whether the call writes a protected path, removes something catastrophic, or
 * could not be checked.
 */
function reachesAFloor(tc: ToolCallSummary): boolean {
	return (
		(tc.escalation?.protectedPaths?.length ?? 0) > 0 ||
		tc.escalation?.dangerousRemoval !== undefined ||
		tc.escalation?.unfinishedCheck !== undefined
	)
}

/** The refusal for a batch that reaches a floor and cannot be asked about it. */
function floorRefusal(toolCalls: readonly ToolCallSummary[]): string {
	if (toolCalls.some((tc) => (tc.escalation?.protectedPaths?.length ?? 0) > 0)) {
		return PROTECTED_PATH_UNATTENDED_REFUSAL
	}
	return toolCalls.some((tc) => tc.escalation?.dangerousRemoval !== undefined)
		? DANGEROUS_REMOVAL_UNATTENDED_REFUSAL
		: UNFINISHED_CHECK_UNATTENDED_REFUSAL
}

/**
 * Whether a mode needs a batch a rule already allowed to come to the policy.
 *
 * `plan` must refuse a change a rule would have let through, and `classify`
 * must look at a call whose allow rule is too wide to vouch for it. A host
 * answers its `reviewAllowedCalls` with this for the mode it is in.
 */
export function modeReviewsAllowedCalls(mode: ReviewMode): boolean {
	return mode === 'plan' || mode === 'classify'
}

/** Whether the mode keeps only the questions a person must answer, and leaves the rest to itself. */
function isPermissive(mode: ReviewMode): boolean {
	return mode === 'bypass' || mode === 'classify'
}

/**
 * Whether the call is one of the few no mode may settle in advance: a rule or
 * hook asked for a person, a sandbox escape, a catastrophic removal, a check
 * that did not finish, or a tool that always needs approval. The dangerous
 * pattern floor and `deny` rules are not here: the gate refuses those first.
 */
function isBypassImmune(tc: ToolCallSummary): boolean {
	return (
		tc.authorization?.askRule === true ||
		tc.escalation?.sandboxEscape === true ||
		tc.escalation?.dangerousRemoval !== undefined ||
		tc.escalation?.unfinishedCheck !== undefined ||
		tc.requiresApproval === true
	)
}

/** The refusal for the first immune thing in a batch nobody can be asked about, or undefined. */
function immuneRefusal(
	toolCalls: readonly ToolCallSummary[],
	escapeConfirmed: boolean,
): string | undefined {
	if (!escapeConfirmed && toolCalls.some((tc) => tc.escalation?.sandboxEscape === true)) {
		return SANDBOX_ESCAPE_UNATTENDED_REFUSAL
	}
	if (toolCalls.some((tc) => tc.escalation?.dangerousRemoval !== undefined)) {
		return DANGEROUS_REMOVAL_UNATTENDED_REFUSAL
	}
	if (toolCalls.some((tc) => tc.escalation?.unfinishedCheck !== undefined)) {
		return UNFINISHED_CHECK_UNATTENDED_REFUSAL
	}
	if (toolCalls.some((tc) => tc.requiresApproval === true)) {
		return REQUIRES_APPROVAL_UNATTENDED_REFUSAL
	}
	if (toolCalls.some((tc) => tc.authorization?.askRule === true)) return ASK_RULE_UNATTENDED_REFUSAL
	return undefined
}

/** One sed command a script may hold: a substitution with plain flags, or a delete, print or line number. */
const SAFE_SED_COMMAND =
	/^\s*(?:\d+(?:,\d+)?|\$|\/[^/]*\/)?\s*(?:s(.)(?:(?!\1)[^\\]|\\.)*\1(?:(?!\1)[^\\]|\\.)*\1[gpiI0-9]*|[dpP=])\s*$/

/**
 * Whether a `sed` invocation can only edit text: its script is made of
 * substitutions and simple line commands. A script with the `e`, `w` or `r`
 * commands or flags can run a program or reach another file, and a script from
 * a file cannot be read here, so those are not edits this vouches for.
 */
function sedOnlyEdits(
	args: readonly { readonly value: string; readonly expands: boolean }[],
): boolean {
	const scripts: string[] = []
	let positional = 0
	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i] as { value: string; expands: boolean }
		if (arg.expands) return false
		const text = arg.value
		if (text === '-e') {
			const next = args[i + 1]
			if (next === undefined || next.expands) return false
			scripts.push(next.value)
			i += 1
			continue
		}
		if (text.startsWith('--expression=')) {
			scripts.push(text.slice('--expression='.length))
			continue
		}
		if (text === '-f' || text.startsWith('--file') || text === '--follow-symlinks') return false
		if (text.startsWith('-')) {
			if (
				!/^-(?:[nErszi]+|i\S*|-in-place(?:=\S*)?|-quiet|-silent|-regexp-extended|-separate|-null-data)$/.test(
					text,
				)
			) {
				return false
			}
			continue
		}
		positional += 1
		if (positional === 1 && scripts.length === 0) scripts.push(text)
	}
	if (scripts.length === 0) return false
	return scripts.every((script) =>
		script
			.split(/;|\n/)
			.filter((part) => part.trim() !== '')
			.every((part) => SAFE_SED_COMMAND.test(part)),
	)
}

/** The batch a person is asked about. */
export interface ToolReviewRequest {
	/** Originating session, preserved by createReviewHandler for host attribution. */
	readonly sessionId?: SessionId
	/** Originating turn, preserved by createReviewHandler for host attribution. */
	readonly turnId?: TurnId
	readonly toolCalls: readonly ToolCallSummary[]
	/**
	 * This batch would send the screen to the model provider for the first
	 * time in the session (see {@link ReviewPolicyOptions.screenConsent}).
	 * The question is whether the model may see the screen for the rest of
	 * the session; a yes also approves this batch, and later screen captures
	 * in the session run without asking.
	 */
	readonly screenConsent?: true
}

export type ToolReviewAnswer =
	| { readonly kind: 'approve' }
	/** Approve, and stop asking for the rest of the turn. */
	| { readonly kind: 'approve-all' }
	| {
			readonly kind: 'reject'
			readonly feedback?: string
			/**
			 * Set by a host when a person said No, so the refusal is recorded as
			 * theirs. `feedback` is what the model is told and a host may fill it
			 * for its own reasons (a closed screen, an interrupted turn), so it
			 * cannot carry this. `note` is the person's own words.
			 */
			readonly declined?: ToolCallDeclined
	  }

/** How a host asks a person. The one thing the kernel cannot supply. */
export type ToolReviewPrompt = (request: ToolReviewRequest) => Promise<ToolReviewAnswer>

export interface ReviewPolicyOptions {
	/** Default `prompt` when a `prompt` is supplied, `auto` otherwise. */
	readonly mode?: ReviewMode
	readonly prompt?: ToolReviewPrompt
	/** Which calls skip review; default `isReviewExempt` over `registry`, or nothing without one. */
	readonly exempt?: ReviewExemption
	readonly registry?: Pick<ToolManager, 'get' | 'sourceOf'>
	/**
	 * Where "approve all" is remembered. A host that shows the state (a
	 * badge saying the session is unattended) passes its own box so both
	 * read the same fact; omitted, the policy keeps one privately.
	 */
	readonly remembered?: { all: boolean }
	/**
	 * What happens to a sandbox escape when there is no `prompt`.
	 *
	 * `'refuse'` (the default) refuses the batch: an escape is consented to by
	 * a person, per call, and a turn with nobody to ask has no one to consent.
	 * `'allow'` confirms it without asking, for an unattended host whose
	 * operator decided in configuration that its commands may leave the
	 * sandbox. With a `prompt` this is not consulted: the person is asked,
	 * in every mode that does not refuse the call outright.
	 */
	readonly unattendedSandboxEscape?: 'refuse' | 'allow'
	/**
	 * Whether a skill's `allowed-tools` pre-approval stands in for a person.
	 *
	 * `'honour'` (the default) approves a batch without asking when every call
	 * that would be asked about carries `ToolCallSummary.skillGrant`. `'ignore'`
	 * asks as though no skill had been loaded — the behaviour before
	 * `allowed-tools` was read as a pre-approval, for a host that does not want
	 * repository content to reduce its prompts. `plan` and `strict` refuse
	 * either way.
	 */
	readonly skillGrants?: 'honour' | 'ignore'
	/**
	 * Ask once per session before the model first sees the screen.
	 *
	 * With a record, a batch holding a call that captures the screen
	 * ({@link capturesScreen}) in a session not yet in `sessions` is put to
	 * a person first, as a {@link ToolReviewRequest.screenConsent} request,
	 * even when every call in it only reads: in `prompt`, `accept-edits` and
	 * `plan`. A yes adds the session; a no refuses the batch. `strict`
	 * refuses such a call unless a rule allowed it, `auto` never asks, and a
	 * policy without a `prompt` refuses. A call a rule allowed is never
	 * asked about. Omitted, the screen is treated like any other read.
	 */
	readonly screenConsent?: ScreenConsentRecord
	/**
	 * Which calls capture the screen. Default: the tool's own
	 * `capturesScreen` declaration, read from `registry`; nothing without one.
	 */
	readonly capturesScreen?: (name: string, input: unknown) => boolean
	/**
	 * The one write `plan` mode lets through: a host that gives plan mode a plan
	 * file says here which call writes it. In `plan`, a call this accepts is not
	 * a change — it is neither refused nor asked about — unless a rule asked to
	 * review it, in which case it is put to the person like a read outside the
	 * roots. Every other write stays refused. Omitted (the default), `plan`
	 * refuses every change, as it always has; the option does nothing in any
	 * other mode.
	 */
	readonly planModeWrite?: (call: ToolCallSummary) => boolean
	/**
	 * The classifier `classify` mode asks. Required for that mode (building a
	 * `classify` policy without one throws) and ignored in every other.
	 */
	readonly classifier?: AutoReviewClassifier
	/** Tool names added to {@link CLASSIFIER_SAFE_TOOLS} for `classify`: never sent to the classifier. */
	readonly safeTools?: readonly string[]
	/**
	 * The roots the turn works in, the working directory first and then the
	 * added directories (or a function that reads them now). `accept-edits`,
	 * and `classify` through it, approve `mkdir`, `touch`, `rm`, `rmdir`, `mv`,
	 * `cp` and `sed` only when every path the shell line names is inside them,
	 * and only when the host says what they are: without this those commands
	 * are asked about as before.
	 */
	readonly roots?: readonly string[] | (() => readonly string[])
	/**
	 * Called when the classifier has blocked enough calls (see
	 * `AutoReviewLimits`) that the host should stop relying on it. The policy
	 * then asks the person about the call that tripped the limit, or ends the
	 * turn when there is nobody to ask. It does not change the mode: the host,
	 * which owns the mode and how it is shown, does that here.
	 */
	readonly onClassifierLimit?: (event: {
		readonly limit: 'consecutive' | 'total'
		readonly reason: string
	}) => void
	/**
	 * Called when the conversation was too long for the classifier to read, so
	 * a host can start a compaction. The call is blocked once with a note telling
	 * the model to try again.
	 */
	readonly onClassifierTranscriptTooLong?: () => void
}

/**
 * Whether a skill's `allowed-tools` grant may stand in for a person on this
 * call: the kernel marked it, and nothing that outranks a skill is present.
 * The second half repeats what the kernel checked before marking, so a mark
 * on a persisted or host-built summary cannot carry more than it should.
 */
function isSkillGranted(tc: ToolCallSummary): boolean {
	return (
		tc.skillGrant !== undefined &&
		!tc.authorization?.explicitReview &&
		tc.authorization?.decision !== 'deny' &&
		!tc.isDestructive &&
		tc.escalation === undefined &&
		tc.requiresApproval !== true
	)
}

/**
 * Whether a `pre_tool_use` hook's `allow` may stand in for a person on this
 * call. The same bar as a skill's grant, repeated here so that a mark on a
 * persisted or host-built summary cannot carry more than the kernel gave it.
 */
function isHookGranted(tc: ToolCallSummary): boolean {
	return (
		tc.hookGrant !== undefined &&
		tc.hookPermission?.decision !== 'ask' &&
		!tc.authorization?.explicitReview &&
		tc.authorization?.decision !== 'deny' &&
		!tc.isDestructive &&
		tc.escalation === undefined &&
		tc.requiresApproval !== true
	)
}

/** The handler behind `createReviewPolicy`, for a host that wants only the function. */
export function createReviewHandler(options: ReviewPolicyOptions = {}): ResumeHandler {
	const { prompt, registry } = options
	const mode: ReviewMode = options.mode ?? (prompt ? 'prompt' : 'auto')
	if (mode === 'classify' && options.classifier === undefined) {
		throw new TypeError(
			'The classify review mode needs a classifier (ReviewPolicyOptions.classifier).',
		)
	}
	const safeTools = new Set([...CLASSIFIER_SAFE_TOOLS, ...(options.safeTools ?? [])])
	/** Set once the classifier has said the conversation is too long, until it judges something. */
	let transcriptTooLong = false
	const toolOf = (name: string) => registry?.get(name) ?? registry?.get(name.toLowerCase())
	const rootsNow = (): readonly string[] =>
		typeof options.roots === 'function' ? options.roots() : (options.roots ?? [])
	const exempt: ReviewExemption =
		options.exempt ??
		(registry ? (name, input) => isReviewExempt(registry, name, input) : () => false)
	const remembered = options.remembered ?? { all: false }
	const capturesScreen =
		options.capturesScreen ??
		(registry
			? (name: string, input: unknown) => {
					const tool = registry.get(name) ?? registry.get(name.toLowerCase())
					return tool?.capturesScreen?.(input) === true
				}
			: () => false)
	/**
	 * Whether a shell call only makes, touches, removes, moves, copies or edits
	 * files, and every path it names is inside the roots: what `accept-edits`
	 * approves beyond `edit` and `write`. A catastrophic removal, a protected
	 * path, a path in a variable, a program nobody can name or a `sed` script
	 * that can run something is not that.
	 */
	const shellFileCommandsInRoots = async (tc: ToolCallSummary): Promise<boolean> => {
		const rootList = rootsNow()
		if (rootList.length === 0) return false
		if (
			tc.escalation !== undefined ||
			tc.isDestructive ||
			tc.requiresApproval === true ||
			tc.authorization?.explicitReview ||
			tc.authorization?.askRule
		) {
			return false
		}
		const tool = toolOf(tc.name)
		const argument = tool?.commandArgument
		if (tool === undefined || argument === undefined) return false
		const line = (tc.input as Record<string, unknown> | null)?.[argument]
		if (typeof line !== 'string') return false
		const dialect = tool.commandDialect?.({ sandboxed: false }) ?? 'sh'
		if (unknownProgramInLine(line, dialect) !== undefined) return false
		const reading = readShellLine(line, dialect)
		if (!reading.complete || reading.invocations.length === 0) return false
		for (const invocation of reading.invocations) {
			if (invocation.program === 'cd') continue
			if (!ACCEPT_EDITS_SHELL_COMMANDS.has(invocation.program)) return false
			if (invocation.program === 'sed' && !sedOnlyEdits(invocation.args)) return false
		}
		if (shellPathAccess(reading).uses.some((use) => use.unresolved)) return false
		const found = await shellEscalations(line, dialect, { roots: rootList, reviewOutside: true })
		return (
			found.outsidePaths.length === 0 &&
			found.protectedPaths.length === 0 &&
			found.dangerousRemoval === undefined
		)
	}

	/** What `accept-edits` approves without asking: edits, exempt reads and file commands inside the roots. */
	const acceptEditsAllows = async (tc: ToolCallSummary): Promise<boolean> =>
		!tc.authorization?.explicitReview &&
		tc.escalation === undefined &&
		!tc.isDestructive &&
		tc.requiresApproval !== true &&
		(ACCEPT_EDITS_TOOLS.has(tc.name) ||
			exempt(tc.name, tc.input) ||
			(await shellFileCommandsInRoots(tc)))

	/**
	 * Whether a rule's `allow` is one the classifier should not defer to: the
	 * rule covers a whole shell tool, or the line starts an interpreter or a
	 * launcher that runs whatever it is given, or the tool starts other agents.
	 * Judged on the call as well as the rule because a rule that names a
	 * program ("python") is a rule about a program that can run anything.
	 */
	const allowRuleTooWide = (tc: ToolCallSummary): boolean => {
		if (CLASSIFIER_DELEGATION_TOOLS.has(tc.name.toLowerCase())) return true
		const tool = toolOf(tc.name)
		const argument = tool?.commandArgument
		if (tool === undefined || argument === undefined) return false
		if (tc.authorization?.allowScope === 'tool') return true
		const line = (tc.input as Record<string, unknown> | null)?.[argument]
		if (typeof line !== 'string') return true
		const reading = readShellLine(line, tool.commandDialect?.({ sandboxed: false }) ?? 'sh')
		return (
			!reading.complete ||
			reading.invocations.some(
				(invocation) =>
					CLASSIFIER_LAUNCHERS.has(invocation.program) ||
					(CLASSIFIER_SCRIPT_RUNNERS.has(invocation.program) &&
						/^(?:run|run-script|exec|x|dlx|create)$/.test(invocation.args[0]?.value ?? '')),
			)
		)
	}

	/** Whether `classify` decides this call without the classifier: it would not be asked, or is plainly safe. */
	const neverSent = async (tc: ToolCallSummary): Promise<boolean> => {
		if (tc.authorization?.decision === 'allow' && !allowRuleTooWide(tc)) return true
		if (safeTools.has(tc.name.toLowerCase())) return true
		if (
			tc.escalation === undefined &&
			!tc.isDestructive &&
			!tc.authorization?.explicitReview &&
			exempt(tc.name, tc.input)
		) {
			return true
		}
		return acceptEditsAllows(tc)
	}

	return async (request, context?: ResumeContext): Promise<HITLResumeDecision> => {
		if (request.type !== 'tool_review') {
			return request.type === 'plan_approval' ? { action: 'approve_plan' } : { action: 'continue' }
		}
		// The one answer a person gives for this batch. The screen question
		// below shows the whole batch, so its yes also answers any question
		// the rest of this function would ask; nobody is asked twice.
		let answered: ToolReviewAnswer | undefined
		const ask = async (screenConsent?: true): Promise<ToolReviewAnswer> =>
			answered ??
			(prompt as ToolReviewPrompt)({
				sessionId: request.sessionId,
				turnId: request.turnId,
				toolCalls: request.toolCalls,
				...(screenConsent ? { screenConsent } : {}),
			})
		// The first look at the screen in a session is the operator's to allow:
		// what is on it goes to the model provider, and a screenshot reads as
		// harmlessly as a file read to every rule below. Asked once, in the
		// modes where a person decides; a rule that allowed the call already
		// said yes, and a call a rule denied will not run.
		const consent = options.screenConsent
		const sessionKey = String(request.sessionId ?? '')
		if (
			consent &&
			mode !== 'auto' &&
			!consent.sessions.has(sessionKey) &&
			request.toolCalls.some(
				(tc) =>
					tc.authorization?.decision !== 'allow' &&
					tc.authorization?.decision !== 'deny' &&
					capturesScreen(tc.name, tc.input),
			)
		) {
			if (mode === 'strict') return { action: 'reject_tools', feedback: STRICT_MODE_REFUSAL }
			if (!prompt) return { action: 'reject_tools', feedback: SCREEN_CONSENT_UNATTENDED_REFUSAL }
			const answer = await ask(true)
			if (answer.kind === 'reject') {
				return {
					action: 'reject_tools',
					feedback: answer.feedback ?? SCREEN_CONSENT_DECLINED_FEEDBACK,
					...(answer.declined ? { declined: answer.declined } : {}),
				}
			}
			consent.sessions.add(sessionKey)
			if (answer.kind === 'approve-all') remembered.all = true
			answered = answer
		}
		// The plan file, in `plan`: the one write that is not a change. A rule
		// that asked for review keeps the call in the batch, so it is asked.
		const isPlanFileWrite = (tc: ToolCallSummary): boolean =>
			mode === 'plan' &&
			options.planModeWrite?.(tc) === true &&
			tc.authorization?.decision !== 'deny'
		const reviewable = request.toolCalls.filter(
			(tc) => !(isPlanFileWrite(tc) && !tc.authorization?.explicitReview),
		)
		if (!batchNeedsReview(reviewable, exempt)) {
			return { action: 'approve_tools' }
		}
		// A batch of nothing but non-destructive file edits is the case
		// `accept-edits` exists for. One shell call in the same batch and the
		// whole batch asks — the operator reviews the batch as a unit, and a
		// prompt that showed only the shell command while the edits went
		// through beside it would be approving something it did not show.
		if (
			mode === 'accept-edits' &&
			(await Promise.all(request.toolCalls.map(acceptEditsAllows))).every(Boolean)
		) {
			return { action: 'approve_tools' }
		}
		// Ordinary reads were approved above. Remaining calls either change
		// state or carry explicit review; plan mode does not grant that authority.
		// Except a batch of reads whose only reason to be here is a path outside
		// the roots: plan mode is for reading, a read is what it tells the model
		// to do, and the question such a path gets is the same in every mode that
		// lets reads run. It goes on to that question below; `strict` still
		// refuses it, since no rule can approve a path outside the roots.
		if (
			mode === 'plan' &&
			!onlyReadsOutsideRoots(
				reviewable.filter((tc) => !isPlanFileWrite(tc)),
				exempt,
			)
		) {
			return { action: 'reject_tools', feedback: PLAN_MODE_REFUSAL }
		}
		if (mode === 'strict') return { action: 'reject_tools', feedback: STRICT_MODE_REFUSAL }
		if (isPermissive(mode)) {
			// A person's answer on the whole batch, as a decision. An escape is
			// confirmed by id only here, only for a person's yes.
			const askPerson = async (escapes: readonly string[]): Promise<HITLResumeDecision> => {
				const answer = await ask()
				if (answer.kind === 'reject') {
					return {
						action: 'reject_tools',
						feedback: answer.feedback ?? DECLINED_TOOL_CALL_FEEDBACK,
						...(answer.declined ? { declined: answer.declined } : {}),
					}
				}
				if (answer.kind === 'approve-all') remembered.all = true
				return {
					action: 'approve_tools',
					...(escapes.length > 0 ? { confirmedEscalations: escapes } : {}),
				}
			}
			const live = request.toolCalls.filter((tc) => tc.authorization?.decision !== 'deny')
			const escapes = live.filter((tc) => tc.escalation?.sandboxEscape === true).map((tc) => tc.id)
			if (mode === 'classify') {
				const classifier = options.classifier as AutoReviewClassifier
				const transcript = context?.transcript() ?? []
				for (const tc of live) {
					// The questions a person must answer are asked of a person, never of a model.
					if (isBypassImmune(tc) || (await neverSent(tc))) continue
					const decision = await classifier.review({
						call: tc,
						transcript,
						...(registry ? { tools: registry } : {}),
						...(context?.signal ? { signal: context.signal } : {}),
					})
					if (decision.verdict === 'allow') {
						transcriptTooLong = false
						continue
					}
					if (decision.verdict === 'too_long') {
						if (!transcriptTooLong) {
							transcriptTooLong = true
							options.onClassifierTranscriptTooLong?.()
							return { action: 'reject_tools', feedback: CLASSIFIER_TRANSCRIPT_TOO_LONG_FEEDBACK }
						}
						// Still too long after the host was told: nobody can judge it
						// automatically. A person decides, or the turn ends.
						if (!prompt) {
							return {
								action: 'abort',
								reason: 'auto mode stopped: the conversation is too long for the safety check',
							}
						}
						return askPerson(escapes)
					}
					transcriptTooLong = false
					if (decision.limitReached !== undefined) {
						options.onClassifierLimit?.({ limit: decision.limitReached, reason: decision.reason })
						if (!prompt) {
							return {
								action: 'abort',
								reason: `auto mode stopped: too many actions were blocked (${decision.reason})`,
							}
						}
						return askPerson(escapes)
					}
					return {
						action: 'reject_tools',
						feedback: autoReviewBlockedFeedback(decision.reason),
					}
				}
			}
			if (!live.some(isBypassImmune)) return { action: 'approve_tools' }
			if (!prompt) {
				const refusal = immuneRefusal(live, options.unattendedSandboxEscape === 'allow')
				if (refusal !== undefined) return { action: 'reject_tools', feedback: refusal }
				return {
					action: 'approve_tools',
					...(escapes.length > 0 ? { confirmedEscalations: escapes } : {}),
				}
			}
			return askPerson(escapes)
		}
		// A sandbox escape is asked about every time, in every mode that got
		// this far — `auto` and a remembered "approve all" included, because
		// both are answers somebody gave BEFORE this command existed. The
		// kernel refuses an escape an approval does not name by id, so the
		// ids below are the consent, and only a person (or an operator's
		// explicit unattended setting) supplies them.
		const escapes = request.toolCalls
			.filter((tc) => tc.escalation?.sandboxEscape === true)
			.map((tc) => tc.id)
		if (escapes.length > 0) {
			if (!prompt) {
				if (options.unattendedSandboxEscape !== 'allow') {
					return { action: 'reject_tools', feedback: SANDBOX_ESCAPE_UNATTENDED_REFUSAL }
				}
				// This opt-in confirms only the sandbox escape. A different call in
				// the batch, or another boundary on this same call, still needs a
				// person; the early return must not approve that boundary too.
				if (request.toolCalls.some(reachesAFloor)) {
					return { action: 'reject_tools', feedback: floorRefusal(request.toolCalls) }
				}
				if (request.toolCalls.some((tc) => (tc.escalation?.outsidePaths?.length ?? 0) > 0)) {
					return { action: 'reject_tools', feedback: OUTSIDE_ROOTS_UNATTENDED_REFUSAL }
				}
				if (request.toolCalls.some((tc) => tc.requiresApproval === true)) {
					return { action: 'reject_tools', feedback: REQUIRES_APPROVAL_UNATTENDED_REFUSAL }
				}
				if (request.toolCalls.some((tc) => tc.escalation?.unknownProgram !== undefined)) {
					return { action: 'reject_tools', feedback: UNKNOWN_PROGRAM_UNATTENDED_REFUSAL }
				}
				return { action: 'approve_tools', confirmedEscalations: escapes }
			}
			const answer = await ask()
			if (answer.kind === 'reject') {
				return {
					action: 'reject_tools',
					feedback: answer.feedback ?? DECLINED_TOOL_CALL_FEEDBACK,
					...(answer.declined ? { declined: answer.declined } : {}),
				}
			}
			// "Approve all" still latches for the calls that follow; it never
			// reaches the next escape, which is asked about above regardless.
			if (answer.kind === 'approve-all') remembered.all = true
			return { action: 'approve_tools', confirmedEscalations: escapes }
		}
		// A write to a protected path, or a removal of something catastrophic,
		// is a question for a person, every time, in every mode that got this
		// far: `auto` and a remembered "approve all" were answers given before
		// the call existed. With nobody to ask it is refused, not approved.
		if (request.toolCalls.some(reachesAFloor)) {
			if (!prompt) return { action: 'reject_tools', feedback: floorRefusal(request.toolCalls) }
			const answer = await ask()
			if (answer.kind === 'reject') {
				return {
					action: 'reject_tools',
					feedback: answer.feedback ?? DECLINED_TOOL_CALL_FEEDBACK,
					...(answer.declined ? { declined: answer.declined } : {}),
				}
			}
			// Latches for the ordinary calls that follow, never for the next floor.
			if (answer.kind === 'approve-all') remembered.all = true
			return { action: 'approve_tools' }
		}
		// A path outside the roots is a question for a person, every time,
		// like an escape: `auto` and a remembered "approve all" were answers
		// given about tools, before this path was named, and neither saw it.
		// With nobody to ask it is refused, not approved.
		if (request.toolCalls.some((tc) => (tc.escalation?.outsidePaths?.length ?? 0) > 0)) {
			if (!prompt) return { action: 'reject_tools', feedback: OUTSIDE_ROOTS_UNATTENDED_REFUSAL }
			const answer = await ask()
			if (answer.kind === 'reject') {
				return {
					action: 'reject_tools',
					feedback: answer.feedback ?? DECLINED_TOOL_CALL_FEEDBACK,
					...(answer.declined ? { declined: answer.declined } : {}),
				}
			}
			// Latches for the ordinary calls that follow, never for the next path.
			if (answer.kind === 'approve-all') remembered.all = true
			return { action: 'approve_tools' }
		}
		// A call the tool itself declared always needs a person's approval is
		// asked about every time, in every mode that got this far — `auto`
		// and a remembered "approve all" included, for the same reason an
		// escape or a path outside the roots is: the tool author's
		// declaration travels with the tool, and no rule, mode or remembered
		// grant was ever an answer to IT specifically.
		if (request.toolCalls.some((tc) => tc.requiresApproval === true)) {
			if (!prompt) return { action: 'reject_tools', feedback: REQUIRES_APPROVAL_UNATTENDED_REFUSAL }
			const answer = await ask()
			if (answer.kind === 'reject') {
				return {
					action: 'reject_tools',
					feedback: answer.feedback ?? DECLINED_TOOL_CALL_FEEDBACK,
					...(answer.declined ? { declined: answer.declined } : {}),
				}
			}
			if (answer.kind === 'approve-all') remembered.all = true
			return { action: 'approve_tools' }
		}
		// A command whose own program name is decided at runtime is a
		// question for a person, every time, for the same reason: no rule, no
		// remembered grant and no unattended mode can vouch for a program
		// nobody can read the name of before it runs. There is no
		// "unattended allow" setting for this the way there is for a sandbox
		// escape — an operator who wants this can only write the program
		// name literally.
		if (request.toolCalls.some((tc) => tc.escalation?.unknownProgram !== undefined)) {
			if (!prompt) return { action: 'reject_tools', feedback: UNKNOWN_PROGRAM_UNATTENDED_REFUSAL }
			const answer = await ask()
			if (answer.kind === 'reject') {
				return {
					action: 'reject_tools',
					feedback: answer.feedback ?? DECLINED_TOOL_CALL_FEEDBACK,
					...(answer.declined ? { declined: answer.declined } : {}),
				}
			}
			if (answer.kind === 'approve-all') remembered.all = true
			return { action: 'approve_tools' }
		}
		if (mode === 'auto' || !prompt || remembered.all) {
			return { action: 'approve_tools' }
		}
		// Every call a person would be asked about is one a skill loaded in
		// this turn pre-approved (`allowed-tools`). Reached only in `prompt`
		// and `accept-edits`: `plan` and `strict` refused above, so a skill's
		// word never outranks either, and the kernel only marks a call no
		// deny, explicit ask, destructive flag or escalation stands behind.
		// One unmarked call and the whole batch is asked about, as always.
		const needsPerson = request.toolCalls.filter(
			(tc) =>
				tc.authorization?.explicitReview ||
				tc.isDestructive ||
				tc.escalation !== undefined ||
				!(
					exempt(tc.name, tc.input) ||
					(mode === 'accept-edits' && ACCEPT_EDITS_TOOLS.has(tc.name))
				),
		)
		const skillsHonoured = options.skillGrants !== 'ignore'
		if (
			answered === undefined &&
			needsPerson.length > 0 &&
			needsPerson.every((tc) => isHookGranted(tc) || (skillsHonoured && isSkillGranted(tc)))
		) {
			const byHook = needsPerson.filter(isHookGranted).map((tc) => tc.id)
			const bySkill = needsPerson.filter((tc) => !isHookGranted(tc)).map((tc) => tc.id)
			return {
				action: 'approve_tools',
				...(bySkill.length > 0 ? { skillGranted: bySkill } : {}),
				...(byHook.length > 0 ? { hookGranted: byHook } : {}),
			}
		}
		const answer = await ask()
		switch (answer.kind) {
			case 'approve':
				return { action: 'approve_tools' }
			case 'approve-all':
				remembered.all = true
				return { action: 'approve_tools' }
			case 'reject':
				return {
					action: 'reject_tools',
					feedback: answer.feedback ?? DECLINED_TOOL_CALL_FEEDBACK,
					...(answer.declined ? { declined: answer.declined } : {}),
				}
		}
	}
}

/**
 * The mode as an `ApprovalPolicy`, named after itself so a durable log can
 * say which one approved a call. Swap it on a turn's `SessionApprovalPolicy`
 * to change mode without ending the turn.
 */
export function createReviewPolicy(options: ReviewPolicyOptions = {}): ApprovalPolicy {
	const mode: ReviewMode = options.mode ?? (options.prompt ? 'prompt' : 'auto')
	return { name: mode, handler: createReviewHandler({ ...options, mode }) }
}
