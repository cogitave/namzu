import {
	LocalSandboxProvider,
	type Logger,
	SANDBOX_ISOLATION_CONTROLS,
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
 * On by default now. What it enforces is a property of the machine, and
 * this module's other job is to make sure nobody has to guess which.
 */

export interface ResolvedSandbox {
	/** Absent when the operator turned it off. */
	readonly provider?: SandboxProvider
	/** One line for the operator, always — including when it is off. */
	readonly notice: string
	/**
	 * True when commands run on the host with no confinement.
	 *
	 * Either because the sandbox is off, or because this platform's
	 * environment enforces nothing. A caller that wants to warn louder in
	 * that case does not have to re-derive it from the notice text.
	 */
	readonly unconfined: boolean
}

/**
 * Build the sandbox for a run, or explain why there is none.
 *
 * Never throws for an ordinary platform shortfall — a machine that cannot
 * confine the network still runs the CLI, and says so. It DOES throw when
 * the operator named a control under `requireIsolation` that this machine
 * cannot enforce, because that request is the one case where continuing
 * quietly would be answering a question they asked with a different
 * answer than the true one.
 */
export function resolveSandbox(log: Logger, config: SandboxConfig | undefined): ResolvedSandbox {
	if (config?.enabled === false) {
		return {
			notice:
				"Sandbox off by configuration: commands run in this process, with this shell's environment. Remove `sandbox.enabled: false` to turn it back on.",
			unconfined: true,
		}
	}

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
			notice: `Sandbox on (${provider.environment}), but this platform enforces none of ${SANDBOX_ISOLATION_CONTROLS.join(', ')} — commands are not confined. Name what you need under \`sandbox.requireIsolation\` to be refused instead of surprised.`,
			unconfined: true,
		}
	}

	return {
		provider,
		notice:
			missing.length === 0
				? `Sandbox on (${provider.environment}): enforcing ${enforced.join(', ')}.`
				: `Sandbox on (${provider.environment}): enforcing ${enforced.join(', ')}; NOT enforcing ${missing.join(', ')}.`,
		unconfined: false,
	}
}
