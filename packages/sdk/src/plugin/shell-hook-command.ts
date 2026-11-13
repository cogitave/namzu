/**
 * What a hook's `if` on a shell command sees beyond the line as typed.
 *
 * A filter such as `Bash(git push *)` is written about a command, and the
 * same command runs behind a wrapper (`sudo git push`, `env A=1 git push`,
 * `nohup git push &`, `xargs git push`, `find . -exec git push {} ;`), under
 * its full path (`/usr/bin/git push`) and with options in front of its
 * subcommand (`git -C repo push`). The hook is attached to stop things, so a
 * filter that misses one of those spellings switches the guard off. Each
 * command of the line is therefore also read with its wrappers peeled, its
 * program named by its basename and git's global options dropped, and the
 * filter matches if any of those readings does.
 *
 * A command whose name is not known until the line runs (`$(echo git) push`,
 * `$CMD push`) cannot be compared with anything: `unknowable` says so, and
 * the caller runs the hook.
 */

import { basename, lexShellCommandLine } from '../authorization/shell-lexer.js'

export interface HookCommandReading {
	/** Every spelling of every command the line runs, as words joined by one space. */
	readonly candidates: readonly string[]
	/** The line runs something whose name cannot be read from it. */
	readonly unknowable: boolean
}

const MAX_VARIANTS = 48

/** Options of a wrapper that take the next word as their value. */
const WRAPPER_VALUE_OPTIONS: Readonly<Record<string, ReadonlySet<string>>> = {
	env: new Set(['-u', '--unset', '-C', '--chdir', '-S', '--split-string']),
	sudo: new Set([
		'-u',
		'--user',
		'-g',
		'--group',
		'-h',
		'--host',
		'-p',
		'--prompt',
		'-C',
		'-D',
		'-R',
		'-T',
		'-U',
	]),
	doas: new Set(['-u', '-C']),
	nice: new Set(['-n', '--adjustment']),
	ionice: new Set(['-c', '-n', '-p', '-P', '-u']),
	timeout: new Set(['-s', '--signal', '-k', '--kill-after']),
	xargs: new Set([
		'-I',
		'-i',
		'-n',
		'-P',
		'-d',
		'-L',
		'-l',
		'-s',
		'-E',
		'-e',
		'-a',
		'--max-args',
		'--max-procs',
		'--delimiter',
		'--max-lines',
		'--max-chars',
		'--arg-file',
	]),
	stdbuf: new Set(['-i', '-o', '-e']),
	command: new Set(),
	nohup: new Set(),
	exec: new Set(['-a']),
	builtin: new Set(),
	time: new Set(['-f', '--format', '-o', '--output']),
	setsid: new Set(),
	chroot: new Set(),
	busybox: new Set(),
	watch: new Set(['-n', '--interval']),
	flock: new Set(['-w', '--timeout', '-E', '--conflict-exit-code']),
}

/** Global options of git that stand between `git` and its subcommand. */
const GIT_VALUE_OPTIONS = new Set([
	'-C',
	'-c',
	'--git-dir',
	'--work-tree',
	'--namespace',
	'--exec-path',
	'--super-prefix',
	'--config-env',
])

/** The words after the wrapper at `words[0]`, or `undefined` when it is not one. */
function peelWrapper(words: readonly string[]): readonly string[] | undefined {
	const head = basename(words[0] ?? '')
	const valueOptions = WRAPPER_VALUE_OPTIONS[head]
	if (valueOptions === undefined) return undefined
	let index = 1
	while (index < words.length) {
		const word = words[index] as string
		if (word === '--') {
			index += 1
			break
		}
		if (head === 'env' && /^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) {
			index += 1
			continue
		}
		if (word.startsWith('-') && word.length > 1) {
			index += valueOptions.has(word) ? 2 : 1
			continue
		}
		// `timeout 5 cmd`, `nice 10 cmd` (old form): a bare duration or number.
		if ((head === 'timeout' || head === 'nice') && /^\d+(?:\.\d+)?[smhd]?$/.test(word)) {
			index += 1
			continue
		}
		break
	}
	// `flock <lockfile> cmd`: the first word after the options is the lock, not the command.
	if (head === 'flock') index += 1
	const rest = words.slice(index)
	return rest.length > 0 ? rest : undefined
}

/** The commands after each `-exec`, `-execdir` or `-ok` of a `find`. */
function findExecutions(words: readonly string[]): string[][] {
	if (basename(words[0] ?? '') !== 'find') return []
	const found: string[][] = []
	for (let index = 1; index < words.length; index += 1) {
		const word = words[index]
		if (word !== '-exec' && word !== '-execdir' && word !== '-ok' && word !== '-okdir') continue
		const body: string[] = []
		for (let next = index + 1; next < words.length; next += 1) {
			const each = words[next] as string
			if (each === ';' || each === ';' || each === '+') break
			body.push(each)
		}
		if (body.length > 0) found.push(body)
	}
	return found
}

/** `git -C repo push` as `git push`. */
function dropGitGlobals(words: readonly string[]): readonly string[] | undefined {
	if (basename(words[0] ?? '') !== 'git') return undefined
	const kept: string[] = ['git']
	let index = 1
	let dropped = false
	while (index < words.length) {
		const word = words[index] as string
		if (!word.startsWith('-')) break
		const name = word.split('=')[0] as string
		if (GIT_VALUE_OPTIONS.has(name)) {
			index += word.includes('=') ? 1 : 2
			dropped = true
		} else if (
			word === '--no-pager' ||
			word === '-p' ||
			word === '-P' ||
			word === '--paginate' ||
			word === '--no-optional-locks' ||
			word === '--bare' ||
			word === '--no-replace-objects'
		) {
			index += 1
			dropped = true
		} else {
			break
		}
	}
	if (!dropped) return undefined
	return [...kept, ...words.slice(index)]
}

function variantsOf(start: readonly string[]): string[][] {
	const seen = new Map<string, string[]>()
	const queue: string[][] = [[...start]]
	while (queue.length > 0 && seen.size < MAX_VARIANTS) {
		const words = queue.shift() as string[]
		const key = words.join('\u0000')
		if (seen.has(key)) continue
		seen.set(key, words)
		const first = words[0]
		if (first === undefined) continue
		const peeled = peelWrapper(words)
		if (peeled !== undefined) queue.push([...peeled])
		for (const body of findExecutions(words)) queue.push(body)
		const git = dropGitGlobals(words)
		if (git !== undefined) queue.push([...git])
		const base = basename(first)
		if (base !== first) queue.push([base, ...words.slice(1)])
	}
	return [...seen.values()]
}

export function readHookCommand(line: string): HookCommandReading {
	const lexed = lexShellCommandLine(line, { dialect: 'sh' })
	if (!lexed.complete) return { candidates: [], unknowable: true }
	const candidates = new Set<string>()
	let unknowable = false
	for (const command of lexed.commands) {
		const words = command.words.slice(command.assignments)
		const head = words[0]
		if (head === undefined) continue
		if (head.expands && /[$`]/.test(head.text)) unknowable = true
		for (const variant of variantsOf(words.map((word) => word.value))) {
			candidates.add(variant.join(' '))
		}
	}
	return { candidates: [...candidates], unknowable }
}
