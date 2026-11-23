import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { removeTempDir } from './__fixtures__/temp-dir.js'
import { runCli } from './cli.js'

/** Error text is wrapped at word boundaries; compare it as a sentence. */
const flat = (text: string) => text.replace(/\s+/g, ' ')

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

	it('does not silently ignore the interactive output schema on a subcommand', async () => {
		const code = await invoke([
			'--output-schema',
			'/unused/schema.json',
			'providers',
			'list',
			'--json',
		])
		expect(code).toBe(64)
		expect(stderr).toContain('--output-schema applies to the interactive TUI')
	})

	it('opens the picker for `resume` with no id instead of refusing it', async () => {
		expect(await invoke(['resume'])).toBe(0)
		expect(flat(stderr)).not.toContain('Missing required argument')
		expect(stdout).toContain('interactive TUI requires a terminal')
	})

	it('refuses the launch flags on a subcommand instead of ignoring them', async () => {
		expect(await invoke(['--model', 'm', '--effort', 'high', 'providers', 'list', '--json'])).toBe(
			64,
		)
		expect(stderr).toContain('--model, --effort apply to the interactive TUI, not this subcommand')
	})

	it('refuses --fast on a subcommand instead of ignoring it', async () => {
		expect(await invoke(['--fast', 'providers', 'list', '--json'])).toBe(64)
		expect(stderr).toContain('--fast apply to the interactive TUI, not this subcommand')
	})

	it('refuses the first message on a subcommand instead of ignoring it', async () => {
		expect(await invoke(['--message', 'hi', 'providers', 'list', '--json'])).toBe(64)
		expect(stderr).toContain('--message apply to the interactive TUI, not this subcommand')
	})

	it('refuses the first message on resume: a resumed conversation never gets one', async () => {
		expect(await invoke(['--message', 'hi', 'resume', 'abc'])).toBe(64)
		expect(flat(stderr)).toContain('not sent when resuming')
	})

	it('refuses -c and -r on a subcommand or on resume instead of ignoring them', async () => {
		expect(await invoke(['-c', 'providers', 'list', '--json'])).toBe(64)
		expect(stderr).toContain('--continue apply to the interactive TUI, not this subcommand')
		stderr = ''
		expect(await invoke(['-c', 'resume', 'abc'])).toBe(64)
		expect(flat(stderr)).toContain('already names one')
	})

	it('points the launch flags at their place after exec', async () => {
		expect(await invoke(['--provider', 'zen', 'exec', 'hello'])).toBe(64)
		expect(stderr).toContain('namzu exec --provider <value> "<prompt>"')
	})

	it('validates --effort and --permission-mode before anything starts', async () => {
		expect(await invoke(['--effort', 'enormous'])).toBe(64)
		expect(stderr).toContain('enormous')
		stderr = ''
		expect(await invoke(['--permission-mode', 'yolo'])).toBe(64)
		expect(flat(stderr)).toContain(
			'Choose one of prompt, accept-edits, plan, bypass, auto, strict.',
		)
	})

	it('keeps --fast a flag with no value, so a word after it is never read as a tier', async () => {
		expect(await invoke(['--help'])).toBe(0)
		expect(flat(stdout)).toMatch(/--fast +Start with fast inference on for this launch only/u)
		expect(flat(stdout)).not.toMatch(/--fast (\[|<)/u)
	})

	it('parses --fast as a bare flag: the word after it is never taken as its value', async () => {
		expect(await invoke(['--fast', '--model', 'gpt-5.5'])).toBe(0)
		expect(stdout).toContain('interactive TUI requires a terminal')
		stdout = ''
		stderr = ''
		// A value-taking flag would swallow the first word and start the session; a bare
		// flag leaves both as arguments, and a launch takes one prompt.
		expect(await invoke(['--fast', 'ultrafast', 'now'])).not.toBe(0)
		expect(flat(stderr)).toContain('Too many arguments')
		expect(stdout).not.toContain('interactive TUI requires a terminal')
	})

	it('lists the launch flags in --help', async () => {
		expect(await invoke(['--help'])).toBe(0)
		for (const flag of [
			'--provider <id>',
			'--model <id>',
			'--effort <level>',
			'--fast',
			'--permission-mode <mode>',
			'-p, --print',
			'-c, --continue',
			'-r, --resume [value]',
		])
			expect(stdout).toContain(flag)
	})

	it('--help returns 0 and lists every registered command', async () => {
		const code = await invoke(['--help'])
		expect(code).toBe(0)
		// Commander prints help to stdout.
		expect(stdout).toContain('namzu')
		expect(stdout).toContain('doctor')
		// `providers` is the area that lists providers and models, and the
		// hyphenated `providers-json` is gone: anchored to the command column
		// so a substring cannot stand in for either.
		expect(stdout).toMatch(/^\s+providers\b/m)
		expect(stdout).not.toMatch(/^\s+providers-json\b/m)
		expect(stdout).not.toMatch(/^\s+skills-json\b/m)
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
		expect(stdout).toMatch(/^\s+update\b/m)
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

	it('refuses a first message given twice, by --message and after --', async () => {
		expect(await invoke(['--message=hi', '--', 'x'])).toBe(64)
		expect(flat(stderr)).toContain('Give the first message once')
	})

	it('a word that is not a command is the prompt; two loose words are refused with EX_USAGE (64)', async () => {
		expect(await invoke(['definitely-not-a-command'])).toBe(0)
		expect(stdout).toContain('interactive TUI requires a terminal')
		stderr = ''
		expect(await invoke(['definitely', 'not-a-command'])).toBe(64)
		expect(flat(stderr)).toMatch(/too many arguments/i)
	})

	it.each([
		[['run', 'hello'], 'run', 'namzu exec "<prompt>"'],
		[['run'], 'run', 'namzu exec "<prompt>"'],
		[['-q', 'run', '--trust', 'hello'], 'run', 'namzu exec "<prompt>"'],
		[['run-stream', '--session', 'k', 'hello'], 'run-stream', 'namzu exec --json "<prompt>"'],
		[['run', '--help'], 'run', 'namzu exec "<prompt>"'],
		[['--profile', 'p', 'run-stream', '-h'], 'run-stream', 'namzu exec --json "<prompt>"'],
	])('a removed command %j is unknown, and the error names exec', async (args, name, hint) => {
		const code = await invoke(args)
		expect(code).toBe(64)
		// One line naming the replacement; not "too many arguments", which is what the
		// root command's default action would otherwise make of the name.
		expect(stderr).not.toContain('too many arguments')
		expect(flat(stderr)).toContain(hint)
		expect(stderr).toContain(`namzu ${name}`)
		// The one sentence (wrapped to the terminal width), with no second pointer to --help.
		expect(stderr).not.toContain('--help')
		expect(stderr).not.toMatch(/Unknown command/)
	})

	it.each([
		['skills-json', 'namzu skills list --json'],
		['providers-json', 'namzu providers list --json'],
	])('the hyphenated %s prints one line naming its replacement and exits 64', async (name, now) => {
		expect(await invoke([name])).toBe(64)
		expect(flat(stderr)).toContain(`This command is now \`${now}\`.`)
		expect(stderr.trim().split('\n')).toHaveLength(1)
	})

	it.each([
		[['upgrade'], '`namzu upgrade` is now `namzu update`.'],
		[['upgrade', '--check'], '`namzu upgrade` is now `namzu update`.'],
		[['login', 'claude'], '`namzu login` is now `namzu auth login`.'],
		[['logout'], '`namzu logout` is now `namzu auth logout`.'],
	])('the retired %j prints one line naming its replacement and exits 64', async (args, line) => {
		expect(await invoke(args)).toBe(64)
		expect(flat(stderr)).toContain(line)
		expect(stderr.trim().split('\n')).toHaveLength(1)
	})

	it('lists update and auth, and none of the retired names', async () => {
		expect(await invoke(['--help'])).toBe(0)
		expect(stdout).toMatch(/^\s+update\b/m)
		expect(stdout).toMatch(/^\s+auth\b/m)
		expect(stdout).not.toMatch(/^\s+(upgrade|login|logout)\b/m)
	})

	it('lists exec and help without aliases, and none of the removed commands', async () => {
		expect(await invoke(['--help'])).toBe(0)
		expect(stdout).toMatch(/^\s+exec\b(?!\|)/m)
		expect(stdout).toMatch(/^\s+help\b/m)
		expect(stdout).not.toMatch(/^\s+\w+\|\w+/m)
		expect(stdout).not.toMatch(/^\s+(run(-stream)?|spaces|e|skills-json|providers-json)\b/m)
		expect(stdout).not.toContain('--yolo')
	})

	it.each([
		[['spaces'], '`namzu spaces` is now `namzu workspaces`.'],
		[['spaces', '--help'], '`namzu spaces` is now `namzu workspaces`.'],
		[['e', 'hello'], '`namzu e` is now `namzu exec`.'],
		[['config', 'reset', 'format'], '`namzu config reset` is now `namzu config unset`.'],
		[['--yolo'], '`--yolo` is now `--dangerously-skip-permissions`.'],
		[['--yolo', 'exec', 'hello'], '`--yolo` is now `--dangerously-skip-permissions`.'],
		[['exec', '--yolo', 'hello'], '`--yolo` is now `--dangerously-skip-permissions`.'],
		[['resume', '--yolo', 'abc'], '`--yolo` is now `--dangerously-skip-permissions`.'],
		[['drain', '--yolo'], '`--yolo` is now `--dangerously-skip-permissions`.'],
		[['workspaces', '--yolo'], '`--yolo` is now `--dangerously-skip-permissions`.'],
		[['help', 'spaces'], '`namzu spaces` is now `namzu workspaces`.'],
	])('the retired spelling %j prints one line, exits 64 and runs nothing', async (args, line) => {
		expect(await invoke(args)).toBe(64)
		expect(flat(stderr)).toContain(line)
		expect(stderr.trim().split('\n')).toHaveLength(1)
		expect(stdout).toBe('')
	})

	it('does not run the old handler of `config reset`', async () => {
		const home = mkdtempSync(join(tmpdir(), 'namzu-cli-reset-'))
		tempRoots.push(home)
		const before = process.env.NAMZU_HOME
		process.env.NAMZU_HOME = home
		try {
			expect(await invoke(['config', 'reset', 'format'])).toBe(64)
			expect(existsSync(join(home, 'config.yaml'))).toBe(false)
			expect(existsSync(join(home, 'config.json'))).toBe(false)
		} finally {
			// biome-ignore lint/performance/noDelete: assigning undefined to process.env stores the text "undefined"
			if (before === undefined) delete process.env.NAMZU_HOME
			else process.env.NAMZU_HOME = before
		}
	})

	it('keeps `--yolo` after `--` as plain text for the prompt', async () => {
		// Only the flag before `--` is a flag; this call is refused for another reason
		// (no folder trust in the test), never as the retired spelling.
		await invoke(['exec', '--', '--yolo'])
		expect(stderr).not.toContain('is now `--dangerously-skip-permissions`')
	})

	describe('namzu help', () => {
		const same = async (helpArgs: string[], flagArgs: string[]) => {
			stdout = ''
			expect(await invoke(flagArgs)).toBe(0)
			const expected = stdout
			stdout = ''
			expect(await invoke(helpArgs)).toBe(0)
			expect(stdout).toBe(expected)
			expect(expected).not.toBe('')
		}

		it('prints the root help for a bare `namzu help`', async () => {
			await same(['help'], ['--help'])
		})

		it.each([
			['exec'],
			['config'],
			['doctor'],
			['workspaces'],
			['computer'],
			['serve'],
			['resume'],
		])('prints what `namzu %s --help` prints', async (name) => {
			await same(['help', name], [name, '--help'])
		})

		it('prints the help when a launch flag is written before it', async () => {
			await same(['-n', 'x', 'help', 'exec'], ['exec', '--help'])
			await same(['--model', 'm', 'exec', '--help'], ['exec', '--help'])
		})

		it('takes an action as well as a command', async () => {
			await same(['help', 'config', 'set'], ['config', 'set', '--help'])
			await same(['help', 'computer', 'stop', 'idle'], ['computer', 'stop', 'idle', '--help'])
		})

		it('names an unknown command, which on its own would be the first message', async () => {
			expect(await invoke(['help', 'definitely-not-a-command'])).toBe(64)
			expect(stderr).toContain("Unknown command 'definitely-not-a-command'.")
			expect(stdout).not.toContain('interactive TUI requires a terminal')
		})

		it('prints the line of a retired name instead of help', async () => {
			expect(await invoke(['help', 'spaces'])).toBe(64)
			expect(flat(stderr)).toContain('`namzu spaces` is now `namzu workspaces`.')
		})
	})

	describe('with a Namzu home that does not exist', () => {
		let missing: string
		let before: string | undefined

		beforeEach(() => {
			const root = mkdtempSync(join(tmpdir(), 'namzu-cli-nohome-'))
			tempRoots.push(root)
			missing = join(root, 'not', 'there', '.namzu')
			before = process.env.NAMZU_HOME
			process.env.NAMZU_HOME = missing
		})

		afterEach(() => {
			// biome-ignore lint/performance/noDelete: assigning undefined to process.env stores the text "undefined"
			if (before === undefined) delete process.env.NAMZU_HOME
			else process.env.NAMZU_HOME = before
		})

		it.each([
			[['--help']],
			[['-h']],
			[['--version']],
			[['-V']],
			[['help']],
			[['help', 'exec']],
			[['help', 'config', 'set']],
			[['exec', '--help']],
			[['doctor', '--help']],
			[['computer', '--help']],
			[['workspaces', '-h']],
		])('answers %j with exit 0 and does not create it', async (args) => {
			expect(await invoke(args)).toBe(0)
			expect(stdout).not.toBe('')
			expect(stderr).toBe('')
			expect(existsSync(missing)).toBe(false)
			expect(existsSync(join(missing, '..'))).toBe(false)
			expect(process.env.NAMZU_HOME).toBe(missing)
		})

		it('still reports it for a command that does need it', async () => {
			expect(await invoke(['config', 'list'])).not.toBe(0)
			expect(existsSync(missing)).toBe(false)
		})
	})

	it('refuses --output-schema before exec and says where it goes', async () => {
		const code = await invoke(['--output-schema', '/unused/schema.json', 'exec', 'hello'])
		expect(code).toBe(64)
		expect(stderr).toContain('namzu exec --output-schema <file>')
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
		const code = await invoke(['skills', 'list', '--cwd', cwd, '--trust'])
		expect(code).toBe(0)
		expect(stdout).toContain(`Skills available for ${cwd}`)
		expect(stdout).toContain('release [project · ./skills] — prepare a verified release')
		// The output names `cwd`, and `cwd` is a random temp path: on CI it once
		// contained "M5" and this failed a test about a milestone stub that
		// was never printed. Look for the stub in what the command SAID, not
		// in where it was pointed.
		expect(stdout.replaceAll(cwd, '<cwd>')).not.toContain('M5')
	})

	it('skills --audit uses the model loader and fails on a skill it cannot offer', async () => {
		const cwd = skillProject('Body without frontmatter.')
		const code = await invoke(['skills', 'list', '--cwd', cwd, '--trust', '--audit'])
		expect(code).toBe(1)
		expect(stdout).toContain(`Skill audit for ${cwd}`)
		expect(stdout).toContain('release: invalid')
		expect(stdout).toContain('has no YAML frontmatter')
	})

	it('skills --audit reports the selected window budget as data', async () => {
		const cwd = skillProject(
			'---\nname: release\ndescription: prepare a verified release\n---\n\nDo the work.',
		)
		const code = await invoke([
			'--format',
			'json',
			'skills',
			'list',
			'--cwd',
			cwd,
			'--trust',
			'--audit',
			'--context-window',
			'1000',
		])
		expect(code).toBe(0)
		const parsed = JSON.parse(stdout) as {
			manifestBudgetChars: number
			findings: Array<{ name: string; status: string }>
		}
		expect(parsed.manifestBudgetChars).toBe(80)
		expect(parsed.findings).toContainEqual(
			expect.objectContaining({ name: 'release', status: 'ready' }),
		)
	})

	it('skills refuses an untrusted target before reading its roster', async () => {
		const cwd = skillProject(
			'---\nname: should-not-leak\ndescription: this project is not trusted\n---\n\nBody.',
		)
		const code = await invoke(['skills', 'list', '--cwd', cwd])
		expect(code).toBe(77)
		expect(stdout).not.toContain('should-not-leak')
		expect(stderr).toContain('folder nobody has trusted')
	})

	it('--format json renders the discovered skill records', async () => {
		const cwd = skillProject(
			'---\nname: release\ndescription: prepare a verified release\n---\n\nDo the work.',
		)
		const code = await invoke(['--format', 'json', 'skills', 'list', '--cwd', cwd, '--trust'])
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

		const code = await invoke(['skills', 'list', '--cwd', root, '--trust'])
		expect(code).toBe(0)
		expect(stdout).toContain('unsafe\\u{001b}\\u{202e}')
		expect(stdout).not.toContain('\u001b')
		expect(stdout).not.toContain('\u202e')
	})

	it('--format yaml keeps a refused skill visible with its reason', async () => {
		const cwd = skillProject('---\nname: broken\ninvalid frontmatter')
		const code = await invoke(['--format', 'yaml', 'skills', 'list', '--cwd', cwd, '--trust'])
		expect(code).toBe(0)
		expect(stdout).toContain('name: release')
		// The directory name survives malformed frontmatter so one broken skill
		// cannot erase the whole roster or its reason.
		expect(stdout).toContain('usable: false')
		expect(stdout).toContain('problem:')
	})

	it('skills refuses malformed arguments with EX_USAGE', async () => {
		const code = await invoke(['skills', 'list', '--cwd'])
		expect(code).toBe(64)
		expect(stderr).toContain('--cwd requires a directory path')
	})

	it('skills --help documents discovery without crossing the project trust gate', async () => {
		const code = await invoke(['skills', '--help'])
		expect(code).toBe(0)
		expect(stdout).toContain('Usage: namzu skills list [--json] [--cwd <path>] [--trust]')
		expect(stdout).toMatch(/later ones shadowing earlier ones of the\s+same name/)
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
		expect(flat(stderr)).toContain('Choose one of pretty, json.')
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
