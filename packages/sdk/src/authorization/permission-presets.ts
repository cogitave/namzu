import { AUTO_APPROVE_POLICY_NAME } from '../runtime/query/approval-policy.js'
import type { AuthorizationGateConfig } from '../types/authorization/index.js'
import type { SandboxIsolationControl, SandboxIsolationReport } from '../types/sandbox/index.js'
import { defaultSandboxedGateConfig, defaultSandboxedShellGateConfig } from './presets.js'

/**
 * A named permission stance: what the gate allows, what the sandbox must
 * actually enforce for that to be safe, and who answers the rest.
 *
 * The three were configured independently and had to agree by hand.
 * `defaultSandboxedGateConfig` auto-approves in-sandbox file mutation, and
 * its own docstring says why: "the FS boundary is enforced by the sandbox
 * layer, not by per-call review". That is a claim about a DIFFERENT
 * subsystem — one nothing checked. Hand that config a `basic` tier, where
 * the spawned process can read and write the whole host filesystem, and the
 * gate keeps auto-approving writes on the grounds of a boundary that is not
 * there.
 *
 * So a preset states its requirement and {@link resolvePermissionPreset}
 * refuses when the host cannot meet it. Refusing is the point: a preset
 * that silently fell back to asking about everything would be safe and
 * unusable, and one that silently kept auto-approving would be neither.
 */

export interface PermissionPreset {
	/** Stable, and written into the run's log. */
	readonly name: string
	/** One sentence an operator reads when choosing between them. */
	readonly description: string
	readonly gate: AuthorizationGateConfig
	/**
	 * The controls the sandbox must actually enforce for `gate` to mean what
	 * it says.
	 *
	 * Controls, not a tier name. `SandboxEnvironment` names an
	 * implementation — one tier denies the network outright while another
	 * leaves the host filesystem visible — and a preset depends on the
	 * property, not on which implementation happens to supply it.
	 */
	readonly requiresIsolation: readonly SandboxIsolationControl[]
	/**
	 * The approval policy name this stance expects to be running under.
	 *
	 * Advisory rather than enforced: this package cannot install a handler,
	 * and a preset that pretended to would be claiming an authority it does
	 * not have. It is here so a host can compare it against the run's actual
	 * policy and so the pairing is written down in one place instead of
	 * living in whoever wired it.
	 */
	readonly expectsApprovalPolicy: string
}

/** A preset whose isolation requirement the host cannot meet. */
export class UnsupportedPermissionPresetError extends Error {
	readonly details: {
		preset: string
		required: readonly SandboxIsolationControl[]
		missing: readonly SandboxIsolationControl[]
	}

	constructor(details: {
		preset: string
		required: readonly SandboxIsolationControl[]
		missing: readonly SandboxIsolationControl[]
	}) {
		super(
			`The "${details.preset}" preset requires ${details.required.join(', ')} isolation; this sandbox does not enforce ${details.missing.join(', ')}.`,
		)
		this.name = 'UnsupportedPermissionPresetError'
		this.details = details
	}
}

/**
 * Ask a human about everything, and rely on nothing.
 *
 * The only preset with no isolation requirement, because it makes no
 * assumption a sandbox could fail to back: every call goes to review.
 * Correct on a bare host, and the one to reach for when the sandbox tier
 * is unknown.
 */
export const SUPERVISED_PRESET: PermissionPreset = {
	name: 'supervised',
	description: 'Every tool call goes to a human. Assumes nothing about the sandbox.',
	gate: {
		enabled: true,
		// `false`, and that is the whole preset. Read-only auto-approval is
		// the one allowance whose safety does not depend on the sandbox — it
		// depends on a tool telling the truth about itself, which is the
		// claim `isTrustedReadOnly` exists because it cannot always take at
		// face value.
		allowReadOnlyTools: false,
		denyDangerousPatterns: true,
		logDecisions: false,
		rules: [{ type: 'deny_dangerous_patterns' }],
	},
	requiresIsolation: [],
	expectsApprovalPolicy: 'host',
}

/**
 * Trust the sandbox for the filesystem; ask about shell and network.
 *
 * `filesystem` only, and the omissions are deliberate. This preset does not
 * auto-approve shell or network calls, so it does not depend on those
 * controls being enforced — requiring them would refuse hosts that could
 * safely run this.
 */
