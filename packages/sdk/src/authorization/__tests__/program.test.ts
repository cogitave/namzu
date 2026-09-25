import { describe, expect, it } from 'vitest'

import {
	DYNAMIC_RESOLUTION_VARIABLES,
	hasPoisoningPrefix,
	poisonsLaterCommands,
	programPositions,
	unknownProgramInLine,
} from '../program.js'
import { lexShellCommandLine } from '../shell-lexer.js'

/**
 * Whether `line` holds a position `unknownProgramInLine` could not resolve
 * to a program name. Calls the SAME exported function `executor.ts`'s
 * `unknownProgramOf` delegates to, rather than re-implementing its
 * opaque-check-then-walk — an independent mirror is exactly what let a
 * previous round's `bash -c "$X"` gap go unnoticed by this suite.
 */
function isUnknown(line: string, dialect: 'bash' | 'sh' = 'bash'): boolean {
	return unknownProgramInLine(line, dialect) !== undefined
}

describe('a re-exec wrapper does not move the program out of reach', () => {
	// The security review's own examples: a wrapper the head-only check used
	// to ignore, standing in front of a program name decided at runtime.
	// Each of these used to slip past `command.words[command.assignments]`
	// because the program was never the head word.
	it.each([
		['env $(echo git) push', 'env, no leading assignment'],
		['env NODE_ENV=production $(echo git) push', 'env with a VAR=value pair first'],
		['command $(echo git) push', 'the `command` builtin'],
		['exec $(echo git) push', 'the `exec` builtin'],
		['builtin $(echo git)', 'the `builtin` builtin'],
		['nice $(echo git) push', 'nice, bare'],
		['nice -n 10 $(echo git) push', 'nice with -n VALUE'],
		['ionice -c2 -n7 $(echo git) push', 'ionice with two attached short options'],
		['nohup $(echo git) push', 'nohup'],
		['timeout 5 $(echo git) push', 'timeout, whose duration is mandatory'],
		['timeout -s TERM 5 $(echo git) push', 'timeout with --signal-style option first'],
		['setsid $(echo git) push', 'setsid'],
		['stdbuf -oL $(echo git) push', 'stdbuf, whose buffering mode is mandatory'],
		['chrt 0 $(echo git) push', 'chrt, whose priority is mandatory'],
		['chrt 99 $(echo git) push', 'chrt with a different priority'],
		['sudo $(echo git) push', 'sudo'],
		['doas $(echo git) push', 'doas'],
		['pkexec $(echo git) push', 'pkexec'],
	])('%s (%s)', (line) => {
		expect(isUnknown(line), line).toBe(true)
	})

	it('is not fooled by a chain of several wrappers stacked on top of each other', () => {
		expect(isUnknown('sudo env nice -n 5 $(echo git) push')).toBe(true)
	})

	it('still reads a plain, unwrapped expanding head the same way as before', () => {
		expect(isUnknown('$(echo git) push')).toBe(true)
	})
})

