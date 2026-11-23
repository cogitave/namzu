/**
 * The one place the interactive session's system prompt is assembled.
 *
 * A new turn and a resumed delegated turn both call `composeSessionSystemPrompt`
 * with the facts they hold; neither lists sections of its own. A section a
 * resumed turn lacks is lacking because the input says so, never because a
 * second list forgot it.
 *
 * Which audience gets which section, written down once:
 *
 * | Section                   | Session turn | Resumed turn | Sub-agent |
 * |---------------------------|--------------|--------------|-----------|
 * | identity                  | yes          | yes          | no, own role |
 * | working doctrine          | yes          | yes          | yes (inside its role) |
 * | browser/desktop routing   | yes          | yes          | no        |
 * | delegation doctrine       | if the Agent tool is not withheld | same | no, a child does not delegate |
 * | pal block                 | yes          | yes          | no        |
 * | conversation evidence     | if enabled   | if enabled   | no        |
 * | where-files-go guidance  | yes          | yes          | no        |
 * | memory guidance           | if the memory tool is mounted | same | taught in its own prompt, when it holds the tool |
 * | deferred-tool guidance    | if any tool is deferred | same | no |
 * | plan doctrine             | no: the plan-mode reminder carries it (no plan file: under `plan`) | under `plan` | no |
 * | environment               | yes          | yes          | child reads its own |
 * | extra system / note       | yes          | yes, the same skills prompt and note a turn gets | no |
 * | skills overflow note      | no, the skill-list reminder carries it | yes | no |
 *
 * Sub-agents are built by `integrations/subagents/runtime.ts` from a role
 * prompt of their own; they share the working doctrine by import and nothing
 * else here (a Pal builds its own persona prompt in `pals/agent-session.ts`,
 * and a scheduled run is an ordinary session turn that withholds tools), because a child cannot see the parent conversation, does not
 * delegate, and is not offered the workflow tool.
 */

import { CONVERSATION_EVIDENCE_GUIDANCE } from '../integrations/sessions/conversation-search.js'
import { toolOnOffer } from '../permissions/tool-flags.js'
import {
	NAMZU_DELEGATION_DOCTRINE,
	NAMZU_PLAN_FILE_DOCTRINE,
	NAMZU_PLAN_MODE_DOCTRINE,
	NAMZU_WORKING_DOCTRINE,
	NAMZU_WORKING_DOCTRINE_WITHOUT_CLOSING,
} from './doctrine.js'
import { AGENT_LAUNCH_TOOL, NAMZU_IDENTITY } from './identity.js'

/**
 * Said only where a person is typing at the session. They can run any line
 * themselves by starting it with `!`, and a command that needs their own
 * authority is better run that way than described.
 */
export const SHELL_ESCAPE_GUIDANCE =
	'When the person has to run a command themselves, give it as one exact line they can paste and tell them they can run it here by typing `!` before it. A `!` line runs in this session, in the working directory, with their own authority, and its output comes back to you. It cannot answer a prompt: for a command that asks for a password or an interactive sign-in, tell them to run it in another terminal instead. Do not suggest it for a command you can run with your own tools.'

/**
 * Said only where `ask_user_question` is mounted for a host that draws it as a card.
 * It names no other tool and never suggests the shell as a way to ask.
 */
export const ASK_USER_QUESTION_GUIDANCE =
	"When a decision is the person's to make, or you need something only they know, ask with `ask_user_question` instead of guessing, and never through a shell command: the shell has no keyboard. Ask only when you are blocked on it, put the option you recommend first and mark it, and keep options short. The person can always answer in their own words. Anything they type goes to you and into the conversation record, so never ask for a password or a secret."

/**
 * How to go about a task on a website. Said only where the browser tools are
 * mounted and can run, so a session without them never reads it.
 */
export const BROWSER_WEB_TASK_GUIDANCE = [
	'Working on a website with the browser tools:',
	"- Go straight to the address the task names, or use the site's own search box, before clicking through menus.",
	'- A navigation already returns the page; take a snapshot only when you need a fresh look. Do one action and read what came back (its Effect line) before the next one. Confirm each step on the page, not by the action having run.',
	'- If an action changed nothing twice, do not repeat it: pick another element, scroll, wait for the text, or find another way in.',
	'- Read pages with the browser only. Do not fetch them with the shell (curl, wget) or hand them to a delegate. If the page does not show what you need to confirm, say so in your report instead of looking for it with the shell, other tools or a delegate.',
	'- A value the page itself shows for this task (a code displayed in another tab, a sample entry) may be typed where that same page asks for it. Passwords and one-time codes are never typed by you: the browser refuses those fields even for a demo value the page displays. Do not wait for the person.',
	'- When a step cannot be done or confirmed (a sign-in, or an action that still shows no change after one other way), carry on with every other step the page lets you do (a step listed after it is still yours to try unless the page blocks it) instead of stopping or retrying, then report which step was left and why.',
	'- Finish by checking the result on the page and report what the page showed.',
].join('\n')

