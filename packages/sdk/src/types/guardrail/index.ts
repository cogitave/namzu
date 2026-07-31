import type { RunId } from '../ids/index.js'
import type { Message } from '../message/index.js'

/**
 * Guardrails inspect what goes INTO a run and what comes OUT of it.
 *
 * namzu had three good gates on tool calls — probe veto, `VerificationGate`,
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

export type InputGuardrailSpec = InputGuardrail | NamedGuardrail<InputGuardrail>
export type OutputGuardrailSpec = OutputGuardrail | NamedGuardrail<OutputGuardrail>
