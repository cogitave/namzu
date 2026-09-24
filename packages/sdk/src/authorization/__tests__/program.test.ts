import { describe, expect, it } from 'vitest'

import {
	DYNAMIC_RESOLUTION_VARIABLES,
	hasPoisoningPrefix,
	poisonsLaterCommands,
	programPositions,
	resolveScriptPrograms,
} from '../program.js'
import { lexShellCommandLine } from '../shell-lexer.js'

/**
 * Whether `line` holds a position `resolveScriptPrograms` could not resolve
 * to a program name — the same walk `executor.ts`'s `unknownProgramOf`,
 * `script-check.ts`'s `verifyScheduledScript` and the scheduled-run floor's
 * `reachesScheduler` each do over a whole script, in one place, so a test
 * against this module is a test against what all three consumers actually
 * see.
 */
function isUnknown(line: string, dialect: 'bash' | 'sh' = 'bash'): boolean {
	const reading = lexShellCommandLine(line, { dialect })
	if (reading.opaque) return true
	return resolveScriptPrograms(reading.commands, dialect).some(({ positions }) =>
		positions.some((p) => p.unknown !== undefined),
	)
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
