import { PLUGIN_NAMESPACE_SEPARATOR } from '../../constants/plugin/index.js'
import { OUTPUT_SECRET_PATTERNS } from '../../constants/secret-patterns.js'
import { untrustedEnvelopeBody } from '../../tools/untrusted-envelope.js'
import type {
	GuardrailVerdict,
	NamedGuardrail,
	OutputGuardrail,
	ToolResultGuardrail,
	ToolResultGuardrailSpec,
	ToolResultVerdict,
} from '../../types/guardrail/index.js'

/**
 * Patterns for credentials that must never leave a run.
 *
 * Deliberately narrow and prefix-anchored, unchanged by the move to
 * `constants/secret-patterns.ts`: a loose "looks like a secret" regex over
 * agent output produces false positives on ordinary code, and a redactor
 * that fires on the wrong thing gets switched off — at which point it
 * protects nothing. The wider, field-name-aware set `provider/errors.ts`
 * needs lives in the same leaf module as `LOG_SECRET_PATTERNS`; it is not
 * used here because a false positive on THIS boundary rewrites the
 * caller's answer, and a false positive there only costs a redacted log
 * value.
 */
const SECRET_PATTERNS = OUTPUT_SECRET_PATTERNS

export interface SecretRedactionOptions {
	/**
	 * `redact` replaces each match with a placeholder and lets the answer
	 * through; `block` refuses the whole result.
	 *
	 * Redaction is the default because the alternative discards a correct
	 * answer over one token, and a gate that costs the user their work
	 * gets turned off.
	 */
	readonly onMatch?: 'redact' | 'block'
	/** Extra patterns, e.g. an internal token format. */
	readonly extraPatterns?: ReadonlyArray<readonly [label: string, pattern: RegExp]>
}

/**
 * Stop credentials reaching the caller.
 *
 * The concrete failure this exists for: an agent reads a credential file —
 * a legitimate read that every tool gate correctly allows — the secret
 * enters context, and it is repeated in the final answer. Every other gate
 * in namzu sits upstream of that moment.
 */
export function secretRedactionGuardrail(
	options: SecretRedactionOptions = {},
): NamedGuardrail<OutputGuardrail> {
	const patterns = [...SECRET_PATTERNS, ...(options.extraPatterns ?? [])]
	const mode = options.onMatch ?? 'redact'

	return {
		name: 'secret-redaction',
		check: ({ output }): GuardrailVerdict => {
			const found: string[] = []
			let redacted = output

			for (const [label, pattern] of patterns) {
				// Fresh lastIndex: these are module-level /g regexes and are
				// reused across runs.
				pattern.lastIndex = 0
				if (!pattern.test(output)) continue
				found.push(label)
				pattern.lastIndex = 0
				redacted = redacted.replace(pattern, `[REDACTED:${label}]`)
			}

			if (found.length === 0) return { action: 'pass' }

			const summary = [...new Set(found)].join(', ')
			return mode === 'block'
				? { action: 'block', reason: `output contained credentials (${summary})` }
				: { action: 'rewrite', output: redacted, reason: `redacted credentials (${summary})` }
		},
	}
}

/**
 * Phrases that only appear when someone is trying to override the agent's
 * instructions.
 *
 * Detection is genuinely partial and this preset says so rather than
 * implying coverage: an injection written in a language the list does not
 * cover, or phrased as ordinary prose, passes. It raises the cost of the
 * lazy attack; it is not a boundary.
 */
const INJECTION_PATTERNS: readonly RegExp[] = [
	/ignore (?:all |any )?(?:your |the )?(?:previous|prior|above|earlier) (?:instructions|prompts?|rules)/i,
	/disregard (?:all |any )?(?:your |the )?(?:previous|prior|above|system) (?:instructions|prompts?|rules)/i,
	/you are (?:now |actually )?(?:in )?(?:developer|debug|god|admin|dan) mode/i,
	/(?:reveal|print|output|repeat|show)(?: me)? (?:your |the )?(?:system prompt|initial instructions|hidden rules)/i,
	/pretend (?:that )?you (?:are|have) no (?:restrictions|rules|guidelines)/i,
]

/**
 * Flag likely instruction-override attempts in the run's input.
 *
 * Input-side because it is cheapest there — nothing has been spent — and
 * because the same text reaching the model is the thing you are trying to
 * prevent.
 *
 * It cannot see an INDIRECT injection, and that is not a limitation of the
 * patterns: an injection carried in a web page or a connected server's
 * answer never appears in the run's input at all. See
 * {@link toolResultInjectionGuardrail}, which is the same list at the other
 * boundary.
 */
