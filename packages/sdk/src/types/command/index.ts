/**
 * Commands a HOST offers its operator — not tools a model can call.
 *
 * There was no seam at all. The whole vocabulary was a literal array in one
 * host's TUI module, over a union shaped by that TUI's own concerns
 * (`repick`, `expand`, `login`, `clear`), and the coupling had already
 * escaped: two non-TUI commands import that array from React-adjacent code
 * to build a name list, for facts the kernel owns.
 *
 * **Never model-visible.** No descriptor is handed to a provider, no
 * dispatch path reaches the LLM, and nothing here is a `ToolDefinition`.
 * That separation is the whole point: a `/tasks` readout is a question the
 * operator asked, and turning it into a tool would let the model call it,
 * spend a turn on it, and put its output in the transcript as if the model
 * had discovered something.
 */

/**
 * What a command produces, structured rather than rendered.
 *
 * The SDK formats nothing. A TUI draws a table, a JSON command prints a
 * document, a web host renders a component — and a pre-rendered string
 * would force all three to parse prose back into the fields it was built
 * from. Returning the fields is the only shape that serves a host the
 * kernel has never seen.
 */
export type HostCommandOutcome =
	| { readonly kind: 'report'; readonly title: string; readonly rows: readonly HostCommandRow[] }
	| { readonly kind: 'prompt'; readonly text: string }
	| { readonly kind: 'ack'; readonly message: string }
	/**
	 * The command exists and cannot answer right now.
	 *
	 * Different from an empty `report`, and different from `undefined`. An
	 * empty report says "I looked and there are none"; this says "I could
	 * not look", and a host that conflates them shows an operator a
	 * confident zero for a question nobody answered.
	 */
	| { readonly kind: 'refused'; readonly reason: string }

/** One line of a report. Keys are column names; a host decides the order. */
export type HostCommandRow = Readonly<Record<string, string | number | boolean | null>>

export interface HostCommandContext {
	/** Whatever followed the command name, unparsed. */
	readonly args: readonly string[]
}

/**
 * A command as it is registered, handler included.
 *
 * `args` is JSON Schema rather than Zod, for the same reason
 * `ToolDefinition.modelInputSchema` is: a descriptor has to survive being
 * sent to a host that is not this process, and a Zod schema does not
 * serialize.
 */
export interface HostCommandDescriptor {
	readonly name: string
	readonly description: string
	/** One line a host can show beside the name. */
	readonly hint?: string
	/** JSON Schema for the arguments, when the command takes any. */
	readonly args?: Record<string, unknown>
	handler(ctx: HostCommandContext): Promise<HostCommandOutcome> | HostCommandOutcome
}

/** The same descriptor with the handler removed, safe to serialize. */
export type SerializableHostCommand = Omit<HostCommandDescriptor, 'handler'>
