import {
	passthroughToolNames,
	toolResultCorrespondenceGuardrail,
	toolResultInjectionGuardrail,
} from '@namzu/sdk'
import type { ToolResultGuardrailSpec } from '@namzu/sdk'

/**
 * The screens an operator may name in `toolResultScreens`.
 *
 * A config file cannot carry a function, so the CLI's vocabulary is a list of
 * NAMES and this module is the one place a name becomes a screen. Two things
 * follow from that. The list is the operator's whole vocabulary — a host with
 * a screen of its own uses the SDK, not this key — and an unknown name is a
 * refused config rather than an ignored entry, because a screen that is
 * silently not installed is worse than one that was never asked for.
 */
export const TOOL_RESULT_SCREEN_NAMES = ['correspondence', 'injection'] as const

export type ToolResultScreenName = (typeof TOOL_RESULT_SCREEN_NAMES)[number]

/**
 * What a screen accepts beside its name.
 *
 * The escape hatch the shipped default needs rather than a tuning knob. The
 * correspondence screen refuses a result that IS the request, which is a true
 * signal and also a description of what a normaliser, a validator, a
 * "nothing found, here is your query" search and a redirect-stub fetch
 * legitimately return. An operator who cannot exempt those turns the screen
 * off, and a screen that is off protects nothing — so the exception has to be
 * reachable from the file the screen was configured in.
 *
 * Inside the config's own vocabulary, so a name is refused rather than
 * ignored like every other value this file reads. See
 * {@link unmatchedPassthroughTools} for the other half: a name that is
 * well-formed but names no tool.
 */
export interface ToolResultScreenOptions {
	/**
	 * Tool names exempt from the correspondence screen.
	 *
	 * A tool answers to several of them — the registered `mcp_weather-co_lookup`,
	 * the server's own `lookup`, and `weather-co:lookup` — and
	 * `passthroughToolNames` in the SDK is the one implementation of that
	 * rule. An exemption written for a shape the tool does not have is
	 * reported rather than ignored; see {@link unmatchedPassthroughTools}.
	 */
	readonly passthroughTools?: readonly string[]
}

/**
 * A screen in `toolResultScreens`: its name, or its name plus the options
 * that screen understands.
 *
 * The option sits with the screen because it is the screen's: a second
 * screen's options are a second entry, not a second top-level key, and an
 * options object can never end up attached to a screen that was not
 * installed — the entry that carries it is the entry that installs it.
 */
export type ToolResultScreenConfig =
	| ToolResultScreenName
	| ({ readonly name: ToolResultScreenName } & ToolResultScreenOptions)

/**
 * Which option keys each screen understands.
 *
 * Read by the loader to refuse an option a screen does not take. Without it
 * `{ "name": "injection", "passthroughTools": [...] }` would parse, install,
 * and do nothing — the shape of a config key that lies about being in force.
 */
export const TOOL_RESULT_SCREEN_OPTION_KEYS: Record<ToolResultScreenName, readonly string[]> = {
	correspondence: ['passthroughTools'],
	injection: [],
}

/** Whether a value out of a config file names a screen this CLI can install. */
export function isToolResultScreenName(value: string): value is ToolResultScreenName {
	return (TOOL_RESULT_SCREEN_NAMES as readonly string[]).includes(value)
}

/** The screen an entry configures, whether it was written as a name or as an object. */
export function toolResultScreenName(entry: ToolResultScreenConfig): ToolResultScreenName {
	return typeof entry === 'string' ? entry : entry.name
}

/**
 * Built on demand rather than held in a table: a screen is cheap and
 * stateless, and a shared instance would be one more thing a caller could
 * mutate out from under a later turn.
 */
function buildScreen(entry: ToolResultScreenConfig): ToolResultGuardrailSpec {
	const name = toolResultScreenName(entry)
	switch (name) {
		case 'correspondence':
			return toolResultCorrespondenceGuardrail(
				typeof entry === 'string' || entry.passthroughTools === undefined
					? {}
					: { passthroughTools: entry.passthroughTools },
			)
		case 'injection':
			return toolResultInjectionGuardrail()
	}
}

/**
 * Names to screens, in the operator's order.
 *
 * `undefined` — the key absent — returns `undefined`, which is the kernel's
 * default rather than "none": the difference between not configuring a screen
 * and turning one off is the difference between a default and a decision, and
 * collapsing them would make the key's absence silently mean the opposite of
 * what a reader expects.
 *
 * An entry written with options is the same screen built with those options,
 * so an exemption is expressible without the SDK. That this was NOT true in
 * the first version of this key — the docs said excluding a tool by name "is
 * a decision that needs the reason next to it", and there was no key for it —
 * is the defect this closes: the reason next to it is not worth a screen the
 * operator switches off instead.
 */
export function resolveToolResultScreens(
	entries: readonly ToolResultScreenConfig[] | undefined,
): readonly ToolResultGuardrailSpec[] | undefined {
	return entries?.map(buildScreen)
}

/** Every tool name an operator exempted, deduplicated, in the order written. */
export function configuredPassthroughTools(
	entries: readonly ToolResultScreenConfig[] | undefined,
): readonly string[] {
	const names: string[] = []
	for (const entry of entries ?? []) {
		if (typeof entry === 'string') continue
		for (const name of entry.passthroughTools ?? []) {
			if (!names.includes(name)) names.push(name)
		}
	}
	return names
}

/**
 * The names an operator wrote that no tool answers to.
 *
 * Checked against the tools a session actually mounts, and against every
 * spelling each of those answers to ({@link passthroughToolNames}), because a
 * report that used a stricter rule than the screen would accuse a working
 * exemption of being dead and send the operator to change something that was
 * already right.
 *
 * This exists because an exemption that matches nothing is the silent
 * failure this file's neighbours are all written against: the config parses,
 * the screen installs, the operator believes a tool is exempt, and the
 * refusal they were trying to stop comes back with nothing to explain it.
 */
export function unmatchedPassthroughTools(
	configured: readonly string[],
	tools: readonly { readonly name: string; readonly server?: string }[],
): readonly string[] {
	if (configured.length === 0) return []
	const answers = new Set<string>()
	for (const tool of tools) {
		for (const name of passthroughToolNames(tool.name, tool.server)) answers.add(name)
	}
	return configured.filter((name) => !answers.has(name))
}
