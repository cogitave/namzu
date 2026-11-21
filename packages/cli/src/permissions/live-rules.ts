import { resolve } from 'node:path'
import { AuthorizationGate, type AuthorizationRule, NOOP_LOGGER } from '@namzu/sdk'

import { readPermissionLayers } from '../config/load.js'
import { isTrusted } from '../integrations/trust/store.js'
import { legacyLocalConfigPath, localSettingsPath } from './local-settings.js'
import { type PermissionsConfig, compilePermissionLayers, permissionTableSource } from './rules.js'

/** Stable predicates captured by running gates; only the local layer is replaceable. */
export function createLivePermissionRules(options: {
	readonly cwd: string
	readonly layers: readonly PermissionsConfig[]
	readonly browserRules?: readonly AuthorizationRule[]
	/**
	 * Whether the folder is trusted, asked at each reload. Its local files are
	 * read only while it is. Absent: the trusted-folder list decides.
	 */
	readonly trusted?: () => boolean
}) {
	const trusted = options.trusted ?? (() => isTrusted(options.cwd))
	// Both local files are replaceable: the earlier one is read until it moves.
	const localPaths = new Set([
		resolve(localSettingsPath(options.cwd)),
		resolve(legacyLocalConfigPath(options.cwd)),
	])
	const isLocal = (table: PermissionsConfig) => localPaths.has(permissionTableSource(table) ?? '')
	const fixed = options.layers.filter((table) => !isLocal(table))
	const initialLocal = options.layers.filter(isLocal)
	const gate = (rules: readonly AuthorizationRule[]) =>
		new AuthorizationGate(
			{
				enabled: true,
				rules: [...rules],
				allowReadOnlyTools: false,
				denyDangerousPatterns: false,
				logDecisions: false,
			},
			NOOP_LOGGER,
		)
	const browser = gate(options.browserRules ?? [])
	const compile = (local: readonly PermissionsConfig[]) => {
		const compiled = compilePermissionLayers([...fixed, ...local], undefined, { cwd: options.cwd })
		if (compiled.diagnostics.length)
			throw new Error(compiled.diagnostics.map((d) => d.message).join('; '))
		return gate(compiled.rules)
	}
	let current = compile(initialLocal)
	const evaluate = (call: Parameters<AuthorizationGate['evaluate']>[0]) => {
		const table = current.evaluate(call)
		if (table.matchedRule !== null && table.decision === 'deny') return table
		const site = browser.evaluate(call)
		return site.matchedRule !== null ? site : table
	}
	// Separate verdict predicates preserve deny-before-allow composition in hosts.
	const rules: AuthorizationRule[] = (['deny', 'review', 'allow'] as const).map((decision) => ({
		type: 'predicate',
		description: `live permission ${decision}`,
		decide: (call) => {
			const result = evaluate(call)
			return result.matchedRule !== null && result.decision === decision ? decision : null
		},
		describe: (call) => evaluate(call).reason,
	}))
	return {
		rules,
		reload(): void {
			// A folder that is not trusted has its local files left unread, as at launch.
			const local = readPermissionLayers({
				cwd: options.cwd,
				...(trusted() ? {} : { includeProject: false }),
			}).filter((layer) => layer.source === 'local-file')
			const next = compile(local.map((layer) => layer.permissions))
			// Publish only after every rule validated. Failure retains the previous policy.
			current = next
		},
	}
}
