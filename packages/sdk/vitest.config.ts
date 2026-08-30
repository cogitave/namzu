import { defineConfig } from 'vitest/config'

import { sdkTestIsolation } from './vitest.shared.js'

export default defineConfig({
	test: {
		...sdkTestIsolation,
		// `*.proc-test.ts` is deliberately OUT of the default run and has its
		// own script and CI step. Those tests spawn a child process to prove
		// something no in-process test can — that a run survives on its own
		// event-loop footprint — and the spawn competes for CPU hard enough to
		// flake the timing-sensitive tests around it. Excluded to keep the unit
		// suite stable, NOT to make it optional: see `test:proc`.
		include: ['src/**/*.test.ts'],
		// The shared setup above only verifies the runner-owned test boundary.
		// There used to be a different setup file whose whole job was
		// `configureLogger({ level: 'silent' })` — a process-wide threshold
		// raised against a process-wide stderr writer, because a component
		// constructed without a logger wrote to stderr and CI annotates every
		// `[ERROR]` line as a workflow error. LOG-20 removed that writer:
		// `resolveLogger(undefined)` is `NOOP_LOGGER`, so silence is what the
		// SDK does on its own and there is nothing left to suppress. Keeping
		// the file would have been worse than useless — it installed a process
		// sink, which is a one-owner slot, so every suite that installs its own
		// hit the deliberate second-install refusal. Do not merge that removed
		// logger mutation into the isolation observer.
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
				// Generated rate data: one exported array of literals, zero
				// branches and zero functions. Same category as `types/` above
				// — there is no behaviour in it to leave untested.
				//
				// This SHARPENS the gate rather than loosening it, which is
				// worth stating because an exclusion usually does the
				// opposite. The file is 282 of the module's 299 lines, and
				// every one of them counts as covered the moment anything
				// imports the module. Left in, the module reads 94% covered
				// with its resolver entirely untested, and losing a third of
				// that resolver's lines still clears a 97% floor. Taken out,
				// the floor is measured against the 17 lines that actually
				// decide something.
				'src/pricing/catalogue.generated.ts',
			],
			all: true,
			clean: true,
		},
	},
})
