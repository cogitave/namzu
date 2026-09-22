import {
	LocalSandboxProvider,
	type Logger,
	SANDBOX_ISOLATION_CONTROLS,
	type SandboxEnvironment,
	type SandboxIsolationControl,
	type SandboxProvider,
	isolationOf,
} from '@namzu/sdk'

import type { SandboxConfig } from '../config/schema.js'

/**
 * The sandbox a CLI run executes its commands in.
 *
 * There was none. `sandboxProvider` appeared zero times in this package,
 * so `context.sandbox` was always undefined and `BashTool` took its
 * fallback branch — `execAsync` in the host process, with the host
 * environment, meaning every credential the operator's shell holds went
 * to every command the model chose to run. The isolation the docs
 * described held on no path.
 *
 * It was then turned on by default, and that default is reversed again, on
 * purpose and for a different reason: on a machine where the sandbox binds
 * only the working directory and cuts the network, a coding agent could not
 * read a file the user pointed it at, reach a package registry, or run a
 * host tool, and every one of those failures read to the model like a wall.
 * The default is now host execution under the permission system — each shell
 * command reviewed, each path outside the working directory an approval
 * request — and the sandbox is the opt-in (`sandbox.enabled: true`) for an
 * operator who wants commands confined. What it enforces when on is a
 * property of the machine, and this module's other job is to make sure
 * nobody has to guess which.
 */

/**
 * Whether the operator asked for the sandbox.
 *
 * `enabled` decides when it is written. Unset, a `requireIsolation` that names
 * a control or an `ephemeral` workspace turns it on: both only mean something
 * inside a sandbox, and silently dropping a stated requirement because a
 * switch sat at its default is the downgrade `requireIsolation` exists to
 * make impossible.
 */
export function sandboxRequested(config: SandboxConfig | undefined): boolean {
	if (config?.enabled !== undefined) return config.enabled
	return (config?.requireIsolation?.length ?? 0) > 0 || config?.workspace === 'ephemeral'
}

/**
 * What a reader needs to know about the sandbox, without the live provider.
 *
 * Split out so `/status` can be handed the facts rather than the object: the
 * provider is a running thing with a filesystem under it, and a render
 * function has no business holding one.
 */
export interface SandboxSummary {
	/**
	 * True when commands run on the host with no confinement.
	 *
	 * Either because the sandbox is off, or because this platform's environment
	 * enforces nothing. A caller that wants to warn louder in that case does not
	 * have to re-derive it from the notice text.
	 */
	readonly unconfined: boolean
	/** Absent when the operator turned the sandbox off. */
	readonly environment?: SandboxEnvironment
	/** Controls this machine actually applies to a spawned command. */
	readonly enforced: readonly SandboxIsolationControl[]
	/**
	 * Controls the operator DEMANDED, which is not recoverable from the line
	 * above: a host that supplies `filesystem` anyway looks identical to one
	 * where it was insisted on, and only the second is a guarantee that
	 * survives moving machines.
	 */
	readonly required: readonly SandboxIsolationControl[]
	/**
	 * Where writes land. Optional only for embedded/older session adapters.
	 * `working-directory` survives turn teardown; `ephemeral` does not.
	 */
	readonly workspace?: 'host' | 'working-directory' | 'ephemeral'
}

export interface ResolvedSandbox extends SandboxSummary {
	/** Absent when the operator turned it off. */
	readonly provider?: SandboxProvider
	/** One line for the operator, always — including when it is off. */
	readonly notice: string
}

/**
 * Build the sandbox for a turn, or explain why there is none.
 *
 * Never throws for an ordinary platform shortfall — a machine that cannot
 * confine the network still runs the CLI, and says so. It DOES throw when
 * the operator named a control under `requireIsolation` that this machine
 * cannot enforce, because that request is the one case where continuing
 * quietly would be answering a question they asked with a different
 * answer than the true one.
 */
export function resolveSandbox(log: Logger, config: SandboxConfig | undefined): ResolvedSandbox {
	if (!sandboxRequested(config)) {
		return {
			notice:
				config?.enabled === false
					? "Sandbox off by configuration: commands and file tools run on this machine, with this shell's environment, under the permission prompts; a path outside the working directory asks before it is used. Set `sandbox.enabled: true` to confine commands."
					: "Sandbox off (the default): commands and file tools run on this machine, with this shell's environment, under the permission prompts; a path outside the working directory asks before it is used. Set `sandbox.enabled: true` to confine commands.",
			unconfined: true,
			enforced: [],
			required: (config?.requireIsolation ?? []) as readonly SandboxIsolationControl[],
			workspace: 'host',
		}
	}
	const workspace = config?.workspace ?? 'working-directory'
	const workspaceNotice =
		workspace === 'working-directory'
			? 'The real working directory is mounted; changes persist across turns.'
			: 'Each turn receives a disposable workspace; changes are removed at teardown.'

	const required = (config?.requireIsolation ?? []) as readonly SandboxIsolationControl[]
	// Constructing with the requirement is what makes `requireIsolation`
	// mean something: the provider refuses rather than downgrading, and the
	// refusal names the control. Catching it here would turn a stated
	// requirement back into a preference.
	const provider = new LocalSandboxProvider(log, { requireIsolation: required })

	const report = isolationOf(provider.environment)
	const enforced = SANDBOX_ISOLATION_CONTROLS.filter((c) => report[c])
	const missing = SANDBOX_ISOLATION_CONTROLS.filter((c) => !report[c])

	if (enforced.length === 0) {
		// The honest case, and the one most likely to be misread. The
		// sandbox is attached and confines nothing, which is not the same as
		// no sandbox and is emphatically not protection.
		return {
			provider,
			notice: `Sandbox on (${provider.environment}), but this platform enforces none of ${SANDBOX_ISOLATION_CONTROLS.join(', ')} — commands are not confined. ${workspaceNotice} Name what you need under \`sandbox.requireIsolation\` to be refused instead of surprised.`,
			unconfined: true,
			environment: provider.environment,
			enforced: [],
			required,
			workspace,
		}
	}

	return {
		provider,
		notice:
			missing.length === 0
				? `Sandbox on (${provider.environment}): enforcing ${enforced.join(', ')}. ${workspaceNotice}`
				: `Sandbox on (${provider.environment}): enforcing ${enforced.join(', ')}; NOT enforcing ${missing.join(', ')}. ${workspaceNotice}`,
		unconfined: false,
		environment: provider.environment,
		enforced,
		required,
		workspace,
	}
}

/**
 * `namzu.sandbox.resolved`'s severity: `warn` when nothing is confined,
 * `info` otherwise. Extracted from the emit call site (`tui/agent.ts`) so
 * this mapping — the one that decides whether an unconfined sandbox reads
 * as routine or as something an operator should act on — is testable
 * without depending on which isolation tier the test happens to run under.
 * `resolveSandbox` reports whatever THIS machine actually enforces, and
 * CI's machine is not every reader's; the existing tests in this file
 * already work around that by branching at runtime on `resolved.unconfined`
 * rather than asserting a fixed tier. A pure function over `ResolvedSandbox`
 * sidesteps the need for that workaround entirely for this one property.
 */
export function sandboxResolvedSeverity(sandbox: ResolvedSandbox): 'info' | 'warn' {
	return sandbox.unconfined ? 'warn' : 'info'
}
