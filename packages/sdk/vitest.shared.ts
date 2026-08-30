import type { InlineConfig } from 'vitest/node'

/**
 * Every supported SDK suite runs below the outer runner's owned temporary
 * directory. This setup file is an observer, not the owner: it runs before
 * every test file and refuses a raw or overridden invocation before product
 * code can persist runtime state in the package checkout.
 */
export const sdkTestIsolation = {
	pool: 'forks',
	setupFiles: ['./src/__fixtures__/sdk-test-working-directory.ts'],
} satisfies Pick<InlineConfig, 'pool' | 'setupFiles'>
