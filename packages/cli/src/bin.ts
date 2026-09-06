#!/usr/bin/env node

import { fileURLToPath } from 'node:url'

import { runCli } from './cli.js'
import { EXIT_INTERNAL_ERROR } from './exit-codes.js'

// The invoked module, rather than a PATH lookup, owns the resume address. A
// source launch must retain its Node loader; the distributed JS needs none.
const entrypoint = fileURLToPath(import.meta.url)
runCli({
	argv: process.argv,
	resumeCommand: [
		process.execPath,
		...(entrypoint.endsWith('.ts') ? process.execArgv : []),
		entrypoint,
	],
}).then(
	(code) => {
		process.exit(code)
	},
	(err) => {
		process.stderr.write(
			`Fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
		)
		process.exit(EXIT_INTERNAL_ERROR)
	},
)
