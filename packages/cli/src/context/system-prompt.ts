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
 * | Section                   | Session turn | Resumed turn | Resident step | Sub-agent |
 * |---------------------------|--------------|--------------|---------------|-----------|
 * | identity                  | yes          | yes          | yes           | no, own role |
 * | working doctrine          | yes          | yes          | no, resident context carries it | yes (inside its role) |
 * | browser/desktop routing   | yes          | yes          | yes           | no        |
 * | delegation doctrine       | if the Agent tool is not withheld | same | no | no, a child does not delegate |
 * | workflow doctrine         | if the workflow tool is offered | no, a resumed turn is not offered it | no | no |
 * | pal block                 | yes          | yes          | no            | no        |
 * | conversation evidence     | if enabled   | if enabled   | if enabled    | no        |
 * | deferred-tool guidance    | if any tool is deferred | same | same | no |
 * | plan doctrine             | under `plan` | under `plan` | no            | no        |
 * | environment               | yes          | yes          | no, it rides in the dynamic block | child reads its own |
 * | extra system / note       | yes          | yes, the same skills prompt and note a turn gets | no | no |
 * | skills overflow note      | yes          | yes          | yes           | no        |
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

export const DEFERRED_TOOL_GUIDANCE =
	'Before using a tool listed under deferred_tools, call search_tools with its exact name to load it. Loading a tool does not change its permissions.'

export interface SessionPromptInput {
	/** A resident step carries its own context; it gets the identity and little else. */
	readonly resident: boolean
	/** Pre-rendered optional blocks, in the order they are read. */
	readonly browserDesktopRouting?: string | null | undefined
	readonly palBlock?: string | undefined
	readonly environment?: string | undefined
	/** True when the Agent tool is sent to this turn. */
	readonly delegationAvailable: boolean
	/** True when the workflow tool is in this turn's toolset. */
	readonly workflowOffered: boolean
	readonly conversationEvidence?: string | undefined
	/** True when a tool in this turn's roster is deferred behind `search_tools`. */
	readonly toolsDeferred: boolean
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
	readonly toolLoading?: 'eager' | 'deferred' | undefined
	/** True when any tool in the toolset this turn sends is deferred. */
	readonly anyToolDeferred: boolean
	readonly planPath?: string | undefined
	readonly skillsOverflowNote?: string | null | undefined
}

/** What differs between one turn and another that holds the same facts. */
export interface SessionPromptTurn {
	readonly resident: boolean
	/** A resumed turn runs over the session's toolset, which has no workflow tool. */
	readonly workflowOffered: boolean
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
		resident: turn.resident,
		browserDesktopRouting: facts.browserDesktopRouting,
		palBlock: facts.palBlock,
		environment: facts.environment,
		delegationAvailable: !facts.withheldTools?.includes(AGENT_LAUNCH_TOOL),
		workflowOffered: turn.workflowOffered,
		conversationEvidence: facts.conversationSessions ? CONVERSATION_EVIDENCE_GUIDANCE : undefined,
		toolsDeferred: facts.toolLoading === 'deferred' || facts.anyToolDeferred,
		permissionMode: turn.permissionMode,
		planPath: facts.planPath,
		extraSystem: turn.extraSystem,
		systemNote: turn.systemNote,
		skillsOverflowNote: facts.skillsOverflowNote,
	}
}

export function composeSessionSystemPrompt(input: SessionPromptInput): string | undefined {
	const { resident } = input
	const sections: (string | null | undefined)[] = [
		NAMZU_IDENTITY,
		resident ? undefined : NAMZU_WORKING_DOCTRINE,
		input.browserDesktopRouting,
		// Advice on delegating, for a turn that has the Agent tool: a run whose
		// job withholds it would only be told how to use a tool it was not sent.
		resident || !input.delegationAvailable ? undefined : NAMZU_DELEGATION_DOCTRINE,
		input.workflowOffered ? WORKFLOW_DOCTRINE : undefined,
		resident ? undefined : input.palBlock,
		input.conversationEvidence,
		// Whenever anything is deferred: a deferred tool the model was never
		// told how to load is a tool it does not have.
		input.toolsDeferred ? DEFERRED_TOOL_GUIDANCE : undefined,
		// Present only while the turn runs under `plan`. A mode change is rare,
		// so the cached prefix it re-keys is a price paid once per switch.
		!resident && input.permissionMode === 'plan'
			? input.planPath
				? NAMZU_PLAN_FILE_DOCTRINE
				: NAMZU_PLAN_MODE_DOCTRINE
			: undefined,
		resident ? undefined : input.environment,
		resident ? undefined : input.extraSystem,
		resident ? undefined : input.systemNote,
		input.skillsOverflowNote,
	]
	return sections.filter((s): s is string => Boolean(s)).join('\n\n') || undefined
}
