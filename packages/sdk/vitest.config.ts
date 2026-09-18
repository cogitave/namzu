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
				// Not source, and the reason it is named: under Vitest 3's
				// `all: true` the v8 provider globbed the whole package root
				// before it transformed anything, and a runtime state tree left
				// here by an old, un-isolated test run (51,444 project
				// directories on one machine) held that glob for forty minutes
				// with every test already reported. Excluding it pruned the walk.
				//
				// Vitest 4 removed `all`, so the walk now starts from the
				// `include` glob above (`src/**/*.ts`) and cannot reach a
				// package-root `.namzu/` at all. The entry stays because it is
				// still true — this is not source — and because a future change
				// to `include` that widened it should not silently re-open the
				// walk that cost forty minutes. It is redundant, not wrong.
				'.namzu/**',
			],
			// `all: true` was here and is gone: Vitest 4 removed the option and
			// made its behaviour the only one — but only when `coverage.include`
			// is set, which it is, ten lines up. The two were not independent
			// spellings of one thing: `all` said "report every file that exists",
			// `include` says "…matching this glob", and under v4 the second is
			// what carries the floor. Removing `all` on its own was verified
			// against the committed config: identical row set, 548 files, and
			// identical percentages in `coverage-summary.json`.
			clean: true,
		},
	},
})
