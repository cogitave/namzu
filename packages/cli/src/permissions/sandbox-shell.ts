/**
 * Shell commands that stay inside the OS sandbox run without a question.
 *
 * The kernel already knows the rule: the sandboxed-shell preset trusts the
 * sandbox for shell commands, and only when the sandbox reports that it
 * confines the file system and the process table. This module is the
 * terminal's side of it, deciding from what the machine actually enforces
 * whether the preset's allowance applies, and nothing more:
 *
 * - Only the shell. The preset also allows file changes inside the sandbox;
 *   the terminal keeps asking about those as the permission mode says, so
 *   turning the sandbox on does not change what an edit costs.
 * - The rule goes behind the operator's own rules and the remembered answers,
 *   so a rule that says ask or deny still decides, and behind the safety floor,
 *   which the gate always checks first.
 * - A command that asks to leave the sandbox is not covered. The kernel treats
 *   it as an escape and asks about it every time, in every mode that does not
 *   refuse it, whatever the gate says.
 */

import {
	type AuthorizationRule,
	SANDBOXED_SHELL_PRESET,
	SANDBOX_ISOLATION_CONTROLS,
	UnsupportedPermissionPresetError,
	resolvePermissionPreset,
} from '@namzu/sdk'

import type { SandboxSummary } from '../context/sandbox.js'

type IsolationReport = Parameters<typeof resolvePermissionPreset>[1]

/**
 * The rules that let an in-sandbox shell command run unasked, or none when the
 * sandbox is off or does not enforce what the preset requires (a tier that
 * cannot confine the file system or the process table keeps every command
 * going through the permission mode).
 */
export function sandboxShellRules(
	sandbox: Pick<SandboxSummary, 'environment' | 'enforced'>,
): readonly AuthorizationRule[] {
	if (sandbox.environment === undefined) return []
	const report = Object.fromEntries(
		SANDBOX_ISOLATION_CONTROLS.map((control) => [control, sandbox.enforced.includes(control)]),
	) as IsolationReport
	let gate: ReturnType<typeof resolvePermissionPreset>
	try {
		gate = resolvePermissionPreset(SANDBOXED_SHELL_PRESET, report)
	} catch (error) {
		if (error instanceof UnsupportedPermissionPresetError) return []
		throw error
	}
	const rules: AuthorizationRule[] = []
	for (const rule of gate.rules) {
		if (rule.type !== 'allow_by_category') continue
		if (rule.categories.includes('shell')) {
			rules.push({ type: 'allow_by_category', categories: ['shell'] })
		}
	}
	return rules
}

/** Whether shell commands inside this session's sandbox run without asking. */
export function sandboxRunsShellUnasked(
	sandbox: Pick<SandboxSummary, 'environment' | 'enforced'> | undefined,
): boolean {
	return sandbox !== undefined && sandboxShellRules(sandbox).length > 0
}

/**
 * The session's rules with the in-sandbox shell allowance behind them: the
 * operator's rules and remembered answers decide first, the allowance is what
 * a shell command meets last, and the gate's safety floor outranks all of it.
 */
export function withSandboxShell(
	rules: readonly AuthorizationRule[],
	sandbox: Pick<SandboxSummary, 'environment' | 'enforced'>,
): readonly AuthorizationRule[] {
	return [...rules, ...sandboxShellRules(sandbox)]
}