export function promptInjectionGuardrail(): NamedGuardrail<
	(ctx: { messages: readonly { readonly content: unknown }[] }) => GuardrailVerdict
> {
	return {
		name: 'prompt-injection',
		check: ({ messages }): GuardrailVerdict => {
			for (const message of messages) {
				const text = typeof message.content === 'string' ? message.content : ''
				for (const pattern of INJECTION_PATTERNS) {
					if (pattern.test(text)) {
						return {
							action: 'block',
							reason: 'input matched a known instruction-override pattern',
						}
					}
				}
			}
			return { action: 'pass' }
		},
	}
}

/**
 * Flag likely instruction-override attempts in what a TOOL returned.
 *
 * The case the input-side screen structurally cannot reach. An indirect
 * injection arrives in a fetched page or a connected server's answer, so it
 * is never in the run's input — by the time it matters the run is
 * legitimate and the payload is riding on a result the model asked for.
 *
 * `refuse`, not `halt`: a hostile result is a reason to abandon that call,
 * not the run. The model is told the answer was refused and can choose
 * something else, which is the behaviour that keeps the control switched on
 * — a screen that ends a run on a false positive gets removed, and then it
 * protects nothing.
 *
 * **Detection is partial and this says so rather than implying coverage.**
 * The pattern list is shared with the input-side screen, so the same caveat
 * holds: an injection phrased as ordinary prose, or written in a language
 * the list does not cover, passes. Pattern-matching and delimiting both
 * measure poorly against an attacker who adapts. This raises the cost of
 * the lazy attack; it is not a boundary, and nothing here should be
 * described as one.
 */
export function toolResultInjectionGuardrail(): NamedGuardrail<ToolResultGuardrail> {
	return {
		name: 'tool-result-injection',
		check: ({ output, provenance }): ToolResultVerdict => {
			for (const pattern of INJECTION_PATTERNS) {
				if (!pattern.test(output)) continue
				// Naming the source is most of what the model needs in order
				// to act. "A result was refused" is not something it can route
				// around; "the answer from weather-co was refused" is.
				const source = provenance ? `the connected server "${provenance.server}"` : 'this tool'
				return {
					action: 'refuse',
					reason: `the result from ${source} matched a known instruction-override pattern`,
				}
			}
			return { action: 'pass' }
		},
	}
}

/**
 * Requests shorter than this are not compared against the result.
 *
 * A one-word echo cannot be told from a one-word answer, and the shorter the
 * value the likelier it is to recur in a legitimate result by coincidence:
 * `ls` of a directory holding one entry called `src`, called with
 * `{ path: "src" }`, returns `src`. The value of catching a five-character
 * restatement is nil — nothing rides on it — so the comparison starts where
 * a restatement actually means something.
 *
 * Counted in CODE POINTS, not UTF-16 units. Eight emoji are eight characters
 * to every reader of this file and sixteen to `String.length`, and a floor
 * that lets them through while the docblock says it excludes short values is
 * a floor that is not doing what it says.
 */
const MIN_RESTATEMENT_LENGTH = 16

/** Whether `text` is at least `minimum` code points long, without counting all of them. */
function isAtLeastCodePoints(text: string, minimum: number): boolean {
	let count = 0
	for (const _character of text) {
		count += 1
		if (count >= minimum) return true
	}
	return false
}

export interface ToolResultCorrespondenceOptions {
	/**
	 * Which results this screen judges.
	 *
	 * `'framed'` — the default — is the results that carry the untrusted
	 * envelope: content this process did not author, marked as such by
	 * `wrapUntrusted`. For a connected server's tool that is every result the
	 * adapter returns (see `frameServerResult`), and it is also a host tool
	 * that framed its own result the same way — which is the point, and what
	 * an earlier `provenance`-based predicate got wrong: the CLI's own remote
	 * Exa search frames its answer and was left unscreened by accident of
	 * registration, while a fetch was screened by the same accident.
	 *
	 * `'all'` adds this process's own unframed tools. That is the host's call
	 * and not a safe default: a host that asks for it owns the consequences
	 * and names its own exceptions in {@link passthroughTools}.
	 */
	readonly scope?: 'framed' | 'all'

