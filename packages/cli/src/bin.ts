#!/usr/bin/env node

import { fileURLToPath } from 'node:url'

import { runCli } from './cli.js'
import { EXIT_INTERNAL_ERROR } from './exit-codes.js'
import { resumeInvocation } from './resume-invocation.js'
import { terminationInProgress } from './termination.js'

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
	(err) => {
		if (terminationInProgress() !== null) return
		process.stderr.write(
			`Fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
		)
		process.exit(EXIT_INTERNAL_ERROR)
	},
)
