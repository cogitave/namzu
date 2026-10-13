import type { ReasoningEffort } from '@namzu/sdk'

// Its own module, with only a type import of the SDK, because the root command
// lists these levels as `--effort` choices: importing them from `exec-flags.ts`
// loaded the SDK for `namzu --version`.

/** Every effort level a flag accepts; a provider offers the subset its model supports. */
export const REASONING_EFFORT_LEVELS = [
	'none',
	'minimal',
	'low',
	'medium',
	'high',
	'xhigh',
	'max',
	'ultra',
] as const satisfies readonly ReasoningEffort[]
