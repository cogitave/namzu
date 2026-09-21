import { defineConfig } from 'vitest/config'

export default defineConfig({
	test: {
		// Keeps the kernel's default state root out of the user's home.
		globalSetup: ['../../tools/vitest-state-root.mjs'],
		exclude: ['**/node_modules/**', '**/dist/**'],
	},
})
