import { defineConfig } from 'vitest/config'

export default defineConfig({
	test: {
		// `*.proc-test.ts` is deliberately OUT of the default run and has its
		// own script and CI step. Those tests spawn a child process to prove
		// something no in-process test can — that a run survives on its own
		// event-loop footprint — and the spawn competes for CPU hard enough to
		// flake the timing-sensitive tests around it. Excluded to keep the unit
		// suite stable, NOT to make it optional: see `test:proc`.
		include: ['src/**/*.test.ts'],
		setupFiles: ['./src/test-setup.ts'],
		coverage: {
			provider: 'v8',
			reporter: ['text', 'json-summary', 'lcov'],
			reportsDirectory: './coverage',
			include: ['src/**/*.ts'],
			exclude: [
				'src/**/*.test.ts',
				'src/**/*.d.ts',
				'src/**/__tests__/**',
				'src/**/__fixtures__/**',
				'src/types/**',
			],
			all: true,
			clean: true,
		},
	},
})