describe('a final review of program.ts: assignments through a wrapper, applet dispatch, export attributes, nested-shell wrappers, explicit shell/editor modes', () => {
	// CRITICAL: `sudo`'s own case never skipped a `NAME=value` pair the way
	// `env`'s already did, so the assignment word itself was reported as the
	// program and the real program after it was never examined at all —
	// worse than merely missing the poisoning, `sudo VAR=value $(echo ls)`
	// read as `VAR=value` being known and `$(echo ls)` never looked at.
	it('sudo skips a NAME=value pair to find the real program, the same way env does', () => {
		expect(isUnknown('sudo VAR=value $(echo ls)')).toBe(true) // the real, wild program
		expect(isUnknown('sudo FOO=x cmd')).toBe(false) // an ordinary assignment, cmd is known
		expect(isUnknown('sudo -u root FOO=x cmd')).toBe(false) // options, then assignment, then cmd
	})

	it('a wrapper NAME=value pair that names a poisoning variable is fed into the poisoning model', () => {
		expect(isUnknown('sudo PATH=/evil cmd')).toBe(true)
		expect(isUnknown('sudo LD_PRELOAD=/evil.so cmd')).toBe(true)
		expect(isUnknown('env PATH=/evil cmd')).toBe(true)
		expect(isUnknown('env LD_PRELOAD=/evil.so cmd')).toBe(true)
		// A non-poisoning name is unaffected either way.
		expect(isUnknown('sudo FOO=bar cmd')).toBe(false)
		expect(isUnknown('env FOO=bar cmd')).toBe(false)
	})

	// CRITICAL: `executor.ts`'s `unknownProgramOf` ignored `reading.opaque`/
	// `!reading.complete` — `bash -c "$X"` never read into the payload (the
	// lexer cannot, since it expands) and marks the WHOLE line opaque, but
	// nothing here noticed: the position-walk over `reading.commands` found
	// only the literal, ordinary word `bash` and called it known. Covered
	// through `unknownProgramInLine`, the exact function `executor.ts` now
	// calls, so this test and that code cannot drift apart again.
	it('an opaque or incomplete reading is itself unknown, not just its resolved positions', () => {
		expect(isUnknown('bash -c "$X"')).toBe(true)
		expect(isUnknown('sh -c "$X"')).toBe(true)
		expect(isUnknown('env -i bash -c "$X"')).toBe(true)
		expect(isUnknown('nice -n 5 sh -ec "$X"')).toBe(true)
		expect(isUnknown('toybox sh -c "$X"')).toBe(true)
		expect(isUnknown('sudo env -i busybox ash -lc "$X"')).toBe(true)
		// Sanity: a LITERAL bash -c payload is still read fine (the lexer
		// splits it into its own nested command), not opaque.
		expect(isUnknown('bash -c "echo hi"')).toBe(false)
		expect(isUnknown('env -i bash -c "echo hi"')).toBe(false)
		expect(isUnknown('toybox sh -c "echo hi"')).toBe(false)
	})

	it('busybox/toybox applet dispatch is transparent, the same as builtin', () => {
		expect(isUnknown('busybox ls -la')).toBe(false)
		expect(isUnknown('toybox echo hi')).toBe(false)
		expect(isUnknown('busybox $(echo ls)')).toBe(true)
	})

	it('declare -x/typeset -x (any cluster with it, never +x) poison later commands like export', () => {
		expect(isUnknown('declare -x PATH=/evil; ls')).toBe(true)
		expect(isUnknown('declare -gx PATH=/evil; ls')).toBe(true)
		expect(isUnknown('typeset -x LD_PRELOAD=/evil.so; ls')).toBe(true)
		expect(isUnknown('declare +x PATH; ls')).toBe(false) // removes the attribute
		expect(isUnknown('declare -r PATH; ls')).toBe(false) // no -x at all
		expect(isUnknown('declare -x FOO=bar; ls')).toBe(false) // not a poisoning name
	})

	it('export -n removes the export attribute and does not poison', () => {
		expect(isUnknown('export -n PATH; ls')).toBe(false)
		expect(isUnknown('export PATH=/evil; ls')).toBe(true) // sanity: plain export still does
	})

	describe('su -c / runuser -c / script -c / flock -c: a -c payload is a nested-shell command', () => {
		it.each([
			['su', '-c'],
			['runuser', '-c'],
			['script', '-c'],
			['flock', '-c'],
		])('%s %s with a literal payload recurses; with an expanding one, unknown', (wrapper, flag) => {
			const target =
				wrapper === 'flock' ? ' /tmp/lock' : wrapper === 'script' ? ' typescript.log' : ''
			expect(isUnknown(`${wrapper} ${flag} "echo hi"${target}`), wrapper).toBe(false)
			expect(isUnknown(`${wrapper} ${flag} "$X"${target}`), wrapper).toBe(true)
		})

		it('a nested wrapper hidden inside a literal -c payload is still unknown, transitively', () => {
			expect(isUnknown('su -c "env $(echo git) push"')).toBe(true)
		})

		it('su/runuser without -c/--command start an interactive login shell: unknown', () => {
			expect(isUnknown('su root')).toBe(true)
			expect(isUnknown('su')).toBe(true)
			expect(isUnknown('runuser root')).toBe(true)
		})

		it('script without -c is known: it records a session, its own argument is a log file, not a command', () => {
			expect(isUnknown('script session.log')).toBe(false)
			expect(isUnknown('script')).toBe(false)
		})

		it('script timing options do not swallow -c, and -T consumes its required value', () => {
			expect(isUnknown('script -t -c "$X" -a /dev/null')).toBe(true)
			expect(isUnknown('script --timing -c "$X" -a /dev/null')).toBe(true)
			expect(isUnknown('script -T timing.log -c "$X" -a /dev/null')).toBe(true)
			expect(isUnknown('script -ttiming.log -c "$X" -a /dev/null')).toBe(true)
			expect(isUnknown('script --timing=timing.log -c "$X" -a /dev/null')).toBe(true)
			expect(isUnknown('script -t -c "echo hi" -a /dev/null')).toBe(false)
			expect(isUnknown('script -T timing.log -c "echo hi" -a /dev/null')).toBe(false)
			expect(isUnknown('script --timing=timing.log -c "echo hi" -a /dev/null')).toBe(false)
		})
	})

	describe('flock: -c and the positional form', () => {
		it('the positional form (file command args…) reads the real argv directly, no shell', () => {
			expect(isUnknown('flock /tmp/lock rsync -a /src /dst')).toBe(false)
			expect(isUnknown('flock -n /tmp/lock echo hi')).toBe(false)
			expect(isUnknown('flock /tmp/lock $(echo systemctl) stop x')).toBe(true)
		})

		it('a bare fd/file with nothing after it names no program at all', () => {
			expect(isUnknown('flock /tmp/lock')).toBe(false)
			expect(isUnknown('flock 9')).toBe(false)
		})
	})

	describe('coverage pass: unshare, nsenter, chroot, setpriv, prlimit, numactl, watch', () => {
		it('unshare/nsenter read their own options, then the ordinary argv', () => {
			expect(isUnknown('unshare -m -- rsync -a /src /dst')).toBe(false)
			expect(isUnknown('unshare --net $(echo rm) -rf /')).toBe(true)
			expect(isUnknown('nsenter -t 1 -m -u -n -i cmd')).toBe(false)
			expect(isUnknown('nsenter -t 1 $(echo rm) -rf /')).toBe(true)
		})

		it('chroot skips the new-root directory, then reads the command; none at all is an interactive shell', () => {
			expect(isUnknown('chroot /mnt bash')).toBe(false)
			expect(isUnknown('chroot /mnt $(echo rm) -rf /')).toBe(true)
			expect(isUnknown('chroot /mnt')).toBe(true)
		})

		it('setpriv reads its own options, then the ordinary argv', () => {
			expect(isUnknown('setpriv --reuid 1000 --regid 1000 --clear-groups cmd')).toBe(false)
			expect(isUnknown('setpriv --reuid 1000 $(echo rm) -rf /')).toBe(true)
		})

		it('prlimit reads a resource option (bare or =value) or -p (no command), then the argv', () => {
			expect(isUnknown('prlimit --nofile=1024:1024 cmd')).toBe(false)
			expect(isUnknown('prlimit --nofile=1024 $(echo rm) -rf /')).toBe(true)
			expect(isUnknown('prlimit -p 1234')).toBe(false)
		})

		it('numactl reads its own options (attached =value only), or --show/--hardware (no command)', () => {
			expect(isUnknown('numactl --interleave=0,1 cmd')).toBe(false)
			expect(isUnknown('numactl --interleave=0,1 $(echo rm) -rf /')).toBe(true)
			expect(isUnknown('numactl --show')).toBe(false)
		})

		it('watch joins and lexes its default payload like eval; -x execs the argv directly', () => {
			expect(isUnknown('watch -n 5 df -h')).toBe(false)
			expect(isUnknown('watch "$X"')).toBe(true)
			expect(isUnknown('watch env $(echo git) push')).toBe(true) // nested wrapper, transitively unknown
			expect(isUnknown('watch -x rsync -a /src /dst')).toBe(false)
			expect(isUnknown('watch -x $(echo rm) -rf /')).toBe(true)
		})

		it('ssh stays out of scope: it is not unwrapped, remains the known program itself', () => {
			// The command it runs is on a REMOTE machine — verifying it is not
			// a question this local resolver can answer at all; `ssh` itself
			// is what is known here, and its trailing words are ordinary,
			// unexamined arguments, exactly like any program this does not
			// specifically model.
			expect(isUnknown('ssh host rm -rf /')).toBe(false)
		})
	})

	describe('sudo -i/-s/-e and bare sudoedit: an explicit unknown, not an accident', () => {
		it.each(['-i', '--login', '-s', '--shell', '-e', '--edit'])(
			'sudo %s is explicitly unknown',
			(flag) => {
				expect(isUnknown(`sudo ${flag}`)).toBe(true)
			},
		)

		it('bare sudoedit is explicitly unknown', () => {
			expect(isUnknown('sudoedit /etc/hosts')).toBe(true)
		})

		it('does not mistake the wrapped command’s OWN -i for sudo’s login flag', () => {
			// sudo's own option scan stops at the first non-option word, the
			// same as every other wrapper here — `-i` two words later belongs
			// to docker, not to sudo.
			expect(isUnknown('sudo docker run -i --rm app')).toBe(false)
		})
	})
})

