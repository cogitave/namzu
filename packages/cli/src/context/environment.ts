/**
 * Where the agent is and when it is.
 *
 * The kernel already tells the model the working directory and the platform.
 * It does not tell it the DATE, and it does not tell it anything about the
 * repository. Both are missing facts a coding agent needs constantly and
 * cannot get right by guessing:
 *
 * - **The date.** A model with no clock answers from its training cut-off. It
 *   writes that date into a changelog entry, into the `last_updated` frontmatter
 *   this repository's own docs carry, into a copyright header — and reasons
 *   about "the current version" of everything from a year that has passed.
 *   Nothing about the output looks wrong; it is confidently, quietly stale.
 * - **The branch.** "Commit this" means something different on a release branch
 *   than on a scratch one, and an agent that has to spend a tool call to find
 *   out spends it on every session.
 *
 * ## What is deliberately NOT here
 *
 * **The working tree's dirty state.** It is the fact a reader will most want to
 * add, and adding it would cost real money for nothing. This block goes into
 * the system prompt, which is the CACHED prefix of every request; a file count
 * that changes whenever the agent saves a file would re-key that prefix on
 * essentially every turn. The date changes once a day and a branch changes
 * rarely, so those two are cheap to carry — and `git status` is one tool call
 * away for an agent that actually needs it, which is the right place to pay.
 *
 * In the interactive terminal the date and branch no longer ride in the
 * system prompt at all (`stable` below): they arrive as an environment reminder,
 * said once and again only when they change, so even that once-a-day re-key is
 * gone. The paragraph above explains why they were cheap enough to carry; the
 * reminder makes them free.
 *
 * Read fresh each turn for the same reason the branch is worth having at all: a
 * session that crosses midnight, or in which the agent checks out a branch
 * itself, must not keep asserting what was true when it started. Because the
 * text only changes when the fact changes, a fresh read costs a cache miss
 * exactly when a cache hit would have been wrong.
 */

import { execFile } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { promisify } from 'node:util'
import type { PermissionMode } from '../permissions/mode.js'

const run = promisify(execFile)

/** Bound on a single git call. A wedged repository must not stall a turn. */
const GIT_TIMEOUT_MS = 2_000

/**
 * Where the tools run and how the model gets past the edge of it.
 *
 * The model used to learn its boundary from refusal strings — "Path escapes
 * the working directory… Tools may only reach inside X" — and read every one
 * as a wall, including the ones with a door in them. Stated up front, it can
 * say what it can reach, and ask for the right thing when it cannot.
 */
export interface ExecutionBoundary {
	/** Present when commands run in the OS sandbox; absent means the host. */
	readonly sandbox?: {
		/** The environment the sandbox resolved to, e.g. `linux-bwrap`. */
		readonly environment: string
		/** Controls this machine actually applies, e.g. `filesystem`, `network`. */
		readonly enforced: readonly string[]
	}
	/**
	 * What a sandboxed command's `dangerously_disable_sandbox` gets: put to the
	 * user (`ask`), granted unasked by configuration (`unattended`), or refused
	 * (`refused` — escapes off, or nobody to ask). Ignored on the host.
	 */
	readonly escape: 'ask' | 'unattended' | 'refused'
	/** Whether a person answers the permission prompts in this session. */
	readonly interactive: boolean
	/**
	 * The permission mode the turn starts under. Absent leaves the sentence
	 * about permissions general, as it was before the mode was passed.
	 */
	readonly mode?: PermissionMode
	/**
	 * This prompt is a sub-agent's. It has no operator of its own and is told
	 * nothing about the mode: its calls follow the session that started it.
	 */
	readonly delegated?: boolean
}

/** What the model needs to know about running under WSL. */
export interface WslFacts {
	/** `WSL_DISTRO_NAME`, when the environment carries it. */
	readonly distro: string | null
	/** Windows executables can be started from the Linux side. */
	readonly interop: boolean
	/** Windows drives mounted under the mount root, as `/mnt/<letter>` by default. */
	readonly drives: readonly string[]
	/**
	 * Where the drives are mounted, with a trailing slash: `[automount] root`
	 * in `/etc/wsl.conf`. Absent means `/mnt/`.
	 */
	readonly mountRoot?: string
}

