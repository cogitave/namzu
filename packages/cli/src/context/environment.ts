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
 * Read fresh each turn for the same reason the branch is worth having at all: a
 * session that crosses midnight, or in which the agent checks out a branch
 * itself, must not keep asserting what was true when it started. Because the
 * text only changes when the fact changes, a fresh read costs a cache miss
 * exactly when a cache hit would have been wrong.
 */

import { execFile } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { promisify } from 'node:util'

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
}

/** What the model needs to know about running under WSL. */
export interface WslFacts {
	/** `WSL_DISTRO_NAME`, when the environment carries it. */
	readonly distro: string | null
	/** Windows executables can be started from the Linux side. */
	readonly interop: boolean
	/** Windows drives mounted under `/mnt`, as `/mnt/<letter>`. */
	readonly drives: readonly string[]
}

/**
 * WSL, or `undefined` on any other Linux.
 *
 * The environment is the signal: WSL sets `WSL_DISTRO_NAME` in every
 * process it starts, and `WSL_INTEROP` names the interop socket when interop
 * is on. Interop also counts as on when its binfmt handler is registered
 * (`/proc/sys/fs/binfmt_misc/WSLInterop`), which survives a shell that
 * dropped the variable. Drives are the one-letter directories under `/mnt`
 * — `/mnt/wsl` and `/mnt/wslg` are WSL's own and are not drives.
 *
 * Every probe is injectable so a test can describe a machine it is not
 * running on; the defaults read this one.
 */
export function detectWsl(
	env: NodeJS.ProcessEnv = process.env,
	probe: {
		readonly exists?: (path: string) => boolean
		readonly list?: (path: string) => readonly string[]
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
	const drives = list('/mnt')
		.filter((name) => /^[a-z]$/i.test(name))
		.sort()
		.map((name) => `/mnt/${name}`)
	return { distro, interop, drives }
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

export function composeEnvironmentPrompt(facts: EnvironmentFacts): string {
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
	if (facts.additionalDirectories && facts.additionalDirectories.length > 0) {
		lines.push(
			`Besides the working directory, the file tools may reach these directories, by absolute path: ${facts.additionalDirectories.map((d) => `\`${d}\``).join(', ')}. Relative paths still resolve against the working directory.`,
		)
	}
	if (facts.boundary) lines.push(...boundaryLines(facts.boundary))
	if (facts.wsl) lines.push(...wslLines(facts.wsl, facts.boundary))
	lines.push(
		'These are facts about right now. Prefer them over any date or branch you would otherwise assume.',
	)
	return `## Environment\n\n${lines.join('\n')}`
}

/** The boundary, and the way past it, in the words the model acts on. */
function boundaryLines(boundary: ExecutionBoundary): string[] {
	const decides = boundary.interactive
		? 'the user is asked to approve it first'
		: "it goes to this session's permission mode first (nobody is at the terminal to ask)"
	if (!boundary.sandbox) {
		return [
			'Tools run on this machine, not in a sandbox: shell commands and file changes go through the permission settings, which may ask the user before they run.',
			`The file tools reach the working directory and any added directories directly. A path anywhere else is not refused: ${decides}. When you need a directory repeatedly, suggest the user add it with \`/add-dir <path>\`. A refusal that remains is a decision, not a missing file; say so rather than retrying another spelling.`,
		]
	}
	const { environment, enforced } = boundary.sandbox
	const network = enforced.includes('network')
		? ' The network is cut inside it.'
		: ' It does not cut the network on this machine.'
	const escapeRoute =
		boundary.escape === 'ask'
			? 'When one command genuinely cannot work inside it (it needs the network, a path it does not mount, or a host tool), set `dangerously_disable_sandbox: true` on that one `bash` call: the user is asked to approve it every time, in every permission mode. Never use it to get around a permission refusal.'
			: boundary.escape === 'unattended'
				? 'When one command genuinely cannot work inside it, `dangerously_disable_sandbox: true` on that `bash` call runs it on the host: this session is configured to allow that without asking, and every use is recorded. Use it only when the sandbox is the obstacle.'
				: 'Commands cannot leave the sandbox in this session. When one needs something the sandbox withholds, say what and why, and let the user decide.'
	return [
		`Shell commands run in a sandbox (${environment}${enforced.length > 0 ? `, enforcing ${enforced.join(', ')}` : ', enforcing nothing on this platform'}). It mounts only the working directory and the added directories; nothing else exists inside it, so no spelling of another path will be found.${network}`,
		`To reach another directory, ask the user to add it with \`/add-dir <path>\` (the next turn binds it). ${escapeRoute}`,
	]
}

/** WSL: where the Windows side is, and how to reach it from here. */
function wslLines(wsl: WslFacts, boundary: ExecutionBoundary | undefined): string[] {
	const sandboxed = boundary?.sandbox !== undefined
	const drives =
		wsl.drives.length > 0
			? `Windows drives are mounted under ${wsl.drives.map((d) => `\`${d}\``).join(', ')} (\`C:\\Users\` is \`/mnt/c/Users\`; \`wslpath -w\` and \`wslpath -u\` convert).`
			: 'No Windows drive is mounted under `/mnt` right now.'
	const reach = sandboxed
		? 'They are outside the sandbox, so a command there needs `/add-dir` or the sandbox escape.'
		: 'They are outside the working directory, so a file tool reaching them asks for approval first, like any other outside path.'
	const interop = wsl.interop
		? `Windows programs start from the shell through WSL interop, by their \`.exe\` name: \`powershell.exe -NoProfile -Command ...\`, \`cmd.exe /c ...\`, \`explorer.exe .\`. \`cmd.exe\` started from a Linux directory warns that UNC paths are unsupported and falls back to C:\\Windows, so \`cd\` under \`/mnt/c\` first or use \`powershell.exe\`. If a name is not found, the Windows side of \`PATH\` was not appended; \`cmd.exe\` is under \`/mnt/c/Windows/System32\` and \`powershell.exe\` under its \`WindowsPowerShell/v1.0\`.${sandboxed ? ' The sandbox does not mount the Windows drives those programs live on, so running one needs the sandbox escape.' : ''}`
		: 'WSL interop is off here, so Windows `.exe` programs cannot be started from the shell.'
	return [
		`This machine is Windows Subsystem for Linux${wsl.distro ? ` (distro \`${wsl.distro}\`)` : ''}. ${drives} ${reach}`,
		interop,
	]
}