describe('source, the dot builtin and eval are read the same way a nested bash -c payload is', () => {
	// Consistency fix (2026-09-24 follow-up review): `source`/`.` with a
	// LITERAL path is known — running that file, exactly like `bash path` —
	// and `eval` with literal argument words has its joined payload lexed
	// and resolved recursively, exactly like `bash -c '<literal>'`. Only an
	// expanding path/argument word, or a payload that does not read cleanly,
	// is unknown. Treating these three as automatically unknown regardless
	// of literalness (the previous round) made `source .venv/bin/activate`
	// ask alongside `source "$X"`, which is exactly the asymmetry `bash
	// script.sh` (known) versus `bash -c "$X"` (unknown) does not have.

	it.each([
		['source "$X"', 'source, runtime path'],
		['. "$X"', 'the dot builtin, runtime path'],
		['. "$(cat /tmp/target)"', 'the dot builtin, command-substitution path'],
		['eval "$X"', 'eval, an expanding argument word'],
	])('%s is unknown (%s)', (line) => {
		expect(isUnknown(line), line).toBe(true)
	})

	it.each([
		['source ./known.sh', 'source, a literal, static path'],
		['. ./known.sh', 'the dot builtin, a literal, static path'],
		['source .venv/bin/activate', 'source, activating a venv'],
		['. .venv/bin/activate', 'the dot builtin, activating a venv'],
	])('%s is known, the same way bash <path> is (%s)', (line) => {
		expect(isUnknown(line), line).toBe(false)
	})

	it('a literal eval payload is lexed and its own commands resolved recursively', () => {
		// `rm -rf ~` is an ordinary, known program: eval reading it does not
		// make it unknown. Whatever catches a dangerous literal argument here
		// is a `deny` rule over the recursively-lexed text, a completely
		// different mechanism from `unknownProgram` — see
		// `script-check.test.ts`'s deny-rule coverage of exactly this.
		expect(isUnknown("eval 'rm -rf ~'")).toBe(false)
		// A wrapper hidden inside a literal eval payload is still unknown,
		// transitively: the payload's own positions are resolved the same
		// way any script's are.
		expect(isUnknown("eval 'env $(echo git) push'")).toBe(true)
		// A payload that does not read as valid shell at all is unknown too.
		expect(isUnknown("eval 'a && && b'")).toBe(true)
	})

	it('eval with no arguments names no position at all (bash: a no-op)', () => {
		expect(isUnknown('eval')).toBe(false)
	})

	it('source/. with no path at all is unknown', () => {
		expect(isUnknown('source')).toBe(true)
		expect(isUnknown('.')).toBe(true)
	})
})

