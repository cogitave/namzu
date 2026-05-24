#!/usr/bin/env node

import { runCli } from './cli.js'
import { EXIT_INTERNAL_ERROR } from './exit-codes.js'

runCli({ argv: process.argv }).then(
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
