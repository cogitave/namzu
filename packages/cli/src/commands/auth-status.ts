/**
 * `namzu auth status` — which credentials this machine has, and whether each
 * can still be used.
 *
 * The report is built from what discovery already found, so it cannot drift
 * from what a session would use. It carries no secret: no token, no key, no
 * fragment of either, and no account identifier the provider issued. Each row
 * says where the credential comes from in words, never what it contains.
 */

import { hasApiCredential } from '../integrations/providers/access.js'
import type { DetectedProvider, DetectionSource } from '../integrations/providers/discover.js'
import { terminalDisplayText } from '../tui/terminal-display.js'

export type AuthKind = 'subscription' | 'api-key' | 'environment'
export type AuthState = 'usable' | 'expired'

export interface AuthStatusRow {
	readonly provider: string
	readonly label: string
	/** Where the credential comes from, in words. Never a secret. */
	readonly account: string
	readonly kind: AuthKind
	readonly state: AuthState
}

const KIND_TEXT: Record<AuthKind, string> = {
	subscription: 'subscription sign-in',
	'api-key': 'API key',
	environment: 'environment variable',
}

function describeSource(source: DetectionSource): { kind: AuthKind; account: string } | null {
	switch (source.kind) {
		case 'env':
			return { kind: 'environment', account: source.envName }
		case 'stored':
			return {
				kind: 'subscription',
				account: source.shared === 'desktop' ? 'Namzu Desktop sign-in' : 'signed in with Namzu',
			}
		case 'claude-file':
			return { kind: 'subscription', account: 'Claude session on this machine' }
		case 'codex-file':
			return { kind: 'subscription', account: 'Codex session on this machine' }
		case 'gemini-file':
			return { kind: 'subscription', account: 'Gemini session on this machine' }
		case 'keychain':
			return { kind: 'subscription', account: 'Claude session in the system keychain' }
		case 'stored-api-key':
		case 'stored-gemini-key':
			return { kind: 'api-key', account: 'saved by Namzu' }
		case 'opencode-file':
			return { kind: 'api-key', account: 'saved by OpenCode' }
		// Local servers, the anonymous free option and typed-in keys are not stored credentials.
		case 'probe':
		case 'public':
		case 'session':
			return null
	}
}

/** Rows for every stored or detected credential, one per source. */
export function authStatusRows(
	detected: readonly DetectedProvider[],
	now: number = Date.now(),
): AuthStatusRow[] {
	const rows: AuthStatusRow[] = []
	for (const d of detected) {
		const primary = describeSource(d.source)
		if (primary === null) continue
		if (d.source.kind === 'env' && d.entry.id === 'zen' && !hasApiCredential(d.entry, d.apiKey)) {
			continue
		}
		const expiresAt = d.oauth?.expiresAt ?? d.codex?.expiresAt
		// A sign-in that carries a refresh token renews itself when it is next used.
		const refreshes = d.oauth?.refreshToken !== undefined
		const expired =
			primary.kind === 'subscription' && expiresAt !== undefined && expiresAt <= now && !refreshes
		rows.push({
			provider: d.entry.id,
			label: d.entry.label,
			account: primary.account,
			kind: primary.kind,
			state: expired ? 'expired' : 'usable',
		})
		// Other places that also supply this provider. Only the kinds that do not
		// expire are listed: for a sign-in the report has no expiry to check.
		for (const alt of d.alternatives) {
			const described = describeSource(alt)
			if (described === null || described.kind === 'subscription') continue
			rows.push({
				provider: d.entry.id,
				label: d.entry.label,
				account: described.account,
				kind: described.kind,
				state: 'usable',
			})
		}
	}
	return rows
}

export function renderAuthStatus(rows: readonly AuthStatusRow[]): string {
	if (rows.length === 0) {
		return 'No credentials found. Sign in with `namzu auth login claude` or `namzu auth login codex`, or set an API key such as ANTHROPIC_API_KEY.'
	}
	const one = (text: string) => terminalDisplayText(text).replace(/[\t\n\r]+/g, ' ')
	const lines = ['Credentials:']
	for (const row of rows) {
		lines.push(
			`  ${one(row.provider).padEnd(12)} ${one(KIND_TEXT[row.kind]).padEnd(22)} ${one(row.account).padEnd(38)} ${row.state}`,
		)
	}
	if (rows.some((row) => row.state === 'expired')) {
		lines.push('', 'An expired sign-in needs `namzu auth login <provider>` again.')
	}
	return lines.join('\n')
}
