// The rest of `bin.ts`, split off so that the compile cache and the warning filter are in place
// before this module, and everything it imports statically, is read. In the bundled build this is
// where the command shell starts; `bin.ts` itself stays a few lines long.

import { runCli } from './cli.js'
import { EXIT_INTERNAL_ERROR } from './exit-codes.js'
import { resumeInvocation } from './resume-invocation.js'
import { terminationInProgress } from './termination-state.js'

/** Run the command line as `entrypoint`, the file that was started (`bin.js`, or `bin.ts` from source). */
export function main(entrypoint: string): void {
	// `--start-check` is how an update asks a new copy whether it can start a session. It loads
	// what a session needs and nothing else, before the command shell is built.
	if (process.argv[2] === '--start-check') {
		void import('./integrations/auto-update/start-check.js')
			.then((check) => check.runStartCheck())
			.then(
				(code) => process.exit(code),
				(error) => {
					process.stdout.write(
						`start check failed: ${error instanceof Error ? error.message : String(error)}\n`,
					)
					process.exit(1)
				},
			)
		return
	}
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
			let report: string
			try {
				const { reportCrash } = await import('./crash-report.js')
				report = reportCrash(err)
			} catch (reportFailure) {
				// The runtime that would write the report is what failed to load.
				const why = reportFailure instanceof Error ? reportFailure.message : String(reportFailure)
				report = `Namzu stopped because of an unexpected problem, and could not save details: ${why}\n`
			}
			process.stderr.write(report)
			process.exit(EXIT_INTERNAL_ERROR)
		},
	)
}
