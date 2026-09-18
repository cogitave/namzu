import { defineConfig } from 'vitest/config'

/**
 * Vitest 4's default `exclude` is `node_modules` and `.git` only — `dist` is
 * no longer in it. This package compiles its tests, so `dist` mirrors `src`
 * one-for-one and the suite was discovered and run twice, once as TypeScript
 * and once as the compiled copy, which has no fixtures beside it. Measured
 * before this file existed: the reported file count was exactly double the
 * count of test files under `src`.
 *
 * The `node_modules` pattern is restated in the list below rather than left
 * implicit, because `exclude` replaces the default list instead of extending
 * it. The spelling matches `packages/files/vitest.config.ts` and the sibling
 * configs.
 */
export default defineConfig({
	test: {
		exclude: ['**/node_modules/**', '**/dist/**'],
	},
})
