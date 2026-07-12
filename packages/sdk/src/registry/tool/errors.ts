import { TOOL_NAME_MAX_LENGTH } from '../../constants/tools/index.js'

/**
 * A tool was registered under a name a strict provider would reject. The
 * registry key and the model-visible name are the same string, so an invalid
 * name is caught at registration rather than as a 400 on the next model call.
 */
export class InvalidToolNameError extends Error {
	readonly toolName: string

	constructor(toolName: string, detail?: string) {
		super(
			`Tool name "${toolName}" is not valid: ${
				detail ??
				`must match [a-zA-Z0-9_-] and be at most ${TOOL_NAME_MAX_LENGTH} characters (providers reject anything else)`
			}`,
		)
		this.name = 'InvalidToolNameError'
		this.toolName = toolName
	}
}

/**
 * `register(id, tool)` was called with an id that differs from `tool.name`.
 * The model is shown `tool.name` but the registry looks the call up by `id`, so
 * a divergence makes the tool uncallable.
 */
export class ToolNameKeyMismatchError extends Error {
	readonly registryKey: string
	readonly toolName: string

	constructor(registryKey: string, toolName: string) {
		super(
			`Tool registered under key "${registryKey}" but its name is "${toolName}". The model is shown the name and calls it back, so the key must equal the name.`,
		)
		this.name = 'ToolNameKeyMismatchError'
		this.registryKey = registryKey
		this.toolName = toolName
	}
}
