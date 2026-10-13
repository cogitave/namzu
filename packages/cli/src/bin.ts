#!/usr/bin/env node

import { fileURLToPath } from 'node:url'

// First, for its effect: the filter must be in place before anything below can
// load `node:sqlite`.
import './warning-filter.js'

import { runCli } from './cli.js'
import { EXIT_INTERNAL_ERROR } from './exit-codes.js'
import { resumeInvocation } from './resume-invocation.js'
import { terminationInProgress } from './termination-state.js'

// Preserve source loaders and alternate installations when the public command differs.
const entrypoint = fileURLToPath(import.meta.url)
runCli({
	argv: process.argv,
	resumeCommand: resumeInvocation(entrypoint),
}).then(
	(code) => {
		// A command stopped by a signal can return while its handler is still
		// giving the conversation back; the handler ends the process.
		if (terminationInProgress() !== null) return
		process.exit(code)
	},
	async (err) => {
		if (terminationInProgress() !== null) return
		// Loaded here and not at the top: the report resolves the Namzu home
		// through the SDK, which `--version` has no other reason to compile.
		try {
			const { reportCrash } = await import('./crash-report.js')
			process.stderr.write(reportCrash(err))
		} catch (reportFailure) {
			// The runtime that would write the report is what failed to load.
			const why = reportFailure instanceof Error ? reportFailure.message : String(reportFailure)
			process.stderr.write(
				`Namzu stopped because of an unexpected problem, and could not save details: ${why}\n`,
			)
		}
		process.exit(EXIT_INTERNAL_ERROR)
	},
)