export const SANDBOXED_PRESET: PermissionPreset = {
	name: 'sandboxed',
	description:
		'In-sandbox file mutation auto-approves; shell and network calls go to a human. Requires a sandbox that confines the filesystem.',
	gate: defaultSandboxedGateConfig(),
	requiresIsolation: ['filesystem'],
	expectsApprovalPolicy: 'host',
}

/**
 * Trust the sandbox for shell too.
 *
 * Requires `process` as well: a shell that auto-approves inside a tier
 * which cannot stop it seeing or signalling host processes is a shell with
 * the run of the machine, and the gate would be approving on the strength
 * of a boundary that does not exist.
 */
export const SANDBOXED_SHELL_PRESET: PermissionPreset = {
	name: 'sandboxed-shell',
	description:
		'Shell as well as file mutation auto-approves inside the sandbox; network calls go to a human. Requires filesystem and process isolation.',
	gate: defaultSandboxedShellGateConfig(),
	requiresIsolation: ['filesystem', 'process'],
	expectsApprovalPolicy: 'host',
}

/**
 * Nobody is watching, so the sandbox has to be.
 *
 * All three controls, because with an auto-approving policy the sandbox is
 * the ONLY boundary left. This is the preset an unattended run wants, and
 * the one whose requirement must not be waived: the whole reason it can
 * approve everything is that the host said nothing can escape.
 */
export const UNATTENDED_PRESET: PermissionPreset = {
	name: 'unattended',
	description:
		'Everything auto-approves. The sandbox is the only boundary, so it must enforce all three controls.',
	gate: {
		...defaultSandboxedShellGateConfig(),
		allowReadOnlyTools: true,
		// Network too, which is exactly what the `network` isolation
		// requirement below is paying for. The sandboxed presets leave
		// network to a human precisely because they do not require that
		// control; this one requires it, so it can spend it.
		rules: [
			{
				type: 'allow_by_category',
				categories: ['filesystem', 'shell', 'analysis', 'custom', 'network'],
			},
		],
	},
	requiresIsolation: ['filesystem', 'network', 'process'],
	expectsApprovalPolicy: AUTO_APPROVE_POLICY_NAME,
}

export const PERMISSION_PRESETS: Readonly<Record<string, PermissionPreset>> = {
	[SUPERVISED_PRESET.name]: SUPERVISED_PRESET,
	[SANDBOXED_PRESET.name]: SANDBOXED_PRESET,
	[SANDBOXED_SHELL_PRESET.name]: SANDBOXED_SHELL_PRESET,
	[UNATTENDED_PRESET.name]: UNATTENDED_PRESET,
}

/** The preset by name, or `undefined` — the reverse lookup a host needs. */
export function permissionPreset(name: string): PermissionPreset | undefined {
	return PERMISSION_PRESETS[name]
}

/**
 * The gate config for a preset, or a refusal naming what is missing.
 *
 * The check is the reason this function exists rather than a property
 * lookup. A host reaching for `unattended` on a `basic` tier is asking for
 * a run that approves everything with nothing enforcing the boundary it is
 * approving on the strength of; the answer is no, with the missing controls
 * named so the host can fix the sandbox rather than guess.
 */
export function resolvePermissionPreset(
	preset: PermissionPreset,
	isolation: SandboxIsolationReport,
): AuthorizationGateConfig {
	const missing = preset.requiresIsolation.filter((control) => !isolation[control])
	if (missing.length > 0) {
		throw new UnsupportedPermissionPresetError({
			preset: preset.name,
			required: preset.requiresIsolation,
			missing,
		})
	}
	return preset.gate
}

/**
 * Every preset this host can actually honour, strongest first.
 *
 * For an operator picking one, and for a host that wants a default it can
 * defend. Ordered by how much they rely on the sandbox rather than
 * alphabetically, so the first entry is always the loosest stance this host
 * can back up and the last is always `supervised`, which needs nothing.
 */
export function availablePermissionPresets(
	isolation: SandboxIsolationReport,
): readonly PermissionPreset[] {
	return [UNATTENDED_PRESET, SANDBOXED_SHELL_PRESET, SANDBOXED_PRESET, SUPERVISED_PRESET].filter(
		(preset) => preset.requiresIsolation.every((control) => isolation[control]),
	)
}