describe('xargs and find -exec name a program outside the head position', () => {
	it('an xargs program that is a shell, or built from its input, is unknown', () => {
		expect(isUnknown('ls | xargs sh')).toBe(true)
		expect(isUnknown('find /tmp -type f | xargs -I{} {}')).toBe(true)
	})
	it('an xargs invocation with an ordinary, named program is known', () => {
		expect(isUnknown('find . -name "*.log" | xargs rm')).toBe(false)
	})
	it('each find -exec/-execdir/-ok/-okdir clause is its own position', () => {
		expect(isUnknown('find /tmp -exec "$X" {} \\;')).toBe(true)
		// The lone `{}` placeholder stands for the file found, not a program.
		expect(isUnknown('find /tmp -exec {} \\;')).toBe(true)
	})
	it('a literal find -exec clause is known, and does not, by itself, become unknown', () => {
		expect(isUnknown('find /tmp -name "*.tmp" -exec rm {} \\;')).toBe(false)
	})
	it('follows wrappers and shell payloads inside find exec clauses', () => {
		for (const clause of ['-exec', '-execdir', '-ok', '-okdir']) {
			expect(isUnknown(`find . -maxdepth 0 ${clause} env $(printf e)cho marker \\;`)).toBe(true)
			expect(isUnknown(`find . -maxdepth 0 ${clause} env bash -c '$X' \\;`)).toBe(true)
			expect(isUnknown(`find . -maxdepth 0 ${clause} bash -c 'echo {}' \\;`)).toBe(true)
			expect(isUnknown(`find . -maxdepth 0 ${clause} env echo marker \\;`)).toBe(false)
		}
		expect(isUnknown('env find . -maxdepth 0 -exec env $(printf e)cho marker \\;')).toBe(true)
	})
})

