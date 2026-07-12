import { EnvInterpolationError, EnvVarNotFoundError } from './errors.js'

/**
 * `$${VAR}` (escape, matched first) or `${VAR}` / `${env:VAR}` (reference).
 */
const INTERPOLATION_PATTERN = /\$\$\{([^}]*)\}|\$\{([^}]*)\}/g

/**
 * Expand `${VAR}` and `${env:VAR}` references in a plugin-supplied value against
 * `env`. `$${VAR}` is an escape that yields the literal text `${VAR}`.
 *
 * A reference to a variable that is not set throws rather than expanding to an
 * empty string: a plugin's MCP server getting a blank API key is a
 * misconfiguration that should stop `enable()`, not surface later as an opaque
 * auth failure from the server.
 *
 * Applied only to MCP `env` values — never to `command` or `args`, which the
 * stdio transport logs verbatim at connect time.
 */
export function interpolateEnvVars(
	value: string,
	env: Readonly<Record<string, string | undefined>>,
): string {
	return value.replace(INTERPOLATION_PATTERN, (_match, escaped: string, reference: string) => {
		if (escaped !== undefined) return `\${${escaped}}`

		const variableName = reference.startsWith('env:') ? reference.slice('env:'.length) : reference
		if (variableName.length === 0) {
			throw new EnvInterpolationError(value, 'empty variable name')
		}

		const resolved = env[variableName]
		if (resolved === undefined) {
			throw new EnvVarNotFoundError(variableName)
		}
		return resolved
	})
}
