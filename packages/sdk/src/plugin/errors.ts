import { TOOL_NAME_MAX_LENGTH } from '../constants/tools/index.js'

/**
 * A component of a composed tool name (the plugin name, an MCP server name, or a
 * leaf tool name) is not usable as a namespace component.
 *
 * Components may contain `[a-zA-Z0-9_-]` but never the `__` separator itself:
 * that exclusion is what makes composition injective, so that `a__b__c` splits
 * back into exactly one (plugin, server, tool) triple.
 */
export class PluginComponentNameError extends Error {
	readonly pluginName: string
	readonly component: string
	readonly role: 'plugin' | 'mcp-server' | 'tool'

	constructor(pluginName: string, role: 'plugin' | 'mcp-server' | 'tool', component: string) {
		const reason = component.includes('__')
			? 'must not contain "__" (that sequence is the namespace separator)'
			: 'must match [a-zA-Z0-9_-] and be non-empty'
		super(
			`Plugin "${pluginName}": ${role} name "${component}" ${reason}. Rename the ${role} and reinstall the plugin.`,
		)
		this.name = 'PluginComponentNameError'
		this.pluginName = pluginName
		this.component = component
		this.role = role
	}
}

/**
 * The name composed from a plugin's components is longer than a provider will
 * accept for a function name. Truncating would reintroduce collisions, so this
 * is a loud failure: one of the components has to get shorter.
 */
export class PluginToolNameTooLongError extends Error {
	readonly pluginName: string
	readonly composedName: string

	constructor(pluginName: string, composedName: string, components: readonly string[]) {
		const longest = [...components].sort((a, b) => b.length - a.length)[0] ?? ''
		super(
			`Plugin "${pluginName}": composed tool name "${composedName}" is ${composedName.length} characters, over the ${TOOL_NAME_MAX_LENGTH}-character provider limit. ` +
				`Shorten a component — "${longest}" is the longest at ${longest.length} characters. Names are never truncated, because truncation would let two tools collide.`,
		)
		this.name = 'PluginToolNameTooLongError'
		this.pluginName = pluginName
		this.composedName = composedName
	}
}

/**
 * An MCP `env` value referenced a variable that is not set in the environment.
 * Thrown rather than substituted-empty, so that a mis-provisioned deployment
 * fails at `enable()` instead of handing the MCP server a blank credential.
 */
export class EnvVarNotFoundError extends Error {
	readonly variableName: string

	constructor(variableName: string) {
		super(
			`Environment variable "${variableName}" is referenced by a plugin MCP config but is not set. Set it, or use $\${${variableName}} to pass the literal text through.`,
		)
		this.name = 'EnvVarNotFoundError'
		this.variableName = variableName
	}
}

/** An MCP `env` value contains a malformed interpolation reference. */
export class EnvInterpolationError extends Error {
	constructor(value: string, detail: string) {
		super(`Invalid interpolation in "${value}": ${detail}`)
		this.name = 'EnvInterpolationError'
	}
}
