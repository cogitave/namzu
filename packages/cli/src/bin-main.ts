// The rest of `bin.ts`, split off so that the compile cache and the warning filter are in place
// before this module, and everything it imports statically, is read. In the bundled build this is
// where the command shell starts; `bin.ts` itself stays a few lines long.

import { runCli } from './cli.js'
import { EXIT_INTERNAL_ERROR, EXIT_UNAVAILABLE } from './exit-codes.js'
import { exitProcess } from './exit-process.js'
import { flushStdio } from './flush-stdio.js'
import { APPLY_AT_EXIT_FLAG } from './integrations/auto-update/deferred-apply.js'
import {
	installWasReplaced,
	replacedInstallLine,
} from './integrations/auto-update/replaced-install.js'
import { resumeInvocation } from './resume-invocation.js'
import { terminationInProgress } from './termination-state.js'

async function plainFailure(err: unknown): Promise<string | undefined> {
	try {
		const { plainStartupFailure } = await import('./startup-failure.js')
		const { namzuHomePath } = await import('./integrations/state/home.js')
		return plainStartupFailure(err, () => {
			try {
				return namzuHomePath()
			} catch {
				return undefined
			}
		})
	} catch {
		return undefined
	}
}

/** Run the command line as `entrypoint`, the file that was started (`bin.js`, or `bin.ts` from source). */
export function main(entrypoint: string): Promise<void> {
	// `--start-check` is how an update asks a new copy whether it can start a session. It loads
	// what a session needs and nothing else, before the command shell is built.
	if (process.argv[2] === '--start-check') {
		return import('./integrations/auto-update/start-check.js')
			.then((check) => check.runStartCheck())
			.then(
				async (code) => {
					await flushStdio()
					process.exit(code)
				},
				() => process.exit(1),
			)
	}
	// A session that ended with an update due starts this detached; it loads everything it needs
	// before it replaces the folder it runs from.
	if (process.argv[2] === APPLY_AT_EXIT_FLAG) {
		return import('./integrations/auto-update/apply-at-exit.js')
			.then((apply) => apply.runApplyAtExit())
			.then(
				() => process.exit(0),
				() => process.exit(1),
			)
	}
	return runCli({
		argv: process.argv,
		resumeCommand: resumeInvocation(entrypoint),
	}).then(
		async (code) => {
			// A command stopped by a signal can return while its handler is still
			// giving the conversation back; the handler ends the process.
			if (terminationInProgress() !== null) return
			await exitProcess(code)
		},
		async (err) => {
			if (terminationInProgress() !== null) return
			let report: string
			let code = EXIT_INTERNAL_ERROR
			if (installWasReplaced({ error: err })) {
				// A newer version installed over this one while it ran is a sentence, not a crash.
				report = `${replacedInstallLine()}\n`
				code = EXIT_UNAVAILABLE
			} else {
				// A full disk that stopped a folder from being created is a sentence, not a crash.
				const plain = await plainFailure(err)
				if (plain !== undefined) code = EXIT_UNAVAILABLE
				// Loaded here and not at the top: the report resolves the Namzu home
				// through the SDK, which `--version` has no other reason to compile.
				try {
					if (plain !== undefined) {
						report = `${plain}\n`
					} else {
						const { reportCrash } = await import('./crash-report.js')
						report = reportCrash(err)
					}
				} catch (reportFailure) {
					// The runtime that would write the report is what failed to load.
					if (installWasReplaced({ error: reportFailure })) {
						report = `${replacedInstallLine()}\n`
						code = EXIT_UNAVAILABLE
					} else {
						const why =
							reportFailure instanceof Error ? reportFailure.message : String(reportFailure)
						report = `Namzu stopped because of an unexpected problem, and could not save details: ${why}\n`
					}
				}
			}
			process.stderr.write(report)
			await exitProcess(code)
		},
	)
}
