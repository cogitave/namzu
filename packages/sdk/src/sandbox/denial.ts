import type { SandboxEnvironment, SandboxExecAttribution } from '../types/sandbox/index.js'

/**
 * Reading a sandboxed command's failure: did the command fail, did the
 * sandbox refuse it, or did the launcher never get as far as running it?
 *
 * The model cannot tell these apart from an exit code. A denied write looks
 * like any other failure, so it retries the same command and burns turns
 * on something no retry can fix; a launcher that could not set up its
 * namespaces looks like the command crashing. Both call for a different
 * answer (ask for the escape, or report a runner fault).
 *
 * This is inference from stderr text, not a verdict from the kernel, and
 * the wording says so. It only ever adds a note; the result is unchanged.
 */

/** Launcher setup failures print this prefix before any user command runs. */
const RUNNER_PREFIX: Partial<Record<SandboxEnvironment, RegExp>> = {
	'linux-bwrap': /^bwrap: (?!execvp )/m,
	'linux-namespace': /^unshare: /m,
	'macos-seatbelt': /^sandbox-exec: /m,
}

const EROFS = /Read-only file system|\bEROFS\b/i
const PERMISSION = /Permission denied|Operation not permitted|\bEACCES\b|\bEPERM\b/i
const ABSOLUTE_PATH = /(?:^|[\s'"`:(])(\/[^\s'"`:)]+)/g

/** Only tiers that confine file writes can produce a sandbox denial. */
const CONFINES_FILES: ReadonlySet<SandboxEnvironment> = new Set(['linux-bwrap', 'macos-seatbelt'])

function within(path: string, root: string): boolean {
	return path === root || path.startsWith(root.endsWith('/') ? root : `${root}/`)
}

function pathsIn(line: string): string[] {
	return [...line.matchAll(ABSOLUTE_PATH)].map((m) => m[1] as string)
}

export interface AttributionInput {
	readonly environment: SandboxEnvironment
	readonly exitCode: number
	readonly stderr: string
	readonly timedOut: boolean
	/** Paths the sandbox lets the command write: root, added directories, scratch. */
	readonly allowedRoots: readonly string[]
}

export function attributeSandboxFailure(
	input: AttributionInput,
): SandboxExecAttribution | undefined {
	if (input.exitCode === 0 || input.timedOut || input.stderr === '') return undefined

	const runner = RUNNER_PREFIX[input.environment]
	if (runner?.test(input.stderr)) {
		const line = input.stderr.split('\n').find((l) => runner.test(l)) ?? ''
		return {
			kind: 'runner-failure',
			message: `The sandbox launcher failed before the command could run (${line.trim()}). This is a runner fault, not a failure of the command; retrying the same command will not help.`,
		}
	}

	if (!CONFINES_FILES.has(input.environment)) return undefined

	for (const line of input.stderr.split('\n')) {
		if (EROFS.test(line)) return denial()
		if (!PERMISSION.test(line)) continue
		const paths = pathsIn(line)
		if (paths.some((p) => !input.allowedRoots.some((root) => within(p, root)))) return denial()
	}
	return undefined
}

function denial(): SandboxExecAttribution {
	return {
		kind: 'denial',
		message:
			'This looks like a sandbox denial: the command touched a path the sandbox does not allow it to write. This is inferred from the error text, not proven. Retrying the same command will fail the same way; if the action is needed, ask to run it outside the sandbox instead.',
	}
}