export const DEFERRED_TOOL_GUIDANCE =
	'A tool listed under deferred_tools has no schema until it is loaded: call search_tools with its exact name first, then call the tool. A tool whose schema you can already see needs no search. Loading does not change its permissions.'

// Said under a section that names tools a deferring session lists but does not send.
const BROWSER_DEFERRED_NOTE =
	'The browser tools (browser, browser_act) are deferred: load them with search_tools, by exact name, before the first call.'
const CONVERSATION_DEFERRED_NOTE =
	'search_conversation and read_conversation are deferred: load them with search_tools, by exact name, before the first call.'
const MEMORY_DEFERRED_NOTE =
	'The memory tools (save_memory, update_memory, search_memory, read_memory) are deferred: load the one you need with search_tools, by exact name, before the first call.'

export interface SessionPromptInput {
	/** Pre-rendered optional blocks, in the order they are read. */
	readonly browserDesktopRouting?: string | null | undefined
	/** {@link BROWSER_WEB_TASK_GUIDANCE}, when the browser tools are mounted and can run. */
	readonly browserWebTask?: string | null | undefined
	readonly palBlock?: string | undefined
	readonly environment?: string | undefined
	/** True when the Agent tool is sent to this turn. */
	readonly delegationAvailable: boolean
	readonly conversationEvidence?: string | undefined
	/** The memory section, present only for a session that holds the tool it teaches. */
	readonly memoryGuidance?: string | undefined
	readonly shellEscapeGuidance?: string | undefined
	/** {@link ASK_USER_QUESTION_GUIDANCE}, when the question tool is mounted for a card host. */
	readonly questionGuidance?: string | undefined
	/** The "Where files go" section; constant, so it never changes mid-session. */
	readonly filePlacementGuidance?: string | undefined
	/** True when a tool in this turn's roster is deferred behind `search_tools`. */
	readonly toolsDeferred: boolean
	/** See {@link SessionPromptTurn.planInReminders}. */
	readonly planInReminders?: boolean
	readonly permissionMode?: string | undefined
	/** The plan file path when the session has a plan mode. */
	readonly planPath?: string | undefined
	readonly extraSystem?: string | undefined
	readonly systemNote?: string | undefined
	/** See {@link SessionPromptFacts.systemOverride}. */
	readonly systemOverride?: string | undefined
	readonly skillsOverflowNote?: string | null | undefined
	/** See {@link SessionPromptFacts.closingSummary}. */
	readonly closingSummary?: boolean | undefined
	/** See {@link SessionPromptFacts.outputStyle}. */
	readonly outputStyle?: string | undefined
	/** See {@link SessionPromptFacts.attribution}. */
	readonly attribution?: string | undefined
}

/** What a session knows when it builds a turn's prompt, whichever path builds it. */
export interface SessionPromptFacts {
	readonly browserDesktopRouting?: string | null | undefined
	readonly browserWebTask?: string | null | undefined
	readonly palBlock?: string | undefined
	readonly environment?: string | undefined
	readonly withheldTools?: readonly string[] | undefined
	/** `--tools`: the only tools on offer; absent offers every tool. */
	readonly onlyTools?: readonly string[] | undefined
	/** `--system-prompt`: replaces the composed sections; see `composeSessionSystemPrompt`. */
	readonly systemOverride?: string | undefined
	readonly conversationSessions?: unknown
	/** Written once at session start, so the prefix stays byte-stable. */
	readonly memoryGuidance?: string | undefined
	/** For a session with a person typing at it; see `SHELL_ESCAPE_GUIDANCE`. */
	readonly shellEscapeGuidance?: string | undefined
	/** See {@link SessionPromptInput.questionGuidance}. */
	readonly questionGuidance?: string | undefined
	/** See {@link SessionPromptInput.filePlacementGuidance}. */
	readonly filePlacementGuidance?: string | undefined
	readonly toolLoading?: 'eager' | 'deferred' | undefined
	/** True when any tool in the toolset this turn sends is deferred. */
	readonly anyToolDeferred: boolean
	readonly planPath?: string | undefined
	readonly skillsOverflowNote?: string | null | undefined
	/** `false` leaves the closing rule out of the working rules; absent keeps them whole. */
	readonly closingSummary?: boolean | undefined
	/** A reply-style note the person wrote; absent or empty adds nothing. */
	readonly outputStyle?: string | undefined
	/** Text commits and pull request descriptions end with; absent or empty adds nothing. */
	readonly attribution?: string | undefined
}

/** What differs between one turn and another that holds the same facts. */
export interface SessionPromptTurn {
	/**
	 * The plan-mode reminder carries the plan file's instructions, so the
	 * prefix does not hold them (and does not change when the mode does).
	 */
	readonly planInReminders?: boolean
	readonly permissionMode?: string | undefined
	readonly extraSystem?: string | undefined
	readonly systemNote?: string | undefined
}

