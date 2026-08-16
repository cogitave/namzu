import type { RunId } from '../ids/index.js'
import type { Message } from '../message/index.js'
import type { ToolProvenance } from '../tool/index.js'

/**
 * Guardrails inspect what goes INTO a run and what comes OUT of it.
 *
 * namzu had three good gates on tool calls — probe veto, `AuthorizationGate`,
 * HITL review — and they all point the same way: they protect the world
 * from the agent. Nothing protected the user from the agent's own output,
 * and nothing looked at the prompt before the run started.
 *
 * The concrete failure: an agent reads a credential file, the read is
 * allowed (it is a legitimate file), the secret enters context, and it is
 * repeated in the final answer. Every existing gate is upstream of that
 * and none of them fire.
 */

export interface InputGuardrailContext {
	readonly runId: RunId
	/** The messages the run is about to start with. */
	readonly messages: readonly Message[]
	/** The assembled system prompt, when there is one. */
	readonly systemPrompt?: string
}

export interface OutputGuardrailContext {
	readonly runId: RunId
	/** The run's final assistant text. */
	readonly output: string
	/** Full message history, for a guardrail that needs the conversation. */
	readonly messages: readonly Message[]
}

/**
 * What a guardrail decided.
 *
 * `rewrite` matters as much as `tripwire`: a PII policy usually wants to
 * redact an account number, not throw the whole answer away. A gate that
 * can only abort forces every redaction use case to be implemented
 * somewhere else.
 */
export type GuardrailVerdict =
	| { readonly action: 'pass' }
	| { readonly action: 'block'; readonly reason: string }
	| { readonly action: 'rewrite'; readonly output: string; readonly reason?: string }

export type InputGuardrail = (
	ctx: InputGuardrailContext,
) => GuardrailVerdict | Promise<GuardrailVerdict>

export type OutputGuardrail = (
	ctx: OutputGuardrailContext,
) => GuardrailVerdict | Promise<GuardrailVerdict>

/** Convenience: a named guardrail, so a block can say which rule tripped. */
export interface NamedGuardrail<T> {
	readonly name: string
	readonly check: T
}

/**
 * What a guardrail sees when a tool has produced a result.
 *
 * The two above bracket the RUN. This one sits at the tool boundary, which
 * is the only place a result can be examined before the model reads it:
 * the registry returns to the executor, the executor applies the output
 * budget and spills what is over it, and compaction summarises later still.
 * So screening here is upstream of both by construction rather than by
 * ordering — a summariser does not distinguish trusted from untrusted text,
 * and content carried into a summary outlives the result it came from.
 *
 * `provenance` is the point. A connector's result is framed with the
 * server's name (see `wrapUntrusted`), and a screen that can only read the
 * value cannot tell a remote server's words from a first-party tool's.
 */
export interface ToolResultGuardrailContext {
	/** The tool as the registry knows it. */
	readonly toolName: string
	/** Validated input the tool was called with. */
	readonly input: unknown
	/** The text the model would read. */
	readonly output: string
	/** Whether the tool itself reported success. */
	readonly success: boolean
	/**
	 * Who produced the tool, when it was not this process. Absent means
	 * host-defined; present names the connected server.
	 */
	readonly provenance?: ToolProvenance
}

/**
 * What a guardrail decided about a tool result.
 *
 * Deliberately NOT {@link GuardrailVerdict}. There, `block` ends the run —
 * it is the only thing it can mean when the subject is the run's input or
 * its final answer. At a tool boundary the useful refusal is usually the
 * other one: fail this call, tell the model why, and let it choose
 * something else. Reusing the word would give one spelling two meanings
 * across boundaries, and a host that shared a function between them would
 * get the wrong one silently.
 *
 * Hence two refusals rather than one:
 *
 *  - `refuse` — recoverable. The `tool_use` fails with the reason in place
 *    of the output. Not blank and not dropped: a model shown an empty
 *    result concludes the tool found nothing, which is a different fact and
 *    invites the retry loop the refusal was meant to prevent.
 *  - `halt` — terminal, for what must not be survived.
 *
 * `rewrite` is for REDACTION — a credential or an account number that
 * should not enter context — and this is the last boundary where it can be
 * removed before it does. It is **not** for neutralising an injection:
 * editing an attack presumes you understood the payload well enough to
 * defang it, and the systems that screen for attacks block instead. The two
 * are the same mechanism and only the discipline separates them, which is
 * why it is written here rather than left to be inferred.
 */
export type ToolResultVerdict =
	| { readonly action: 'pass' }
	| { readonly action: 'refuse'; readonly reason: string }
	| { readonly action: 'halt'; readonly reason: string }
	| { readonly action: 'rewrite'; readonly output: string; readonly reason?: string }

export type ToolResultGuardrail = (
	ctx: ToolResultGuardrailContext,
) => ToolResultVerdict | Promise<ToolResultVerdict>

export type ToolResultGuardrailSpec = ToolResultGuardrail | NamedGuardrail<ToolResultGuardrail>

export type InputGuardrailSpec = InputGuardrail | NamedGuardrail<InputGuardrail>
export type OutputGuardrailSpec = OutputGuardrail | NamedGuardrail<OutputGuardrail>
