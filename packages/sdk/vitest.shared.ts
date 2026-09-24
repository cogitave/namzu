import type { InlineConfig } from 'vitest/node'

/**
 * Every supported SDK suite runs below the outer runner's owned temporary
 * directory. The working-directory file is an observer, not the owner: it
 * runs before every test file and refuses a raw or overridden invocation
 * before product code can persist runtime state in the package checkout —
 * kept single-purpose rather than folding the `vi.waitFor` budget fix into
 * it, matching that file's own docstring.
 */
export const sdkTestIsolation = {
	pool: 'forks',
	setupFiles: [
		'./src/__fixtures__/sdk-test-working-directory.ts',
		'./src/__fixtures__/vi-wait-for-budget.ts',
	],
} satisfies Pick<InlineConfig, 'pool' | 'setupFiles'>