/**
 * The composer's input for one turn. Both assembly sites go through this, so
 * the flags derived from the session's options (delegation, evidence, deferred
 * tools) have one definition and cannot drift between a new turn and a resume.
 */
export function sessionPromptInput(
	facts: SessionPromptFacts,
	turn: SessionPromptTurn,
): SessionPromptInput {
	const toolsDeferred = facts.toolLoading === 'deferred' || facts.anyToolDeferred
	const withNote = <T extends string | null | undefined>(section: T, note: string): T =>
		section && toolsDeferred ? (`${section}\n${note}` as T) : section
	return {
		browserDesktopRouting: facts.browserDesktopRouting,
		browserWebTask: withNote(facts.browserWebTask, BROWSER_DEFERRED_NOTE),
		palBlock: facts.palBlock,
		environment: facts.environment,
		delegationAvailable:
			!facts.withheldTools?.includes(AGENT_LAUNCH_TOOL) &&
			toolOnOffer(facts.onlyTools, AGENT_LAUNCH_TOOL),
		systemOverride: facts.systemOverride,
		conversationEvidence: withNote(
			facts.conversationSessions ? CONVERSATION_EVIDENCE_GUIDANCE : undefined,
			CONVERSATION_DEFERRED_NOTE,
		),
		memoryGuidance: withNote(facts.memoryGuidance, MEMORY_DEFERRED_NOTE),
		shellEscapeGuidance: facts.shellEscapeGuidance,
		questionGuidance: facts.questionGuidance,
		filePlacementGuidance: facts.filePlacementGuidance,
		toolsDeferred,
		planInReminders: turn.planInReminders,
		permissionMode: turn.permissionMode,
		planPath: facts.planPath,
		extraSystem: turn.extraSystem,
		systemNote: turn.systemNote,
		skillsOverflowNote: facts.skillsOverflowNote,
		closingSummary: facts.closingSummary,
		outputStyle: facts.outputStyle,
		attribution: facts.attribution,
	}
}

/** The person's reply style, as a note that sits under the working rules. */
export function replyStyleNote(style: string | undefined): string | undefined {
	const text = style?.trim()
	if (!text) return undefined
	return `### Reply style\nThe person asked for replies to read this way: ${text}\nFollow it for wording and layout. It never overrides the working rules above or what the person asks for in a message.`
}

/** The text commits and pull request descriptions end with. */
export function attributionNote(text: string | undefined): string | undefined {
	const line = text?.trim()
	if (!line) return undefined
	return `### Commit and pull request text\n- When you write a commit message or a pull request description at the person's request, end it with this text on its own lines, exactly as given:\n${line}`
}

export function composeSessionSystemPrompt(input: SessionPromptInput): string | undefined {
	// `--system-prompt`: the person's text stands where Namzu's identity, working
	// rules, guidance and environment sections would. What this turn itself adds
	// (a mode note, a hook's notice) still follows it.
	if (input.systemOverride !== undefined) {
		return (
			[input.systemOverride, input.extraSystem, input.systemNote]
				.filter((s): s is string => Boolean(s))
				.join('\n\n') || undefined
		)
	}
	const sections: (string | null | undefined)[] = [
		NAMZU_IDENTITY,
		input.closingSummary === false
			? NAMZU_WORKING_DOCTRINE_WITHOUT_CLOSING
			: NAMZU_WORKING_DOCTRINE,
		replyStyleNote(input.outputStyle),
		attributionNote(input.attribution),
		input.browserDesktopRouting,
		input.browserWebTask,
		// Advice on delegating, for a turn that has the Agent tool: a run whose
		// job withholds it would only be told how to use a tool it was not sent.
		!input.delegationAvailable ? undefined : NAMZU_DELEGATION_DOCTRINE,
		input.palBlock,
		input.conversationEvidence,
		input.filePlacementGuidance,
		input.memoryGuidance,
		input.shellEscapeGuidance,
		input.questionGuidance,
		// Whenever anything is deferred: a deferred tool the model was never
		// told how to load is a tool it does not have.
		input.toolsDeferred ? DEFERRED_TOOL_GUIDANCE : undefined,
		// Present only while the turn runs under `plan`, and only where no
		// plan-mode reminder carries it: with a plan file the reminder is the
		// single source, so a toggle leaves the cached prefix alone. A turn with
		// no reminder channel (a resumed one) keeps it here.
		input.permissionMode === 'plan' && !(input.planPath && input.planInReminders)
			? input.planPath
				? NAMZU_PLAN_FILE_DOCTRINE
				: NAMZU_PLAN_MODE_DOCTRINE
			: undefined,
		input.environment,
		input.extraSystem,
		input.systemNote,
		input.skillsOverflowNote,
	]
	return sections.filter((s): s is string => Boolean(s)).join('\n\n') || undefined
}
