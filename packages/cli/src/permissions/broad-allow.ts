/**
 * Allow rules that, read plainly, allow any program at all.
 *
 * `Bash(python *)` reads like permission for one tool. It is permission for
 * whatever Python is handed, so a model that can write a line of Python can
 * run anything the person could. The same is true of every interpreter, every
 * shell, a wrapper that runs the command after it (`env`, `sudo`, `timeout`),
 * a launcher for packages (`npx`, `npm run`), a remote shell, and a bare
 * `Bash` or `Bash(*)`.
 *
 * Nothing here changes what a rule matches. A rule the person wrote still
 * allows what it says. This only finds the ones that are wider than they look,
 * so `namzu doctor` and the start of a run can say so and name a rule to write
 * instead. (A session's "don't ask again" never offers one of these; that is
 * `session-allow.ts`, and `classify` mode already sends such a call to its
 * reviewer whatever the rule says.)
 */

import type { PermissionLayer } from '../config/load.js'
import { readPermissionLayers, shortHomePath } from '../config/load.js'
import { isPermissionEffect } from './rules.js'

/** Programs that run the text they are given as code. */
const INTERPRETERS: readonly string[] = [
	'python',
	'python2',
	'python3',
	'node',
	'deno',
	'tsx',
	'ruby',
	'perl',
	'php',
	'lua',
	'npx',
	'bunx',
	'npm run',
	'yarn run',
	'pnpm run',
	'bun run',
	'eval',
	'exec',
	'ssh',
]

/** Shells, and programs that run the command that follows them. */
const WRAPPERS: readonly string[] = [
	'sh',
	'bash',
	'zsh',
	'fish',
	'csh',
	'tcsh',
	'ksh',
	'mksh',
	'dash',
	'ash',
	'hush',
	'rbash',
	'rsh',
	'busybox',
	'toybox',
	'wsl',
	'cmd',
	'powershell',
	'pwsh',
	'env',
	'xargs',
	'command',
	'builtin',
	'noglob',
	'nice',
	'stdbuf',
	'nohup',
	'timeout',
	'time',
	'watch',
	'ionice',
	'chrt',
	'setsid',
	'taskset',
	'strace',
	'ltrace',
	'script',
	'flock',
	'unshare',
	'nsenter',
	'sandbox-exec',
	'sudo',
	'doas',
	'pkexec',
	'su',
	'runuser',
]

/** Tools that reach other machines or accounts; their rule has to name what they do. */
const NETWORK_TOOLS: readonly string[] = ['curl', 'wget', 'kubectl', 'aws', 'gcloud', 'gsutil']

/** `kubectl` words that change a cluster or run something in it. */
const KUBECTL_WRITES: ReadonlySet<string> = new Set([
	'exec',
	'apply',
	'create',
	'delete',
	'run',
	'cp',
	'port-forward',
	'proxy',
	'patch',
	'edit',
	'replace',
	'attach',
	'debug',
	'scale',
	'rollout',
	'drain',
	'cordon',
	'taint',
])

export interface BroadAllow {
	/** The rule as written in a list: `Bash(python *)`. */
	readonly rule: string
	/** A short name for the file it came from. */
	readonly source: string
	/** Why it allows more than it reads as. */
	readonly why: string
	/** A narrower rule to write instead. */
	readonly instead: string
}

function nameOf(program: string): string {
	return program.split(/[\\/]/).pop() ?? program
}

/** `foo:*` and `foo *` are one spelling. */
function normalised(pattern: string): string {
	const text = pattern.trim().toLowerCase()
	return text.endsWith(':*') ? `${text.slice(0, -2)} *` : text
}

/** Whether `rest` (the words a rule leaves open after a name) is only flags, or flags then a wildcard. */
function startsWithFlag(rest: string): boolean {
	return rest.startsWith('-')
}

function networkVerdict(name: string, rest: string): boolean {
	if (/[$`]/.test(rest)) return true
	const words = rest.split(/\s+/).filter((w) => w !== '' && w !== '*')
	const firstPlain = words.find((w) => !w.startsWith('-'))
	if (firstPlain === undefined) return !(/^(?:curl|wget)$/.test(name) && rest.includes('://'))
	if (/^(?:curl|wget)$/.test(name)) return false
	if (name === 'kubectl') return KUBECTL_WRITES.has(firstPlain)
	return false
}

/**
 * Whether the text of a `bash` rule allows any program.
 *
 * Returns the reason and a narrower rule, or undefined when the rule names
 * what it runs.
 */
export function broadBashPattern(
	pattern: string | undefined,
): { readonly why: string; readonly instead: string } | undefined {
	if (pattern === undefined || /^[\s*]*$/.test(pattern) || /^:?\*$/.test(pattern.trim())) {
		return {
			why: 'it allows every command',
			instead: 'Bash(git status *) and Bash(pnpm test *), one rule for each command you trust',
		}
	}
	const text = normalised(pattern)
	for (const name of [...INTERPRETERS, ...WRAPPERS, ...NETWORK_TOOLS]) {
		const exact = text === name || text === `${name} *` || text === `${name}*`
		const prefix = text.startsWith(`${name} `) && text.endsWith('*')
		if (!exact && !prefix) continue
		const rest = exact ? '' : text.slice(name.length + 1, -1).trim()
		if (NETWORK_TOOLS.includes(name)) {
			if (exact || networkVerdict(name, rest)) {
				return {
					why: `it lets \`${name}\` do anything it can`,
					instead: networkInstead(name),
				}
			}
			continue
		}
		if (INTERPRETERS.includes(name)) {
			const module = /^python[\d.]*$/.test(name) && /^-m\s+[\w.]+\s*$/.test(rest)
			if (exact || (startsWithFlag(rest) && !module)) {
				return {
					why: `it lets \`${name}\` run any code it is given`,
					instead: interpreterInstead(name),
				}
			}
			continue
		}
		if (exact || startsWithFlag(rest)) {
			return {
				why: `it lets \`${name}\` run any command after it`,
				instead: `Bash(${name === 'sudo' ? 'sudo systemctl status *' : `${name} 30 git status *`})`,
			}
		}
	}
	return wrappedProgram(text)
}