describe('a poisoned resolution environment makes a later literal name untrustworthy', () => {
	it('a leading assignment poisons only its own command', () => {
		expect(isUnknown('PATH=/tmp/x ls')).toBe(true)
		expect(isUnknown('PATH=$(echo /tmp/evil):$PATH ls')).toBe(true)
	})

	it('export poisons every later command in the same script, literal or not', () => {
		expect(isUnknown('export PATH=/tmp/evil; ls')).toBe(true)
		// Regression: an export whose VALUE expands must still be read as
		// exporting PATH — the `NAME=` prefix is what identifies the
		// variable, and it is reliable even when the text after `=` is not.
		expect(isUnknown('export PATH=$(echo /tmp/evil); ls')).toBe(true)
	})

	it('a bare, standalone assignment with no trailing command poisons what follows', () => {
		expect(poisonsLaterCommands(oneCommand('PATH=/tmp/evil'))).toBe(true)
	})

	it('an ordinary command is not poisoned by an unrelated assignment or export', () => {
		expect(isUnknown('FOO=bar node app.js')).toBe(false)
		expect(isUnknown('export FOO=bar; node app.js')).toBe(false)
	})

	for (const variable of DYNAMIC_RESOLUTION_VARIABLES) {
		it(`poisons on ${variable}, not only PATH`, () => {
			expect(isUnknown(`${variable}=x ls`)).toBe(true)
		})
	}
})

describe('argument-level expansion alone does not make a position unknown', () => {
	it.each([
		['echo $(date)', 'argument substitution, literal program'],
		['git push origin "$(cat branch-name.txt)"', 'a literal program, an expanding argument'],
		[
			'cd "$(git rev-parse --show-toplevel)" && pnpm test',
			'expansion in one command, not the other',
		],
	])('%s is known (%s)', (line) => {
		expect(isUnknown(line), line).toBe(false)
	})
})