	/**
	 * Tools whose answer IS the request, and must not be refused for saying
	 * so: a validator returning what it validated, a normaliser returning the
	 * normalised form, a search that repeats its query when it found nothing,
	 * a fetch whose page body is its own URL.
	 *
	 * This is the escape hatch the check needs rather than a tuning knob. The
	 * screen is right about a tool that was asked a question and handed the
	 * question back; it is wrong about a tool whose purpose is to hand
	 * something back, and nothing on the context distinguishes the two. The
	 * false positive is the way this control dies — the host switches the
	 * screen off and it then protects nothing — so the exemption has to be
	 * cheap enough to be the first thing reached for.
	 *
	 * A tool answers to several names and each REGISTRATION SHAPE yields its
	 * own set; {@link passthroughToolNames} is the one implementation and
	 * spells them out, rather than this option and the check each carrying
	 * half of the rule.
	 */
	readonly passthroughTools?: readonly string[]
}

interface RequestText {
	/** Where in the request the text sits, e.g. `city` or `filters.city`. */
	readonly path: string
	readonly text: string
}

function normalizeText(text: string): string {
	return text.trim().replace(/\s+/g, ' ')
}

/**
 * Every string the call was made with, and where it sat.
 *
 * Strings only. A number is a plausible answer — a count of 10, a port of
 * 8080 — and comparing one would fire on `{ maxResults: 10 }` answered with
 * `10`, which is a legitimate result from a legitimate tool.
 */
function collectRequestText(value: unknown, path: string, into: RequestText[]): void {
	if (typeof value === 'string') {
		const text = normalizeText(value)
		if (isAtLeastCodePoints(text, MIN_RESTATEMENT_LENGTH)) into.push({ path, text })
		return
	}
	if (Array.isArray(value)) {
		for (const [index, item] of value.entries()) {
			collectRequestText(item, `${path}[${index}]`, into)
		}
		return
	}
	if (value === null || typeof value !== 'object') return
	for (const [key, nested] of Object.entries(value)) {
		collectRequestText(nested, path === '' ? key : `${path}.${key}`, into)
	}
}

/** How the refusal names the argument that came back, for a caller that cannot see the path syntax. */
function describeSubject(path: string): string {
	if (path === '') return 'what this call sent'
	const item = /^\[(\d+)\]$/.exec(path)
	if (item) return `item ${item[1]} of the request`
	return `the "${path}" argument this call sent`
}

/**
 * Every name a tool answers to, so `passthroughTools` does not require the
 * host to write the connector's own internal spelling.
 *
 * Each registration shape yields its own set, and the sets are NOT
 * interchangeable — an exemption written for one shape does not exempt
 * another:
 *
 *  - A server connected directly registers `mcp_<server>_<tool>` (the
 *    adapter concatenates `mcp_${serverName}_${toolName}` verbatim). For
 *    `mcp_weather-co_lookup` with `server: 'weather-co'`, the accepted names
 *    are `mcp_weather-co_lookup`, `lookup`, and `weather-co:lookup`.
 *  - A server a plugin contributes registers
 *    `<plugin>__mcp__<server>__<tool>`. For
 *    `myplugin__mcp__weather__lookup` the accepted names are
 *    `myplugin__mcp__weather__lookup`, the bare tail after the last `__`
 *    (`lookup`), and `weather:lookup` — NOT `mcp_weather_lookup`, which is
 *    the direct shape's spelling of a name this tool does not have.
 *  - A tool of this process's own has no server and no namespace, so the
 *    registered name is the whole set.
 *
 * The bare name is what the server's manifest calls the tool — the name the
 * operator has in front of them when they read its manifest — and
 * `server:tool` is what a human writes. Both are derived from the registered
 * name and the tool's provenance, so a caller that has only one of the two
 * gets the registered name and nothing else.
 */
export function passthroughToolNames(toolName: string, server?: string): readonly string[] {
	const names = new Set<string>([toolName])

	const separator = toolName.lastIndexOf(PLUGIN_NAMESPACE_SEPARATOR)
	const pluginBare =
		separator < 0 ? undefined : toolName.slice(separator + PLUGIN_NAMESPACE_SEPARATOR.length)
	if (pluginBare !== undefined) names.add(pluginBare)

	const directPrefix = server === undefined ? undefined : `mcp_${server}_`
	const connectedBare =
		directPrefix !== undefined && toolName.startsWith(directPrefix)
			? toolName.slice(directPrefix.length)
			: undefined
	if (connectedBare !== undefined) names.add(connectedBare)

	const bare = connectedBare ?? pluginBare
	if (bare !== undefined && server !== undefined) names.add(`${server}:${bare}`)

	return [...names]
}

