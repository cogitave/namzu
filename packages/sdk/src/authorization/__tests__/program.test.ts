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
	return resolveScriptPrograms(reading.commands).some(({ positions }) =>
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

describe('eval, source and the dot builtin run text as code, not a program by name', () => {
	it.each([
		['eval "$X"', 'eval, runtime string'],
		['eval "$(cat /tmp/cmd)"', 'eval, command-substitution string'],
		['source "$X"', 'source, runtime path'],
		['. "$X"', 'the dot builtin, runtime path'],
	])('%s is unknown (%s)', (line) => {
		expect(isUnknown(line), line).toBe(true)
	})

	it('is unknown even when the argument is a literal, static path', () => {
		// The argument never expands here — `./known.sh` is exactly the text
		// that runs — but `source`/`.`/`eval` read it as code to execute in the
		// current shell, not as a program's identity a rule could match, and
		// nothing here inspects a sourced file's contents. Unknown regardless
		// of literalness is deliberate, not a gap: see the module doc comment.
		expect(isUnknown('source ./known.sh')).toBe(true)
		expect(isUnknown('. ./known.sh')).toBe(true)
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

	it('is a fixed set: exactly four asks over the whole corpus above, named here', () => {
		// Pinned so a change to this list is a change someone has to look at.
		// Two are the review's own accepted asks — a program built from
		// command substitution has no static name a rule could ever match,
		// wrapper or not. The other two are `source`/`.` activating a venv:
		// ordinary and common, but `source`/`.` read their argument as code
		// to run in the current shell, unknown wherever they stand (see the
		// eval/source/dot describe block above) — a NEW ask this round adds
		// deliberately, not a regression, because the same rule that closes
		// `source "$X"` cannot stop at `source ./known.sh` without leaving
		// exactly the gap it exists to close.
		const asks = [
			'$(npm bin)/tsc --noEmit',
			'"$(git rev-parse --show-toplevel)"/scripts/x.sh',
			'source .venv/bin/activate',
			'. .venv/bin/activate',
		]
		for (const line of asks) expect(isUnknown(line), line).toBe(true)
		expect(asks).toHaveLength(4)
	})
})

describe('programPositions on one command, directly', () => {
	it('reports no positions for an empty command', () => {
		expect(
			programPositions({
				words: [],
				assignments: 0,
				redirections: [],
				text: '',
				origin: 'line',
				depth: 0,
			}),
		).toEqual([])
	})

	it('unwraps a literal wrapper to the literal program that follows it', () => {
		const reading = lexShellCommandLine('sudo systemctl stop namzu-scheduler.service', {
			dialect: 'bash',
		})
		const [command] = reading.commands
		const positions = programPositions(command as (typeof reading.commands)[number])
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
