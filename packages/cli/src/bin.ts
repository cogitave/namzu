#!/usr/bin/env node

import { runDoctorCommand } from './commands/doctor.js'

const HELP = `namzu — operator CLI for the Namzu agent platform

Usage:
  namzu <command> [options]

Commands:
  doctor       Run health checks against the local environment
  help         Show this help

Examples:
  namzu doctor
  namzu doctor --json
  namzu doctor --category sandbox,runtime
  namzu doctor --per-check-timeout 8000
`

async function main(): Promise<number> {
	const [, , command, ...rest] = process.argv

	if (!command || command === 'help' || command === '--help' || command === '-h') {
		process.stdout.write(`${HELP}\n`)
		return 0
	}

	switch (command) {
		case 'doctor':
			return runDoctorCommand(rest)
		default:
			process.stderr.write(`Unknown command: ${command}\n\n${HELP}\n`)
			return 64 // EX_USAGE per sysexits
	}
}

main().then(
	(code) => {
		process.exit(code)
	},
	(err) => {
		process.stderr.write(
			`Fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
		)
		process.exit(70) // EX_SOFTWARE per sysexits
	},
)
