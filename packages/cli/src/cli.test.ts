import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { removeTempDir } from './__fixtures__/temp-dir.js'
import { runCli } from './cli.js'

describe('runCli', () => {
	let stdout: string
	let stderr: string
	let originalStdoutWrite: typeof process.stdout.write
	let originalStderrWrite: typeof process.stderr.write
	let tempRoots: string[]

	beforeEach(() => {
		tempRoots = []
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
		for (const root of tempRoots) removeTempDir(root)
	})

	const invoke = (args: string[]) => runCli({ argv: ['node', 'namzu', ...args] })

	it('--help returns 0 and lists every registered command', async () => {
		const code = await invoke(['--help'])
		expect(code).toBe(0)
		// Commander prints help to stdout.
		expect(stdout).toContain('namzu')
		expect(stdout).toContain('doctor')
		// `providers-json` is a command; bare `providers` is not, and the
		// difference is invisible to `toContain('providers')` — that assertion
		// stayed green through the removal of the `providers` profile command
		// because `providers-json` contains it as a prefix. This is the same
		// trap `tools` fell into below, so it is anchored the same way: the
		// sibling must be present, and the removed command must be absent as a
		// command rather than as a substring.
		expect(stdout).toMatch(/^\s+providers-json\b/m)
		expect(stdout).not.toMatch(/^\s+providers\s/m)
		expect(stdout).toContain('skills')
		expect(stdout).toContain('serve')
		// Anchored to the command column, like `providers-json` above: a
		// substring match on whole help output cannot tell a registered command
		// from the word "drain" in a description. Registering the command is
		// the whole point of the drain work — the SDK loop, the claim and the
		// resume were all reachable from a test and from nothing an operator
		// could type, which is the defect. Deleting the line in `cli.ts` that
		// registers it must fail HERE.
		expect(stdout).toMatch(/^\s+drain\b/m)
		expect(stdout).toMatch(/^\s+upgrade\b/m)
		// `tools` was asserted here until the peer-daemon removal deleted the
		// command. The assertion kept passing, because "tools" also occurs in
		// the --dangerously-skip-permissions description ("Run tools without
		// asking…") — a substring match on whole help output cannot tell a
		// command from a word in a sentence. Anchored to the command column so
		// it means what it says.
		expect(stdout).not.toMatch(/^\s+tools\b/m)
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

	function skillProject(contents: string): string {
		const root = mkdtempSync(join(tmpdir(), 'namzu-cli-skills-'))
		tempRoots.push(root)
		mkdirSync(join(root, 'skills', 'release'), { recursive: true })
		writeFileSync(join(root, 'skills', 'release', 'SKILL.md'), contents)
		return root
	}

	it('skills discovers the trusted target instead of printing a milestone stub', async () => {
		const cwd = skillProject(
			'---\nname: release\ndescription: prepare a verified release\n---\n\nDo the work.',
		)
		const code = await invoke(['skills', '--cwd', cwd, '--trust'])
		expect(code).toBe(0)
		expect(stdout).toContain(`Skills available for ${cwd}`)
		expect(stdout).toContain('release [project] — prepare a verified release')
		expect(stdout).not.toContain('M5')
	})

	it('skills refuses an untrusted target before reading its roster', async () => {
		const cwd = skillProject(
			'---\nname: should-not-leak\ndescription: this project is not trusted\n---\n\nBody.',
		)
		const code = await invoke(['skills', '--cwd', cwd])
		expect(code).toBe(77)
		expect(stdout).not.toContain('should-not-leak')
		expect(stderr).toContain('folder nobody has trusted')
	})

	it('--format json renders the discovered skill records', async () => {
		const cwd = skillProject(
			'---\nname: release\ndescription: prepare a verified release\n---\n\nDo the work.',
		)
		const code = await invoke(['--format', 'json', 'skills', '--cwd', cwd, '--trust'])
		expect(code).toBe(0)
		const parsed = JSON.parse(stdout) as {
			cwd: string
			count: number
			skills: Array<{ name: string; source: string; usable: boolean }>
		}
		expect(parsed.cwd).toBe(cwd)
		expect(parsed.count).toBeGreaterThanOrEqual(1)
		expect(parsed.skills).toContainEqual(
			expect.objectContaining({ name: 'release', source: 'project', usable: true }),
		)
	})

	it('text output exposes project-controlled terminal controls as visible escapes', async () => {
		const root = mkdtempSync(join(tmpdir(), 'namzu-cli-skills-controls-'))
		tempRoots.push(root)
		const unsafeName = 'unsafe\u001b\u202e'
		mkdirSync(join(root, 'skills', unsafeName), { recursive: true })
		writeFileSync(join(root, 'skills', unsafeName, 'SKILL.md'), 'Body without frontmatter.')

		const code = await invoke(['skills', '--cwd', root, '--trust'])
		expect(code).toBe(0)
		expect(stdout).toContain('unsafe\\u{001b}\\u{202e}')
		expect(stdout).not.toContain('\u001b')
		expect(stdout).not.toContain('\u202e')
	})

	it('--format yaml keeps a refused skill visible with its reason', async () => {
		const cwd = skillProject('---\nname: broken\ninvalid frontmatter')
		const code = await invoke(['--format', 'yaml', 'skills', '--cwd', cwd, '--trust'])
		expect(code).toBe(0)
		expect(stdout).toContain('name: release')
		// The directory name survives malformed frontmatter so one broken skill
		// cannot erase the whole roster or its reason.
		expect(stdout).toContain('usable: false')
		expect(stdout).toContain('problem:')
	})

	it('skills refuses malformed arguments with EX_USAGE', async () => {
		const code = await invoke(['skills', '--cwd'])
		expect(code).toBe(64)
		expect(stderr).toContain('--cwd requires a directory path')
	})

	it('skills --help documents discovery without crossing the project trust gate', async () => {
		const code = await invoke(['skills', '--help'])
		expect(code).toBe(0)
		expect(stdout).toContain('Usage: namzu skills [--cwd <path>] [--trust]')
		expect(stdout).toMatch(/Project\s+skills shadow user skills/)
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
		expect(code).toBe(64)
		expect(stderr).toContain('unknown option: --frobnicate')
	})

	// LOG-05: --verbose/--quiet raise or lower the log floor; --log-format
	// chooses the sink's rendering. Both are Commander-level concerns —
	// conflicting flags and an unrecognised format value — refused before
	// any subcommand's handler runs, so `doctor --help` (already exercised
	// above, and cheap: it returns before the real diagnostic registry
	// runs) stands in for all five entry points; WHICH entry point installs
	// WHICH sink is commands/__tests__/*-log-sink.test.ts and
	// tui/__tests__/log-pane.test.ts's job, not this file's.
	it('--verbose and --quiet together are refused as conflicting options (EX_USAGE)', async () => {
		const code = await invoke(['--verbose', '--quiet', 'doctor'])
		expect(code).toBe(64)
		expect(stderr).toContain('cannot be used with')
	})

	it('--log-format rejects a value that is not pretty or json (EX_USAGE)', async () => {
		const code = await invoke(['--log-format', 'xml', 'doctor'])
		expect(code).toBe(64)
		expect(stderr).toContain('Allowed choices are pretty, json')
	})

	it('--verbose alone and --log-format json alone both parse (no conflict, a real value)', async () => {
		// `doctor --help` rather than bare `doctor`: the point is that the two
		// new global flags parse without throwing — dies if either Option lost
		// its .conflicts()/.choices() declaration — not a live run of the real
		// diagnostic registry, which reads the actual sandbox/providers/vault
		// state and is unmocked here. Bare `doctor` would make this test's
		// pass/fail depend on the machine it runs on and add several seconds
		// against a 10s wall-clock default, for no assertion this test needs.
		const code = await invoke(['--verbose', '--log-format', 'json', 'doctor', '--help'])
		expect(code).toBe(0)
	})
})