describe('negative controls: an ordinary coding-session command never asks', () => {
	it.each([
		'git status',
		'git commit -m "fix: bug"',
		'git push origin main',
		'npm install',
		'npm run build',
		'pnpm --filter @namzu/sdk test',
		'npx tsc --noEmit',
		'node dist/index.js',
		'node -e "console.log(1)"',
		'python3 -m venv .venv',
		'make -j4',
		'cargo build --release',
		'docker build -t app .',
		'docker run --rm -it app bash',
		'kubectl get pods -n default',
		'cd "$DIR" && ls -la',
		'for f in *.ts; do echo "$f"; done',
		'while read -r l; do echo "$l"; done < file.txt',
		'FOO=bar node app.js',
		'NODE_ENV=production npm start',
		'echo "built at $(date)"',
		'export PATH="$PATH:/usr/local/bin"',
		'rm -rf node_modules',
		'find . -name "*.log" -delete',
		'grep -r "TODO" src/',
		'curl -fsSL https://example.com/install.sh | sh',
		'echo $HOME',
		'ls ~/projects',
		'cat "$FILE"',
		'./scripts/build.sh',
		'bash scripts/build.sh',
		'bash -c "echo hi"',
		'sh -c "echo hi"',
		'source .venv/bin/activate',
		'. .venv/bin/activate',
	])('%s', (line) => {
		expect(isUnknown(line), line).toBe(false)
	})

	// A wrapper's own real option grammar, in its idiomatic (often
	// attached-short-option) form, must not itself trip "an option this does
	// not read": the fail-closed behaviour is for an option `skipOptions`
	// truly does not model, not for the everyday spelling of the ones it does.
	it.each([
		['ionice -c2 -n7 rsync -a /src /dst', 'ionice, attached class and level'],
		['nice -n10 make -j4', 'nice, attached adjustment'],
		['stdbuf -oL grep foo', 'stdbuf, attached buffering mode'],
		['stdbuf -oL -eL tail -f log', 'stdbuf, two attached modes'],
		['taskset -c0-3 make -j4', 'taskset, attached cpu list'],
		['taskset -c 0-3 make -j4', 'taskset, separate cpu list'],
		['taskset --cpu-list=0-3 make -j4', 'taskset, long form with ='],
		['sudo -u build make', 'sudo -u with a separate argument'],
		['env -C /tmp ls', 'env -C with a separate argument'],
		['env -u FOO node app.js', 'env -u with a separate argument'],
	])('%s is known (%s)', (line) => {
		expect(isUnknown(line), line).toBe(false)
	})

	it('is a fixed set: exactly two asks over the whole corpus above, named here', () => {
		// Pinned so a change to this list is a change someone has to look at.
		// Both are the review's own accepted asks — a program built from
		// command substitution has no static name a rule could ever match,
		// wrapper or not, whatever the substitution's own text looks like.
		// `source .venv/bin/activate`/`. .venv/bin/activate` are NOT here:
		// a literal `source`/`.` path is known, the same way `bash path` is
		// (see the describe block above) — they moved into the "does not
		// ask" list above in the consistency-review follow-up.
		const asks = ['$(npm bin)/tsc --noEmit', '"$(git rev-parse --show-toplevel)"/scripts/x.sh']
		for (const line of asks) expect(isUnknown(line), line).toBe(true)
		expect(asks).toHaveLength(2)
	})
})

describe('programPositions on one command, directly', () => {
	it('reports no positions for an empty command', () => {
		expect(
			programPositions(
				{
					words: [],
					assignments: 0,
					redirections: [],
					text: '',
					origin: 'line',
					depth: 0,
				},
				'bash',
			),
		).toEqual([])
	})

	it('unwraps a literal wrapper to the literal program that follows it', () => {
		const reading = lexShellCommandLine('sudo systemctl stop namzu-scheduler.service', {
			dialect: 'bash',
		})
		const [command] = reading.commands
		const positions = programPositions(command as (typeof reading.commands)[number], 'bash')
		expect(positions).toHaveLength(1)
		expect(positions[0]?.unknown).toBeUndefined()
		expect(positions[0]?.word?.value).toBe('systemctl')
	})

	it('fails closed on an option a wrapper does not recognise, rather than guessing past it', () => {
		expect(isUnknown('sudo --made-up-flag git push')).toBe(true)
	})
})

describe('hasPoisoningPrefix reads only the leading assignments, not the whole command', () => {
	it('is false for a command with no leading assignment', () => {
		expect(hasPoisoningPrefix(oneCommand('ls -la'))).toBe(false)
	})
	it('is true for PATH set as a command prefix', () => {
		expect(hasPoisoningPrefix(oneCommand('PATH=/tmp/x ls'))).toBe(true)
	})
	it('is false for an unrelated prefix assignment', () => {
		expect(hasPoisoningPrefix(oneCommand('FOO=bar ls'))).toBe(false)
	})
})

/** The reading's one command, for tests that want a `ShellCommand` directly. */
function oneCommand(line: string) {
	const reading = lexShellCommandLine(line, { dialect: 'bash' })
	const [command] = reading.commands
	if (command === undefined)
		throw new Error(`expected exactly one command in ${JSON.stringify(line)}`)
	return command
}