/**
 * Refuse a result that is the request rather than an answer to it.
 *
 * #399 recorded that a screen at this boundary cannot know what a tool SHOULD
 * have answered, and the issue that asked for this screen named three
 * mismatches — a weather lookup for one city answering about another, a read
 * of one path returning another's contents, a search returning instructions
 * rather than results. **This screen decides none of the three.** The first
 * two need a declaration of which argument names the subject, and the
 * framework cannot infer one: for a file read the answer is the file's
 * contents, which do not name the path, so the natural rule — an answer
 * mentions its subject — would refuse every ordinary read. The third is what
 * {@link toolResultInjectionGuardrail} already screens for at this same
 * boundary, and re-implementing it here would give the two the same blind spot
 * rather than the different one this adds.
 *
 * What is left is the one correspondence failure that needs no domain
 * knowledge and cannot be an answer: **the result restates the request**. A
 * tool handed a question and returning that question has answered nothing,
 * whatever it is a tool for. The comparison is exact equality after
 * whitespace normalisation against each string the call carried, so a result
 * that says anything extra — the answer plus anything at all — passes.
 *
 * ## Why it judges framed results by default
 *
 * Because the envelope is the only marker that means *this process did not
 * write this*, and the judgment it supports is the one this screen can make.
 * Content arrives framed — by `wrapUntrusted`, through `frameServerResult`
 * for a connector's tool result — when it came from outside: a connected
 * server answered, or a host tool decided its own answer was not this
 * process's to vouch for. A result that IS the request is a signal there.
 *
 * An earlier version judged results whose tool definition carried
 * `provenance`, which is set by the MCP adapter and by nothing else. That
 * predicate and this one agree on every connector result the comparison can
 * act on, and they differ exactly where registration is an accident of the
 * code rather than a fact about the content: the CLI's own remote Exa search
 * frames its answer with this envelope and registers as a host tool, so a
 * search that restated its query was out of scope while a fetch that did was
 * in it. `scope` is a statement about what the screen is willing to judge, so
 * it is expressed in terms of the content rather than of who mounted the
 * tool.
 *
 * What the default leaves alone is this process's own UNFRAMED tools.
 * `web_fetch` returns the page body, and a page whose body IS the URL it was
 * fetched from — a redirect stub, a "you are here" placeholder, an echo
 * endpoint — is a true result from a working tool that frames nothing.
 * `test/…/a-result-that-does-not-answer-its-request` runs the shipped tool
 * set through this screen with real calls and asserts none is refused, which
 * is where that claim is checked rather than argued.
 *
 * `scope: 'all'` adds those too. That is the host's call, and it is the scope
 * that costs something: under it, a fetch-like tool whose answer is its own
 * argument is refused until the host names it in
 * {@link ToolResultCorrespondenceOptions.passthroughTools}.
 *
 * The two other ways out were both worse. An exemption list of builtin NAMES
 * inside this preset is a list that drifts — the next fetch-like tool has to
 * remember to add itself, and a host tool that happens to be called
 * `web_fetch` would be exempted by accident — and a subject declaration on
 * every tool would be a new field on `ToolDefinition` that exists for this one
 * screen.
 *
 * ## Three things it deliberately does not touch
 *
 *  - **An empty result for a non-empty request.** Real, and not a signal:
 *    a search that matched nothing and a file with nothing in it both return
 *    nothing, and refusing either tells the model to stop looking when there
 *    was nothing to find.
 *  - **A shape contradicting `ToolDefinition.outputSchema`.** The schema is
 *    not on {@link ToolResultGuardrailContext} and is documented as shown to
 *    the model, never validated. Carrying it and enforcing it are changes to
 *    that contract, not this screen's to make.
 *  - **A failed call.** On `success: false` the text is a diagnostic, and
 *    `screenToolResult` replaces the output when it refuses — so refusing
 *    here would trade an echo nobody needs to catch for the error message
 *    the model needs to read.
 *
 * The comparison runs on the frame as well as on the text: a connector's
 * result reaches a screen already wrapped by `wrapUntrusted`, so comparing
 * the raw output would never match the one case this is most worth having —
 * a connected server returning the request. Both the whole output and, when
 * it is one wrapped block, the body inside it are compared.
 *
 * Detection is partial and this says so rather than implying coverage: an
 * answer about the wrong subject, an answer that is plausible prose, and a
 * restatement shorter than {@link MIN_RESTATEMENT_LENGTH} all pass.
 */