/**
 * WSL, or `undefined` on any other Linux.
 *
 * The environment is the signal: WSL sets `WSL_DISTRO_NAME` in every
 * process it starts, and `WSL_INTEROP` names the interop socket when interop
 * is on. Interop also counts as on when its binfmt handler is registered
 * (`/proc/sys/fs/binfmt_misc/WSLInterop`), which survives a shell that
 * dropped the variable. Drives are the one-letter directories under the
 * mount root (`/mnt/` unless `/etc/wsl.conf` moves it) — `/mnt/wsl` and
 * `/mnt/wslg` are WSL's own and are not drives.
 *
 * Every probe is injectable so a test can describe a machine it is not
 * running on; the defaults read this one.
 */
export function detectWsl(
	env: NodeJS.ProcessEnv = process.env,
	probe: {
		readonly exists?: (path: string) => boolean
		readonly list?: (path: string) => readonly string[]
		/** The mount root; absent reads `/etc/wsl.conf`. */
		readonly mountRoot?: string
	} = {},
): WslFacts | undefined {
	const distro = env.WSL_DISTRO_NAME?.trim() || null
	const socket = env.WSL_INTEROP?.trim() || null
	if (!distro && !socket) return undefined
	const exists = probe.exists ?? existsSync
	const list =
		probe.list ??
		((path: string) => {
			try {
				return readdirSync(path)
			} catch {
				return []
			}
		})
	const interop = socket !== null || exists('/proc/sys/fs/binfmt_misc/WSLInterop')
	const mountRoot = probe.mountRoot ?? readWslMountRoot()
	const drives = list(mountRoot === '/' ? '/' : mountRoot.slice(0, -1))
		.filter((name) => /^[a-z]$/i.test(name))
		.sort()
		.map((name) => `${mountRoot}${name}`)
	return { distro, interop, drives, mountRoot }
}

/** Where WSL mounts the Windows drives unless `/etc/wsl.conf` moves them. */
export const DEFAULT_WSL_MOUNT_ROOT = '/mnt/'

/**
 * The `[automount] root` of a `wsl.conf`, with a trailing slash; `/mnt/` when
 * the file, the section or the key is absent, or the value is not absolute.
 *
 * The same reading `@namzu/browser` makes (`parseWslMountRoot` there), kept
 * here because the CLI's leaf packages do not import one another: sections
 * and keys in any case, `#`/`;` comments, quotes around the value, a BOM.
 */
