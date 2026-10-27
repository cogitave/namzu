/**
 * The pre-execution gate every session of this application runs under.
 *
 * The kernel's read-only allowance asks whether a tool's read-only CLAIM can be
 * believed; it never asks what the call reaches. A page fetch changes nothing
 * here and so claims read-only, and without the exclusion below it would run
 * unasked on every domain. Network tools therefore fall through to the
 * operator's rules, the remembered answers and, last, the question, in every
 * session that uses this gate: the main conversation, a sub-agent, a Pal's
 * session and headless runs.
 *
 * `web_search` keeps the behaviour it has always had: it sends a query to a
 * search service and fetches no page, and it runs without a question. Its
 * allowance is a rule placed after the operator's own, so a `deny` or `ask` a
 * person wrote for it still decides first.
 */

import type { AuthorizationGateConfig, AuthorizationRule } from '@namzu/sdk'

/** Tools that reach another host, which the read-only allowance must not approve. */
export const NETWORK_CATEGORY = 'network'

const SEARCH_ALLOWANCE: AuthorizationRule = { type: 'allow_by_name', toolNames: ['web_search'] }

/**
 * The gate for a session, with the operator's rules in it.
 *
 * The dangerous-pattern denial is the floor and outranks everything; the
 * read-only allowance is consulted after the operator's rules, so
 * `read = "ask"` is reachable.
 */
export function cliGate(rules: readonly AuthorizationRule[] | undefined): AuthorizationGateConfig {
	return {
		enabled: true,
		allowReadOnlyTools: true,
		allowReadOnlyExcludeCategories: [NETWORK_CATEGORY],
		denyDangerousPatterns: true,
		logDecisions: false,
		rules: [...(rules ?? []), SEARCH_ALLOWANCE],
	}
}