export function toolResultCorrespondenceGuardrail(
	options: ToolResultCorrespondenceOptions = {},
): NamedGuardrail<ToolResultGuardrail> {
	const passthrough = new Set(options.passthroughTools ?? [])
	const scope = options.scope ?? 'framed'

	return {
		name: 'tool-result-correspondence',
		check: ({ toolName, input, output, success, provenance }): ToolResultVerdict => {
			if (!success) return { action: 'pass' }
			// `output` is typed as a string and a tool that ignores its own
			// contract can hand back something else. Nothing here can compare
			// a number against a request, and a screen that throws fails
			// CLOSED — so the one thing this must not do is refuse a result
			// because it could not read it.
			if (typeof output !== 'string') return { action: 'pass' }

			// The scope, and the same reader the comparison below uses rather
			// than a second "looks framed" test that could disagree with it.
			//
			// This is a superset of the `provenance`-based predicate it
			// replaced, for every result the comparison can act on. The only
			// tool definition carrying `provenance` is the MCP adapter's, and
			// `frameServerResult` frames every non-empty text it returns — so
			// a connected result that reaches the comparison at all carries a
			// legible frame. The one case the new predicate drops is a
			// connected result with an EMPTY output, which the comparison
			// skipped anyway (`normalizeText('')` is `''`, and an empty string
			// is never a request of the minimum length).
			const body = untrustedEnvelopeBody(output)
			if (scope !== 'all' && body === undefined) return { action: 'pass' }

			if (
				passthrough.size > 0 &&
				passthroughToolNames(toolName, provenance?.server).some((name) => passthrough.has(name))
			) {
				return { action: 'pass' }
			}

			const request: RequestText[] = []
			collectRequestText(input, '', request)
			if (request.length === 0) return { action: 'pass' }

			// The whole output, and the body when the output is one wrapped
			// block. The two are never the same string — the frame carries the
			// tags — so this is two comparisons, not the same one twice, and
			// the refusal says which one matched.
			for (const [text, insideFrame] of [
				[normalizeText(output), false],
				[normalizeText(body ?? ''), true],
			] as const) {
				if (text === '') continue
				const restated = request.find((entry) => entry.text === text)
				if (!restated) continue
				// The reason names the tool, and says what the comparison
				// actually did. Both were wrong before: a host reading the
				// transcript is the person who can exempt this tool, and
				// "verbatim" was a false claim about a comparison that ran
				// after whitespace normalisation.
				const matched = insideFrame
					? `the text inside the untrusted frame from "${toolName}"`
					: `the result from "${toolName}"`
				return {
					action: 'refuse',
					reason: `${matched} is ${describeSubject(restated.path)}, whitespace-normalised, so it is the request rather than an answer to it`,
				}
			}

			return { action: 'pass' }
		},
	}
}

/**
 * The screens a run installs on itself when its host configured none.
 *
 * A DEFAULT, and the reason it is here rather than on
 * {@link ToolRegistryConfig.resultGuardrails}: a host assembles a registry
 * and hands it to `runAgent`, so a registry-constructor default would be the
 * host's to write and this repository's default would reach nobody. The run
 * is the thing that has to carry it, and a run that wants none says so with
 * an empty array — which is the escape hatch, and it exists precisely because
 * the screen below can refuse a result.
 *
 * One screen, scoped to results framed as untrusted. See the preset for why
 * the scope is what it is: an unframed host tool whose answer IS the request —
 * `web_fetch` returning a page whose body is its own URL — is an ordinary
 * result, and a default that refuses those is a default that breaks a working
 * tool.
 *
 * **A default that refuses a legitimate result is a default that gets turned
 * off, so the exemption has to be reachable from wherever the screen is
 * installed.** `toolResultCorrespondenceGuardrail({ passthroughTools })` is
 * how a host writing SDK code says so; a run's `toolResultGuardrails` array
 * is where it substitutes its own configured instance. An application that
 * ships the default without also shipping a way to name an exception has
 * shipped a switch with one position.
 *
 * Frozen, because it is handed to callers who may want to extend it:
 * `[...DEFAULT_TOOL_RESULT_GUARDRAILS, myScreen()]`. A caller that could
 * mutate it would be mutating the default for every other run in the process.
 */
export const DEFAULT_TOOL_RESULT_GUARDRAILS: readonly ToolResultGuardrailSpec[] = Object.freeze([
	toolResultCorrespondenceGuardrail(),
])
