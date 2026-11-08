/**
 * The one place the interactive session's system prompt is assembled.
 *
 * A new turn and a resumed delegated turn both call `composeSessionSystemPrompt`
 * with the facts they hold; neither lists sections of its own. A section a
 * resumed turn lacks is lacking because the input says so (its toolset has no
 * workflow tool, so `workflowOffered` is false), never because a second list
 * forgot it.
 *
 * Which audience gets which section, written down once:
 *
 * | Section                   | Session turn | Resumed turn | Sub-agent |
 * |---------------------------|--------------|--------------|-----------|
 * | identity                  | yes          | yes          | no, own role |
 * | working doctrine          | yes          | yes          | yes (inside its role) |
 * | browser/desktop routing   | yes          | yes          | no        |
 * | delegation doctrine       | if the Agent tool is not withheld | same | no, a child does not delegate |
 * | workflow doctrine         | if the workflow tool is offered | no, a resumed turn is not offered it | no |
 * | pal block                 | yes          | yes          | no        |
 * | conversation evidence     | if enabled   | if enabled   | no        |
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
import { WORKFLOW_DOCTRINE } from '../integrations/workflows/doctrine.js'
import {
	NAMZU_DELEGATION_DOCTRINE,
	NAMZU_PLAN_FILE_DOCTRINE,
	NAMZU_PLAN_MODE_DOCTRINE,
	NAMZU_WORKING_DOCTRINE,
} from './doctrine.js'
import { AGENT_LAUNCH_TOOL, NAMZU_IDENTITY } from './identity.js'

/**
 * Said only where a person is typing at the session. They can run any line
 * themselves by starting it with `!`, and a command that needs their own
 * authority is better run that way than described.
 */
export const SHELL_ESCAPE_GUIDANCE =
	'When the person has to run a command themselves, give it as one exact line they can paste and tell them they can run it here by typing `!` before it. A `!` line runs in this session, in the working directory, with their own authority, and its output comes back to you. It cannot answer a prompt: for a command that asks for a password or an interactive sign-in, tell them to run it in another terminal instead. Do not suggest it for a command you can run with your own tools.'

export const DEFERRED_TOOL_GUIDANCE =
	'The deferred_tools catalogue is a discovery snapshot, not live availability status. The current runtime tool schemas are authoritative: call a tool directly when its schema is visible, even if the catalogue lists it as deferred. Only when a needed deferred tool schema is absent, call search_tools with its exact name to load it. Loading a tool does not change its permissions.'

export interface SessionPromptInput {
	/** Pre-rendered optional blocks, in the order they are read. */
	readonly browserDesktopRouting?: string | null | undefined
	readonly palBlock?: string | undefined
	readonly environment?: string | undefined
	/** True when the Agent tool is sent to this turn. */
	readonly delegationAvailable: boolean
	/** True when the workflow tool is in this turn's toolset. */
	readonly workflowOffered: boolean
	/** The session's workflow size guideline, said beside the workflow doctrine; empty for none. */
	readonly workflowSizeAdvice?: string | undefined
	readonly conversationEvidence?: string | undefined
	/** The memory section, present only for a session that holds the tool it teaches. */
	readonly memoryGuidance?: string | undefined
	readonly shellEscapeGuidance?: string | undefined
	/** True when a tool in this turn's roster is deferred behind `search_tools`. */
	readonly toolsDeferred: boolean
	/** See {@link SessionPromptTurn.planInReminders}. */
	readonly planInReminders?: boolean
	readonly permissionMode?: string | undefined
	/** The plan file path when the session has a plan mode. */
	readonly planPath?: string | undefined
	readonly extraSystem?: string | undefined
	readonly systemNote?: string | undefined
	readonly skillsOverflowNote?: string | null | undefined
}

/** What a session knows when it builds a turn's prompt, whichever path builds it. */
export interface SessionPromptFacts {
	readonly browserDesktopRouting?: string | null | undefined
	readonly palBlock?: string | undefined
	readonly environment?: string | undefined
	readonly withheldTools?: readonly string[] | undefined
	readonly conversationSessions?: unknown
	/** Written once at session start, so the prefix stays byte-stable. */
	readonly memoryGuidance?: string | undefined
	/** For a session with a person typing at it; see `SHELL_ESCAPE_GUIDANCE`. */
	readonly shellEscapeGuidance?: string | undefined
	readonly toolLoading?: 'eager' | 'deferred' | undefined
	/** True when any tool in the toolset this turn sends is deferred. */
	readonly anyToolDeferred: boolean
	readonly planPath?: string | undefined
	readonly skillsOverflowNote?: string | null | undefined
	readonly workflowSizeAdvice?: string | undefined
}

/** What differs between one turn and another that holds the same facts. */
export interface SessionPromptTurn {
	/** A resumed turn runs over the session's toolset, which has no workflow tool. */
	readonly workflowOffered: boolean
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
	return {
		browserDesktopRouting: facts.browserDesktopRouting,
		palBlock: facts.palBlock,
		environment: facts.environment,
		delegationAvailable: !facts.withheldTools?.includes(AGENT_LAUNCH_TOOL),
		workflowOffered: turn.workflowOffered,
		conversationEvidence: facts.conversationSessions ? CONVERSATION_EVIDENCE_GUIDANCE : undefined,
		memoryGuidance: facts.memoryGuidance,
		shellEscapeGuidance: facts.shellEscapeGuidance,
		toolsDeferred: facts.toolLoading === 'deferred' || facts.anyToolDeferred,
		planInReminders: turn.planInReminders,
		permissionMode: turn.permissionMode,
		planPath: facts.planPath,
		extraSystem: turn.extraSystem,
		systemNote: turn.systemNote,
		skillsOverflowNote: facts.skillsOverflowNote,
		workflowSizeAdvice: facts.workflowSizeAdvice,
	}
}

export function composeSessionSystemPrompt(input: SessionPromptInput): string | undefined {
	const sections: (string | null | undefined)[] = [
		NAMZU_IDENTITY,
		NAMZU_WORKING_DOCTRINE,
		input.browserDesktopRouting,
		// Advice on delegating, for a turn that has the Agent tool: a run whose
		// job withholds it would only be told how to use a tool it was not sent.
		!input.delegationAvailable ? undefined : NAMZU_DELEGATION_DOCTRINE,
		input.workflowOffered
			? [WORKFLOW_DOCTRINE, input.workflowSizeAdvice].filter(Boolean).join('\n\n')
			: undefined,
		input.palBlock,
		input.conversationEvidence,
		input.memoryGuidance,
		input.shellEscapeGuidance,
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