function networkInstead(name: string): string {
	if (name === 'curl' || name === 'wget') return `Bash(${name} https://api.example.com/*)`
	return `Bash(${name} get *)`
}

function interpreterInstead(name: string): string {
	if (name === 'npx' || name === 'bunx') return `Bash(${name} prettier *)`
	if (/\srun$/.test(name)) return `Bash(${name} build)`
	if (name === 'ssh') return 'Bash(ssh deploy@host.example.com uptime)'
	if (name === 'eval' || name === 'exec')
		return 'Bash(git status *), the command itself without eval or exec'
	return `Bash(${name} scripts/build.py *)`
}

/**
 * A wrapper word followed by a wildcard where the program should be, or by a
 * flag that runs a string (`bash -c *`), in any order of its own flags.
 */
function wrappedProgram(
	text: string,
): { readonly why: string; readonly instead: string } | undefined {
	const head = text.split('*')[0] ?? ''
	const words = head.split(/\s+/).filter((w) => w !== '')
	if (words.some((w) => /^(?:-\w*c|\/c)$/.test(w))) {
		const shell = words.find((w) => WRAPPERS.includes(nameOf(w)))
		if (shell !== undefined) {
			return {
				why: `it lets \`${nameOf(shell)} -c\` run any command line`,
				instead: 'Bash(git status *)',
			}
		}
	}
	let i = 0
	while (
		i < words.length &&
		(/^\w+=/.test(words[i] as string) ||
			/^-/.test(words[i] as string) ||
			/^\d+[smhd]?$/.test(words[i] as string))
	) {
		i += 1
	}
	const first = words[i]
	if (first === undefined || !WRAPPERS.includes(nameOf(first))) return undefined
	const afterWrapper = words.slice(i + 1).filter((w) => !/^(?:-|\w+=|\d+[smhd]?$)/.test(w))
	const next = afterWrapper[0]
	if (next === undefined && text.includes('*')) {
		return {
			why: `it lets \`${nameOf(first)}\` run any command after it`,
			instead: `Bash(${nameOf(first)} 30 git status *)`,
		}
	}
	if (
		next !== undefined &&
		[...INTERPRETERS, ...WRAPPERS, ...NETWORK_TOOLS].includes(nameOf(next)) &&
		text.endsWith('*')
	) {
		return {
			why: `it lets \`${nameOf(next)}\` run anything through \`${nameOf(first)}\``,
			instead: 'Bash(git status *)',
		}
	}
	return undefined
}

/** The allow rules in these files that allow any program, with the file each came from. */
export function broadAllowRules(layers: readonly PermissionLayer[]): BroadAllow[] {
	const out: BroadAllow[] = []
	for (const layer of layers) {
		const key = Object.keys(layer.permissions).find((k) => k.toLowerCase() === 'bash')
		const rule = key === undefined ? undefined : layer.permissions[key]
		if (rule === undefined) continue
		const source = shortHomePath(layer.path)
		if (typeof rule === 'string') {
			if (rule !== 'allow') continue
			const found = broadBashPattern(undefined)
			if (found) out.push({ rule: 'Bash', source, ...found })
			continue
		}
		for (const [pattern, effect] of Object.entries(rule)) {
			if (!isPermissionEffect(effect) || effect !== 'allow') continue
			const found = broadBashPattern(pattern)
			if (found) out.push({ rule: `Bash(${pattern})`, source, ...found })
		}
	}
	return out
}

/** One finding as a line for a person. */
export function describeBroadAllow(found: BroadAllow): string {
	return `${found.rule} (${found.source}) is wider than it reads: ${found.why}. Write a narrower rule instead, such as ${found.instead}.`
}

/**
 * Say each wide allow rule once per process, the way a legacy rule name is
 * said: the files are read the same way `/permissions` reads them, and a file
 * that cannot be read is left to the loader to report.
 */
const saidBroad = new Set<string>()

export function warnBroadAllowRules(
	cwd: string | undefined,
	log: { warn: (message: string) => void },
	read: () => readonly PermissionLayer[] = () => readPermissionLayers(cwd ? { cwd } : {}),
): void {
	let found: BroadAllow[]
	try {
		found = broadAllowRules(read())
	} catch {
		return
	}
	for (const item of found) {
		const text = describeBroadAllow(item)
		if (saidBroad.has(text)) continue
		saidBroad.add(text)
		log.warn(text)
	}
}
