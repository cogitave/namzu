/**
 * May a pasted or dropped image file be read?
 *
 * The operator put the path in the composer themself, so the file is read
 * wherever it lives: a screenshot on the Windows desktop, reached through
 * `/mnt/c`, is as welcome as one in the project. The one thing that stops the
 * read is a `deny` rule for the path, checked on the path as written and on
 * the file a link leads to. A rule that only asks does not refuse it (the
 * operator already chose this file), and the folders the session reaches do
 * not matter. A refused path is never read and never sent anywhere.
 */

import { AuthorizationGate, type AuthorizationRule, NOOP_LOGGER } from '@namzu/sdk'

export interface ImageReadPolicyOptions {
	/** The operator's permission rules, read at each check. */
	readonly rules?: () => readonly AuthorizationRule[] | undefined
}

/** `null` when the path may be read, otherwise a plain sentence saying why not. */
export type ImageReadPolicy = (path: string) => Promise<string | null>

export function createImageReadPolicy(options: ImageReadPolicyOptions): ImageReadPolicy {
	return async (path) => {
		const rules = options.rules?.() ?? []
		if (rules.length === 0) return null
		const gate = new AuthorizationGate(
			{
				enabled: true,
				rules: [...rules],
				allowReadOnlyTools: false,
				denyDangerousPatterns: false,
				logDecisions: false,
			},
			NOOP_LOGGER,
		)
		// The rule looks through links itself, so a link into a denied folder is refused too.
		const verdict = gate.evaluate({ toolName: 'read', toolInput: { path }, toolDef: undefined })
		if (verdict.matchedRule !== null && verdict.decision === 'deny') {
			return `A permission rule keeps this session from reading ${path}.`
		}
		return null
	}
}
