import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { runCli } from './cli.js'

describe('runCli', () => {
	let stdout: string
	let stderr: string
	let originalStdoutWrite: typeof process.stdout.write
	let originalStderrWrite: typeof process.stderr.write

	beforeEach(() => {
		stdout = ''
		stderr = ''
		originalStdoutWrite = process.stdout.write.bind(process.stdout)
		originalStderrWrite = process.stderr.write.bind(process.stderr)
		process.stdout.write = ((chunk: string | Uint8Array): boolean => {
			stdout += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
			return true
		}) as typeof process.stdout.write
		process.stderr.write = ((chunk: string | Uint8Array): boolean => {
			stderr += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
			return true
		}) as typeof process.stderr.write
	})

	afterEach(() => {
		process.stdout.write = originalStdoutWrite
		process.stderr.write = originalStderrWrite
	})

	const invoke = (args: string[]) => runCli({ argv: ['node', 'namzu', ...args] })

	it('--help returns 0 and lists every registered command', async () => {
		const code = await invoke(['--help'])
		expect(code).toBe(0)
		// Commander prints help to stdout.
		expect(stdout).toContain('namzu')
		expect(stdout).toContain('doctor')
		expect(stdout).toContain('tools')
		expect(stdout).toContain('providers')
		expect(stdout).toContain('skills')
		expect(stdout).toContain('serve')
		// `chat` was a misread of the product shape — the TUI IS the chat,
		// not a separate subcommand. `chat` must not appear in help.
		expect(stdout).not.toContain('chat')
	})

	it('no args without a TTY prints a fallback marker and exits 0 (tests run without a TTY)', async () => {
		const code = await invoke([])
		expect(code).toBe(0)
		expect(stdout).toContain('TUI requires a terminal')
		expect(stdout).toContain('namzu --help')
	})

	it('--version returns 0 and prints a version string', async () => {
		const code = await invoke(['--version'])
		expect(code).toBe(0)
		expect(stdout).toMatch(/\d+\.\d+\.\d+/)
	})

	it('unknown command returns sysexits EX_USAGE (64)', async () => {
		const code = await invoke(['definitely-not-a-command'])
		expect(code).toBe(64)
		// Commander chooses between "unknown command" and "too many arguments"
		// depending on whether a default action is registered. Either wording
		// is acceptable — the contract is the sysexit code, not the message.
		expect(stderr).toMatch(/unknown command|too many arguments/)
	})

	it('stub commands print a structured marker and exit 0', async () => {
		const code = await invoke(['skills'])
		expect(code).toBe(0)
		expect(stdout).toContain('M5')
		expect(stdout).toContain('skills')
	})

	it('--format json renders stubs as JSON', async () => {
		const code = await invoke(['--format', 'json', 'skills'])
		expect(code).toBe(0)
		const parsed = JSON.parse(stdout) as { stub: boolean; milestone: string }
		expect(parsed.stub).toBe(true)
		expect(parsed.milestone).toBe('M5')
	})

	it('--format yaml renders stubs as YAML', async () => {
		const code = await invoke(['--format', 'yaml', 'serve'])
		expect(code).toBe(0)
		expect(stdout).toContain('stub: true')
		expect(stdout).toContain('milestone: M7')
	})

	it('doctor command pass-through preserves --help routing to the doctor', async () => {
		// The legacy doctor --help text starts with "namzu doctor —" while the
		// shell help would start with "Usage: namzu". This distinguishes them.
		const code = await invoke(['doctor', '--help'])
		expect(code).toBe(0)
		expect(stdout).toContain('namzu doctor')
		expect(stdout).toContain('--per-check-timeout')
	})

	it('doctor command pass-through forwards unknown flags into doctor parser', async () => {
		const code = await invoke(['doctor', '--frobnicate'])
		// doctor's own parser surfaces 70 (EXIT_INTERNAL_ERROR) on unknown options.
		expect(code).toBe(70)
		expect(stderr).toContain('unknown option: --frobnicate')
	})
})