export function parseWslMountRoot(wslConf: string | undefined): string {
	if (!wslConf) return DEFAULT_WSL_MOUNT_ROOT
	let inAutomount = false
	let root: string | undefined
	for (const raw of wslConf.replace(/^\uFEFF/, '').split(/\r?\n/)) {
		const line = raw.trim()
		if (line.length === 0 || line.startsWith('#') || line.startsWith(';')) continue
		const section = /^\[([^\]]+)\]$/.exec(line)
		if (section) {
			inAutomount = (section[1] ?? '').trim().toLowerCase() === 'automount'
			continue
		}
		const eq = line.indexOf('=')
		if (!inAutomount || eq <= 0 || line.slice(0, eq).trim().toLowerCase() !== 'root') continue
		let value = line
			.slice(eq + 1)
			.replace(/\s[#;].*$/, '')
			.trim()
		if (/^(["']).*\1$/.test(value)) value = value.slice(1, -1)
		root = value
	}
	if (!root || !root.startsWith('/')) return DEFAULT_WSL_MOUNT_ROOT
	return root.endsWith('/') ? root : `${root}/`
}

/** This machine's mount root, from `/etc/wsl.conf`; `/mnt/` when it cannot be read. */
export function readWslMountRoot(
	readFile: (path: string) => string | undefined = (path) => {
		try {
			return readFileSync(path, 'utf8')
		} catch {
			return undefined
		}
	},
): string {
	return parseWslMountRoot(readFile('/etc/wsl.conf'))
}

/** Windows' `System32` as WSL mounts it: `/mnt/c/Windows/System32` under the default root. */
export function wslSystem32(mountRoot: string = DEFAULT_WSL_MOUNT_ROOT): string {
	return `${mountRoot}c/Windows/System32`
}

export interface EnvironmentFacts {
	/** ISO calendar date, `YYYY-MM-DD`, in the machine's own timezone. */
	readonly today: string
	/** Directories besides the working directory the file tools may reach, absolute. */
	readonly additionalDirectories?: readonly string[]
	/** Where the tools run; absent leaves the boundary unstated, as before. */
	readonly boundary?: ExecutionBoundary
	/** Present when this is WSL. */
	readonly wsl?: WslFacts
	/**
	 * `branch` when on one, `null` when the working directory is not a
	 * repository, `'detached'` when it is one with no branch checked out.
	 */
	readonly branch: string | null
	readonly isRepository: boolean
}

/**
 * The machine's local calendar date.
 *
 * Local, not UTC: the user's "today" is the one on their wall, and an agent
 * that writes tomorrow's date into a changelog because the machine is eight
 * hours behind UTC has made exactly the mistake this exists to prevent.
 */
export function localIsoDate(now: Date): string {
	const pad = (n: number): string => String(n).padStart(2, '0')
	return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

async function git(cwd: string, args: readonly string[]): Promise<string | null> {
	try {
		const { stdout } = await run('git', [...args], { cwd, timeout: GIT_TIMEOUT_MS })
		const out = stdout.trim()
		return out.length > 0 ? out : null
	} catch {
		// No git on the machine, not a repository, or the call timed out. All
		// three mean the same thing to a caller: this fact is unavailable, and
		// the block below simply does not claim it.
		return null
	}
}

export async function readEnvironmentFacts(
	cwd: string,
	now: Date = new Date(),
): Promise<EnvironmentFacts> {
	// `symbolic-ref` rather than `rev-parse --abbrev-ref HEAD`, because it
	// answers on an unborn branch — a freshly initialised repository with no
	// commit yet, where `rev-parse HEAD` fails and would be read as "not a
	// repository". Both calls at once: they are independent and each is a
	// process.
	const [insideWorkTree, branch] = await Promise.all([
		git(cwd, ['rev-parse', '--is-inside-work-tree']),
		git(cwd, ['symbolic-ref', '--short', 'HEAD']),
	])
	const isRepository = insideWorkTree === 'true'
	return {
		today: localIsoDate(now),
		// A repository with no symbolic HEAD is on a detached one. Distinguishing
		// that from "not a repository" matters: on a detached HEAD a commit goes
		// nowhere reachable, and an agent about to commit should know.
		branch: isRepository ? (branch ?? 'detached') : null,
		isRepository,
	}
}

/** How {@link composeEnvironmentPrompt} is read. */
export interface EnvironmentPromptOptions {
	/**
	 * Leave out what changes while a session runs: the date, the branch and
	 * the permission mode's wording. The text then belongs in the cached
	 * prefix, because nothing in it is re-keyed by a new day, a checkout or a
	 * mode switch. Those facts ride in reminders instead (see
	 * `reminders/environment.ts` and `reminders/mode.ts`).
	 */
	readonly stable?: boolean
}

/** The date and branch sentences, the facts that change under a running session. */
export function environmentFactLines(
	facts: Pick<EnvironmentFacts, 'today' | 'branch' | 'isRepository'>,
): string[] {
	const lines = [`Today's date is ${facts.today}.`]
	if (!facts.isRepository) {
		lines.push('The working directory is not a git repository.')
	} else if (facts.branch === 'detached') {
		lines.push(
			'The working directory is a git repository with a detached HEAD — no branch is checked out, so a commit made here is not reachable from any branch.',
		)
	} else {
		lines.push(`The working directory is a git repository on branch \`${facts.branch}\`.`)
	}
	return lines
}

export function composeEnvironmentPrompt(
	facts: EnvironmentFacts,
	options: EnvironmentPromptOptions = {},
): string {
	const stable = options.stable === true
	const lines = stable ? [] : environmentFactLines(facts)
	if (facts.additionalDirectories && facts.additionalDirectories.length > 0) {
		lines.push(
			`Besides the working directory, the file tools may reach these directories, by absolute path: ${facts.additionalDirectories.map((d) => `\`${d}\``).join(', ')}. Relative paths still resolve against the working directory.`,
		)
	}
	if (facts.boundary) lines.push(...boundaryLines(facts.boundary, stable))
	if (facts.wsl) lines.push(...wslLines(facts.wsl, facts.boundary))
	if (!stable) {
		lines.push(
			'These are facts about right now. Prefer them over any date or branch you would otherwise assume.',
		)
	}
	return `## Environment\n\n${lines.join('\n')}`
}

/**
 * What the permission mode does to a call on the host, said per mode and never
 * more than the mode does: the safety rules that no mode relaxes are named as
 * such, so a mode that stops asking is not read as one that stops checking.
 */
export function permissionSentence(boundary: ExecutionBoundary, stable = false): string {
	if (stable) {
		return 'Shell commands and file changes go through the permission settings. Whether the user is asked first depends on the permission mode; you are told whenever the mode is anything but the usual one, and when it ends (plan mode has its own notices).'
	}
	if (boundary.delegated) {
		return 'Your shell commands and file changes follow the permission mode of the session that started you. You have no one to ask yourself, and a refused call stays refused.'
	}
	const noOneAsks = boundary.interactive
		? ''
		: ' Nobody is at the terminal, so a call that would ask is refused.'
	switch (boundary.mode) {
		case undefined:
			return 'Shell commands and file changes go through the permission settings, which may ask the user before they run.'
		case 'prompt':
			return `Shell commands and file changes the user's rules do not already allow are put to the user before they run.${noOneAsks}`
		case 'accept-edits':
			return `File edits and simple file commands in the working directory run without asking; any other shell command or change is put to the user first.${noOneAsks}`
		case 'plan':
			return 'This is plan mode: reading is allowed and every change is refused, except to the plan file, until the user leaves plan mode.'
		case 'bypass':
			return "Permission prompts are off in this mode, so calls run without asking. What always needs the user still does: removing a home or top-level directory, leaving a sandbox, and anything the user's rules say to ask about. Protected files and the safety rules apply as usual."
		case 'classify':
			return `Calls that would otherwise ask the user are checked automatically instead, and some may still be refused. A refused call is a decision, not an error to route around.${noOneAsks}`
		case 'strict':
			return 'Only preapproved tools run; any other call is refused without asking.'
		case 'auto':
			return 'Nobody is asked: routine calls run and anything out of bounds is refused.'
	}
}

/** The boundary, and the way past it, in the words the model acts on. */
function boundaryLines(boundary: ExecutionBoundary, stable = false): string[] {
	if (!boundary.sandbox) {
		const outside = boundary.delegated
			? 'A path anywhere else is refused, or decided by the session that started you, and you cannot approve it yourself. If you needed a directory, name it in your summary.'
			: boundary.interactive
				? 'A path anywhere else is not refused outright: the user is asked to approve that call first, every time — in plan mode too, for a read; the strict permission mode refuses it. When you need a directory repeatedly, suggest the user add it with `/add-dir <path>`.'
				: 'A path anywhere else is refused in this session, because it needs a person to approve it and nobody is at the terminal. If you need one, say which directory and why, so the user can add it (`--add-dir <path>`) and run again.'
		return [
			`Tools run on this machine, not in a sandbox. ${permissionSentence(boundary, stable)}`,
			`The file tools reach the working directory and any added directories directly. ${outside} A refusal that remains is a decision, not a missing file; say so rather than retrying another spelling.`,
		]
	}
	const { environment, enforced } = boundary.sandbox
	const network = enforced.includes('network')
		? ' The network is cut inside it.'
		: ' It does not cut the network on this machine.'
	const escapeRoute =
		boundary.escape === 'ask'
			? 'When one command genuinely cannot work inside it (it needs the network, a path it does not mount, or a host tool), set `dangerously_disable_sandbox: true` on that one `bash` call: the user is asked to approve it every time, whatever else is approved; the plan and strict permission modes refuse it. Never use it to get around a permission refusal.'
			: boundary.escape === 'unattended'
				? 'When one command genuinely cannot work inside it, `dangerously_disable_sandbox: true` on that `bash` call runs it on the host: this session is configured to allow that without asking, and every use is recorded. Use it only when the sandbox is the obstacle.'
				: 'Commands cannot leave the sandbox in this session. When one needs something the sandbox withholds, say what and why, and let the user decide.'
	// Said per what the platform enforces, never more. A tier that does not
	// confine the file system (`linux-namespace`, `basic`) leaves the whole
	// host visible to a command; one that does still shows it the system
	// directories programs need, read-only, and a private /tmp.
	const files = enforced.includes('filesystem')
		? ' Inside it, commands can read and write the working directory and the added directories; the system directories programs need are readable, /tmp is private to the command, and the rest of this machine (the home directory, other projects, other mounts) cannot be reached from it, so no spelling of such a path will be found.'
		: ' It does not confine the file system here, so commands can still see files outside the working directory.'
	return [
		`Shell commands run in a sandbox (${environment}${enforced.length > 0 ? `, enforcing ${enforced.join(', ')}` : ', enforcing nothing on this platform'}).${files}${network} The file tools reach only the working directory and the added directories.`,
		`${
			boundary.delegated
				? 'To reach another directory, name it in your summary; the session that started you decides whether to add it.'
				: 'To reach another directory, ask the user to add it with `/add-dir <path>` (the next turn binds it).'
		} ${escapeRoute}`,
	]
}

/** WSL: where the Windows side is, and how to reach it from here. */
function wslLines(wsl: WslFacts, boundary: ExecutionBoundary | undefined): string[] {
	// Only a sandbox that confines the file system hides the drives; one that
	// does not leaves them visible to commands, like the host.
	const sandboxed = boundary?.sandbox?.enforced.includes('filesystem') === true
	const fileTools =
		boundary?.sandbox !== undefined
			? 'the file tools reach them only once added with `/add-dir`'
			: boundary?.interactive === false
				? 'a file tool reaching them is refused in this session, since nobody is here to approve it'
				: 'a file tool reaching them asks for approval first, like any other outside path'
	// The paths below are ones the model will type, so they follow the mount
	// root; under the default one the text is what it always was.
	const root = wsl.mountRoot ?? DEFAULT_WSL_MOUNT_ROOT
	const drives =
		wsl.drives.length > 0
			? `Windows drives are mounted under ${wsl.drives.map((d) => `\`${d}\``).join(', ')} (\`C:\\Users\` is \`${root}c/Users\`; \`wslpath -w\` and \`wslpath -u\` convert).`
			: `No Windows drive is mounted under \`${root === '/' ? '/' : root.slice(0, -1)}\` right now.`
	const reach = sandboxed
		? 'They are outside the sandbox, so a command there needs `/add-dir` or the sandbox escape.'
		: `They are outside the working directory, so ${fileTools}.`
	const interop = wsl.interop
		? `Windows programs start from the shell through WSL interop, by their \`.exe\` name: \`powershell.exe -NoProfile -Command ...\`, \`cmd.exe /c ...\`, \`explorer.exe .\` (it exits 1 even when it succeeds). \`cmd.exe\` started from a Linux directory warns that UNC paths are unsupported and falls back to C:\\Windows, so \`cd\` under \`${root}c\` first or use \`powershell.exe\`. If a name is not found, the Windows side of \`PATH\` was not appended; \`cmd.exe\` is under \`${wslSystem32(root)}\` and \`powershell.exe\` under its \`WindowsPowerShell/v1.0\`.${sandboxed ? ' The sandbox does not mount the Windows drives those programs live on, so running one needs the sandbox escape.' : ''}`
		: 'WSL interop is off here, so Windows `.exe` programs cannot be started from the shell.'
	return [
		`This machine is Windows Subsystem for Linux${wsl.distro ? ` (distro \`${wsl.distro}\`)` : ''}. ${drives} ${reach}`,
		interop,
	]
}
